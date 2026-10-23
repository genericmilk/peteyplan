<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { confirmDialog, requestDialogClose, vModal } from '~/composables/useModal'
import { menuPosition, vDismiss } from '~/composables/useDropdown'
import { joinRepoPath, useEditors } from '~/composables/useEditors'
import {
  PhArrowUp,
  PhArrowsClockwise,
  PhCaretDown,
  PhArrowDown,
  PhCheck,
  PhCheckCircle,
  PhCloud,
  PhCloudArrowDown,
  PhCloudArrowUp,
  PhDesktopTower,
  PhFolder,
  PhFolderOpen,
  PhFolderSimplePlus,
  PhGitBranch,
  PhGitCommit,
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
  /** A file was clicked with no editor set up yet */
  configureEditors: []
}>()

const POLL_MS = 30_000

const git = ref<{ available: boolean; version: string | null } | null>(null)
const repos = ref<Repo[]>([])
const loaded = ref(false)
const refreshing = ref(false)
type Action = 'commit' | 'push' | 'pull' | 'discard' | 'refresh' | 'switch' | 'fetch'
const busy = ref<Record<string, Action | undefined>>({})
const messages = ref<Record<string, string>>({})
const repoErrors = ref<Record<string, string>>({})
const browseOpen = ref(false)
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

function pull(repo: Repo) {
  return runAction(repo, 'pull', () => call<Repo>(`/api/repos/${repo.id}/pull`, { method: 'POST' }))
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

async function link(chosen: string) {
  const folder = chosen.trim()
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
    browseEl.value?.close()
  } catch (err) {
    linkError.value = err instanceof Error ? err.message : 'Could not link that folder'
  } finally {
    linking.value = false
  }
}

/** Paths match ignoring trailing slashes and case, so Windows and WSL paths compare too. */
function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  return !!a && !!b && norm(a) === norm(b)
}

function isLinked(folder: string): boolean {
  return repos.value.some((repo) => samePath(repo.path, folder))
}

function baseName(file: string): string {
  return file.split('/').pop() || file
}

function dirName(file: string): string {
  const at = file.lastIndexOf('/')
  return at > 0 ? file.slice(0, at) : ''
}

/* ── Open in editor ─────────────────────────────────────────────────────────── */

const { editors, defaultEditor, openInEditor } = useEditors()
const openWith = ref<{ top: number; right: number; path: string } | null>(null)

function canOpen(file: GitFile): boolean {
  return fileCode(file) !== 'D'
}

function openTitle(file: GitFile): string {
  if (!canOpen(file)) return 'Deleted, so there is nothing to open'
  return defaultEditor.value ? `Open in ${defaultEditor.value.name}` : 'Choose an editor to open files in'
}

function openRepoTitle(): string {
  return defaultEditor.value ? `Open the folder in ${defaultEditor.value.name}` : 'Choose an editor to open folders in'
}

function openPath(path: string) {
  if (!defaultEditor.value) return emit('configureEditors')
  openInEditor(defaultEditor.value, path)
}

function openRepo(repo: Repo) {
  openPath(joinRepoPath(repo.path, ''))
}

function openFile(repo: Repo, file: GitFile) {
  if (canOpen(file)) openPath(joinRepoPath(repo.path, file.path))
}

function toggleOpenWith(event: MouseEvent, path: string) {
  openWith.value = openWith.value?.path === path
    ? null
    : { ...menuPosition(event.currentTarget as Element, 'right', 200) as { top: number; right: number }, path }
}

function openWithEditor(id: string) {
  const editor = editors.value.find((entry) => entry.id === id)
  const target = openWith.value
  openWith.value = null
  if (editor && target) openInEditor(editor, target.path)
}

const STATUS_LABELS: Record<string, string> = {
  M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', T: 'Type changed', '?': 'New file',
}

function fileCode(file: GitFile): string {
  if (file.untracked) return '?'
  if (file.index === 'U' || file.worktree === 'U') return 'U'
  return file.worktree !== '.' ? file.worktree : file.index
}

/** One chip per kind of change, e.g. "3 modified", "1 new". */
function changeChips(status: GitStatus): { code: string; label: string; title: string }[] {
  const counts = new Map<string, number>()
  for (const file of status.files) {
    const code = fileCode(file)
    counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  return [...counts].map(([code, n]) => {
    const name = (STATUS_LABELS[code] ?? 'Changed').toLowerCase().replace('new file', 'new')
    return { code, label: `${n} ${name}`, title: `${n} ${STATUS_LABELS[code] ?? 'changed'}` }
  })
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
  browseOpen.value = true
  browseEl.value?.showModal()
  // Start where you left off, else home.
  await browseTo(listing.value?.path ?? '')
}

defineExpose({ openBrowser })

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
      <div class="code-header-actions">
        <button
          type="button"
          class="btn"
          :disabled="refreshing"
          title="Check every folder again"
          @click="refresh"
        ><PhArrowsClockwise :size="15" :class="{ spinning: refreshing }" aria-hidden="true" />Refresh</button>
        <button v-if="git?.available !== false" type="button" class="btn btn-primary" @click="openBrowser">
          <PhFolderSimplePlus :size="15" aria-hidden="true" />Link repo
        </button>
      </div>
    </div>

    <div v-if="git && !git.available" class="code-unavailable">
      <strong>Git isn't available to the server.</strong>
      Run PeteyPlan directly on your machine (<code>npm run dev</code>), or start Docker with
      <code>docker compose -f docker-compose.yml -f docker-compose.git.yml up -d --build</code>
      so the container has git and can see your code folder.
    </div>

    <div v-else class="code-repos">
      <p v-if="linkError && !browseOpen" class="code-repo-error" role="alert">{{ linkError }}</p>

      <article v-for="repo in repos" :key="repo.id" class="code-repo" :class="{ attention: needsAttention(repo.status) }">
        <header class="code-repo-head">
          <span class="code-repo-icon" aria-hidden="true"><PhFolderOpen :size="18" /></span>
          <div class="code-repo-name">
            <h3>
              <button type="button" class="code-repo-open" :title="repo.path + '\n' + openRepoTitle()" @click="openRepo(repo)">{{ repo.name }}</button>
              <button
                v-if="editors.length > 1"
                type="button"
                class="code-file-with"
                :aria-label="'Open ' + repo.name + ' with…'"
                title="Open with…"
                aria-haspopup="menu"
                @click="toggleOpenWith($event, joinRepoPath(repo.path, ''))"
              ><PhCaretDown :size="11" weight="bold" aria-hidden="true" /></button>
            </h3>
            <span class="code-repo-path" :title="repo.path">{{ repo.path }}</span>
          </div>
          <button
            type="button"
            class="btn-icon"
            title="Check again"
            aria-label="Check again"
            :disabled="!!busy[repo.id]"
            @click="refreshRepo(repo)"
          ><PhArrowsClockwise :size="15" :class="{ spinning: busy[repo.id] === 'refresh' }" /></button>
          <button type="button" class="btn-icon danger" title="Unlink folder" aria-label="Unlink folder" @click="unlink(repo)"><PhLinkBreak :size="15" /></button>
        </header>

        <div v-if="repo.status" class="code-repo-meta">
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
            <PhGitBranch :size="13" aria-hidden="true" />
            <span class="code-branch-label">{{ busy[repo.id] === 'switch' ? 'Switching…' : repo.status.branch ?? 'detached' }}</span>
            <PhCaretDown :size="10" weight="bold" aria-hidden="true" />
          </button>
          <span v-if="repo.status.ahead" class="code-sync code-ahead" :title="repo.status.ahead + ' commit(s) not pushed'"><PhArrowUp :size="11" weight="bold" aria-hidden="true" />{{ repo.status.ahead }} to push</span>
          <button
            v-if="repo.status.behind"
            type="button"
            class="code-sync code-behind code-pull"
            :disabled="!!busy[repo.id] || !repo.status.upstream"
            :title="'Pull ' + repo.status.behind + ' commit' + (repo.status.behind === 1 ? '' : 's') + ' from ' + repo.status.upstream + ' (fast-forward only)'"
            @click="pull(repo)"
          >
            <PhArrowDown :size="11" weight="bold" aria-hidden="true" />{{ busy[repo.id] === 'pull' ? 'Pulling…' : repo.status.behind + ' behind' }}
          </button>
          <span class="spacer"></span>
          <span v-for="chip in changeChips(repo.status)" :key="chip.code" class="code-chip" :data-code="chip.code" :title="chip.title">{{ chip.label }}</span>
          <span v-if="!repo.status.files.length" class="code-chip code-chip-clean"><PhCheck :size="11" weight="bold" aria-hidden="true" />Clean</span>
        </div>

        <p v-if="repo.error" class="code-repo-error">{{ repo.error }}</p>

        <ul v-if="repo.status?.files.length" class="code-files">
          <li v-for="file in repo.status.files" :key="file.path">
            <button
              type="button"
              class="code-file-open"
              :disabled="!canOpen(file)"
              :title="(file.from ? file.from + ' → ' : '') + file.path + '\n' + openTitle(file)"
              @click="openFile(repo, file)"
            >
              <code class="code-file-status" :data-code="fileCode(file)" :aria-label="STATUS_LABELS[fileCode(file)]">{{ fileCode(file) }}</code>
              <span class="code-file-name">{{ baseName(file.path) }}</span>
              <span class="code-file-dir">
                <template v-if="file.from">from {{ file.from }}</template>
                <template v-else>{{ dirName(file.path) }}</template>
              </span>
            </button>
            <button
              v-if="editors.length > 1 && canOpen(file)"
              type="button"
              class="code-file-with"
              :aria-label="'Open ' + baseName(file.path) + ' with…'"
              title="Open with…"
              aria-haspopup="menu"
              @click="toggleOpenWith($event, joinRepoPath(repo.path, file.path))"
            ><PhCaretDown :size="11" weight="bold" aria-hidden="true" /></button>
          </li>
        </ul>
        <div v-else-if="repo.status" class="code-clean">
          <PhCheckCircle :size="22" aria-hidden="true" />
          <span>{{ repo.status.ahead ? 'Everything is committed' : 'Nothing to commit' }}</span>
        </div>

        <p v-if="repoErrors[repo.id]" class="code-repo-error" role="alert">{{ repoErrors[repo.id] }}</p>

        <footer class="code-repo-foot">
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
              type="button"
              class="btn btn-danger"
              :disabled="!!busy[repo.id]"
              @click="confirmDiscard(repo)"
            ><PhTrash :size="15" aria-hidden="true" />Discard…</button>
            <button
              type="submit"
              class="btn btn-primary"
              :disabled="!!busy[repo.id] || !(messages[repo.id] || '').trim()"
            ><PhCloudArrowUp :size="15" aria-hidden="true" />{{ busy[repo.id] === 'commit' ? 'Pushing…' : 'Commit & push' }}</button>
          </form>
          <div v-else-if="repo.status?.ahead" class="code-commit">
            <span class="code-note">{{ repo.status.ahead }} commit{{ repo.status.ahead === 1 ? '' : 's' }} waiting to be pushed</span>
            <button type="button" class="btn btn-primary" :disabled="!!busy[repo.id]" @click="push(repo)">
              <PhCloudArrowUp :size="15" aria-hidden="true" />{{ busy[repo.id] === 'push' ? 'Pushing…' : 'Push' }}
            </button>
          </div>
          <p v-if="repo.status?.lastCommit" class="code-last-commit">
            <PhGitCommit :size="13" aria-hidden="true" />
            <code>{{ repo.status.lastCommit.hash }}</code>
            <span>{{ repo.status.lastCommit.subject }}</span>
          </p>
          <p v-else-if="repo.status?.initial" class="code-last-commit">No commits yet</p>
        </footer>
      </article>

      <div v-if="loaded && repos.length === 0" class="releases-empty-state code-empty">
        <span>No repos linked to {{ boardName }} yet. Link a project folder to see its changes, switch branches and push from here.</span>
        <button type="button" class="btn btn-primary" @click="openBrowser"><PhFolderSimplePlus :size="15" aria-hidden="true" />Link repo</button>
      </div>
    </div>

    <Teleport to="body">
      <template v-if="branchMenu && branchRepo">
        <div class="release-new-backdrop" @click="closeBranchMenu"></div>
        <div
          v-dismiss="closeBranchMenu"
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

    <dialog
      ref="browseEl"
      v-modal="{ sizeKey: 'folders' }"
      class="folder-dialog"
      aria-labelledby="folder-dialog-title"
      @close="browseOpen = false"
    >
      <div class="dialog-form">
        <h2 id="folder-dialog-title">Link a repo to {{ boardName }}</h2>
        <div class="folder-browser">
          <nav class="folder-roots" aria-label="Places">
            <span class="folder-roots-heading">Places</span>
            <button
              v-for="root in localRoots"
              :key="root.path"
              type="button"
              :class="{ active: activeRoot === root.path }"
              :title="root.path"
              @click="browseTo(root.path)"
            ><component :is="ROOT_ICONS[root.kind]" :size="15" aria-hidden="true" /><span>{{ root.label }}</span></button>
            <template v-if="wslRoots.length">
              <span class="folder-roots-heading">WSL</span>
              <button
                v-for="root in wslRoots"
                :key="root.path"
                type="button"
                :class="{ active: activeRoot === root.path }"
                :title="root.path"
                @click="browseTo(root.path)"
              ><PhLinuxLogo :size="15" aria-hidden="true" /><span>{{ root.label }}</span></button>
            </template>
            <template v-if="repos.length">
              <span class="folder-roots-heading">Linked here</span>
              <button
                v-for="repo in repos"
                :key="repo.id"
                type="button"
                class="folder-root-linked"
                :class="{ active: samePath(listing?.path, repo.path) }"
                :title="repo.path"
                @click="browseTo(repo.path)"
              ><PhCheckCircle :size="15" weight="fill" aria-hidden="true" /><span>{{ repo.name }}</span></button>
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
              <input v-model="browsePath" type="text" aria-label="Folder path, press Enter to go there" placeholder="Type a path and press Enter" spellcheck="false" autocomplete="off" />
            </form>
            <ul class="folder-list" :aria-busy="browsing">
              <li
                v-for="folder in listing?.folders ?? []"
                :key="folder.path"
                :class="{ repo: folder.repo, linked: isLinked(folder.path) }"
              >
                <button type="button" class="folder-open" :title="folder.path" @click="browseTo(folder.path)">
                  <PhGitBranch v-if="folder.repo" :size="16" aria-hidden="true" />
                  <PhFolder v-else :size="16" aria-hidden="true" />
                  <span class="folder-name">{{ folder.name }}</span>
                  <span v-if="folder.repo && !isLinked(folder.path)" class="folder-tag">Git repo</span>
                </button>
                <span v-if="isLinked(folder.path)" class="folder-linked-tag"><PhCheck :size="12" weight="bold" aria-hidden="true" />Linked</span>
                <button v-else-if="folder.repo" type="button" class="btn folder-link" :disabled="linking" @click="link(folder.path)">Link</button>
              </li>
              <li v-if="listing && !listing.folders.length" class="folder-empty">No folders here</li>
              <li v-if="listing?.truncated" class="folder-empty">Showing the first {{ listing.folders.length }} folders. Type a path to go deeper.</li>
            </ul>
            <p v-if="browseError || linkError" class="code-repo-error" role="alert">{{ browseError || linkError }}</p>
          </div>
        </div>
        <div class="dialog-actions">
          <span class="folder-status" :class="{ 'folder-status-linked': listing && isLinked(listing.path) }">
            <template v-if="listing && isLinked(listing.path)"><PhCheckCircle :size="14" weight="fill" aria-hidden="true" />Already linked to {{ boardName }}</template>
            <template v-else-if="listing?.repo"><PhGitBranch :size="13" aria-hidden="true" />This folder is a git repo</template>
            <template v-else>Open a folder marked <PhGitBranch :size="13" aria-label="git" /> to link it</template>
          </span>
          <span class="spacer"></span>
          <button type="button" class="btn" @click="requestDialogClose(browseEl)">Cancel</button>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="!listing || linking || isLinked(listing.path)"
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
    <Teleport v-if="openWith" to="body">
      <div class="release-new-backdrop" @click="openWith = null"></div>
      <div
        v-dismiss="() => { openWith = null }"
        class="column-menu code-open-with-menu"
        role="menu"
        :style="{ top: openWith.top + 'px', right: openWith.right + 'px' }"
      >
        <button v-for="editor in editors" :key="editor.id" type="button" role="menuitem" @click="openWithEditor(editor.id)">
          {{ editor.name }}<small v-if="editor.id === defaultEditor?.id">Default</small>
        </button>
      </div>
    </Teleport>
  </section>
</template>
