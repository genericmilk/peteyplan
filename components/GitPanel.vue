<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { confirmDialog, requestDialogClose, vModal } from '~/composables/useModal'
import {
  PhArrowUp,
  PhArrowsClockwise,
  PhCaretDown,
  PhCaretRight,
  PhCheck,
  PhCloud,
  PhCloudArrowDown,
  PhCloudArrowUp,
  PhDesktopTower,
  PhFolder,
  PhFolderOpen,
  PhFolderSimplePlus,
  PhGitBranch,
  PhHardDrives,
  PhHouse,
  PhLinuxLogo,
  PhPlus,
  PhLinkBreak,
  PhTrash,
} from '@phosphor-icons/vue'

interface GitFile { path: string; from?: string; index: string; worktree: string; untracked: boolean }
interface GitStatus {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  initial: boolean
  files: GitFile[]
  lastCommit: { hash: string; subject: string } | null
}
interface FolderRoot { label: string; path: string; kind: 'home' | 'root' | 'drive' | 'wsl' | 'code' }
interface FolderListing {
  path: string
  parent: string | null
  repo: boolean
  folders: { name: string; path: string; repo: boolean }[]
  truncated: boolean
  roots: FolderRoot[]
}
interface Branches { current: string | null; local: { name: string; upstream: string | null }[]; remote: string[] }
interface Repo { id: string; boardId: string; path: string; name: string; status: GitStatus | null; error: string | null }

const props = defineProps<{ boardId: string; boardName: string; open: boolean }>()
const emit = defineEmits<{
  /** Number of linked repos with uncommitted or unpushed work */
  attention: [count: number]
}>()

const POLL_MS = 30_000

const git = ref<{ available: boolean; version: string | null } | null>(null)
const repos = ref<Repo[]>([])
const loaded = ref(false)
const refreshing = ref(false)
type Action = 'commit' | 'push' | 'discard' | 'refresh' | 'switch' | 'fetch'
const busy = ref<Record<string, Action | undefined>>({})
const messages = ref<Record<string, string>>({})
const repoErrors = ref<Record<string, string>>({})
const expanded = ref(new Set<string>())
const linkPath = ref('')
const linkError = ref('')
const linking = ref(false)
let request = 0
let pollTimer: ReturnType<typeof setInterval> | undefined

const attention = computed(() => repos.value.filter((repo) => needsAttention(repo.status)).length)
watch(attention, (count) => emit('attention', count), { immediate: true })

function needsAttention(status: GitStatus | null): boolean {
  return !!status && (status.files.length > 0 || status.ahead > 0)
}

async function call<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const data = await res.json()
      if (data && typeof data.statusMessage === 'string') message = data.statusMessage
    } catch { /* keep generic message */ }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

async function refresh() {
  const id = props.boardId
  const mine = ++request
  refreshing.value = true
  try {
    git.value ??= await call('/api/git')
    const data = await call<{ repos: Repo[] }>(`/api/boards/${encodeURIComponent(id)}/repos`)
    if (mine !== request) return
    repos.value = data.repos
    loaded.value = true
  } catch (err) {
    if (mine === request) linkError.value = err instanceof Error ? err.message : 'Could not load linked folders'
  } finally {
    if (mine === request) refreshing.value = false
  }
}

function replaceRepo(next: Repo) {
  repos.value = repos.value.map((repo) => (repo.id === next.id ? next : repo))
}

async function runAction(repo: Repo, action: Action, task: () => Promise<Repo>) {
  if (busy.value[repo.id]) return
  busy.value = { ...busy.value, [repo.id]: action }
  const { [repo.id]: _, ...rest } = repoErrors.value
  repoErrors.value = rest
  try {
    replaceRepo(await task())
    return true
  } catch (err) {
    repoErrors.value = { ...repoErrors.value, [repo.id]: err instanceof Error ? err.message : 'Something went wrong' }
    // A failed push still may have committed; show the real state.
    call<Repo>(`/api/repos/${repo.id}/status`).then(replaceRepo, () => {})
    return false
  } finally {
    busy.value = { ...busy.value, [repo.id]: undefined }
  }
}

async function commitAndPush(repo: Repo) {
  const message = (messages.value[repo.id] || '').trim()
  if (!message) return
  const ok = await runAction(repo, 'commit', () => call<Repo>(`/api/repos/${repo.id}/commit`, {
    method: 'POST',
    body: JSON.stringify({ message, push: true }),
  }))
  if (ok) messages.value = { ...messages.value, [repo.id]: '' }
}

function push(repo: Repo) {
  return runAction(repo, 'push', () => call<Repo>(`/api/repos/${repo.id}/push`, { method: 'POST' }))
}

function refreshRepo(repo: Repo) {
  return runAction(repo, 'refresh', () => call<Repo>(`/api/repos/${repo.id}/status`))
}

async function unlink(repo: Repo) {
  if (!(await confirmDialog({
    title: `Unlink ${repo.name}?`,
    message: `It's removed from ${props.boardName}. The folder and its files stay on disk.`,
    confirmLabel: 'Unlink',
  }))) return
  try {
    await call(`/api/repos/${repo.id}`, { method: 'DELETE' })
    repos.value = repos.value.filter((entry) => entry.id !== repo.id)
  } catch (err) {
    repoErrors.value = { ...repoErrors.value, [repo.id]: err instanceof Error ? err.message : 'Could not unlink' }
  }
}

async function link(chosen?: string) {
  const folder = (chosen ?? linkPath.value).trim()
  if (!folder || linking.value) return
  linking.value = true
  linkError.value = ''
  try {
    const repo = await call<Repo>(`/api/boards/${encodeURIComponent(props.boardId)}/repos`, {
      method: 'POST',
      body: JSON.stringify({ path: folder }),
    })
    if (!repos.value.some((entry) => entry.id === repo.id)) repos.value = [...repos.value, repo]
    else replaceRepo(repo)
    linkPath.value = ''
    browseEl.value?.close()
  } catch (err) {
    linkError.value = err instanceof Error ? err.message : 'Could not link that folder'
  } finally {
    linking.value = false
  }
}

function toggleFiles(id: string) {
  const next = new Set(expanded.value)
  if (!next.delete(id)) next.add(id)
  expanded.value = next
}

const STATUS_LABELS: Record<string, string> = {
  M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', T: 'Type changed', '?': 'New file',
}

function fileCode(file: GitFile): string {
  if (file.untracked) return '?'
  if (file.index === 'U' || file.worktree === 'U') return 'U'
  return file.worktree !== '.' ? file.worktree : file.index
}

function changeSummary(status: GitStatus): string {
  const n = status.files.length
  return n ? `${n} change${n === 1 ? '' : 's'}` : 'Clean'
}

/* ── Discard confirm ───────────────────────────────────────────────────────── */

const discardEl = ref<HTMLDialogElement | null>(null)
const discardId = ref<string | null>(null)
const discardUntracked = ref(false)
const discardRepo = computed(() => repos.value.find((repo) => repo.id === discardId.value))
const discardTracked = computed(() => discardRepo.value?.status?.files.filter((file) => !file.untracked) ?? [])
const discardNew = computed(() => discardRepo.value?.status?.files.filter((file) => file.untracked) ?? [])

function confirmDiscard(repo: Repo) {
  discardId.value = repo.id
  discardUntracked.value = false
  nextTick(() => discardEl.value?.showModal())
}

async function submitDiscard() {
  const repo = discardRepo.value
  discardEl.value?.close()
  if (!repo) return
  const includeUntracked = discardUntracked.value
  await runAction(repo, 'discard', () => call<Repo>(`/api/repos/${repo.id}/discard`, {
    method: 'POST',
    body: JSON.stringify({ includeUntracked }),
  }))
}

/* ── Branch menu ───────────────────────────────────────────────────────────── */

const branchMenu = ref<{ repoId: string; top: number; left: number } | null>(null)
const branches = ref<Branches | null>(null)
const branchQuery = ref('')
const branchError = ref('')
const branchInput = ref<HTMLInputElement | null>(null)
const branchRepo = computed(() => repos.value.find((repo) => repo.id === branchMenu.value?.repoId))
const branchMatches = computed(() => {
  const q = branchQuery.value.trim().toLowerCase()
  const list = branches.value
  if (!list) return { local: [], remote: [] }
  return {
    local: list.local.filter((b) => b.name.toLowerCase().includes(q)),
    remote: list.remote.filter((name) => name.toLowerCase().includes(q)),
  }
})
const canCreateBranch = computed(() => {
  const q = branchQuery.value.trim()
  return !!q && !!branches.value && !branches.value.local.some((b) => b.name === q)
})

async function loadBranches(repo: Repo) {
  branchError.value = ''
  try {
    const data = await call<Branches>(`/api/repos/${repo.id}/branches`)
    if (branchMenu.value?.repoId === repo.id) branches.value = data
  } catch (err) {
    branchError.value = err instanceof Error ? err.message : 'Could not list branches'
  }
}

async function openBranchMenu(event: MouseEvent, repo: Repo) {
  if (branchMenu.value?.repoId === repo.id) return closeBranchMenu()
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const width = 300
  branchMenu.value = {
    repoId: repo.id,
    top: rect.bottom + 6,
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
  }
  branches.value = null
  branchQuery.value = ''
  await nextTick()
  branchInput.value?.focus()
  await loadBranches(repo)
}

function closeBranchMenu() {
  branchMenu.value = null
  branches.value = null
}

async function switchBranch(repo: Repo, branch: string, mode: 'local' | 'create' | 'remote') {
  closeBranchMenu()
  await runAction(repo, 'switch', () => call<Repo>(`/api/repos/${repo.id}/switch`, {
    method: 'POST',
    body: JSON.stringify({ branch, mode }),
  }))
}

function onBranchEnter(repo: Repo) {
  const { local, remote } = branchMatches.value
  const q = branchQuery.value.trim()
  const exact = local.find((b) => b.name === q)
  if (exact) return exact.name !== branches.value?.current && switchBranch(repo, exact.name, 'local')
  if (canCreateBranch.value && !local.length && !remote.length) return switchBranch(repo, q, 'create')
  if (local.length === 1 && local[0]!.name !== branches.value?.current) return switchBranch(repo, local[0]!.name, 'local')
  if (!local.length && remote.length === 1) return switchBranch(repo, remote[0]!, 'remote')
}

async function fetchRepo(repo: Repo) {
  const ok = await runAction(repo, 'fetch', () => call<Repo>(`/api/repos/${repo.id}/fetch`, { method: 'POST' }))
  if (ok && branchMenu.value?.repoId === repo.id) await loadBranches(repo)
  else if (!ok) branchError.value = repoErrors.value[repo.id] ?? ''
}

/* ── Folder picker ─────────────────────────────────────────────────────────── */

const browseEl = ref<HTMLDialogElement | null>(null)
const listing = ref<FolderListing | null>(null)
const browsePath = ref('')
const browseError = ref('')
const browsing = ref(false)
const ROOT_ICONS = { home: PhHouse, root: PhDesktopTower, drive: PhHardDrives, wsl: PhLinuxLogo, code: PhFolderOpen }
const localRoots = computed(() => listing.value?.roots.filter((root) => root.kind !== 'wsl') ?? [])
const wslRoots = computed(() => listing.value?.roots.filter((root) => root.kind === 'wsl') ?? [])
let browseRequest = 0

async function browseTo(target: string) {
  const mine = ++browseRequest
  browsing.value = true
  browseError.value = ''
  try {
    const data = await call<FolderListing>(`/api/folders?path=${encodeURIComponent(target)}`)
    if (mine !== browseRequest) return
    listing.value = data
    browsePath.value = data.path
  } catch (err) {
    if (mine === browseRequest) browseError.value = err instanceof Error ? err.message : 'Could not open that folder'
  } finally {
    if (mine === browseRequest) browsing.value = false
  }
}

async function openBrowser() {
  linkError.value = ''
  browseEl.value?.showModal()
  // Start where you left off, else from what's typed, else home.
  await browseTo(listing.value?.path ?? linkPath.value.trim())
}

/** The most specific place containing the folder being shown, to highlight it. */
const activeRoot = computed(() => {
  const current = listing.value?.path.toLowerCase() ?? ''
  let best: FolderRoot | null = null
  for (const root of listing.value?.roots ?? []) {
    const base = root.path.toLowerCase().replace(/[\\/]+$/, '')
    const inside = current === base || current.startsWith(base + '/') || current.startsWith(base + '\\')
    if (inside && (!best || root.path.length > best.path.length)) best = root
  }
  return best?.path ?? null
})

/* ── Refresh cadence ───────────────────────────────────────────────────────── */

function onFocus() {
  if (props.open) void refresh()
}

watch(() => props.boardId, () => {
  repos.value = []
  loaded.value = false
  linkError.value = ''
  repoErrors.value = {}
  void refresh()
})

watch(() => props.open, (open) => {
  clearInterval(pollTimer)
  if (!open) return
  void refresh()
  pollTimer = setInterval(() => { if (!document.hidden) void refresh() }, POLL_MS)
}, { immediate: true })

onMounted(() => {
  window.addEventListener('focus', onFocus)
  // Load once for the top-bar badge even while the panel is closed.
  if (!props.open) void refresh()
})

onBeforeUnmount(() => {
  clearInterval(pollTimer)
  window.removeEventListener('focus', onFocus)
})
</script>

<template>
  <section v-show="open" id="code-panel" class="releases-panel code-panel" aria-label="Code changes">
    <div class="releases-panel-header">
      <div>
        <h2>Code</h2>
        <p class="releases-panel-hint">
          Local folders linked to {{ boardName }}. Commit &amp; push sends every change to the branch's remote.
        </p>
      </div>
      <button
        type="button"
        class="btn"
        :disabled="refreshing"
        title="Check every folder again"
        @click="refresh"
      ><PhArrowsClockwise :size="15" :class="{ spinning: refreshing }" aria-hidden="true" />Refresh</button>
    </div>

    <div v-if="git && !git.available" class="code-unavailable">
      <strong>Git isn't available to the server.</strong>
      Run PeteyPlan directly on your machine (<code>npm run dev</code>), or start Docker with
      <code>docker compose -f docker-compose.yml -f docker-compose.git.yml up -d --build</code>
      so the container has git and can see your code folder.
    </div>

    <div v-else class="code-repos">
      <article v-for="repo in repos" :key="repo.id" class="code-repo" :class="{ attention: needsAttention(repo.status) }">
        <div class="code-repo-head">
          <div class="code-repo-name">
            <h3 :title="repo.path">{{ repo.name }}</h3>
            <span class="code-repo-path">{{ repo.path }}</span>
          </div>
          <template v-if="repo.status">
            <button
              type="button"
              class="code-branch"
              :class="{ open: branchMenu?.repoId === repo.id }"
              :disabled="!!busy[repo.id]"
              aria-haspopup="dialog"
              :aria-expanded="branchMenu?.repoId === repo.id"
              :title="'Switch branch' + (repo.status.upstream ? ' · tracking ' + repo.status.upstream : ' · no upstream yet, Push sets one')"
              @click="openBranchMenu($event, repo)"
            >
              <PhGitBranch :size="13" aria-hidden="true" />{{ busy[repo.id] === 'switch' ? 'Switching…' : repo.status.branch ?? 'detached' }}
              <span v-if="repo.status.ahead" class="code-ahead" :title="repo.status.ahead + ' commit(s) not pushed'">↑{{ repo.status.ahead }}</span>
              <span v-if="repo.status.behind" class="code-behind" :title="repo.status.behind + ' commit(s) on the remote you don\'t have (as of the last fetch)'">↓{{ repo.status.behind }}</span>
              <PhCaretDown :size="10" weight="bold" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="code-changes"
              :class="{ clean: !repo.status.files.length }"
              :disabled="!repo.status.files.length"
              :aria-expanded="expanded.has(repo.id)"
              @click="toggleFiles(repo.id)"
            >
              <template v-if="repo.status.files.length">
                <PhCaretDown v-if="expanded.has(repo.id)" :size="12" weight="bold" aria-hidden="true" />
                <PhCaretRight v-else :size="12" weight="bold" aria-hidden="true" />
              </template>
              {{ changeSummary(repo.status) }}
            </button>
          </template>
          <span class="spacer"></span>
          <button
            type="button"
            class="btn-icon"
            title="Check again"
            aria-label="Check again"
            :disabled="!!busy[repo.id]"
            @click="refreshRepo(repo)"
          ><PhArrowsClockwise :size="15" :class="{ spinning: busy[repo.id] === 'refresh' }" /></button>
          <button type="button" class="btn-icon" title="Unlink folder" aria-label="Unlink folder" @click="unlink(repo)"><PhLinkBreak :size="15" /></button>
        </div>

        <p v-if="repo.error" class="code-repo-error">{{ repo.error }}</p>

        <ul v-if="repo.status && expanded.has(repo.id) && repo.status.files.length" class="code-files">
          <li v-for="file in repo.status.files" :key="file.path">
            <code class="code-file-status" :data-code="fileCode(file)" :title="STATUS_LABELS[fileCode(file)]">{{ fileCode(file) }}</code>
            <span class="code-file-path" :title="file.path">
              <template v-if="file.from">{{ file.from }} → </template>{{ file.path }}
            </span>
          </li>
        </ul>

        <form v-if="repo.status?.files.length" class="code-commit" @submit.prevent="commitAndPush(repo)">
          <input
            v-model="messages[repo.id]"
            type="text"
            maxlength="200"
            placeholder="Commit message"
            aria-label="Commit message"
            autocomplete="off"
            :disabled="!!busy[repo.id]"
          />
          <button
            type="submit"
            class="btn btn-primary"
            :disabled="!!busy[repo.id] || !(messages[repo.id] || '').trim()"
          ><PhCloudArrowUp :size="15" aria-hidden="true" />{{ busy[repo.id] === 'commit' ? 'Pushing…' : 'Commit & push' }}</button>
          <button
            type="button"
            class="btn btn-danger"
            :disabled="!!busy[repo.id]"
            @click="confirmDiscard(repo)"
          ><PhTrash :size="15" aria-hidden="true" />Discard…</button>
        </form>
        <div v-else-if="repo.status?.ahead" class="code-commit">
          <span class="code-note">{{ repo.status.ahead }} commit{{ repo.status.ahead === 1 ? '' : 's' }} waiting to be pushed</span>
          <button type="button" class="btn btn-primary" :disabled="!!busy[repo.id]" @click="push(repo)">
            <PhCloudArrowUp :size="15" aria-hidden="true" />{{ busy[repo.id] === 'push' ? 'Pushing…' : 'Push' }}
          </button>
        </div>

        <p v-if="repoErrors[repo.id]" class="code-repo-error" role="alert">{{ repoErrors[repo.id] }}</p>
        <p v-if="repo.status?.lastCommit" class="code-last-commit">
          Last commit <code>{{ repo.status.lastCommit.hash }}</code> {{ repo.status.lastCommit.subject }}
        </p>
        <p v-else-if="repo.status?.initial" class="code-last-commit">No commits yet</p>
      </article>

      <p v-if="loaded && repos.length === 0" class="releases-empty-state code-empty">
        No folders linked to {{ boardName }} yet. Add a project folder below to see its changes here.
      </p>

      <form class="code-link" @submit.prevent="link">
        <input
          v-model="linkPath"
          type="text"
          placeholder="/Users/you/Projects/my-app"
          aria-label="Absolute path to a project folder"
          autocomplete="off"
          spellcheck="false"
          :disabled="linking"
        />
        <button type="button" class="btn" :disabled="linking" @click="openBrowser">
          <PhFolderOpen :size="15" aria-hidden="true" />Browse…
        </button>
        <button type="submit" class="btn" :disabled="linking || !linkPath.trim()">
          <PhFolderSimplePlus :size="15" aria-hidden="true" />Link folder
        </button>
      </form>
      <p v-if="linkError" class="code-repo-error" role="alert">{{ linkError }}</p>
    </div>

    <Teleport to="body">
      <template v-if="branchMenu && branchRepo">
        <div class="release-new-backdrop" @click="closeBranchMenu"></div>
        <div
          class="column-menu code-branch-menu"
          role="dialog"
          aria-label="Switch branch"
          :style="{ top: branchMenu.top + 'px', left: branchMenu.left + 'px' }"
          @keydown.esc="closeBranchMenu"
        >
          <div class="code-branch-search">
            <input
              ref="branchInput"
              v-model="branchQuery"
              type="text"
              placeholder="Find or create a branch"
              aria-label="Find or create a branch"
              autocomplete="off"
              spellcheck="false"
              @keydown.enter.prevent="onBranchEnter(branchRepo)"
            />
            <button
              type="button"
              class="btn-icon"
              title="Fetch branches from the remote"
              aria-label="Fetch from remote"
              :disabled="!!busy[branchRepo.id]"
              @click="fetchRepo(branchRepo)"
            ><PhCloudArrowDown :size="15" :class="{ spinning: busy[branchRepo.id] === 'fetch' }" /></button>
          </div>
          <p v-if="branchRepo.status?.files.length" class="code-branch-note">
            Your {{ branchRepo.status.files.length }} uncommitted change{{ branchRepo.status.files.length === 1 ? '' : 's' }} come with you. Git stops if they'd clash with the other branch.
          </p>
          <p v-if="branchError" class="code-repo-error code-branch-note" role="alert">{{ branchError }}</p>
          <div class="code-branch-list">
            <p v-if="!branches && !branchError" class="code-branch-empty">Loading branches…</p>
            <template v-if="branches">
              <span v-if="branchMatches.local.length" class="folder-roots-heading">Local</span>
              <button
                v-for="b in branchMatches.local"
                :key="b.name"
                type="button"
                :class="{ current: b.name === branches.current }"
                :disabled="b.name === branches.current"
                @click="switchBranch(branchRepo, b.name, 'local')"
              >
                <PhCheck v-if="b.name === branches.current" :size="14" weight="bold" aria-hidden="true" />
                <PhGitBranch v-else :size="14" aria-hidden="true" />
                <span class="code-branch-name">{{ b.name }}</span>
                <small v-if="b.upstream">{{ b.upstream }}</small>
              </button>
              <span v-if="branchMatches.remote.length" class="folder-roots-heading">Remote</span>
              <button
                v-for="name in branchMatches.remote"
                :key="name"
                type="button"
                :title="'Check out ' + name + ' as a local branch'"
                @click="switchBranch(branchRepo, name, 'remote')"
              >
                <PhCloud :size="14" aria-hidden="true" />
                <span class="code-branch-name">{{ name }}</span>
              </button>
              <button
                v-if="canCreateBranch"
                type="button"
                class="code-branch-create"
                @click="switchBranch(branchRepo, branchQuery.trim(), 'create')"
              >
                <PhPlus :size="14" weight="bold" aria-hidden="true" />
                <span class="code-branch-name">Create <strong>{{ branchQuery.trim() }}</strong></span>
                <small v-if="branches.current">from {{ branches.current }}</small>
              </button>
              <p v-if="!branchMatches.local.length && !branchMatches.remote.length && !canCreateBranch" class="code-branch-empty">No branches yet</p>
            </template>
          </div>
        </div>
      </template>
    </Teleport>

    <dialog ref="browseEl" v-modal="{ sizeKey: 'folders' }" class="folder-dialog" aria-labelledby="folder-dialog-title">
      <div class="dialog-form">
        <h2 id="folder-dialog-title">Choose a project folder</h2>
        <div class="folder-browser">
          <nav class="folder-roots" aria-label="Places">
            <button
              v-for="root in localRoots"
              :key="root.path"
              type="button"
              :class="{ active: activeRoot === root.path }"
              :title="root.path"
              @click="browseTo(root.path)"
            ><component :is="ROOT_ICONS[root.kind]" :size="15" aria-hidden="true" />{{ root.label }}</button>
            <template v-if="wslRoots.length">
              <span class="folder-roots-heading">WSL</span>
              <button
                v-for="root in wslRoots"
                :key="root.path"
                type="button"
                :class="{ active: activeRoot === root.path }"
                :title="root.path"
                @click="browseTo(root.path)"
              ><PhLinuxLogo :size="15" aria-hidden="true" />{{ root.label }}</button>
            </template>
          </nav>
          <div class="folder-main">
            <form class="folder-path" @submit.prevent="browseTo(browsePath)">
              <button
                type="button"
                class="btn-icon"
                title="Up one folder"
                aria-label="Up one folder"
                :disabled="!listing?.parent || browsing"
                @click="listing?.parent && browseTo(listing.parent)"
              ><PhArrowUp :size="15" /></button>
              <input v-model="browsePath" type="text" aria-label="Folder path" spellcheck="false" autocomplete="off" />
            </form>
            <ul class="folder-list" :aria-busy="browsing">
              <li v-for="folder in listing?.folders ?? []" :key="folder.path" :class="{ repo: folder.repo }">
                <button type="button" class="folder-open" :title="folder.path" @click="browseTo(folder.path)">
                  <PhGitBranch v-if="folder.repo" :size="15" aria-hidden="true" />
                  <PhFolder v-else :size="15" aria-hidden="true" />
                  <span>{{ folder.name }}</span>
                </button>
                <button v-if="folder.repo" type="button" class="btn folder-link" :disabled="linking" @click="link(folder.path)">Link</button>
              </li>
              <li v-if="listing && !listing.folders.length" class="folder-empty">No folders here</li>
              <li v-if="listing?.truncated" class="folder-empty">Showing the first {{ listing.folders.length }} folders. Type a path to go deeper.</li>
            </ul>
            <p v-if="browseError || linkError" class="code-repo-error" role="alert">{{ browseError || linkError }}</p>
          </div>
        </div>
        <div class="dialog-actions">
          <span class="folder-status">
            <template v-if="listing?.repo"><PhGitBranch :size="13" aria-hidden="true" />This folder is a git repository</template>
            <template v-else>Folders with <PhGitBranch :size="13" aria-label="git" /> are repositories</template>
          </span>
          <span class="spacer"></span>
          <button type="button" class="btn" @click="requestDialogClose(browseEl)">Cancel</button>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="!listing || linking"
            :title="listing?.repo ? undefined : 'Links the repository this folder belongs to'"
            @click="listing && link(listing.path)"
          ><PhFolderSimplePlus :size="15" aria-hidden="true" />Link this folder</button>
        </div>
      </div>
    </dialog>

    <dialog ref="discardEl" v-modal class="release-dialog code-discard-dialog" aria-labelledby="code-discard-title" @close="discardId = null">
      <form v-if="discardRepo" method="dialog" class="dialog-form" @submit.prevent="submitDiscard">
        <h2 id="code-discard-title">Discard changes in {{ discardRepo.name }}?</h2>
        <p class="release-dialog-schedule">
          Every edit since the last commit is lost. This can't be undone.
        </p>
        <ul v-if="discardTracked.length" class="code-files code-files-dialog">
          <li v-for="file in discardTracked" :key="file.path">
            <code class="code-file-status" :data-code="fileCode(file)">{{ fileCode(file) }}</code>
            <span class="code-file-path">{{ file.path }}</span>
          </li>
        </ul>
        <template v-if="discardNew.length">
          <label class="checkbox-row">
            <input v-model="discardUntracked" type="checkbox" />
            Also delete {{ discardNew.length }} new file{{ discardNew.length === 1 ? '' : 's' }} git isn't tracking
          </label>
          <ul class="code-files code-files-dialog" :class="{ muted: !discardUntracked }">
            <li v-for="file in discardNew" :key="file.path">
              <code class="code-file-status" data-code="?">?</code>
              <span class="code-file-path">{{ file.path }}</span>
            </li>
          </ul>
        </template>
        <div class="dialog-actions">
          <span class="spacer"></span>
          <button type="button" class="btn" @click="requestDialogClose(discardEl)">Cancel</button>
          <button
            type="submit"
            class="btn btn-danger"
            :disabled="!discardTracked.length && !discardUntracked"
          ><PhTrash :size="15" aria-hidden="true" />Discard</button>
        </div>
      </form>
    </dialog>
  </section>
</template>
