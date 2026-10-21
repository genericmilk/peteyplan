<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  PhArchive,
  PhArrowDown,
  PhArrowLeft,
  PhArrowRight,
  PhArrowUp,
  PhCards,
  PhCaretDown,
  PhCheck,
  PhColumns,
  PhDotsSixVertical,
  PhDotsThreeVertical,
  PhFunnel,
  PhGear,
  PhLink,
  PhListChecks,
  PhMagnifyingGlass,
  PhMoon,
  PhPencilSimple,
  PhPlus,
  PhRocketLaunch,
  PhSliders,
  PhSquaresFour,
  PhSun,
  PhTrash,
  PhX,
} from '@phosphor-icons/vue'
import {
  ARCHIVE_AFTER_DAYS,
  DEFAULT_PROGRESS,
  FIRST_STAGE,
  KIND_LABEL_MAX_LENGTH,
  KINDS_MAX,
  LAST_STAGE,
  STAGE_LABEL_MAX_LENGTH,
  STAGES_MAX,
  cardKinds,
  defaultKind,
  isKindId,
  isProgressForKind,
  kindDef,
  normalizeKind,
  normalizeProgress,
  progressForKindChange,
  progressIndex,
  stagesForKind,
  useCardKinds,
  type KindDef,
  type KindId,
  type ProgressId,
} from '~/shared/progress'
import {
  CHECKLIST_ITEM_MAX_LENGTH,
  checklistProgress,
  newChecklistItem,
  normalizeChecklist,
  type ChecklistItem,
} from '~/shared/checklist'
import { accentPalette } from '~/shared/accent'
import type { PaletteItem } from '~/components/CommandPalette.vue'
import {
  SHARE_HASH_KEY,
  decodeSharedCard,
  encodeSharedCard,
  shareTokenFrom,
  type SharedCard,
} from '~/shared/share'
import {
  DENSITY_OPTIONS,
  MOTION_OPTIONS,
  SURFACE_OPTIONS,
  THEME_OPTIONS,
  initPreferences,
  usePreferences,
} from '~/composables/usePreferences'

interface Card {
  id: string
  number: number
  ref: string
  title: string
  description: string
  jiraKey?: string
  dueBy?: string
  kind?: KindId
  progress?: ProgressId
  completedAt?: string | null
  /** ISO datetime when opened in the UI; null/undefined = unopened (show unread dot) */
  viewedAt?: string | null
  releaseId?: string | null
  columnId?: string
  checklist?: ChecklistItem[]
}
interface Column { id: string; title: string; cards: Card[] }
interface Release {
  id: string
  title: string
  weekStart: string
  preprodSchedule: string
  prodSchedule: string
  preprodKey: string
  prodKey: string
  cards: Card[]
}
interface Board { columns: Column[]; releases: Release[] }
interface BoardInfo { id: string; name: string; emoji: string; color: string; isDefault: boolean }
interface ArchivedCard {
  id: string
  number: number
  ref: string
  title: string
  description: string
  jiraKey: string
  dueBy: string
  kind: KindId
  progress: ProgressId
  completedAt: string | null
  archivedAt: string | null
  columnId: string
  columnTitle: string | null
  checklist?: ChecklistItem[]
}

type TextPart = { type: 'text'; value: string } | { type: 'jira'; key: string }
type DueTone = 'none' | 'overdue' | 'today' | 'upcoming'

function todayIso(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function dueTone(dueBy?: string): DueTone {
  if (!dueBy) return 'none'
  const today = todayIso()
  if (dueBy < today) return 'overdue'
  if (dueBy === today) return 'today'
  return 'upcoming'
}

function formatDueBy(dueBy: string): string {
  const [y, m, d] = dueBy.split('-').map(Number)
  if (!y || !m || !d) return dueBy
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

const JIRA_BROWSE_BASE = 'https://kycglobal.atlassian.net/browse'
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g
const JIRA_URL_RE =
  /https?:\/\/kycglobal\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/gi
const PREPROD_HINT = 'Monday 17:00'
const PROD_HINT = 'Tuesday 17:00'

function jiraBrowseUrl(key: string) {
  return `${JIRA_BROWSE_BASE}/${key}`
}

/** Normalize a bare key or pasted browse URL to uppercase KEY, or ''. */
function normalizeJiraKey(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  const fromUrl = trimmed.match(
    /https?:\/\/kycglobal\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/i
  )
  if (fromUrl) return fromUrl[1].toUpperCase()
  if (/^[A-Z][A-Z0-9]+-\d+$/i.test(trimmed)) return trimmed.toUpperCase()
  const embedded = trimmed.toUpperCase().match(/[A-Z][A-Z0-9]+-\d+/)
  return embedded ? embedded[0] : ''
}

/** Split text into plain segments and clickable Jira keys / browse URLs. */
function linkifyJira(text: string): TextPart[] {
  if (!text) return []
  const combined = new RegExp(
    `${JIRA_URL_RE.source}|${JIRA_KEY_RE.source}`,
    'gi'
  )
  const parts: TextPart[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = combined.exec(text)) !== null) {
    if (match.index > last) {
      parts.push({ type: 'text', value: text.slice(last, match.index) })
    }
    const key = (match[1] || match[2] || match[0]).toUpperCase()
    parts.push({ type: 'jira', key })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) })
  return parts.length ? parts : [{ type: 'text', value: text }]
}
/* ── Markdown descriptions (read-only views) ──────────────────────────────── */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const MD_SLOT_RE = /(\u0000\d+\u0000)/g

function mdSlot(slots: string[], html: string): string {
  slots.push(html)
  return `\u0000${slots.length - 1}\u0000`
}

/** Inline spans (bold, italic, strike) + Jira keys on escaped text; slots stay opaque. */
function renderDescInline(s: string, slots: string[], links = true): string {
  s = s.replace(/\*\*\*([^*<>\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*([^*<>\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__([^_<>\n]+)__/g, '<strong>$1</strong>')
  // Single-char emphasis needs non-word chars on both sides (2*3*4, foo_bar,
  // 5 * 3 stay literal). Escaped entities (&quot; …) are non-word, so no
  // special-casing needed. Lookahead keeps trailing punctuation unconsumed.
  s = s.replace(/(^|[^\w*])\*([^*<>\n]+)\*(?=[^\w*]|$)/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^\w_])_([^_<>\n]+)_(?=[^\w_]|$)/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~<>\n]+)~~/g, '<del>$1</del>')
  // links=false (link text): jira pass skipped, no nested anchors.
  // Slot segments always pass through untouched either way.
  if (links) {
    const jira = new RegExp(`${JIRA_URL_RE.source}|${JIRA_KEY_RE.source}`, 'gi')
    s = s
      .split(MD_SLOT_RE)
      .map((seg, i) =>
        i % 2 === 1
          ? seg
          : seg.replace(jira, (m: string, fromUrl?: string, bare?: string) => {
              const key = (fromUrl || bare || m).toUpperCase()
              return mdSlot(
                slots,
                `<a class="jira-link" href="${jiraBrowseUrl(key)}" target="_blank" rel="noopener noreferrer">${key}</a>`
              )
            })
      )
      .join('')
  }
  return s.replace(/\n/g, '<br>')
}
/** Render description markdown to safe HTML (all user text escaped first). */
function renderDescHtml(input: string): string {
  if (!input) return ''
  const slots: string[] = []
  // Peel trailing punctuation off an HTML-escaped URL match. Entities
  // (&quot; &gt; …) peel first — otherwise the ';' would be eaten as punctuation.
  // A ')' only peels when it unbalances the URL's own parens.
  const trimUrlTail = (raw: string): [string, string] => {
    let url = raw
    let trail = ''
    for (;;) {
      const ent = url.match(/&(quot|#39|gt|lt|amp);$/)
      if (ent) {
        trail = ent[0] + trail
        url = url.slice(0, -ent[0].length)
        continue
      }
      const ch = url.match(/[.,;:!?)\]}'"]$/)
      if (!ch) break
      // Balanced parens: keep the ')' that closes a '(' inside the URL.
      if (ch[0] === ')') {
        const open = (url.match(/\(/g) ?? []).length
        const close = (url.match(/\)/g) ?? []).length
        if (close <= open) break
      }
      trail = ch[0] + trail
      url = url.slice(0, -1)
    }
    return [url, trail]
  }
  const inline = (t: string) => renderDescInline(t, slots)
  let s = escapeHtml(input)
  // Fenced code blocks: opener/closer must be full lines (```info … ```).
  // Mid-line ``` stays inline code. Padded with blank lines so the slot
  // always forms its own block (<pre> inside <p> is invalid).
  // (?![\s\S]) is absolute end-of-input ($ matches at every line end here).
  s = s.replace(/^[ ]{0,3}```[^`\n]*\n([\s\S]*?)(?:^[ ]{0,3}```[ \t]*$|(?![\s\S]))/gm, (_m: string, code: string) =>
    `\n\n${mdSlot(slots, `<pre class="md-pre"><code>${code.replace(/^\n+|\n+$/g, '')}</code></pre>`)}\n\n`
  )
  // Inline code (matching backtick runs: `x`, ``x``, ```x```).
  s = s.replace(/(`{1,3})([^`\n]+?)\1/g, (_m: string, _ticks: string, code: string) =>
    mdSlot(slots, `<code class="md-code">${code}</code>`)
  )
  // Explicit links [text](https://…); other schemes left literal. Link text gets
  // inline spans (no nested links); trailing URL punctuation stays outside.
  // Inner code slots resolve before the outer slot (final pass is single-level).
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s<]+)\)/g, (_m: string, text: string, rawUrl: string) => {
    const [url, trail] = trimUrlTail(rawUrl)
    if (!url) return _m
    const inner = renderDescInline(text, slots, false)
      .split(MD_SLOT_RE)
      .map((seg, i) => (i % 2 === 1 ? slots[Number(seg.slice(1, -1))] ?? '' : seg))
      .join('')
    return mdSlot(slots, `<a class="md-link" href="${url}" target="_blank" rel="noopener noreferrer">${inner}</a>`) + trail
  })
  // Jira browse URLs keep the existing key-style link.
  s = s.replace(JIRA_URL_RE, (m: string, key?: string) =>
    mdSlot(
      slots,
      `<a class="jira-link" href="${jiraBrowseUrl((key || m).toUpperCase())}" target="_blank" rel="noopener noreferrer">${(key || m).toUpperCase()}</a>`
    )
  )
  // Bare URLs (explicit links + Jira URLs already slotted; split keeps slots opaque).
  // url stays HTML-escaped: correct in both href and display.
  s = s
    .split(MD_SLOT_RE)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(/https?:\/\/[^\s<]+/g, (m: string) => {
            const [url, trail] = trimUrlTail(m)
            if (!url) return m
            return mdSlot(slots, `<a class="md-link" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`) + trail
          })
    )
    .join('')
  const html = s
    .split(/\n{2,}/)
    .filter((block) => block.trim() !== '')
    .map((block) => {
      // Slot-only blocks (fenced code) render unwrapped: <pre> inside <p> is invalid.
      const solo = block.trim().match(/^\u0000(\d+)\u0000$/)
      if (solo && slots[Number(solo[1])]?.startsWith('<pre')) return block.trim()
      const lines = block.split('\n')
      const heading = lines[0].trim().match(/^(#{1,6})\s+(.*?)\s*$/)
      if (heading && heading[2]) {
        const rest = lines.slice(1).join('\n').trim()
        return (
          `<div class="md-h md-h${heading[1].length}">${inline(heading[2])}</div>` +
          (rest ? `<p class="md-p">${inline(rest)}</p>` : '')
        )
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(block)) return '<hr class="md-hr">'
      if (lines.every((l) => /^\s*&gt;/.test(l))) {
        return `<blockquote class="md-quote">${inline(lines.map((l) => l.replace(/^\s*&gt;\s?/, '')).join('\n'))}</blockquote>`
      }
      const ul = lines.every((l) => /^\s*[-*•]\s+\S/.test(l))
      const ol = lines.every((l) => /^\s*\d{1,9}[.)]\s+\S/.test(l))
      if (ul || ol) {
        const items = lines.map((l) => inline(l.replace(/^\s*(?:[-*•]|\d{1,9}[.)])\s+/, '')))
        const lis = items.map((item) => `<li>${item}</li>`).join('')
        return ul ? `<ul class="md-list">${lis}</ul>` : `<ol class="md-olist">${lis}</ol>`
      }
      return `<p class="md-p">${inline(block)}</p>`
    })
    .join('')
  return html
    .split(MD_SLOT_RE)
    .map((seg, i) => (i % 2 === 1 ? slots[Number(seg.slice(1, -1))] ?? '' : seg))
    .join('')
}

/* ── State ─────────────────────────────────────────────────────────────────── */

const { prefs, resolvedTheme, motionFactor, toggleTheme } = usePreferences()

/** Favicon SVG source, recoloured to the active board once loaded on the client. */
const faviconTemplate = ref<string | null>(null)
const brandInk = ref<string | null>(null)
const FAVICON_TEMPLATE_COLOR = /#3565e0/gi

useHead(() => ({
  link: [{
    key: 'peteyplan-favicon',
    id: 'peteyplan-favicon',
    rel: 'icon',
    type: 'image/svg+xml',
    href: import.meta.server
      ? '/favicon.svg'
      : faviconTemplate.value && brandInk.value
        ? 'data:image/svg+xml,' + encodeURIComponent(faviconTemplate.value.replace(FAVICON_TEMPLATE_COLOR, brandInk.value))
        : `/favicon-${resolvedTheme.value}.svg`,
  }],
}))

const board = ref<Board>({ columns: [], releases: [] })
const boards = ref<BoardInfo[]>([])
const activeBoardId = ref('board-default')
const activeBoard = computed(() => boards.value.find((entry) => entry.id === activeBoardId.value))

// The active board's colour tints the whole UI: ambient backdrop (cross-fades via the
// registered --ambient property), accent palette, nav logo and favicon.
watch([() => activeBoard.value?.color, resolvedTheme], ([color, theme]) => {
  if (!color || typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty('--ambient', color)
  const palette = accentPalette(color, theme)
  if (!palette) return
  for (const [name, value] of Object.entries(palette)) root.style.setProperty(name, value)
  brandInk.value = palette['--brand-ink']
})
const switchingBoardId = ref<string | null>(null)
let boardRequest = 0
let boardRefreshRequest = 0
let cancelBoardPan: (() => void) | null = null
const dragSourceBoardId = ref<string | null>(null)
const dragSourceColumn = ref<Column | null>(null)
const foreignDrag = computed(() => !!dragSourceBoardId.value && dragSourceBoardId.value !== activeBoardId.value)
const loading = ref(true)
const error = ref<string | null>(null)
const searchQuery = ref('')
const releasesOpen = ref(false)
const releaseDropTarget = ref<string | null>(null)
// Seeded from the server's list during SSR and sent in the payload, so the
// first client render matches the server even when types are customised.
const workTypes = useState<KindDef[]>('work-types', () => cardKinds())
// Client only: during SSR the server's own registry must stay in charge.
if (import.meta.client) useCardKinds(() => workTypes.value)

const isSearching = computed(() => searchQuery.value.trim().length > 0)

function cardMatchesQuery(card: Card, q: string): boolean {
  const kind = normalizeKind(card.kind)
  const stage = stagesForKind(kind).find((s) => s.id === normalizeProgress(card.progress, kind))
  const hay = [
    card.title,
    card.description,
    card.ref ?? '',
    card.jiraKey ?? '',
    card.dueBy ?? '',
    card.kind ?? '',
    kindDef(kind).label,
    card.progress ?? '',
    stage?.label ?? '',
    ...(card.checklist ?? []).map((item) => item.text),
  ]
    .join(' ')
    .toLowerCase()
  return hay.includes(q)
}

/** Columns with cards filtered by the live search query (view-only). */
const displayColumns = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  const columns = [...board.value.columns]
  // Keep the native drag source mounted while showing a different board.
  if (foreignDrag.value && dragSourceColumn.value) columns.push(dragSourceColumn.value)
  return columns.map((col) => ({
    ...col,
    parked: foreignDrag.value && col.id === dragSourceColumn.value?.id,
    cards: q ? col.cards.filter((c) => cardMatchesQuery(c, q)) : col.cards,
    totalCount: col.cards.length,
  }))
})

/* ── API client ────────────────────────────────────────────────────────────── */

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  if (/^\/api\/(?:board|archive|columns|releases)(?:\/|$)/.test(url)) {
    url += `${url.includes('?') ? '&' : '?'}boardId=${encodeURIComponent(activeBoardId.value)}`
  }
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
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

function normalizeBoard(data: Board): Board {
  return {
    columns: data.columns || [],
    releases: data.releases || [],
  }
}

async function loadBoard() {
  loading.value = true
  try {
    boards.value = (await api<{ boards: BoardInfo[] }>('/api/boards')).boards
    const saved = localStorage.getItem('peteyplan-board')
    activeBoardId.value = boards.value.find((entry) => entry.id === saved)?.id
      ?? boards.value.find((entry) => entry.isDefault)!.id
    const [kinds, loaded] = await Promise.all([
      api<{ kinds: KindDef[] }>('/api/kinds'),
      api<Board>('/api/board'),
    ])
    workTypes.value = kinds.kinds
    board.value = normalizeBoard(loaded)
    error.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load board'
  } finally {
    loading.value = false
  }
}

async function refreshBoard() {
  const id = activeBoardId.value
  const request = ++boardRefreshRequest
  const switchRequest = boardRequest
  try {
    const data = await api<Board>('/api/board')
    if (id !== activeBoardId.value || request !== boardRefreshRequest || switchRequest !== boardRequest) return
    board.value = normalizeBoard(data)
    error.value = null
  } catch (err) {
    if (id === activeBoardId.value && request === boardRefreshRequest && switchRequest === boardRequest) {
      error.value = err instanceof Error ? err.message : 'Failed to save'
    }
  }
}

/** Total duration of the board-switch slide, shared across every board it passes. */
const BOARD_SWITCH_MS = 100

/** `pulled` is how far an elastic wheel pull already slid the board, so the slide picks up from there. */
async function switchBoard(id: string, pulled = 0) {
  cancelPillHover()
  cancelBoardPan?.()
  resetBoardPull()
  if (id === activeBoardId.value) {
    ++boardRequest
    switchingBoardId.value = null
    return
  }
  const request = ++boardRequest
  switchingBoardId.value = id
  const fromIndex = boards.value.findIndex((entry) => entry.id === activeBoardId.value)
  const toIndex = boards.value.findIndex((entry) => entry.id === id)
  const direction = toIndex > fromIndex ? 1 : -1
  const reduceMotion = motionFactor.value === 0
  const route = fromIndex < 0 || reduceMotion
    ? boards.value.filter((entry) => entry.id === id)
    : boards.value.filter((_, index) => direction > 0
      ? index > fromIndex && index <= toIndex
      : index < fromIndex && index >= toIndex)
  if (direction < 0 && !reduceMotion) route.reverse()
  try {
    const steps = await Promise.all(route.map(async (entry) => ({
      entry,
      data: normalizeBoard(await api<Board>(`/api/board?boardId=${encodeURIComponent(entry.id)}`)),
    })))
    if (request !== boardRequest) return
    closeBoardMenu()
    closeColumnMenu()
    searchQuery.value = ''
    dropIndicator.value = null
    columnDropIndex.value = null
    releaseDropTarget.value = null
    error.value = null
    // The whole switch fits in BOARD_SWITCH_MS: each step gets the time that's left, and
    // intermediate boards are skipped once there isn't enough left to show them.
    const deadline = performance.now() + BOARD_SWITCH_MS * motionFactor.value
    const MIN_STEP_MS = 24
    for (const [index, step] of steps.entries()) {
      if (request !== boardRequest) return
      const stepsLeft = steps.length - index
      if (stepsLeft > 1 && (deadline - performance.now()) / stepsLeft < MIN_STEP_MS) continue
      const el = boardEl.value
      const snapshot = !reduceMotion && el ? el.cloneNode(true) as HTMLElement : null
      if (snapshot && el) {
        snapshot.classList.add('board-pan-snapshot')
        snapshot.setAttribute('aria-hidden', 'true')
        snapshot.inert = true
        snapshot.removeAttribute('aria-label')
        snapshot.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'))
        snapshot.querySelectorAll('.drag-source-parked').forEach((node) => node.remove())
        el.parentElement?.append(snapshot)
        snapshot.scrollLeft = el.scrollLeft
      }
      activeBoardId.value = step.entry.id
      board.value = step.data
      localStorage.setItem('peteyplan-board', step.entry.id)
      await nextTick()
      if (request !== boardRequest) { snapshot?.remove(); return }
      if (el) el.scrollLeft = 0
      if (snapshot && el) {
        const width = el.clientWidth
        const start = index === 0 ? Math.min(pulled, width) : 0
        const duration = Math.max(0, (deadline - performance.now()) / stepsLeft)
        const easing = steps.length === 1 ? 'cubic-bezier(.2,.65,.35,1)'
          : index === 0 ? 'cubic-bezier(.45,0,1,1)'
          : index === steps.length - 1 ? 'cubic-bezier(0,0,.55,1)' : 'linear'
        await new Promise<void>((resolve) => {
          const outgoing = snapshot.animate([
            { transform: `translateX(${-direction * start}px)` },
            { transform: `translateX(${-direction * width}px)` },
          ], { duration, easing, fill: 'forwards' })
          const incoming = el.animate([
            { transform: `translateX(${direction * (width - start)}px)` },
            { transform: 'translateX(0)' },
          ], { duration, easing, fill: 'forwards' })
          const finish = () => {
            outgoing.onfinish = null
            incoming.onfinish = null
            outgoing.cancel()
            incoming.cancel()
            snapshot.remove()
            cancelBoardPan = null
            resolve()
          }
          cancelBoardPan = finish
          incoming.onfinish = finish
        })
      }
    }
  } catch (err) {
    if (request === boardRequest) fail(err)
  }
  finally { if (request === boardRequest) switchingBoardId.value = null }
}

function fail(err: unknown) {
  error.value = err instanceof Error ? err.message : 'Something went wrong'
}

/* ── Lookups ───────────────────────────────────────────────────────────────── */

function findColumn(columnId: string) {
  return board.value.columns.find((c) => c.id === columnId)
}

function findRelease(releaseId: string) {
  return board.value.releases.find((r) => r.id === releaseId)
}

function releaseTitleForCard(card: Card): string | null {
  if (!card.releaseId) return null
  return findRelease(card.releaseId)?.title ?? null
}

function formatWeekDay(weekStart: string, offsetDays: number): string {
  const [y, m, d] = weekStart.split('-').map(Number)
  if (!y || !m || !d) return weekStart
  const date = new Date(y, m - 1, d + offsetDays)
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function toggleReleasesPanel() {
  releasesOpen.value = !releasesOpen.value
}

async function addRelease() {
  try {
    await api('/api/releases', { method: 'POST', body: JSON.stringify({}) })
    await refreshBoard()
    releasesOpen.value = true
  } catch (err) { fail(err) }
}

async function saveRelease(
  releaseId: string,
  title: string,
  weekStart: string,
  preprodKey: string,
  prodKey: string
) {
  const trimmed = title.trim()
  if (!trimmed) return
  try {
    await api(`/api/releases/${releaseId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: trimmed,
        weekStart: weekStart.trim(),
        preprodKey: normalizeJiraKey(preprodKey),
        prodKey: normalizeJiraKey(prodKey),
      }),
    })
    await refreshBoard()
  } catch (err) { fail(err) }
}

async function deleteRelease(releaseId: string) {
  const rel = findRelease(releaseId)
  if (!rel) return
  const count = rel.cards.length
  const message =
    count > 0
      ? `Delete "${rel.title}"? Its ${count} card${count === 1 ? '' : 's'} will stay on the board but leave this release.`
      : `Delete "${rel.title}"?`
  if (!window.confirm(message)) return
  try {
    await api(`/api/releases/${releaseId}`, { method: 'DELETE' })
    await refreshBoard()
  } catch (err) { fail(err) }
}

async function assignCardToRelease(cardId: string, releaseId: string) {
  // Optimistic: mark on board cards + rebuild release card lists locally.
  for (const col of board.value.columns) {
    const card = col.cards.find((c) => c.id === cardId)
    if (card) {
      card.releaseId = releaseId
      break
    }
  }
  syncReleaseCardsFromBoard()
  try {
    await api(`/api/releases/${releaseId}/cards`, {
      method: 'POST',
      body: JSON.stringify({ cardId }),
    })
    await refreshBoard()
  } catch (err) {
    fail(err)
    await refreshBoard()
  }
}

async function removeCardFromRelease(releaseId: string, cardId: string) {
  for (const col of board.value.columns) {
    const card = col.cards.find((c) => c.id === cardId)
    if (card && card.releaseId === releaseId) {
      card.releaseId = null
      break
    }
  }
  syncReleaseCardsFromBoard()
  try {
    await api(`/api/releases/${releaseId}/cards/${cardId}`, { method: 'DELETE' })
    await refreshBoard()
  } catch (err) {
    fail(err)
    await refreshBoard()
  }
}

/** Keep release.cards in sync with column card.releaseId after optimistic edits. */
function syncReleaseCardsFromBoard() {
  const all = board.value.columns.flatMap((c) => c.cards)
  for (const rel of board.value.releases) {
    rel.cards = all.filter((c) => c.releaseId === rel.id)
  }
}

function onReleaseDragOver(event: DragEvent, releaseId: string) {
  if (isSearching.value || foreignDrag.value || !dragged.value || draggedColumnId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  releaseDropTarget.value = releaseId
}

function onReleaseDragLeave(event: DragEvent) {
  const el = event.currentTarget as HTMLElement
  if (!el.contains(event.relatedTarget as Node | null)) {
    if (releaseDropTarget.value) releaseDropTarget.value = null
  }
}

function onReleaseDrop(event: DragEvent, releaseId: string) {
  if (foreignDrag.value) return
  event.preventDefault()
  event.stopPropagation()
  const d = dragged.value
  releaseDropTarget.value = null
  if (d) {
    assignCardToRelease(d.cardId, releaseId)
  }
  finishDrag()
}

/* ── Column actions ────────────────────────────────────────────────────────── */

async function addColumn(title: string) {
  const trimmed = title.trim()
  if (!trimmed) return
  try {
    await api('/api/columns', { method: 'POST', body: JSON.stringify({ title: trimmed }) })
    await refreshBoard()
  } catch (err) { fail(err) }
}

async function renameColumn(columnId: string, title: string) {
  const trimmed = title.trim()
  if (!findColumn(columnId) || !trimmed) return
  try {
    await api(`/api/columns/${columnId}`, { method: 'PATCH', body: JSON.stringify({ title: trimmed }) })
    await refreshBoard()
  } catch (err) { fail(err) }
}

async function deleteColumn(columnId: string) {
  const col = findColumn(columnId)
  if (!col) return
  const count = col.cards.length
  const message =
    count > 0
      ? `Delete "${col.title}"? Its ${count} card${count === 1 ? '' : 's'} will be removed.`
      : `Delete "${col.title}"?`
  if (!window.confirm(message)) return
  try {
    await api(`/api/columns/${columnId}`, { method: 'DELETE' })
    await refreshBoard()
  } catch (err) { fail(err) }
}

async function clearColumnCards(columnId: string) {
  const col = findColumn(columnId)
  if (!col) return
  const count = col.cards.length
  if (count === 0) return
  const message = `Archive all ${count} card${count === 1 ? '' : 's'} in "${col.title}"? You can restore them from Archive.`
  if (!window.confirm(message)) return
  try {
    await api(`/api/columns/${columnId}/cards`, { method: 'DELETE' })
    await refreshBoard()
  } catch (err) { fail(err) }
}

async function swapColumn(columnId: string, direction: -1 | 1) {
  const fromIndex = board.value.columns.findIndex((col) => col.id === columnId)
  if (fromIndex === -1) return
  const toIndex = fromIndex + direction
  if (toIndex < 0 || toIndex >= board.value.columns.length) return
  await moveColumn(columnId, toIndex)
}

/* ── Card actions ──────────────────────────────────────────────────────────── */

async function saveCard(
  columnId: string,
  cardId: string | null,
  title: string,
  description: string,
  jiraKey: string,
  dueBy: string,
  progress: ProgressId = DEFAULT_PROGRESS,
  kind: KindId = defaultKind(),
  checklist: ChecklistItem[] = []
): Promise<string | null> {
  const trimmed = title.trim()
  if (!trimmed || !findColumn(columnId)) return null
  const normalizedKind = normalizeKind(kind)
  const payload = {
    title: trimmed,
    description: description.trim(),
    jiraKey: normalizeJiraKey(jiraKey),
    dueBy: dueBy.trim(),
    kind: normalizedKind,
    progress: normalizeProgress(progress, normalizedKind),
    checklist: normalizeChecklist(checklist),
  }
  try {
    let savedId = cardId
    if (cardId) {
      await api(`/api/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
    } else {
      // Created from the dialog — already viewed by the user.
      savedId = (await api<{ id: string }>('/api/cards', {
        method: 'POST',
        body: JSON.stringify({ columnId, ...payload, markViewed: true }),
      })).id
    }
    await refreshBoard()
    return savedId
  } catch (err) {
    fail(err)
    return null
  }
}

async function setCardProgress(cardId: string, progress: ProgressId) {
  // Optimistic update so the trail lights immediately.
  for (const col of board.value.columns) {
    const card = col.cards.find((c) => c.id === cardId)
    if (card) {
      const kind = cardKind(card)
      const next = normalizeProgress(progress, kind)
      if (normalizeProgress(card.progress, kind) === next) return
      card.progress = next
      if (next === 'done') {
        if (!card.completedAt) card.completedAt = new Date().toISOString()
      } else {
        card.completedAt = null
      }
      break
    }
  }
  try {
    await api(`/api/cards/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ progress }),
    })
    await refreshBoard()
  } catch (err) {
    fail(err)
    await refreshBoard()
  }
}

async function setCardKind(cardId: string, kind: KindId) {
  const nextKind = normalizeKind(kind)
  for (const col of board.value.columns) {
    const card = col.cards.find((c) => c.id === cardId)
    if (card) {
      const fromKind = cardKind(card)
      if (fromKind === nextKind) return
      card.kind = nextKind
      card.progress = progressForKindChange(card.progress, fromKind, nextKind)
      break
    }
  }
  try {
    await api(`/api/cards/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ kind: nextKind }),
    })
  } catch (err) {
    fail(err)
    await refreshBoard()
  }
}

function cardKind(card: Card): KindId {
  return normalizeKind(card.kind)
}

function cardStages(card: Card) {
  return stagesForKind(cardKind(card))
}

function cardProgress(card: Card): ProgressId {
  return normalizeProgress(card.progress, cardKind(card))
}

function cardStageLabel(card: Card): string {
  return cardStages(card).find((stage) => stage.id === cardProgress(card))?.label ?? 'Todo'
}

function isProgressReached(card: Card, stageId: ProgressId): boolean {
  const kind = cardKind(card)
  return progressIndex(cardProgress(card), kind) >= progressIndex(stageId, kind)
}

function isProgressCurrent(card: Card, stageId: ProgressId): boolean {
  return cardProgress(card) === stageId
}

function showCardDue(card: Card): boolean {
  return !!card.dueBy && cardProgress(card) !== 'done'
}

function isDoneColumn(column: Column): boolean {
  return column.title.trim().toLowerCase() === 'done'
}

/** Remaining time until a Done card auto-archives, or null when not applicable. */
function archiveCountdown(card: Card): string | null {
  if (cardProgress(card) !== 'done' || !card.completedAt) return null
  const completed = new Date(card.completedAt).getTime()
  if (Number.isNaN(completed)) return null
  const archiveAt = completed + ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000
  const ms = archiveAt - Date.now()
  if (ms <= 0) return 'Archiving soon'
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000))
  if (days <= 1) return 'Archives today'
  if (days === 2) return 'Archives tomorrow'
  return `Archives in ${days} days`
}

function archiveCountdownTitle(card: Card): string {
  if (!card.completedAt) return ''
  const completed = new Date(card.completedAt)
  if (Number.isNaN(completed.getTime())) return ''
  const archiveAt = new Date(completed.getTime() + ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000)
  return `Auto-archives ${archiveAt.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`
}

function onCardKindChange(cardId: string, event: Event) {
  const value = (event.target as HTMLSelectElement).value
  setCardKind(cardId, normalizeKind(value))
}

/* ── Card checklists (on the board) ────────────────────────────────────────── */

const COLLAPSED_CHECKLISTS_KEY = 'peteyplan-collapsed-checklists'
const CARD_CHECKLIST_PREVIEW = 6
const collapsedChecklists = ref(new Set<string>())
const quickAddCardId = ref<string | null>(null)
const quickAddText = ref('')
const checklistSaves = new Map<string, Promise<void>>()

function checklistOf(card: Card): ChecklistItem[] {
  return card.checklist ?? []
}

function isChecklistCollapsed(card: Card): boolean {
  return collapsedChecklists.value.has(card.id)
}

function toggleChecklistCollapsed(card: Card) {
  const next = new Set(collapsedChecklists.value)
  if (next.has(card.id)) next.delete(card.id)
  else next.add(card.id)
  collapsedChecklists.value = next
  try { localStorage.setItem(COLLAPSED_CHECKLISTS_KEY, JSON.stringify([...next])) } catch { /* storage unavailable */ }
}

/** Unticked items first so the remaining work stays visible in the preview. */
function checklistPreview(card: Card): ChecklistItem[] {
  const items = checklistOf(card)
  if (items.length <= CARD_CHECKLIST_PREVIEW) return items
  return [...items.filter((item) => !item.done), ...items.filter((item) => item.done)].slice(0, CARD_CHECKLIST_PREVIEW)
}

function findBoardCard(cardId: string): Card | undefined {
  for (const col of board.value.columns) {
    const card = col.cards.find((c) => c.id === cardId)
    if (card) return card
  }
}

/** Persist a card's current checklist; saves for one card run in order so the last edit wins. */
function persistChecklist(cardId: string) {
  const previous = checklistSaves.get(cardId) ?? Promise.resolve()
  const next = previous.then(async () => {
    const card = findBoardCard(cardId)
    if (!card) return
    try {
      await api(`/api/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ checklist: checklistOf(card) }),
      })
    } catch (err) {
      fail(err)
      await refreshBoard()
    }
  })
  checklistSaves.set(cardId, next)
  void next.finally(() => { if (checklistSaves.get(cardId) === next) checklistSaves.delete(cardId) })
}

function toggleChecklistItem(card: Card, itemId: string) {
  const item = checklistOf(card).find((entry) => entry.id === itemId)
  if (!item) return
  item.done = !item.done
  persistChecklist(card.id)
}

function startQuickAdd(card: Card) {
  quickAddCardId.value = card.id
  quickAddText.value = ''
  if (isChecklistCollapsed(card)) toggleChecklistCollapsed(card)
  nextTick(() => document.querySelector<HTMLInputElement>(`.card[data-id="${card.id}"] .checklist-quick-input`)?.focus())
}

function stopQuickAdd() {
  quickAddCardId.value = null
  quickAddText.value = ''
}

function submitQuickAdd(card: Card) {
  const text = quickAddText.value.trim()
  if (!text) { stopQuickAdd(); return }
  card.checklist = [...checklistOf(card), newChecklistItem(text.slice(0, CHECKLIST_ITEM_MAX_LENGTH))]
  quickAddText.value = ''
  persistChecklist(card.id)
}

/* ── Inline card capture ─────────────────────────────────────────────────── */

const quickCardColumnId = ref<string | null>(null)
const quickCardTitle = ref('')
const enteringCardIds = ref(new Set<string>())

function startQuickCard(columnId: string) {
  quickCardColumnId.value = columnId
  quickCardTitle.value = ''
  nextTick(() => document.querySelector<HTMLTextAreaElement>(`.column[data-id="${columnId}"] .quick-card textarea`)?.focus())
}

function stopQuickCard() {
  quickCardColumnId.value = null
  quickCardTitle.value = ''
}

/** Briefly flag a new card so it animates in where it lands. */
function markCardEntering(cardId: string) {
  enteringCardIds.value = new Set(enteringCardIds.value).add(cardId)
  setTimeout(() => {
    const next = new Set(enteringCardIds.value)
    next.delete(cardId)
    enteringCardIds.value = next
  }, 600)
}

/** Create a card from the inline box; the box stays open for the next one. */
async function submitQuickCard() {
  const columnId = quickCardColumnId.value
  const title = quickCardTitle.value.replace(/\s+/g, ' ').trim()
  if (!columnId || !title || !findColumn(columnId)) return
  quickCardTitle.value = ''
  try {
    const created = await api<Card>('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ columnId, title, markViewed: true }),
    })
    markCardEntering(created.id)
    await refreshBoard()
  } catch (err) { fail(err) }
}

function onQuickCardBlur() {
  if (quickCardTitle.value.trim()) void submitQuickCard()
  stopQuickCard()
}

/** Hand the typed title over to the full card dialog. */
function quickCardToDialog() {
  const columnId = quickCardColumnId.value
  const title = quickCardTitle.value.trim()
  stopQuickCard()
  if (!columnId) return
  openCardDialog(columnId, null)
  cardTitle.value = title
}

async function deleteCard(cardId: string) {
  if (!window.confirm('Archive this card? You can restore it from Archive.')) return
  try {
    await api(`/api/cards/${cardId}`, { method: 'DELETE' })
    await refreshBoard()
  } catch (err) { fail(err) }
}

/* ── Drag & drop ───────────────────────────────────────────────────────────── */

const dragged = ref<{ cardId: string; columnId: string } | null>(null)
const draggingId = ref<string | null>(null)
const dropIndicator = ref<{ columnId: string; index: number } | null>(null)

const draggedColumnId = ref<string | null>(null)
const columnDropIndex = ref<number | null>(null)
/** A card is hovering the empty space after the last column: dropping makes a new column. */
const newColumnDrop = ref(false)
const pillHoverId = ref<string | null>(null)
let pillHoverTimer: ReturnType<typeof setTimeout> | null = null

function cancelPillHover() {
  if (pillHoverTimer !== null) clearTimeout(pillHoverTimer)
  pillHoverTimer = null
  pillHoverId.value = null
}

function onPillDragOver(event: DragEvent, id: string) {
  if (!dragged.value && !draggedColumnId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  stopEdgeScroll()
  if (id === activeBoardId.value || pillHoverId.value === id || switchingBoardId.value === id) return
  cancelPillHover()
  pillHoverId.value = id
  pillHoverTimer = setTimeout(() => switchBoard(id), 350)
}

function finishDrag() {
  cancelPillHover()
  document.removeEventListener('dragover', onDocumentDragOver)
  stopEdgeScroll()
  dragged.value = null
  draggingId.value = null
  draggedColumnId.value = null
  dropIndicator.value = null
  columnDropIndex.value = null
  newColumnDrop.value = false
  releaseDropTarget.value = null
  dragSourceBoardId.value = null
  dragSourceColumn.value = null
}

async function transferDraggedItem(
  type: 'card' | 'column',
  itemId: string,
  targetColumnId?: string,
  targetPosition?: number,
  newColumn = false
) {
  const fromBoardId = dragSourceBoardId.value
  const toBoardId = activeBoardId.value
  // A card dropped on a board with no columns, or past the last column, lands in a new "Untitled column".
  const createsColumn = type === 'card' && (newColumn || (!targetColumnId && board.value.columns.length === 0))
  finishDrag()
  try {
    await api(`/api/boards/${toBoardId}/items`, {
      method: 'POST',
      body: JSON.stringify({ fromBoardId, type, itemId, targetColumnId, targetPosition, newColumn }),
    })
    await refreshBoard()
    const created = createsColumn && activeBoardId.value === toBoardId ? board.value.columns.at(-1) : undefined
    if (created) openColumnDialog(created.id, 'Name the new column')
  } catch (err) { fail(err) }
}

async function onPillDrop(event: DragEvent, id: string) {
  if (!dragged.value && !draggedColumnId.value) return
  event.preventDefault()
  event.stopPropagation()
  const type = draggedColumnId.value ? 'column' : 'card'
  const itemId = draggedColumnId.value ?? dragged.value!.cardId
  const fromBoardId = dragSourceBoardId.value
  await switchBoard(id)
  if (activeBoardId.value !== id) { finishDrag(); return }
  dragSourceBoardId.value = fromBoardId
  await transferDraggedItem(type, itemId, type === 'card' ? board.value.columns[0]?.id : undefined)
}

const EDGE_SCROLL_ZONE = 72
const EDGE_SCROLL_MAX = 28
let edgeScrollRaf: number | null = null
let edgeScrollSpeed = 0

function stopEdgeScroll() {
  edgeScrollSpeed = 0
  if (edgeScrollRaf != null) {
    cancelAnimationFrame(edgeScrollRaf)
    edgeScrollRaf = null
  }
}

function edgeScrollTick() {
  edgeScrollRaf = null
  const el = boardEl.value
  if (!el || !edgeScrollSpeed || (!dragged.value && !draggedColumnId.value)) {
    stopEdgeScroll()
    return
  }
  el.scrollLeft += edgeScrollSpeed
  edgeScrollRaf = requestAnimationFrame(edgeScrollTick)
}

function updateEdgeScroll(clientX: number) {
  if (!dragged.value && !draggedColumnId.value) {
    stopEdgeScroll()
    return
  }
  const width = window.innerWidth
  let speed = 0
  if (clientX < EDGE_SCROLL_ZONE) {
    const t = (EDGE_SCROLL_ZONE - clientX) / EDGE_SCROLL_ZONE
    speed = -Math.ceil(EDGE_SCROLL_MAX * Math.min(1, Math.max(0, t)))
  } else if (clientX > width - EDGE_SCROLL_ZONE) {
    const t = (clientX - (width - EDGE_SCROLL_ZONE)) / EDGE_SCROLL_ZONE
    speed = Math.ceil(EDGE_SCROLL_MAX * Math.min(1, Math.max(0, t)))
  }

  edgeScrollSpeed = speed
  if (!speed) {
    stopEdgeScroll()
    return
  }
  if (edgeScrollRaf == null) {
    edgeScrollRaf = requestAnimationFrame(edgeScrollTick)
  }
}

function onDocumentDragOver(event: DragEvent) {
  if (!dragged.value && !draggedColumnId.value) return
  updateEdgeScroll(event.clientX)
}

function isDropIndicator(columnId: string, index: number) {
  return !!dropIndicator.value && dropIndicator.value.columnId === columnId && dropIndicator.value.index === index
}

function isColumnDropIndicator(index: number) {
  return columnDropIndex.value === index
}

function onCardDragStart(event: DragEvent, columnId: string, card: Card) {
  if (isSearching.value) {
    event.preventDefault()
    return
  }
  if (!event.dataTransfer) return
  event.dataTransfer.setData('text/plain', card.id)
  event.dataTransfer.setData('application/x-petey-card', card.id)
  event.dataTransfer.effectAllowed = 'move'
  dragged.value = { cardId: card.id, columnId }
  dragSourceBoardId.value = activeBoardId.value
  dragSourceColumn.value = findColumn(columnId)!
  draggingId.value = card.id
  draggedColumnId.value = null
  columnDropIndex.value = null
  document.addEventListener('dragover', onDocumentDragOver)
}

function onCardDragEnd() {
  finishDrag()
}

function onColumnHeaderDragStart(event: DragEvent, column: Column) {
  const target = event.target as HTMLElement | null
  if (target?.closest('button')) {
    event.preventDefault()
    return
  }
  if (!event.dataTransfer) return
  event.dataTransfer.setData('text/plain', column.id)
  event.dataTransfer.setData('application/x-petey-column', column.id)
  event.dataTransfer.effectAllowed = 'move'
  draggedColumnId.value = column.id
  dragSourceBoardId.value = activeBoardId.value
  dragSourceColumn.value = findColumn(column.id)!
  columnDropIndex.value = null
  dragged.value = null
  draggingId.value = null
  dropIndicator.value = null
  document.addEventListener('dragover', onDocumentDragOver)
}

function onColumnHeaderDragEnd() {
  finishDrag()
}

function onColumnDragOver(event: DragEvent, column: Column) {
  if (isSearching.value || !dragged.value || draggedColumnId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'

  const container = (event.target as HTMLElement).closest('.column-cards') as HTMLElement | null
  if (!container) return

  const cardEls = Array.from(container.querySelectorAll<HTMLElement>('.card:not(.placeholder)')).filter(
    (el) => el.dataset.id !== dragged.value?.cardId
  )

  let index = cardEls.length
  for (let i = 0; i < cardEls.length; i++) {
    const rect = cardEls[i].getBoundingClientRect()
    if (event.clientY < rect.top + rect.height / 2) {
      index = i
      break
    }
  }
  dropIndicator.value = { columnId: column.id, index }
}

function onColumnDragLeave(event: DragEvent) {
  const container = event.currentTarget as HTMLElement
  if (!container.contains(event.relatedTarget as Node | null)) {
    dropIndicator.value = null
  }
}

function onColumnDrop(event: DragEvent, column: Column) {
  event.preventDefault()
  if (draggedColumnId.value) return
  event.stopPropagation()
  const d = dragged.value
  const indicator = dropIndicator.value
  if (d && foreignDrag.value) {
    transferDraggedItem('card', d.cardId, column.id, indicator?.index ?? column.cards.length)
    return
  }
  if (d && indicator && indicator.columnId === column.id) {
    moveCard(d.cardId, column.id, indicator.index)
  }
  finishDrag()
}

/** True when the pointer is to the right of the last real column. */
function isPastLastColumn(boardEl: HTMLElement, clientX: number): boolean {
  const cols = boardEl.querySelectorAll<HTMLElement>('.column:not(.column-placeholder):not(.drag-source-parked)')
  const last = cols[cols.length - 1]
  return !!last && clientX > last.getBoundingClientRect().right
}

function onBoardDragOver(event: DragEvent) {
  if (foreignDrag.value && dragged.value && board.value.columns.length === 0) {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    return
  }
  if (dragged.value && !draggedColumnId.value) {
    const past = !isSearching.value && isPastLastColumn(event.currentTarget as HTMLElement, event.clientX)
    newColumnDrop.value = past
    if (!past) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    dropIndicator.value = null
    return
  }
  if (!draggedColumnId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'

  const boardEl = event.currentTarget as HTMLElement
  const colEls = Array.from(boardEl.querySelectorAll<HTMLElement>('.column:not(.column-placeholder):not(.drag-source-parked)')).filter(
    (el) => el.dataset.id !== draggedColumnId.value
  )

  let index = colEls.length
  for (let i = 0; i < colEls.length; i++) {
    const rect = colEls[i].getBoundingClientRect()
    if (event.clientX < rect.left + rect.width / 2) {
      index = i
      break
    }
  }
  columnDropIndex.value = index
}

function onBoardDragLeave(event: DragEvent) {
  const boardEl = event.currentTarget as HTMLElement
  if (!boardEl.contains(event.relatedTarget as Node | null)) {
    columnDropIndex.value = null
    newColumnDrop.value = false
  }
}

function onBoardDrop(event: DragEvent) {
  event.preventDefault()
  if (foreignDrag.value && dragged.value && board.value.columns.length === 0) {
    transferDraggedItem('card', dragged.value.cardId)
    return
  }
  if (dragged.value && newColumnDrop.value) {
    transferDraggedItem('card', dragged.value.cardId, undefined, undefined, true)
    return
  }
  const columnId = draggedColumnId.value
  const index = columnDropIndex.value
  if (columnId && foreignDrag.value) {
    transferDraggedItem('column', columnId, undefined, index ?? board.value.columns.length)
    return
  }
  if (columnId != null && index != null) {
    moveColumn(columnId, index)
  }
  finishDrag()
}

async function moveCard(cardId: string, toColumnId: string, index: number) {
  // Optimistic local reorder for instant feedback.
  let fromIndex = -1
  const fromCol = board.value.columns.find((col) => {
    fromIndex = col.cards.findIndex((c) => c.id === cardId)
    return fromIndex !== -1
  })
  if (!fromCol || fromIndex === -1) return

  const [moved] = fromCol.cards.splice(fromIndex, 1)
  const toCol = findColumn(toColumnId)
  if (!toCol) return

  if (index > toCol.cards.length) index = toCol.cards.length
  toCol.cards.splice(index, 0, moved)

  // Dropping into Done lights the Done progress trail and starts the archive clock.
  if (isDoneColumn(toCol) && cardProgress(moved) !== 'done') {
    moved.progress = 'done'
    moved.completedAt = new Date().toISOString()
  }

  // Persist the full new ordering of the destination column, then refresh
  // so due-date auto-rank from the server is applied.
  try {
    await api('/api/cards/reorder', {
      method: 'POST',
      body: JSON.stringify({ columnId: toColumnId, orderedIds: toCol.cards.map((c) => c.id) }),
    })
    await refreshBoard()
  } catch (err) {
    fail(err)
    await refreshBoard()
  }
}

async function moveColumn(columnId: string, index: number) {
  const fromIndex = board.value.columns.findIndex((col) => col.id === columnId)
  if (fromIndex === -1) return

  const [moved] = board.value.columns.splice(fromIndex, 1)
  if (index > board.value.columns.length) index = board.value.columns.length
  board.value.columns.splice(index, 0, moved)

  try {
    await api('/api/columns/reorder', {
      method: 'POST',
      body: JSON.stringify({ orderedIds: board.value.columns.map((c) => c.id) }),
    })
    await refreshBoard()
  } catch (err) {
    fail(err)
    await refreshBoard()
  }
}

/* ── Card dialog ───────────────────────────────────────────────────────────── */

const cardDialogEl = ref<HTMLDialogElement | null>(null)
const cardTitleInput = ref<HTMLInputElement | null>(null)
const cardDescTextarea = ref<HTMLTextAreaElement | null>(null)
const cardDialogTitle = ref('Edit card')
const cardTitle = ref('')
const cardDesc = ref('')
const cardJiraKey = ref('')
const cardDueBy = ref('')
const cardKindId = ref<KindId>(defaultKind())
const cardProgressStage = ref<ProgressId>(DEFAULT_PROGRESS)
const cardDeleteVisible = ref(false)
const cardDialogColumnId = ref<string | null>(null)
const cardDialogCardId = ref<string | null>(null)
const cardDialogRef = ref('')
/** Where Save puts the card; '' column means a new Untitled column on that board. */
const cardMoveBoardId = ref('')
const cardMoveColumnId = ref('')
const cardMoveColumns = ref<{ id: string; title: string }[]>([])
const descEditing = ref(false)
const cardChecklist = ref<ChecklistItem[]>([])
const checklistDraft = ref('')
const checklistDraftInput = ref<HTMLInputElement | null>(null)
const checklistDragIndex = ref<number | null>(null)

const dialogChecklistProgress = computed(() => checklistProgress(cardChecklist.value))

/** Checklist to save, including a typed-but-not-added item so it isn't lost. */
function cardChecklistWithDraft(): ChecklistItem[] {
  const text = checklistDraft.value.trim()
  return text ? [...cardChecklist.value, newChecklistItem(text)] : cardChecklist.value
}

function addDialogChecklistItem() {
  const text = checklistDraft.value.trim()
  if (!text) return
  cardChecklist.value.push(newChecklistItem(text))
  checklistDraft.value = ''
  nextTick(() => checklistDraftInput.value?.focus())
}

function removeDialogChecklistItem(index: number) {
  cardChecklist.value.splice(index, 1)
}

/** Backspace in an emptied item removes it and focuses the previous one. */
function onChecklistItemBackspace(event: KeyboardEvent, index: number) {
  const item = cardChecklist.value[index]
  if (item.text) return
  event.preventDefault()
  cardChecklist.value.splice(index, 1)
  nextTick(() => {
    const inputs = cardDialogEl.value?.querySelectorAll<HTMLInputElement>('.checklist-edit-text')
    inputs?.[Math.max(0, index - 1)]?.focus()
  })
}

function onChecklistItemDragStart(event: DragEvent, index: number) {
  checklistDragIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }
}

function onChecklistItemDragOver(event: DragEvent, index: number) {
  const from = checklistDragIndex.value
  if (from === null) return
  event.preventDefault()
  if (from === index) return
  const [moved] = cardChecklist.value.splice(from, 1)
  cardChecklist.value.splice(index, 0, moved)
  checklistDragIndex.value = index
}

const dialogStages = computed(() => stagesForKind(cardKindId.value))

/** Normalized Jira key from the dialog field (empty when invalid / blank). */
const dialogJiraKey = computed(() => normalizeJiraKey(cardJiraKey.value))

function onDialogKindChange() {
  // v-model already applied the new kind; keep the stage if it exists there.
  cardProgressStage.value = normalizeProgress(cardProgressStage.value, cardKindId.value)
}

function startDescEdit() {
  descEditing.value = true
  nextTick(() => {
    const el = cardDescTextarea.value
    if (!el) return
    el.focus()
    const len = el.value.length
    el.setSelectionRange(len, len)
  })
}

/** Open the card dialog unless the click landed on a rendered link. */
function openCardUnlessLink(event: MouseEvent, columnId: string, cardId: string) {
  if ((event.target as HTMLElement | null)?.closest?.('a')) return
  openCardDialog(columnId, cardId)
}

/** Clicks on rendered links open the link; clicks elsewhere start editing. */
function onDescViewClick(event: MouseEvent) {
  if ((event.target as HTMLElement | null)?.closest?.('a')) return
  startDescEdit()
}
/** Keyboard activation mirrors click: links keep native behavior. */
function onDescViewKeydown(event: KeyboardEvent) {
  if ((event.target as HTMLElement | null)?.closest?.('a')) return
  startDescEdit()
}

/** Clear the unread indicator when a card is opened. */
async function markCardViewed(card: Card) {
  if (card.viewedAt) return
  const viewedAt = new Date().toISOString()
  card.viewedAt = viewedAt
  // Keep release-panel copies in sync with the board card.
  for (const rel of board.value.releases) {
    const copy = rel.cards.find((c) => c.id === card.id)
    if (copy) copy.viewedAt = viewedAt
  }
  try {
    await api(`/api/cards/${card.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ viewed: true }),
    })
  } catch (err) {
    fail(err)
  }
}

function openCardDialog(columnId: string, cardId: string | null) {
  cardDialogColumnId.value = columnId
  cardDialogCardId.value = cardId
  cardMoveBoardId.value = activeBoardId.value
  cardMoveColumnId.value = columnId
  cardMoveColumns.value = board.value.columns.map(({ id, title }) => ({ id, title }))
  if (cardId) {
    const card = findColumn(columnId)?.cards.find((c) => c.id === cardId)
    if (!card) return
    cardDialogTitle.value = 'Edit card'
    cardDialogRef.value = card.ref || ''
    cardTitle.value = card.title
    cardDesc.value = card.description || ''
    cardJiraKey.value = card.jiraKey || ''
    cardDueBy.value = card.dueBy || ''
    cardChecklist.value = (card.checklist ?? []).map((item) => ({ ...item }))
    cardKindId.value = normalizeKind(card.kind)
    cardProgressStage.value = normalizeProgress(card.progress, cardKindId.value)
    cardDeleteVisible.value = true
    descEditing.value = false
    void markCardViewed(card)
  } else {
    cardDialogTitle.value = 'New card'
    cardDialogRef.value = ''
    cardTitle.value = ''
    cardDesc.value = ''
    cardJiraKey.value = ''
    cardDueBy.value = ''
    cardChecklist.value = []
    cardKindId.value = defaultKind()
    cardProgressStage.value = DEFAULT_PROGRESS
    cardDeleteVisible.value = false
    descEditing.value = true
  }
  nextTick(() => {
    cardDialogEl.value?.showModal()
    cardTitleInput.value?.focus()
    cardTitleInput.value?.select()
  })
}

function closeCardDialog() {
  cardDialogEl.value?.close()
}

function onCardDialogClose() {
  cardTitle.value = ''
  cardDesc.value = ''
  cardJiraKey.value = ''
  cardDueBy.value = ''
  cardChecklist.value = []
  checklistDraft.value = ''
  cardKindId.value = defaultKind()
  cardProgressStage.value = DEFAULT_PROGRESS
  descEditing.value = false
}

async function onCardMoveBoardChange() {
  const boardId = cardMoveBoardId.value
  const columns = await fetchBoardColumns(boardId)
  if (boardId !== cardMoveBoardId.value) return
  cardMoveColumns.value = columns
  if (boardId === activeBoardId.value) cardMoveColumnId.value = cardDialogColumnId.value ?? ''
  else cardMoveColumnId.value = columns[0]?.id ?? ''
}

/** Move a saved card to the board and column picked in the dialog, if they changed. */
async function moveCardFromDialog(cardId: string) {
  const toBoardId = cardMoveBoardId.value
  const targetColumnId = cardMoveColumnId.value
  const newColumn = !targetColumnId
  if (toBoardId === activeBoardId.value && targetColumnId === cardDialogColumnId.value) return
  try {
    await api(`/api/boards/${toBoardId}/items`, {
      method: 'POST',
      body: JSON.stringify({ fromBoardId: activeBoardId.value, type: 'card', itemId: cardId, targetColumnId: targetColumnId || undefined, newColumn }),
    })
    if (!newColumn) {
      await refreshBoard()
      return
    }
    // Follow the card so its new Untitled column can be named straight away.
    if (toBoardId === activeBoardId.value) await refreshBoard()
    else await switchBoard(toBoardId)
    const created = activeBoardId.value === toBoardId ? board.value.columns.at(-1) : undefined
    if (created) openColumnDialog(created.id, 'Name the new column')
  } catch (err) { fail(err) }
}

async function saveCardFromDialog() {
  const savedId = await saveCard(
    cardDialogColumnId.value!,
    cardDialogCardId.value,
    cardTitle.value,
    cardDesc.value,
    cardJiraKey.value,
    cardDueBy.value,
    cardProgressStage.value,
    cardKindId.value,
    cardChecklistWithDraft()
  )
  closeCardDialog()
  if (savedId) await moveCardFromDialog(savedId)
}

async function deleteCardFromDialog() {
  if (cardDialogCardId.value) {
    await deleteCard(cardDialogCardId.value)
  }
  closeCardDialog()
}

/* ── Share links ───────────────────────────────────────────────────────────── */

const shareLinkCopied = ref(false)
let shareLinkCopiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Clipboard API needs a secure context; plain-http LAN installs fall back.
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    ;(cardDialogEl.value ?? document.body).appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}

/** Copy a link carrying the card as shown in the dialog, unsaved edits included. */
async function copyCardShareLink() {
  const kind = normalizeKind(cardKindId.value)
  const progress = normalizeProgress(cardProgressStage.value, kind)
  const token = await encodeSharedCard({
    title: cardTitle.value.trim() || 'Untitled card',
    description: cardDesc.value.trim(),
    jiraKey: normalizeJiraKey(cardJiraKey.value),
    dueBy: cardDueBy.value.trim(),
    kind,
    kindLabel: kindDef(kind).label,
    progress,
    progressLabel: stagesForKind(kind).find((stage) => stage.id === progress)?.label ?? '',
    checklist: cardChecklistWithDraft().map(({ text, done }) => ({ text, done })),
    ref: cardDialogRef.value,
  })
  try {
    await copyText(`${location.origin}/#${SHARE_HASH_KEY}=${token}`)
  } catch (err) {
    fail(err)
    return
  }
  shareLinkCopied.value = true
  clearTimeout(shareLinkCopiedTimer)
  clearTimeout(flashColumnTimer)
  shareLinkCopiedTimer = setTimeout(() => { shareLinkCopied.value = false }, 1800)
}

const shareDialogEl = ref<HTMLDialogElement | null>(null)
const sharedCard = ref<SharedCard | null>(null)
const shareBoardId = ref('')
const shareColumns = ref<{ id: string; title: string }[]>([])
const shareColumnId = ref('')
const shareBusy = ref(false)
const sharedCardSummary = computed(() => {
  const card = sharedCard.value
  if (!card) return ''
  const kind = kindDef(sharedCardKind(card))
  const progress = sharedCardProgress(card, kind.id)
  const parts: string[] = [kind.label, kind.stages.find((stage) => stage.id === progress)?.label ?? '']
  const jira = normalizeJiraKey(card.jiraKey)
  if (jira) parts.push(jira)
  if (card.dueBy) parts.push(`Due ${formatDueBy(card.dueBy)}`)
  if (card.checklist.length) parts.push(`${card.checklist.filter((item) => item.done).length}/${card.checklist.length} checklist`)
  return parts.filter(Boolean).join(' · ')
})

function clearShareHash() {
  if (shareTokenFrom(location.hash)) history.replaceState(null, '', location.pathname + location.search)
}

async function openShareFromHash() {
  const token = shareTokenFrom(location.hash)
  if (!token) return
  const card = await decodeSharedCard(token)
  if (!card) {
    clearShareHash()
    error.value = 'That share link is broken or incomplete. Ask for it to be copied again.'
    return
  }
  sharedCard.value = card
  shareBoardId.value = activeBoardId.value
  await loadShareColumns()
  nextTick(() => shareDialogEl.value?.showModal())
}

/** Column ids and titles for any board; the active board is read locally. */
async function fetchBoardColumns(boardId: string): Promise<{ id: string; title: string }[]> {
  let columns: Column[] = board.value.columns
  if (boardId !== activeBoardId.value) {
    try {
      const res = await fetch(`/api/board?boardId=${encodeURIComponent(boardId)}`)
      columns = res.ok ? ((await res.json()) as Board).columns ?? [] : []
    } catch { columns = [] }
  }
  return columns.map(({ id, title }) => ({ id, title }))
}

async function loadShareColumns() {
  const boardId = shareBoardId.value
  const columns = await fetchBoardColumns(boardId)
  if (boardId !== shareBoardId.value) return
  shareColumns.value = columns
  if (!shareColumns.value.some((col) => col.id === shareColumnId.value)) {
    shareColumnId.value = shareColumns.value[0]?.id ?? ''
  }
}

function closeShareDialog() {
  shareDialogEl.value?.close()
}

function onShareDialogClose() {
  sharedCard.value = null
  shareBusy.value = false
  clearShareHash()
}

/** Match the sender's work type by id, then by name; unknown types fall back to the default. */
function sharedCardKind(card: SharedCard): KindId {
  return isKindId(card.kind) ? card.kind : normalizeKind(card.kindLabel || card.kind)
}

function sharedCardProgress(card: SharedCard, kind: KindId): ProgressId {
  return isProgressForKind(card.progress, kind) ? card.progress : normalizeProgress(card.progressLabel || card.progress, kind)
}

async function addSharedCard() {
  const card = sharedCard.value
  if (!card || !shareColumnId.value || shareBusy.value) return
  shareBusy.value = true
  const kind = sharedCardKind(card)
  try {
    await api('/api/cards', {
      method: 'POST',
      body: JSON.stringify({
        columnId: shareColumnId.value,
        title: card.title,
        description: card.description,
        jiraKey: normalizeJiraKey(card.jiraKey),
        dueBy: card.dueBy,
        kind,
        progress: sharedCardProgress(card, kind),
        checklist: card.checklist,
      }),
    })
    const targetBoardId = shareBoardId.value
    closeShareDialog()
    if (targetBoardId === activeBoardId.value) await refreshBoard()
    else await switchBoard(targetBoardId)
  } catch (err) {
    fail(err)
    shareBusy.value = false
  }
}

/* ── Release dialog ────────────────────────────────────────────────────────── */

const releaseDialogEl = ref<HTMLDialogElement | null>(null)
const releaseTitleInput = ref<HTMLInputElement | null>(null)
const releaseDialogId = ref<string | null>(null)
const releaseTitle = ref('')
const releaseWeekStart = ref('')
const releasePreprodKey = ref('')
const releaseProdKey = ref('')

const dialogPreprodKey = computed(() => normalizeJiraKey(releasePreprodKey.value))
const dialogProdKey = computed(() => normalizeJiraKey(releaseProdKey.value))

function openReleaseDialog(releaseId: string) {
  const rel = findRelease(releaseId)
  if (!rel) return
  releaseDialogId.value = rel.id
  releaseTitle.value = rel.title
  releaseWeekStart.value = rel.weekStart
  releasePreprodKey.value = rel.preprodKey || ''
  releaseProdKey.value = rel.prodKey || ''
  nextTick(() => {
    releaseDialogEl.value?.showModal()
    releaseTitleInput.value?.focus()
    releaseTitleInput.value?.select()
  })
}

function closeReleaseDialog() {
  releaseDialogEl.value?.close()
}

function onReleaseDialogClose() {
  releaseDialogId.value = null
  releaseTitle.value = ''
  releaseWeekStart.value = ''
  releasePreprodKey.value = ''
  releaseProdKey.value = ''
}

async function saveReleaseFromDialog() {
  if (!releaseDialogId.value) return
  await saveRelease(
    releaseDialogId.value,
    releaseTitle.value,
    releaseWeekStart.value,
    releasePreprodKey.value,
    releaseProdKey.value
  )
  closeReleaseDialog()
}

async function deleteReleaseFromDialog() {
  if (!releaseDialogId.value) return
  const id = releaseDialogId.value
  closeReleaseDialog()
  await deleteRelease(id)
}

/* ── Column dialog ─────────────────────────────────────────────────────────── */

const columnDialogEl = ref<HTMLDialogElement | null>(null)
const columnTitleInput = ref<HTMLInputElement | null>(null)
const columnDialogTitle = ref('New column')
const columnTitle = ref('')
const columnMode = ref<'add' | 'rename'>('add')
const columnDialogColumnId = ref<string | null>(null)

function openColumnDialog(columnId: string | null, heading?: string) {
  const col = columnId ? findColumn(columnId) : null
  columnMode.value = col ? 'rename' : 'add'
  columnDialogColumnId.value = col?.id ?? null
  columnDialogTitle.value = heading ?? (col ? 'Rename column' : 'New column')
  columnTitle.value = col?.title ?? ''
  nextTick(() => {
    columnDialogEl.value?.showModal()
    columnTitleInput.value?.focus()
    columnTitleInput.value?.select()
  })
}

function closeColumnDialog() {
  columnDialogEl.value?.close()
}

function onColumnDialogClose() {
  columnTitle.value = ''
}

async function saveColumnFromDialog() {
  const title = columnTitle.value.trim()
  if (!title) return
  if (columnMode.value === 'rename' && columnDialogColumnId.value) {
    await renameColumn(columnDialogColumnId.value, title)
  } else {
    await addColumn(title)
  }
  closeColumnDialog()
}

/* ── Column dropdown menu ──────────────────────────────────────────────────── */

const columnMenuEl = ref<HTMLDivElement | null>(null)
const columnMenu = ref<{ columnId: string; top: number; right: number } | null>(null)

function openColumnMenu(columnId: string, event: MouseEvent) {
  const btn = event.currentTarget as HTMLElement
  const rect = btn.getBoundingClientRect()
  columnMenu.value = {
    columnId,
    top: rect.bottom + 4,
    right: Math.max(8, window.innerWidth - rect.right),
  }
}

function closeColumnMenu() {
  columnMenu.value = null
}

const columnMenuIndex = computed(() => {
  const id = columnMenu.value?.columnId
  if (!id) return -1
  return board.value.columns.findIndex((col) => col.id === id)
})

const canMoveColumnLeft = computed(() => columnMenuIndex.value > 0)
const canMoveColumnRight = computed(() => {
  const idx = columnMenuIndex.value
  return idx >= 0 && idx < board.value.columns.length - 1
})

const columnMenuCardCount = computed(() => {
  const id = columnMenu.value?.columnId
  if (!id) return 0
  return findColumn(id)?.cards.length ?? 0
})

function renameColumnFromMenu() {
  const columnId = columnMenu.value?.columnId
  closeColumnMenu()
  if (columnId) openColumnDialog(columnId)
}

function moveColumnLeftFromMenu() {
  const columnId = columnMenu.value?.columnId
  closeColumnMenu()
  if (columnId) swapColumn(columnId, -1)
}

function moveColumnRightFromMenu() {
  const columnId = columnMenu.value?.columnId
  closeColumnMenu()
  if (columnId) swapColumn(columnId, 1)
}

function clearColumnCardsFromMenu() {
  const columnId = columnMenu.value?.columnId
  closeColumnMenu()
  if (columnId) clearColumnCards(columnId)
}

function deleteColumnFromMenu() {
  const columnId = columnMenu.value?.columnId
  closeColumnMenu()
  if (columnId) deleteColumn(columnId)
}

/* ── Board menu + archive ──────────────────────────────────────────────────── */

const boardMenuEl = ref<HTMLDivElement | null>(null)
const boardMenu = ref<{ top: number; right: number } | null>(null)
const archiveDialogEl = ref<HTMLDialogElement | null>(null)
const archivedCards = ref<ArchivedCard[]>([])
const archiveLoading = ref(false)
const settingsDialogEl = ref<HTMLDialogElement | null>(null)
const boardDrafts = ref<BoardInfo[]>([])
const newBoard = ref({ name: '', emoji: '📋', color: '#5b8cff' })
const settingsBusy = ref(false)
const settingsTab = ref<'appearance' | 'boards' | 'types'>('appearance')

function openSettings(tab: 'appearance' | 'boards' | 'types' = 'appearance') {
  closeBoardMenu()
  settingsTab.value = tab
  boardDrafts.value = boards.value.map((entry) => ({ ...entry }))
  resetKindDrafts()
  settingsDialogEl.value?.showModal()
}

/** Editable copy of the work types; `stages` holds only those between Todo and Done. */
interface KindDraft { key: number; id: string; label: string; stages: { key: number; id: string; label: string }[] }
const kindDrafts = ref<KindDraft[]>([])
let kindDraftKey = 0

function kindDraftsFrom(kinds: KindDef[]): KindDraft[] {
  return kinds.map((kind) => ({
    key: ++kindDraftKey,
    id: kind.id,
    label: kind.label,
    stages: kind.stages.slice(1, -1).map((stage) => ({ key: ++kindDraftKey, ...stage })),
  }))
}

function kindDraftsPayload(drafts: KindDraft[]) {
  return drafts.map((kind) => ({
    id: kind.id,
    label: kind.label.trim(),
    stages: kind.stages.filter((stage) => stage.label.trim()).map((stage) => ({ id: stage.id, label: stage.label.trim() })),
  }))
}

function resetKindDrafts() {
  kindDrafts.value = kindDraftsFrom(workTypes.value)
}

const kindDraftsDirty = computed(() =>
  JSON.stringify(kindDraftsPayload(kindDrafts.value)) !== JSON.stringify(kindDraftsPayload(kindDraftsFrom(workTypes.value)))
)

function moveInList<T>(list: T[], index: number, direction: -1 | 1) {
  const target = index + direction
  if (target < 0 || target >= list.length) return
  ;[list[index], list[target]] = [list[target], list[index]]
}

function addKindDraft() {
  kindDrafts.value.push({ key: ++kindDraftKey, id: '', label: '', stages: [{ key: ++kindDraftKey, id: '', label: 'Doing' }] })
  nextTick(() => {
    const inputs = document.querySelectorAll<HTMLInputElement>('.work-type-name input')
    inputs[inputs.length - 1]?.focus()
  })
}

function removeKindDraft(index: number) {
  const kind = kindDrafts.value[index]
  const fallback = kindDrafts.value.find((_, i) => i !== index)
  if (!fallback) return
  const name = kind.label.trim() || 'this work type'
  if (kind.id && !window.confirm(`Remove "${name}"? Its cards become "${fallback.label.trim() || 'the first type'}" when you save.`)) return
  kindDrafts.value.splice(index, 1)
}

function addStageDraft(kind: KindDraft) {
  kind.stages.push({ key: ++kindDraftKey, id: '', label: '' })
  nextTick(() => document.querySelector<HTMLInputElement>(`[data-stage-key="${kind.stages[kind.stages.length - 1].key}"]`)?.focus())
}

async function saveKindDrafts() {
  settingsBusy.value = true
  try {
    const saved = await api<{ kinds: KindDef[] }>('/api/kinds', {
      method: 'PUT',
      body: JSON.stringify({ kinds: kindDraftsPayload(kindDrafts.value) }),
    })
    workTypes.value = saved.kinds
    resetKindDrafts()
    error.value = null
    // Cards on removed types or stages were moved server-side.
    await refreshBoard()
  } catch (err) { fail(err) }
  finally { settingsBusy.value = false }
}

async function saveBoardSettings(draft: { name: string; emoji: string; color: string }, id?: string) {
  settingsBusy.value = true
  try {
    const saved = await api<BoardInfo>(id ? `/api/boards/${id}` : '/api/boards', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(draft),
    })
    if (id) {
      boards.value = boards.value.map((entry) => entry.id === id ? saved : entry)
      boardDrafts.value = boardDrafts.value.map((entry) => entry.id === id ? { ...saved } : entry)
    } else {
      boards.value.push(saved)
      boardDrafts.value.push({ ...saved })
      newBoard.value = { name: '', emoji: '📋', color: '#5b8cff' }
    }
    error.value = null
  } catch (err) { fail(err) }
  finally { settingsBusy.value = false }
}

async function removeBoard(entry: BoardInfo) {
  if (entry.isDefault || !window.confirm(`Delete "${entry.name}" and all its columns, cards, archived cards, and releases? This cannot be undone.`)) return
  settingsBusy.value = true
  try {
    await api(`/api/boards/${entry.id}`, { method: 'DELETE' })
    boards.value = boards.value.filter((board) => board.id !== entry.id)
    boardDrafts.value = boardDrafts.value.filter((board) => board.id !== entry.id)
    if (activeBoardId.value === entry.id) {
      await switchBoard(boards.value.find((board) => board.isDefault)!.id)
    }
  } catch (err) { fail(err) }
  finally { settingsBusy.value = false }
}

function openBoardMenu(event: MouseEvent) {
  closeColumnMenu()
  const btn = event.currentTarget as HTMLElement
  const rect = btn.getBoundingClientRect()
  boardMenu.value = {
    top: rect.bottom + 4,
    right: Math.max(8, window.innerWidth - rect.right),
  }
}

function closeBoardMenu() {
  boardMenu.value = null
}

function formatArchivedAt(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

async function loadArchive() {
  archiveLoading.value = true
  try {
    const data = await api<{ cards: ArchivedCard[] }>('/api/archive')
    archivedCards.value = data.cards
    error.value = null
  } catch (err) {
    fail(err)
  } finally {
    archiveLoading.value = false
  }
}

async function openArchiveFromMenu() {
  closeBoardMenu()
  await loadArchive()
  nextTick(() => archiveDialogEl.value?.showModal())
}

function closeArchiveDialog() {
  archiveDialogEl.value?.close()
}

async function restoreArchivedCard(cardId: string) {
  try {
    await api('/api/archive/restore', {
      method: 'POST',
      body: JSON.stringify({ cardId }),
    })
    await loadArchive()
    await refreshBoard()
  } catch (err) { fail(err) }
}

async function permanentlyDeleteArchivedCard(cardId: string) {
  if (!window.confirm('Permanently delete this card? This cannot be undone.')) return
  try {
    await api(`/api/archive/${cardId}`, { method: 'DELETE' })
    await loadArchive()
  } catch (err) { fail(err) }
}

function onDocumentMousedown(event: MouseEvent) {
  const target = event.target as Node
  if (columnMenu.value && columnMenuEl.value && !columnMenuEl.value.contains(target)) {
    closeColumnMenu()
  }
  if (boardMenu.value && boardMenuEl.value && !boardMenuEl.value.contains(target)) {
    closeBoardMenu()
  }
}

const boardEl = ref<HTMLElement | null>(null)

/* ── Command palette ───────────────────────────────────────────────────────── */

interface SearchIndex {
  columns: { id: string; boardId: string; title: string; cardCount: number }[]
  cards: (Card & { boardId: string; columnTitle: string; archivedAt: string | null })[]
}

const paletteOpen = ref(false)
const paletteQuery = ref('')
const paletteLoading = ref(false)
const searchIndex = ref<SearchIndex>({ columns: [], cards: [] })
const paletteShortcut = ref('Ctrl K')
const flashColumnId = ref<string | null>(null)
let flashColumnTimer: ReturnType<typeof setTimeout> | undefined

async function openPalette() {
  closeBoardMenu()
  closeColumnMenu()
  paletteQuery.value = ''
  paletteOpen.value = true
  paletteLoading.value = true
  try {
    searchIndex.value = await api<SearchIndex>('/api/search')
  } catch (err) { fail(err) }
  finally { paletteLoading.value = false }
}

async function goToBoard(boardId: string) {
  if (boardId !== activeBoardId.value) await switchBoard(boardId)
  return activeBoardId.value === boardId
}

async function goToCard(card: SearchIndex['cards'][number]) {
  if (!(await goToBoard(card.boardId))) return
  if (card.archivedAt) await openArchiveFromMenu()
  else openCardDialog(card.columnId!, card.id)
}

async function goToColumn(column: SearchIndex['columns'][number]) {
  if (!(await goToBoard(column.boardId))) return
  searchQuery.value = ''
  await nextTick()
  boardEl.value?.querySelector(`.column[data-id="${CSS.escape(column.id)}"]`)
    ?.scrollIntoView({ behavior: motionFactor.value ? 'smooth' : 'auto', inline: 'center', block: 'nearest' })
  flashColumnId.value = column.id
  clearTimeout(flashColumnTimer)
  flashColumnTimer = setTimeout(() => { flashColumnId.value = null }, 1400)
}

const paletteItems = computed<PaletteItem[]>(() => {
  const boardById = new Map(boards.value.map((entry) => [entry.id, entry]))
  const firstColumn = board.value.columns[0]
  const query = paletteQuery.value.trim()
  const items: PaletteItem[] = []
  const action = (item: Omit<PaletteItem, 'group'>) => items.push({ group: 'Actions', ...item })

  if (firstColumn) {
    action({ id: 'new-card', title: 'New card', subtitle: `In ${firstColumn.title}`, icon: PhPlus, keywords: 'add create task', run: () => openCardDialog(firstColumn.id, null) })
    for (const col of board.value.columns.slice(1)) {
      action({ id: `new-card-${col.id}`, title: `New card in ${col.title}`, icon: PhPlus, keywords: 'add create task', queryOnly: true, run: () => openCardDialog(col.id, null) })
    }
  }
  action({ id: 'new-column', title: 'New column', icon: PhColumns, keywords: 'add create list', run: () => openColumnDialog(null) })
  action({ id: 'new-board', title: 'New board', icon: PhSquaresFour, keywords: 'add create', run: () => openSettings('boards') })
  action({ id: 'releases', title: releasesOpen.value ? 'Hide releases' : 'Show releases', icon: PhRocketLaunch, keywords: 'release folders deploy', run: toggleReleasesPanel })
  action({ id: 'archive', title: 'Open archive', icon: PhArchive, keywords: 'archived restore done old', run: openArchiveFromMenu })
  action({ id: 'theme', title: resolvedTheme.value === 'dark' ? 'Switch to day mode' : 'Switch to night mode', icon: resolvedTheme.value === 'dark' ? PhSun : PhMoon, keywords: 'theme light dark day night appearance', run: toggleTheme })
  action({ id: 'settings', title: 'Settings', icon: PhGear, keywords: 'appearance theme density motion surfaces preferences', run: () => openSettings('appearance') })
  action({ id: 'work-types', title: 'Edit work types', icon: PhSliders, keywords: 'kinds stages progress settings', run: () => openSettings('types') })
  action({ id: 'boards', title: 'Manage boards', icon: PhSquaresFour, keywords: 'rename delete colour color emoji settings', run: () => openSettings('boards') })
  if (isSearching.value) {
    action({ id: 'clear-filter', title: 'Clear filter', subtitle: `Showing cards matching “${searchQuery.value.trim()}”`, icon: PhX, keywords: 'search reset', run: () => { searchQuery.value = '' } })
  }
  if (query) {
    action({ id: 'filter', title: 'Filter this board', subtitle: `Only show cards matching “${query}”`, icon: PhFunnel, anyQuery: true, run: () => { searchQuery.value = query } })
  }

  for (const entry of boards.value) {
    items.push({
      id: `board-${entry.id}`,
      group: 'Boards',
      title: entry.name,
      subtitle: entry.id === activeBoardId.value ? 'Current board' : undefined,
      emoji: entry.emoji,
      keywords: 'board switch go',
      run: () => switchBoard(entry.id),
    })
  }

  for (const col of searchIndex.value.columns) {
    const owner = boardById.get(col.boardId)
    items.push({
      id: `column-${col.id}`,
      group: 'Columns',
      title: col.title,
      subtitle: `${owner?.emoji ?? ''} ${owner?.name ?? ''} · ${col.cardCount} ${col.cardCount === 1 ? 'card' : 'cards'}`.trim(),
      icon: PhColumns,
      keywords: `${owner?.name ?? ''} column`,
      queryOnly: true,
      run: () => goToColumn(col),
    })
  }

  for (const card of searchIndex.value.cards) {
    const owner = boardById.get(card.boardId)
    const kind = normalizeKind(card.kind)
    const stage = stagesForKind(kind).find((entry) => entry.id === normalizeProgress(card.progress, kind))?.label ?? ''
    items.push({
      id: `card-${card.id}`,
      group: 'Cards',
      title: card.title,
      subtitle: [`${owner?.emoji ?? ''} ${owner?.name ?? ''}`.trim(), card.columnTitle, stage, card.archivedAt ? 'Archived' : '']
        .filter(Boolean).join(' · '),
      hint: card.ref,
      icon: card.archivedAt ? PhArchive : PhCards,
      muted: !!card.archivedAt,
      keywords: [
        card.ref, card.jiraKey, card.description, card.columnTitle, owner?.name, kindDef(kind).label, stage,
        ...(card.checklist ?? []).map((item) => item.text), card.archivedAt ? 'archived' : '',
      ].filter(Boolean).join(' '),
      queryOnly: true,
      run: () => goToCard(card),
    })
  }
  return items
})

/** Cmd/Ctrl+K toggles the command palette anywhere; "/" opens it when not typing. */
function onDocumentKeydown(event: KeyboardEvent) {
  const openDialog = document.querySelector('dialog[open]')
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
    if (openDialog && !openDialog.classList.contains('command-palette')) return
    event.preventDefault()
    if (paletteOpen.value) paletteOpen.value = false
    else void openPalette()
    return
  }
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, select, [contenteditable="true"]') || openDialog) return
  event.preventDefault()
  void openPalette()
}

/**
 * After scrolling a column, keep horizontal pan locked briefly so overscroll doesn't jump sideways.
 * Panning the board locks off the pull into the next board the same way.
 */
const COLUMN_SCROLL_UNLOCK_MS = 250
let columnScrollLockUntil = 0
let boardScrollLockUntil = 0

/**
 * Wheel over a column scrolls that column vertically first.
 * Horizontal board pan unlocks 250ms after the last column scroll movement
 * (or immediately when not mid-column-scroll / outside a scrollable column).
 * Likewise, pulling past the board's edge into the next board unlocks once the
 * scroll that panned the board there has paused for 250ms.
 */
function onBoardWheel(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey) return
  const board = boardEl.value
  if (!board) return

  const dominantHorizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
  const now = performance.now()

  // Prefer scrolling the column under the cursor before panning the board.
  if (!dominantHorizontal && event.deltaY) {
    const column = (event.target as HTMLElement | null)?.closest?.(
      '.column:not(.column-placeholder)'
    ) as HTMLElement | null
    const cards = column?.querySelector('.column-cards') as HTMLElement | null
    if (cards && cards.scrollHeight > cards.clientHeight + 1) {
      const maxTop = cards.scrollHeight - cards.clientHeight
      const nextTop = Math.min(maxTop, Math.max(0, cards.scrollTop + event.deltaY))
      if (nextTop !== cards.scrollTop) {
        cards.scrollTop = nextTop
        columnScrollLockUntil = now + COLUMN_SCROLL_UNLOCK_MS
        event.preventDefault()
        return
      }
      // At the column end — hold horizontal until the lock expires.
      if (now < columnScrollLockUntil) {
        event.preventDefault()
        return
      }
    }
  }

  const delta = dominantHorizontal ? event.deltaX : event.deltaY
  if (!delta) return

  // Swallow the tail of the gesture that just broke into a board.
  if (now < boardPullSwallowUntil) {
    boardPullSwallowUntil = now + BOARD_PULL_IDLE_MS
    event.preventDefault()
    return
  }

  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? board.clientWidth : 1
  const direction = Math.sign(delta) as 1 | -1
  const amount = Math.abs(delta) * unit

  // Scrolling back against a pull eases it out before the board scrolls again.
  if (boardPull.value && !boardPull.value.releasing && direction !== boardPull.value.direction) {
    pullBoard(-amount)
    event.preventDefault()
    return
  }

  const max = Math.max(0, board.scrollWidth - board.clientWidth)
  const next = Math.min(max, Math.max(0, board.scrollLeft + delta))
  if (next !== board.scrollLeft) {
    board.scrollLeft = next
    boardScrollLockUntil = now + COLUMN_SCROLL_UNLOCK_MS
    event.preventDefault()
    return
  }

  const index = boards.value.findIndex((entry) => entry.id === activeBoardId.value)
  const neighbour = index < 0 ? undefined : boards.value[index + direction]
  if (!neighbour || switchingBoardId.value) return
  event.preventDefault()
  // At the board's edge mid-pan — hold while that scroll (or its momentum) carries on,
  // so only a fresh scroll after a pause pulls in the next board.
  if (now < boardScrollLockUntil) {
    boardScrollLockUntil = now + COLUMN_SCROLL_UNLOCK_MS
    return
  }
  if (boardPull.value?.id !== neighbour.id || boardPull.value.releasing) {
    // Trackpads send a stream of small pixel deltas; mouse wheels send coarse notches.
    startBoardPull(neighbour, direction, event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && amount < 50)
  }
  pullBoard(amount)
}

/** Wheel distance past the board's edge that breaks into the neighbouring board. */
const BOARD_PULL_COMMIT = 420
/** Trackpads follow the finger directly, so they break through sooner. */
const BOARD_PULL_COMMIT_FINE = 220
/** Furthest the board stretches, approached asymptotically. */
const BOARD_PULL_MAX = 180
/** A pause this long abandons the pull (and ends the swallow lock). */
const BOARD_PULL_IDLE_MS = 160
const BOARD_PULL_RELEASE_MS = 280

const boardPull = ref<{
  id: string
  name: string
  emoji: string
  color: string
  direction: 1 | -1
  offset: number
  progress: number
  releasing: boolean
  fine: boolean
} | null>(null)
let boardPullDistance = 0
let boardPullSwallowUntil = 0
let boardPullIdleTimer: ReturnType<typeof setTimeout> | undefined
let boardPullReleaseTimer: ReturnType<typeof setTimeout> | undefined

function startBoardPull(entry: BoardInfo, direction: 1 | -1, fine: boolean) {
  clearTimeout(boardPullReleaseTimer)
  boardPullDistance = 0
  boardPull.value = {
    id: entry.id, name: entry.name, emoji: entry.emoji, color: entry.color,
    direction, offset: 0, progress: 0, releasing: false, fine,
  }
}

function pullBoard(amount: number) {
  const pull = boardPull.value
  const el = boardEl.value
  if (!pull || !el) return
  clearTimeout(boardPullIdleTimer)
  boardPullDistance = Math.max(0, boardPullDistance + amount)
  if (!boardPullDistance) { resetBoardPull(); return }
  const commit = pull.fine ? BOARD_PULL_COMMIT_FINE : BOARD_PULL_COMMIT
  const offset = BOARD_PULL_MAX * (1 - Math.exp(-boardPullDistance / (commit * 0.75)))
  if (boardPullDistance >= commit) {
    boardPullSwallowUntil = performance.now() + BOARD_PULL_IDLE_MS
    void switchBoard(pull.id, offset)
    return
  }
  pull.offset = offset
  pull.progress = boardPullDistance / commit
  // Smooth out mouse-wheel notches; trackpad deltas are already continuous.
  el.classList.toggle('board-pulling', !pull.fine)
  el.style.transform = `translateX(${-pull.direction * offset}px)`
  boardPullIdleTimer = setTimeout(releaseBoardPull, BOARD_PULL_IDLE_MS)
}

/** Abandoned pull: spring the board back and let the peek slide away. */
function releaseBoardPull() {
  const pull = boardPull.value
  const el = boardEl.value
  if (!pull || !el) return
  boardPullDistance = 0
  pull.offset = 0
  pull.progress = 0
  pull.releasing = true
  el.classList.remove('board-pulling')
  el.classList.add('board-pull-release')
  el.style.transform = ''
  boardPullReleaseTimer = setTimeout(resetBoardPull, BOARD_PULL_RELEASE_MS)
}

function resetBoardPull() {
  clearTimeout(boardPullIdleTimer)
  clearTimeout(boardPullReleaseTimer)
  boardPullDistance = 0
  boardPull.value = null
  const el = boardEl.value
  if (!el) return
  el.classList.remove('board-pulling', 'board-pull-release')
  el.style.transform = ''
}

const boardPillsEl = ref<HTMLElement | null>(null)

function onBoardPillsWheel(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey) return
  const el = boardPillsEl.value
  if (!el || el.scrollWidth <= el.clientWidth + 1) return
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  if (!delta) return
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 32
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientWidth : 1
  el.scrollLeft = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, el.scrollLeft + delta * unit))
  event.preventDefault()
}

watch(boardPillsEl, (el, prev) => {
  prev?.removeEventListener('wheel', onBoardPillsWheel)
  el?.addEventListener('wheel', onBoardPillsWheel, { passive: false })
})

watch(boardEl, (el, prev) => {
  prev?.removeEventListener('wheel', onBoardWheel)
  el?.addEventListener('wheel', onBoardWheel, { passive: false })
})

onMounted(() => {
  initPreferences()
  if (/Mac|iPhone|iPad/.test(navigator.platform)) paletteShortcut.value = '⌘K'
  fetch('/favicon-light.svg')
    .then((res) => (res.ok ? res.text() : null))
    .then((svg) => { faviconTemplate.value = svg })
    .catch(() => { /* keep the static favicon */ })
  try {
    const stored = JSON.parse(localStorage.getItem(COLLAPSED_CHECKLISTS_KEY) || '[]')
    if (Array.isArray(stored)) collapsedChecklists.value = new Set(stored.filter((id) => typeof id === 'string'))
  } catch { /* storage unavailable */ }
  document.addEventListener('mousedown', onDocumentMousedown)
  document.addEventListener('keydown', onDocumentKeydown)
  window.addEventListener('hashchange', openShareFromHash)
  loadBoard().then(openShareFromHash)
})

onBeforeUnmount(() => {
  ++boardRequest
  cancelBoardPan?.()
  cancelPillHover()
  resetBoardPull()
  document.removeEventListener('mousedown', onDocumentMousedown)
  document.removeEventListener('keydown', onDocumentKeydown)
  window.removeEventListener('hashchange', openShareFromHash)
  clearTimeout(shareLinkCopiedTimer)
  document.removeEventListener('dragover', onDocumentDragOver)
  stopEdgeScroll()
  boardEl.value?.removeEventListener('wheel', onBoardWheel)
  boardPillsEl.value?.removeEventListener('wheel', onBoardPillsWheel)
})
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="logo" aria-hidden="true"></span>
      <h1 class="sr-only">PeteyPlan</h1>
      <span class="brand-divider" aria-hidden="true"></span>
      <nav ref="boardPillsEl" class="board-pills" aria-label="Boards">
        <button
          v-for="entry in boards"
          :key="entry.id"
          type="button"
          class="board-pill"
          :class="{ active: entry.id === activeBoardId, 'drag-hover': pillHoverId === entry.id, switching: switchingBoardId === entry.id }"
          :style="{ '--board-color': entry.color }"
          :aria-label="entry.name"
          :disabled="loading"
          :aria-pressed="entry.id === activeBoardId"
          :title="entry.name + '. Drop a card or column here to move it to this board'"
          @click="switchBoard(entry.id)"
          @dragover="onPillDragOver($event, entry.id)"
          @dragleave="!($event.currentTarget as HTMLElement).contains($event.relatedTarget as Node | null) && cancelPillHover()"
          @drop="onPillDrop($event, entry.id)"
        >
          <span class="board-pill-emoji" aria-hidden="true">{{ entry.emoji }}</span>
          <span class="board-pill-name" aria-hidden="true">{{ entry.name }}</span>
        </button>
      </nav>
      <span class="sr-only" aria-live="polite">{{ activeBoard?.name }}</span>
    </div>
    <div class="topbar-actions">
      <span v-if="isSearching" class="filter-chip">
        <PhFunnel :size="13" aria-hidden="true" />
        <span class="filter-chip-text">{{ searchQuery.trim() }}</span>
        <button type="button" :aria-label="'Clear filter ' + searchQuery.trim()" title="Clear filter" @click="searchQuery = ''"><PhX :size="12" weight="bold" /></button>
      </span>
      <button type="button" class="topbar-search palette-trigger" :aria-keyshortcuts="paletteShortcut === '⌘K' ? 'Meta+K' : 'Control+K'" @click="openPalette">
        <PhMagnifyingGlass :size="15" aria-hidden="true" />
        <span class="palette-trigger-text">Search or jump to…</span>
        <kbd aria-hidden="true">{{ paletteShortcut }}</kbd>
      </button>
      <button
        class="btn"
        :class="{ 'btn-active': releasesOpen }"
        :aria-expanded="releasesOpen"
        aria-controls="releases-panel"
        @click="toggleReleasesPanel"
      ><PhRocketLaunch :size="15" aria-hidden="true" />Releases</button>
      <button class="btn btn-primary" :disabled="loading || !!switchingBoardId" @click="openColumnDialog(null)"><PhPlus :size="15" weight="bold" aria-hidden="true" />Column</button>
      <button
        type="button"
        class="btn-icon theme-toggle"
        :title="resolvedTheme === 'dark' ? 'Switch to day mode' : 'Switch to night mode'"
        :aria-label="resolvedTheme === 'dark' ? 'Switch to day mode' : 'Switch to night mode'"
        @click="toggleTheme"
      >
        <PhSun v-if="resolvedTheme === 'dark'" :size="18" aria-hidden="true" />
        <PhMoon v-else :size="18" aria-hidden="true" />
      </button>
      <button
        class="btn-icon board-menu-btn"
        :class="{ 'menu-open': !!boardMenu }"
        title="Board options"
        aria-label="Board options"
        @mousedown.stop
        @click="openBoardMenu($event)"
      ><PhDotsThreeVertical :size="18" weight="bold" /></button>
    </div>
  </header>

  <div v-if="error" class="error-banner">
    <span>{{ error }}</span>
    <button class="btn-icon" title="Dismiss" aria-label="Dismiss error" @click="error = null"><PhX :size="15" /></button>
  </div>

  <section
    v-if="releasesOpen && !loading"
    id="releases-panel"
    class="releases-panel"
    aria-label="Release folders"
  >
    <div class="releases-panel-header">
      <div>
        <h2>Releases</h2>
        <p class="releases-panel-hint">
          Drag cards into a folder. Preprod update {{ PREPROD_HINT }} · Prod go-live {{ PROD_HINT }}
        </p>
      </div>
      <button class="btn btn-primary" type="button" @click="addRelease"><PhPlus :size="15" weight="bold" aria-hidden="true" />New release</button>
    </div>
    <div class="releases-row">
      <article
        v-for="rel in board.releases"
        :key="rel.id"
        class="release-folder"
        :class="{ 'drop-target': releaseDropTarget === rel.id }"
        @dragover="onReleaseDragOver($event, rel.id)"
        @dragleave="onReleaseDragLeave"
        @drop="onReleaseDrop($event, rel.id)"
      >
        <div class="release-folder-header">
          <div class="release-folder-title-row">
            <h3 class="release-folder-title" :title="rel.title">{{ rel.title }}</h3>
            <span class="release-folder-count">{{ rel.cards.length }}</span>
            <button
              type="button"
              class="btn-icon"
              title="Edit release"
              aria-label="Edit release"
              @click="openReleaseDialog(rel.id)"
            ><PhPencilSimple :size="15" /></button>
          </div>
          <div class="release-schedule">
            <div class="release-schedule-row">
              <span class="release-env">Preprod</span>
              <span class="release-when">{{ formatWeekDay(rel.weekStart, 0) }} · {{ rel.preprodSchedule }}</span>
              <a
                v-if="rel.preprodKey"
                class="release-ticket"
                :href="jiraBrowseUrl(rel.preprodKey)"
                :title="'Open preprod ' + rel.preprodKey"
                target="_blank"
                rel="noopener noreferrer"
                @click.stop
              >{{ rel.preprodKey }}</a>
              <button
                v-else
                type="button"
                class="release-ticket release-ticket-missing"
                @click="openReleaseDialog(rel.id)"
              >Link ticket</button>
            </div>
            <div class="release-schedule-row">
              <span class="release-env release-env-prod">Prod</span>
              <span class="release-when">{{ formatWeekDay(rel.weekStart, 1) }} · {{ rel.prodSchedule }}</span>
              <a
                v-if="rel.prodKey"
                class="release-ticket"
                :href="jiraBrowseUrl(rel.prodKey)"
                :title="'Open CM ' + rel.prodKey"
                target="_blank"
                rel="noopener noreferrer"
                @click.stop
              >{{ rel.prodKey }}</a>
              <button
                v-else
                type="button"
                class="release-ticket release-ticket-missing"
                @click="openReleaseDialog(rel.id)"
              >Link CM</button>
            </div>
          </div>
        </div>
        <ul class="release-cards">
          <li
            v-for="card in rel.cards"
            :key="card.id"
            class="release-card"
          >
            <button
              type="button"
              class="release-card-open"
              @click="openCardDialog(card.columnId, card.id)"
            >
              <span v-if="card.ref" class="card-ref">{{ card.ref }}</span>
              <span class="release-card-title">{{ card.title }}</span>
            </button>
            <button
              type="button"
              class="btn-icon release-card-remove"
              title="Remove from release"
              aria-label="Remove from release"
              @click="removeCardFromRelease(rel.id, card.id)"
            ><PhX :size="14" /></button>
          </li>
          <li v-if="rel.cards.length === 0" class="release-empty">
            {{ dragged ? 'Drop card here' : 'Drop cards here' }}
          </li>
        </ul>
      </article>
      <div v-if="board.releases.length === 0" class="releases-empty-state">
        No releases yet. Create one for the next Monday / Tuesday window.
      </div>
    </div>
  </section>

  <main v-if="loading" class="board-loading" aria-busy="true" aria-label="Loading board">
    <div v-for="n in 3" :key="n" class="skeleton-column" aria-hidden="true">
      <div class="skeleton-line"></div>
      <div v-for="m in 4 - n % 2" :key="m" class="skeleton-card"></div>
    </div>
  </main>

  <div v-else class="board-viewport">
  <main
    ref="boardEl"
    class="board"
    :aria-label="activeBoard?.name ?? 'Kanban board'"
    :aria-busy="!!switchingBoardId"
    @dragover.prevent="onBoardDragOver"
    @dragleave="onBoardDragLeave"
    @drop.prevent="onBoardDrop"
  >
    <template v-for="(col, colIndex) in displayColumns" :key="col.id">
      <div v-if="!col.parked && isColumnDropIndicator(colIndex)" class="column column-placeholder" aria-hidden="true"></div>
      <section
        class="column"
        :class="{ flash: flashColumnId === col.id, dragging: draggedColumnId === col.id, 'drag-source-parked': col.parked, 'is-done-column': isDoneColumn(col) }"
        :aria-hidden="col.parked || undefined"
        :data-id="col.id"
      >
      <div
        class="column-header"
        draggable="true"
        title="Drag to reorder"
        @dragstart="onColumnHeaderDragStart($event, col)"
        @dragend="onColumnHeaderDragEnd"
      >
        <span class="column-title" :title="col.title">{{ col.title }}</span>
        <span
          class="column-count"
          :title="isSearching ? col.cards.length + ' of ' + col.totalCount + ' tasks' : undefined"
        >{{ isSearching ? col.cards.length + '/' + col.totalCount : col.cards.length }}</span>
        <button
          class="btn-icon"
          :class="{ 'menu-open': columnMenu?.columnId === col.id }"
          title="Column options"
          aria-label="Column options"
          @mousedown.stop
          @click="openColumnMenu(col.id, $event)"
        ><PhDotsThreeVertical :size="17" weight="bold" /></button>
      </div>

      <div
        class="column-cards"
        @dragover.prevent="onColumnDragOver($event, col)"
        @dragleave="onColumnDragLeave"
        @drop.prevent="onColumnDrop($event, col)"
      >
        <template v-for="(card, index) in col.cards" :key="card.id">
          <div v-if="!isSearching && isDropIndicator(col.id, index)" class="card placeholder"></div>
          <article
            class="card"
            :class="{ dragging: draggingId === card.id, 'card-enter': enteringCardIds.has(card.id) }"
            :data-id="card.id"
            :draggable="!isSearching && quickAddCardId !== card.id"
            @click="openCardUnlessLink($event, col.id, card.id)"
            @dragstart="onCardDragStart($event, col.id, card)"
            @dragend="onCardDragEnd"
          >
            <span
              v-if="!card.viewedAt"
              class="card-unopened"
              title="New, not opened yet"
              aria-label="New card, not opened yet"
            ></span>
            <div class="card-meta">
              <span v-if="card.ref" class="card-ref" :title="'Card ' + card.ref">{{ card.ref }}</span>
              <a
                v-if="card.jiraKey"
                class="card-jira"
                :href="jiraBrowseUrl(card.jiraKey)"
                :title="jiraBrowseUrl(card.jiraKey)"
                target="_blank"
                rel="noopener noreferrer"
                @click.stop
              >{{ card.jiraKey }}</a>
              <button
                v-if="card.releaseId && releaseTitleForCard(card)"
                type="button"
                class="card-release"
                :title="'In release: ' + releaseTitleForCard(card)"
                @click.stop="releasesOpen = true"
              >{{ releaseTitleForCard(card) }}</button>
              <span
                v-if="showCardDue(card)"
                class="card-due"
                :class="'due-' + dueTone(card.dueBy)"
                :title="'Due ' + formatDueBy(card.dueBy!)"
              >{{ formatDueBy(card.dueBy!) }}</span>
              <span
                v-if="archiveCountdown(card)"
                class="card-archive-in"
                :title="archiveCountdownTitle(card)"
              >{{ archiveCountdown(card) }}</span>
            </div>
            <div class="card-title">
              <template v-for="(part, i) in linkifyJira(card.title)" :key="'t' + i">
                <a
                  v-if="part.type === 'jira'"
                  class="jira-link"
                  :href="jiraBrowseUrl(part.key)"
                  target="_blank"
                  rel="noopener noreferrer"
                  @click.stop
                >{{ part.key }}</a>
                <template v-else>{{ part.value }}</template>
              </template>
            </div>
            <div v-if="card.description" class="card-desc" v-html="renderDescHtml(card.description)"></div>
            <div
              v-if="checklistOf(card).length || quickAddCardId === card.id"
              class="card-checklist"
              @click.stop
              @mousedown.stop
            >
              <button
                v-if="checklistOf(card).length"
                type="button"
                class="checklist-summary"
                :class="{ collapsed: isChecklistCollapsed(card) }"
                :aria-expanded="!isChecklistCollapsed(card)"
                :title="isChecklistCollapsed(card) ? 'Show checklist' : 'Hide checklist'"
                @click="toggleChecklistCollapsed(card)"
              >
                <PhCaretDown class="checklist-chevron" :size="11" weight="bold" aria-hidden="true" />
                <PhListChecks :size="14" aria-hidden="true" />
                <span
                  class="checklist-count"
                  :class="{ complete: checklistProgress(checklistOf(card)).done === checklistOf(card).length }"
                >{{ checklistProgress(checklistOf(card)).done }}/{{ checklistOf(card).length }}</span>
              </button>
              <ul v-if="!isChecklistCollapsed(card)" class="checklist-items">
                <li
                  v-for="item in checklistPreview(card)"
                  :key="item.id"
                  :class="{ done: item.done }"
                >
                  <label class="checklist-item">
                    <input
                      type="checkbox"
                      :checked="item.done"
                      @change="toggleChecklistItem(card, item.id)"
                    />
                    <span class="checklist-item-text">{{ item.text }}</span>
                  </label>
                </li>
                <li v-if="checklistOf(card).length > checklistPreview(card).length" class="checklist-more">
                  <button type="button" @click="openCardDialog(col.id, card.id)">
                    +{{ checklistOf(card).length - checklistPreview(card).length }} more
                  </button>
                </li>
              </ul>
              <form v-if="quickAddCardId === card.id" class="checklist-quick" @submit.prevent="submitQuickAdd(card)">
                <input
                  v-model="quickAddText"
                  class="checklist-quick-input"
                  type="text"
                  :maxlength="CHECKLIST_ITEM_MAX_LENGTH"
                  placeholder="Add an item, press Enter"
                  aria-label="New checklist item"
                  @keydown.esc.prevent="stopQuickAdd"
                  @blur="submitQuickAdd(card); stopQuickAdd()"
                />
              </form>
            </div>
            <div class="card-status" @click.stop @mousedown.stop>
              <div
                class="stage-track"
                :class="{ 'is-done': cardProgress(card) === 'done' }"
                role="group"
                :aria-label="'Progress: ' + cardStageLabel(card)"
              >
                <button
                  v-for="stage in cardStages(card)"
                  :key="stage.id"
                  type="button"
                  class="stage-step"
                  :class="{ reached: isProgressReached(card, stage.id), current: isProgressCurrent(card, stage.id) }"
                  :data-label="isProgressCurrent(card, stage.id) ? stage.label + ' (current)' : 'Set to ' + stage.label"
                  :aria-label="'Set progress to ' + stage.label"
                  :aria-pressed="isProgressCurrent(card, stage.id)"
                  @click="setCardProgress(card.id, stage.id)"
                ></button>
              </div>
              <div class="card-footer">
                <span class="stage-label" :class="{ 'is-done': cardProgress(card) === 'done' }">{{ cardStageLabel(card) }}</span>
                <label class="card-kind">
                  <span class="sr-only">Work type</span>
                  <select
                    class="kind-select"
                    :value="cardKind(card)"
                    title="Work type"
                    :aria-label="'Work type for ' + (card.title || 'card')"
                    @change="onCardKindChange(card.id, $event)"
                  >
                    <option
                      v-for="kind in cardKinds()"
                      :key="kind.id"
                      :value="kind.id"
                    >{{ kind.label }}</option>
                  </select>
                </label>
                <button
                  type="button"
                  class="btn-icon checklist-add-btn"
                  title="Add checklist item"
                  :aria-label="'Add checklist item to ' + card.title"
                  @click="startQuickAdd(card)"
                >
                  <PhListChecks :size="15" />
                </button>
              </div>
            </div>
          </article>
        </template>
        <div v-if="!isSearching && isDropIndicator(col.id, col.cards.length)" class="card placeholder"></div>
        <div v-if="col.cards.length === 0 && (isSearching || !isDropIndicator(col.id, 0))" class="column-empty">
          {{ isSearching ? 'No matching tasks' : 'Drop cards here' }}
        </div>
      </div>

      <div class="column-footer">
        <form v-if="quickCardColumnId === col.id" class="quick-card" @submit.prevent="submitQuickCard">
          <textarea
            v-model="quickCardTitle"
            rows="2"
            maxlength="120"
            placeholder="What needs doing?"
            :aria-label="'New card in ' + col.title"
            @keydown.enter.exact.prevent="submitQuickCard"
            @keydown.esc.prevent="stopQuickCard"
            @blur="onQuickCardBlur"
          ></textarea>
          <div class="quick-card-hint">
            <span><kbd>Enter</kbd> to add</span>
            <span class="spacer"></span>
            <button type="button" @mousedown.prevent @click="quickCardToDialog">Add details</button>
          </div>
        </form>
        <button v-else class="add-card" @click="startQuickCard(col.id)"><PhPlus :size="14" weight="bold" aria-hidden="true" />Add card</button>
      </div>
    </section>
    </template>
    <div
      v-if="isColumnDropIndicator(board.columns.length)"
      class="column column-placeholder"
      aria-hidden="true"
    ></div>
    <div v-if="newColumnDrop" class="column new-column-ghost" aria-hidden="true">
      <span class="column-title">Untitled column</span>
      <span class="new-column-ghost-hint"><PhPlus :size="14" weight="bold" />Drop to create a column</span>
    </div>
    <div v-if="board.columns.length === 0" class="board-empty">
      <div class="board-empty-emoji" aria-hidden="true">{{ activeBoard?.emoji }}</div>
      <h2>{{ activeBoard?.name }}</h2>
      <p>{{ foreignDrag && dragged ? 'Drop your card here to create a new column.' : 'Nothing here yet. Add a column, or drag one in from another board.' }}</p>
      <button class="btn btn-primary" @click="openColumnDialog(null)"><PhPlus :size="15" weight="bold" aria-hidden="true" />Add column</button>
    </div>
  </main>
  <div
    v-if="boardPull"
    class="board-pull-peek"
    :class="[boardPull.direction > 0 ? 'is-next' : 'is-prev', { releasing: boardPull.releasing, direct: boardPull.fine && !boardPull.releasing, ready: boardPull.progress > 0.8 }]"
    :style="{ '--board-color': boardPull.color, '--pull-offset': boardPull.offset + 'px', '--pull-progress': boardPull.progress }"
    aria-hidden="true"
  >
    <span class="board-pull-emoji">{{ boardPull.emoji }}</span>
    <span class="board-pull-name">{{ boardPull.name }}</span>
  </div>
  </div>

  <dialog ref="settingsDialogEl" class="settings-dialog" aria-labelledby="board-settings-title" @cancel="settingsBusy && $event.preventDefault()">
    <div class="dialog-form">
      <h2 id="board-settings-title">Settings</h2>
      <div class="settings-tabs" role="tablist" aria-label="Settings sections">
        <button
          id="settings-tab-appearance"
          type="button"
          role="tab"
          class="settings-tab"
          :aria-selected="settingsTab === 'appearance'"
          aria-controls="settings-panel-appearance"
          @click="settingsTab = 'appearance'"
        >Appearance</button>
        <button
          id="settings-tab-boards"
          type="button"
          role="tab"
          class="settings-tab"
          :aria-selected="settingsTab === 'boards'"
          aria-controls="settings-panel-boards"
          @click="settingsTab = 'boards'"
        >Boards</button>
        <button
          id="settings-tab-types"
          type="button"
          role="tab"
          class="settings-tab"
          :aria-selected="settingsTab === 'types'"
          aria-controls="settings-panel-types"
          @click="settingsTab = 'types'"
        >Work types</button>
      </div>
      <p v-if="error" class="settings-error" role="alert">{{ error }}</p>

      <section
        v-show="settingsTab === 'appearance'"
        id="settings-panel-appearance"
        role="tabpanel"
        aria-labelledby="settings-tab-appearance"
        class="settings-panel"
      >
        <div class="setting-row">
          <div class="setting-label">
            <h3>Theme</h3>
            <p>Day, night, or follow your system. The sun/moon button in the top bar flips it quickly.</p>
          </div>
          <div class="segmented" role="radiogroup" aria-label="Theme">
            <button
              v-for="option in THEME_OPTIONS"
              :key="option.id"
              type="button"
              role="radio"
              :aria-checked="prefs.theme === option.id"
              @click="prefs.theme = option.id"
            >{{ option.id === 'light' ? '☀︎' : option.id === 'dark' ? '☾' : '◐' }} {{ option.label }}</button>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-label">
            <h3>Surfaces</h3>
            <p>Frosted glass lets each board's colour glow through. Solid is plainer and lighter on older machines.</p>
          </div>
          <div class="segmented" role="radiogroup" aria-label="Surfaces">
            <button
              v-for="option in SURFACE_OPTIONS"
              :key="option.id"
              type="button"
              role="radio"
              :aria-checked="prefs.surface === option.id"
              @click="prefs.surface = option.id"
            >{{ option.label }}</button>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-label">
            <h3>Transition speed</h3>
            <p>
              Board switches, hover effects and panels.
              <template v-if="motionFactor === 0 && prefs.motion !== 'off'"> Your system's reduce-motion setting is on, so animations are off.</template>
            </p>
          </div>
          <div class="segmented" role="radiogroup" aria-label="Transition speed">
            <button
              v-for="option in MOTION_OPTIONS"
              :key="option.id"
              type="button"
              role="radio"
              :aria-checked="prefs.motion === option.id"
              @click="prefs.motion = option.id"
            >{{ option.label }}</button>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-label">
            <h3>Density</h3>
            <p>Compact fits more cards and narrower columns on screen.</p>
          </div>
          <div class="segmented" role="radiogroup" aria-label="Density">
            <button
              v-for="option in DENSITY_OPTIONS"
              :key="option.id"
              type="button"
              role="radio"
              :aria-checked="prefs.density === option.id"
              @click="prefs.density = option.id"
            >{{ option.label }}</button>
          </div>
        </div>
        <p class="settings-hint">Appearance is saved in this browser. Press <kbd>{{ paletteShortcut }}</kbd> anywhere to search cards, boards and actions.</p>
      </section>

      <section
        v-show="settingsTab === 'boards'"
        id="settings-panel-boards"
        role="tabpanel"
        aria-labelledby="settings-tab-boards"
        class="settings-panel"
      >
        <p class="settings-hint">Choose a name, emoji and colour for each board. The default board can be edited but never deleted.</p>
        <form
          v-for="draft in boardDrafts"
          :key="draft.id"
          class="board-settings-row"
          @submit.prevent="saveBoardSettings(draft, draft.id)"
        >
          <BoardEmojiPicker v-model="draft.emoji" :label="'Emoji for ' + draft.name" :disabled="settingsBusy" />
          <label class="board-name-field">Name<input v-model="draft.name" :aria-label="'Name for ' + draft.name" required maxlength="60" /></label>
          <label>Colour<input v-model="draft.color" :aria-label="'Colour for ' + draft.name" type="color" required /></label>
          <button class="btn" :disabled="settingsBusy" type="submit">Save</button>
          <button class="btn btn-danger" :disabled="settingsBusy || draft.isDefault" :title="draft.isDefault ? 'The default board cannot be deleted' : 'Delete board and all its contents'" type="button" @click="removeBoard(draft)">Delete</button>
        </form>
        <form class="board-settings-row new-board-form" @submit.prevent="saveBoardSettings(newBoard)">
          <h3>New board</h3>
          <BoardEmojiPicker v-model="newBoard.emoji" label="New board emoji" :disabled="settingsBusy" />
          <label class="board-name-field">Name<input v-model="newBoard.name" aria-label="New board name" placeholder="Board name" required maxlength="60" /></label>
          <label>Colour<input v-model="newBoard.color" aria-label="New board colour" type="color" required /></label>
          <button class="btn btn-primary" :disabled="settingsBusy" type="submit">Create board</button>
        </form>
      </section>

      <section
        v-show="settingsTab === 'types'"
        id="settings-panel-types"
        role="tabpanel"
        aria-labelledby="settings-tab-types"
        class="settings-panel"
      >
        <p class="settings-hint">
          Each work type has its own progress stages. Every type starts at Todo and ends at Done, which is what marks a card complete.
          The first type is used for new cards. Cards on a stage you remove step back to the stage before it.
        </p>
        <form id="work-types-form" class="work-types" @submit.prevent="saveKindDrafts">
          <div v-for="(kind, kindIndex) in kindDrafts" :key="kind.key" class="work-type-row">
            <div class="work-type-head">
              <label class="work-type-name">
                <span>Name<template v-if="kindIndex === 0"> · default for new cards</template></span>
                <input v-model="kind.label" required :maxlength="KIND_LABEL_MAX_LENGTH" placeholder="Work type name" autocomplete="off" />
              </label>
              <button type="button" class="btn-icon" :disabled="kindIndex === 0" :aria-label="'Move ' + (kind.label || 'work type') + ' up'" title="Move up" @click="moveInList(kindDrafts, kindIndex, -1)"><PhArrowUp :size="15" /></button>
              <button type="button" class="btn-icon" :disabled="kindIndex === kindDrafts.length - 1" :aria-label="'Move ' + (kind.label || 'work type') + ' down'" title="Move down" @click="moveInList(kindDrafts, kindIndex, 1)"><PhArrowDown :size="15" /></button>
              <button type="button" class="btn-icon danger" :disabled="kindDrafts.length === 1" :aria-label="'Remove ' + (kind.label || 'work type')" :title="kindDrafts.length === 1 ? 'Keep at least one work type' : 'Remove work type'" @click="removeKindDraft(kindIndex)"><PhTrash :size="15" /></button>
            </div>
            <ol class="work-type-stages" :aria-label="'Stages for ' + (kind.label || 'work type')">
              <li class="stage-chip fixed">{{ FIRST_STAGE.label }}</li>
              <li v-for="(stage, stageIndex) in kind.stages" :key="stage.key" class="stage-chip">
                <button type="button" class="stage-chip-move" :disabled="stageIndex === 0" :aria-label="'Move ' + (stage.label || 'stage') + ' earlier'" @click="moveInList(kind.stages, stageIndex, -1)"><PhArrowLeft :size="12" /></button>
                <input
                  v-model="stage.label"
                  :data-stage-key="stage.key"
                  :maxlength="STAGE_LABEL_MAX_LENGTH"
                  :size="Math.max(4, stage.label.length)"
                  placeholder="Stage"
                  :aria-label="'Stage ' + (stageIndex + 2) + ' name'"
                  autocomplete="off"
                  @keydown.backspace="!stage.label && kind.stages.splice(stageIndex, 1)"
                />
                <button type="button" class="stage-chip-move" :disabled="stageIndex === kind.stages.length - 1" :aria-label="'Move ' + (stage.label || 'stage') + ' later'" @click="moveInList(kind.stages, stageIndex, 1)"><PhArrowRight :size="12" /></button>
                <button type="button" class="stage-chip-move" :aria-label="'Remove ' + (stage.label || 'stage')" @click="kind.stages.splice(stageIndex, 1)"><PhX :size="12" /></button>
              </li>
              <li v-if="kind.stages.length < STAGES_MAX">
                <button type="button" class="stage-chip add" @click="addStageDraft(kind)"><PhPlus :size="12" /> Stage</button>
              </li>
              <li class="stage-chip fixed">{{ LAST_STAGE.label }}</li>
            </ol>
          </div>
          <div class="work-types-actions">
            <button type="button" class="btn" :disabled="settingsBusy || kindDrafts.length >= KINDS_MAX" @click="addKindDraft"><PhPlus :size="14" /> Add work type</button>
            <span class="spacer"></span>
            <button type="button" class="btn" :disabled="settingsBusy || !kindDraftsDirty" @click="resetKindDrafts">Revert</button>
            <button type="submit" class="btn btn-primary" :disabled="settingsBusy || !kindDraftsDirty">Save work types</button>
          </div>
        </form>
      </section>
      <div class="dialog-actions">
        <span class="spacer"></span>
        <button class="btn" :disabled="settingsBusy" @click="settingsDialogEl?.close()">Close</button>
      </div>
    </div>
  </dialog>

  <CommandPalette v-model:open="paletteOpen" v-model:query="paletteQuery" :items="paletteItems" :loading="paletteLoading" />

  <!-- Card dialog -->
  <dialog ref="cardDialogEl" class="card-dialog" @close="onCardDialogClose">
    <form method="dialog" class="dialog-form card-dialog-form" @submit.prevent="saveCardFromDialog">
      <h2>{{ cardDialogTitle }}<span v-if="cardDialogRef" class="card-dialog-ref">{{ cardDialogRef }}</span></h2>
      <label class="card-dialog-title">
        Title
        <input
          ref="cardTitleInput"
          v-model="cardTitle"
          type="text"
          maxlength="120"
          placeholder="Task title"
          autocomplete="off"
          @keydown.enter.prevent="saveCardFromDialog"
        />
      </label>
      <div class="card-dialog-grid">
        <div class="card-dialog-fields">
          <div class="card-dialog-location">
            <label>
              Board
              <select v-model="cardMoveBoardId" class="kind-select dialog-kind-select" @change="onCardMoveBoardChange">
                <option v-for="entry in boards" :key="entry.id" :value="entry.id">{{ entry.emoji }} {{ entry.name }}</option>
              </select>
            </label>
            <label>
              Column
              <select v-model="cardMoveColumnId" class="kind-select dialog-kind-select">
                <option v-for="col in cardMoveColumns" :key="col.id" :value="col.id">{{ col.title }}</option>
                <option value="">+ New column</option>
              </select>
            </label>
          </div>
          <div class="card-dialog-jira">
            <div class="card-dialog-field-heading">
              <label for="card-jira-key-input">Jira key</label>
              <a
                v-if="dialogJiraKey"
                class="card-dialog-jira-open"
                :href="jiraBrowseUrl(dialogJiraKey)"
                :title="'Open ' + dialogJiraKey + ' in Jira'"
                target="_blank"
                rel="noopener noreferrer"
              >Open in Jira</a>
            </div>
            <input
              id="card-jira-key-input"
              v-model="cardJiraKey"
              type="text"
              maxlength="200"
              placeholder="CX-1831 or browse URL"
              autocomplete="off"
              spellcheck="false"
              @keydown.enter.prevent="saveCardFromDialog"
            />
          </div>
          <label v-if="cardProgressStage !== 'done'">
            Due by
            <input
              v-model="cardDueBy"
              type="date"
              class="due-input"
              :title="cardDueBy ? 'Due ' + cardDueBy : 'Optional due date'"
            />
          </label>
          <label>
            Work type
            <select
              v-model="cardKindId"
              class="kind-select dialog-kind-select"
              @change="onDialogKindChange"
            >
              <option
                v-for="kind in cardKinds()"
                :key="kind.id"
                :value="kind.id"
              >{{ kind.label }}</option>
            </select>
          </label>
          <fieldset class="card-dialog-progress">
            <legend>Progress</legend>
            <div class="card-progress dialog-progress" role="group" aria-label="Card progress">
              <button
                v-for="stage in dialogStages"
                :key="stage.id"
                type="button"
                class="progress-pill"
                :class="{
                  reached: progressIndex(cardProgressStage, cardKindId) >= progressIndex(stage.id, cardKindId),
                  current: cardProgressStage === stage.id,
                  done: cardProgressStage === 'done' && stage.id === 'done',
                }"
                :title="stage.label"
                :aria-pressed="cardProgressStage === stage.id"
                @click="cardProgressStage = stage.id"
              >{{ stage.label }}</button>
            </div>
          </fieldset>
        </div>
        <div class="card-dialog-side">
        <div class="card-dialog-checklist">
          <div class="card-dialog-field-heading">
            <span class="card-dialog-desc-label">Checklist</span>
            <span
              v-if="dialogChecklistProgress.total"
              class="checklist-count"
              :class="{ complete: dialogChecklistProgress.done === dialogChecklistProgress.total }"
            >{{ dialogChecklistProgress.done }}/{{ dialogChecklistProgress.total }}</span>
          </div>
          <span
            v-if="dialogChecklistProgress.total"
            class="checklist-bar checklist-bar-wide"
            :class="{ 'checklist-bar-complete': dialogChecklistProgress.done === dialogChecklistProgress.total }"
            aria-hidden="true"
          >
            <span :style="{ width: (dialogChecklistProgress.done / dialogChecklistProgress.total) * 100 + '%' }"></span>
          </span>
          <ul v-if="cardChecklist.length" class="checklist-edit">
            <li
              v-for="(item, index) in cardChecklist"
              :key="item.id"
              :class="{ done: item.done, dragging: checklistDragIndex === index }"
              @dragover="onChecklistItemDragOver($event, index)"
              @drop.prevent
            >
              <span
                class="checklist-handle"
                draggable="true"
                title="Drag to reorder"
                aria-hidden="true"
                @dragstart="onChecklistItemDragStart($event, index)"
                @dragend="checklistDragIndex = null"
              ><PhDotsSixVertical :size="14" weight="bold" /></span>
              <input v-model="item.done" type="checkbox" :aria-label="'Done: ' + item.text" />
              <input
                v-model="item.text"
                class="checklist-edit-text"
                type="text"
                :maxlength="CHECKLIST_ITEM_MAX_LENGTH"
                :aria-label="'Checklist item ' + (index + 1)"
                @keydown.enter.prevent="checklistDraftInput?.focus()"
                @keydown.backspace="onChecklistItemBackspace($event, index)"
              />
              <button
                type="button"
                class="btn-icon checklist-remove"
                title="Remove item"
                :aria-label="'Remove ' + item.text"
                @click="removeDialogChecklistItem(index)"
              ><PhX :size="14" /></button>
            </li>
          </ul>
          <input
            ref="checklistDraftInput"
            v-model="checklistDraft"
            class="checklist-draft"
            type="text"
            :maxlength="CHECKLIST_ITEM_MAX_LENGTH"
            placeholder="+ Add an item, press Enter"
            aria-label="New checklist item"
            autocomplete="off"
            @keydown.enter.prevent="addDialogChecklistItem"
          />
        </div>
        <div class="card-dialog-desc" :class="{ 'with-checklist': cardChecklist.length > 0 }">
          <span class="card-dialog-desc-label">Description</span>
          <textarea
            v-if="descEditing"
            ref="cardDescTextarea"
            v-model="cardDesc"
            maxlength="4000"
            placeholder="Optional details… Markdown supported (links, lists, `code`); CX-1831 becomes a link"
          ></textarea>
          <div
            v-else
            class="card-dialog-desc-view"
            role="button"
            tabindex="0"
            :title="cardDesc ? 'Click to edit' : 'Click to add a description'"
            @click="onDescViewClick"
            @keydown.enter.prevent="onDescViewKeydown"
            @keydown.space.prevent="onDescViewKeydown"
          >
            <div v-if="cardDesc" class="md-body" v-html="renderDescHtml(cardDesc)"></div>
            <span v-else class="card-dialog-desc-placeholder">Click to add a description…</span>
          </div>
        </div>
        </div>
      </div>
      <div class="dialog-actions">
        <button v-if="cardDeleteVisible" type="button" class="btn btn-danger" @click="deleteCardFromDialog">Archive</button>
        <button
          v-if="cardDialogCardId"
          type="button"
          class="btn"
          title="Copy a link to this card. Whoever opens it in their PeteyPlan can add a copy to their board."
          @click="copyCardShareLink"
        >
          <PhCheck v-if="shareLinkCopied" :size="15" weight="bold" />
          <PhLink v-else :size="15" weight="bold" />
          <span aria-live="polite">{{ shareLinkCopied ? 'Link copied' : 'Copy link' }}</span>
        </button>
        <span class="spacer"></span>
        <button type="button" class="btn" @click="closeCardDialog">Cancel</button>
        <button type="button" class="btn btn-primary" @click="saveCardFromDialog">Save</button>
      </div>
    </form>
  </dialog>

  <!-- Shared card dialog -->
  <dialog ref="shareDialogEl" class="share-dialog" aria-labelledby="share-dialog-title" @close="onShareDialogClose">
    <form v-if="sharedCard" method="dialog" class="dialog-form" @submit.prevent="addSharedCard">
      <h2 id="share-dialog-title">Shared card<span v-if="sharedCard.ref" class="card-dialog-ref">{{ sharedCard.ref }}</span></h2>
      <div class="share-preview">
        <p class="share-preview-title">{{ sharedCard.title }}</p>
        <p class="share-preview-meta">{{ sharedCardSummary }}</p>
        <div v-if="sharedCard.description" class="share-preview-desc md-body" v-html="renderDescHtml(sharedCard.description)"></div>
      </div>
      <div class="share-targets">
        <label>
          Board
          <select v-model="shareBoardId" class="kind-select dialog-kind-select" @change="loadShareColumns">
            <option v-for="entry in boards" :key="entry.id" :value="entry.id">{{ entry.emoji }} {{ entry.name }}</option>
          </select>
        </label>
        <label>
          Column
          <select v-model="shareColumnId" class="kind-select dialog-kind-select" :disabled="!shareColumns.length">
            <option v-for="col in shareColumns" :key="col.id" :value="col.id">{{ col.title }}</option>
          </select>
        </label>
      </div>
      <div class="dialog-actions">
        <span class="spacer"></span>
        <button type="button" class="btn" @click="closeShareDialog">Cancel</button>
        <button type="submit" class="btn btn-primary" autofocus :disabled="!shareColumnId || shareBusy">Add to board</button>
      </div>
    </form>
  </dialog>

  <!-- Release dialog -->
  <dialog ref="releaseDialogEl" class="release-dialog" @close="onReleaseDialogClose">
    <form method="dialog" class="dialog-form" @submit.prevent="saveReleaseFromDialog">
      <h2>Edit release</h2>
      <label>
        Title
        <input
          ref="releaseTitleInput"
          v-model="releaseTitle"
          type="text"
          maxlength="80"
          placeholder="Release name"
          autocomplete="off"
          @keydown.enter.prevent="saveReleaseFromDialog"
        />
      </label>
      <label>
        Week (Monday)
        <input
          v-model="releaseWeekStart"
          type="date"
          class="due-input"
          title="Monday of the release week. Preprod goes out that evening, prod the next day."
        />
      </label>
      <p class="release-dialog-schedule">
        Preprod {{ PREPROD_HINT }} · Prod {{ PROD_HINT }}
      </p>
      <div class="release-dialog-tickets">
        <div>
          <div class="card-dialog-field-heading">
            <label for="release-preprod-key">Preprod release</label>
            <a
              v-if="dialogPreprodKey"
              class="card-dialog-jira-open"
              :href="jiraBrowseUrl(dialogPreprodKey)"
              target="_blank"
              rel="noopener noreferrer"
            >Open in Jira</a>
          </div>
          <input
            id="release-preprod-key"
            v-model="releasePreprodKey"
            type="text"
            maxlength="200"
            placeholder="Jira key or browse URL"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div>
          <div class="card-dialog-field-heading">
            <label for="release-prod-key">Prod CM ticket</label>
            <a
              v-if="dialogProdKey"
              class="card-dialog-jira-open"
              :href="jiraBrowseUrl(dialogProdKey)"
              target="_blank"
              rel="noopener noreferrer"
            >Open in Jira</a>
          </div>
          <input
            id="release-prod-key"
            v-model="releaseProdKey"
            type="text"
            maxlength="200"
            placeholder="CM ticket key or browse URL"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-danger" @click="deleteReleaseFromDialog">Delete</button>
        <span class="spacer"></span>
        <button type="button" class="btn" @click="closeReleaseDialog">Cancel</button>
        <button type="button" class="btn btn-primary" @click="saveReleaseFromDialog">Save</button>
      </div>
    </form>
  </dialog>

  <!-- Column dialog -->
  <dialog ref="columnDialogEl" class="column-dialog" @close="onColumnDialogClose">
    <form method="dialog" class="dialog-form" @submit.prevent="saveColumnFromDialog">
      <h2>{{ columnDialogTitle }}</h2>
      <label>
        Column name
        <input
          ref="columnTitleInput"
          v-model="columnTitle"
          type="text"
          maxlength="60"
          placeholder="Column name"
          autocomplete="off"
          @keydown.enter.prevent="saveColumnFromDialog"
        />
      </label>
      <div class="dialog-actions">
        <span class="spacer"></span>
        <button type="button" class="btn" @click="closeColumnDialog">Cancel</button>
        <button type="button" class="btn btn-primary" @click="saveColumnFromDialog">Save</button>
      </div>
    </form>
  </dialog>

  <!-- Column dropdown menu -->
  <div
    v-if="columnMenu"
    ref="columnMenuEl"
    class="column-menu"
    :style="{ top: columnMenu.top + 'px', right: columnMenu.right + 'px' }"
  >
    <button @click="renameColumnFromMenu"><PhPencilSimple :size="15" />Rename</button>
    <button :disabled="!canMoveColumnLeft" @click="moveColumnLeftFromMenu"><PhArrowLeft :size="15" />Move left</button>
    <button :disabled="!canMoveColumnRight" @click="moveColumnRightFromMenu"><PhArrowRight :size="15" />Move right</button>
    <hr />
    <button
      class="danger"
      :disabled="columnMenuCardCount === 0"
      @click="clearColumnCardsFromMenu"
    ><PhArchive :size="15" />Archive all cards</button>
    <button class="danger" @click="deleteColumnFromMenu"><PhTrash :size="15" />Delete column</button>
  </div>

  <!-- Board dropdown menu -->
  <div
    v-if="boardMenu"
    ref="boardMenuEl"
    class="column-menu"
    :style="{ top: boardMenu.top + 'px', right: boardMenu.right + 'px' }"
  >
    <button @click="openSettings('appearance')"><PhGear :size="15" />Settings</button>
    <button @click="openSettings('boards')"><PhSquaresFour :size="15" />Manage boards</button>
    <button @click="openArchiveFromMenu"><PhArchive :size="15" />Archive</button>
  </div>

  <!-- Archive screen -->
  <dialog ref="archiveDialogEl" class="archive-dialog" @close="archivedCards = []">
    <div class="dialog-form archive-dialog-form">
      <div class="archive-dialog-header">
        <h2>Archive</h2>
        <p class="archive-dialog-hint">
          Done cards auto-archive after {{ ARCHIVE_AFTER_DAYS }} days. Soft-deleted cards are recoverable here.
        </p>
      </div>
      <div v-if="archiveLoading" class="archive-empty">Loading archive…</div>
      <div v-else-if="archivedCards.length === 0" class="archive-empty">No archived cards</div>
      <ul v-else class="archive-list">
        <li v-for="card in archivedCards" :key="card.id" class="archive-item">
          <div class="archive-item-main">
            <div class="archive-item-title"><span v-if="card.ref" class="card-ref">{{ card.ref }}</span> {{ card.title }}</div>
            <div class="archive-item-meta">
              <span>{{ kindDef(normalizeKind(card.kind)).label }}</span>
              <span v-if="card.columnTitle">· {{ card.columnTitle }}</span>
              <span v-if="card.archivedAt">· {{ formatArchivedAt(card.archivedAt) }}</span>
            </div>
            <div v-if="card.description" class="archive-item-desc">{{ card.description }}</div>
          </div>
          <div class="archive-item-actions">
            <button type="button" class="btn btn-primary" @click="restoreArchivedCard(card.id)">Restore</button>
            <button type="button" class="btn btn-danger" @click="permanentlyDeleteArchivedCard(card.id)">Delete</button>
          </div>
        </li>
      </ul>
      <div class="dialog-actions">
        <span class="spacer"></span>
        <button type="button" class="btn" @click="closeArchiveDialog">Close</button>
      </div>
    </div>
  </dialog>
</template>
