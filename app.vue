<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ARCHIVE_AFTER_DAYS,
  CARD_KINDS,
  DEFAULT_KIND,
  DEFAULT_PROGRESS,
  kindDef,
  normalizeKind,
  normalizeProgress,
  progressForKindChange,
  progressIndex,
  stagesForKind,
  type KindId,
  type ProgressId,
} from '~/shared/progress'

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
  releaseId?: string | null
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

const board = ref<Board>({ columns: [], releases: [] })
const loading = ref(true)
const error = ref<string | null>(null)
const searchQuery = ref('')
const releasesOpen = ref(false)
const releaseDropTarget = ref<string | null>(null)

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
  ]
    .join(' ')
    .toLowerCase()
  return hay.includes(q)
}

/** Columns with cards filtered by the live search query (view-only). */
const displayColumns = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) {
    return board.value.columns.map((col) => ({
      ...col,
      totalCount: col.cards.length,
    }))
  }
  return board.value.columns.map((col) => ({
    ...col,
    cards: col.cards.filter((c) => cardMatchesQuery(c, q)),
    totalCount: col.cards.length,
  }))
})

/* ── API client ────────────────────────────────────────────────────────────── */

async function api<T>(url: string, options?: RequestInit): Promise<T> {
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
    board.value = normalizeBoard(await api<Board>('/api/board'))
    error.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load board'
  } finally {
    loading.value = false
  }
}

async function refreshBoard() {
  try {
    board.value = normalizeBoard(await api<Board>('/api/board'))
    error.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to save'
  }
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
  if (isSearching.value || !dragged.value || draggedColumnId.value) return
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
  event.preventDefault()
  event.stopPropagation()
  const d = dragged.value
  releaseDropTarget.value = null
  if (d) {
    assignCardToRelease(d.cardId, releaseId)
  }
  document.removeEventListener('dragover', onDocumentDragOver)
  stopEdgeScroll()
  dragged.value = null
  draggingId.value = null
  dropIndicator.value = null
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
  kind: KindId = DEFAULT_KIND
) {
  const trimmed = title.trim()
  if (!trimmed || !findColumn(columnId)) return
  const normalizedKind = normalizeKind(kind)
  const payload = {
    title: trimmed,
    description: description.trim(),
    jiraKey: normalizeJiraKey(jiraKey),
    dueBy: dueBy.trim(),
    kind: normalizedKind,
    progress: normalizeProgress(progress, normalizedKind),
  }
  try {
    if (cardId) {
      await api(`/api/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
    } else {
      await api('/api/cards', {
        method: 'POST',
        body: JSON.stringify({ columnId, ...payload }),
      })
    }
    await refreshBoard()
  } catch (err) { fail(err) }
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
  draggingId.value = card.id
  draggedColumnId.value = null
  columnDropIndex.value = null
  document.addEventListener('dragover', onDocumentDragOver)
}

function onCardDragEnd() {
  document.removeEventListener('dragover', onDocumentDragOver)
  stopEdgeScroll()
  dragged.value = null
  draggingId.value = null
  dropIndicator.value = null
  releaseDropTarget.value = null
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
  columnDropIndex.value = null
  dragged.value = null
  draggingId.value = null
  dropIndicator.value = null
  document.addEventListener('dragover', onDocumentDragOver)
}

function onColumnHeaderDragEnd() {
  document.removeEventListener('dragover', onDocumentDragOver)
  stopEdgeScroll()
  draggedColumnId.value = null
  columnDropIndex.value = null
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
  const d = dragged.value
  const indicator = dropIndicator.value
  if (d && indicator && indicator.columnId === column.id) {
    moveCard(d.cardId, column.id, indicator.index)
  }
  document.removeEventListener('dragover', onDocumentDragOver)
  stopEdgeScroll()
  dragged.value = null
  draggingId.value = null
  dropIndicator.value = null
}

function onBoardDragOver(event: DragEvent) {
  if (!draggedColumnId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'

  const boardEl = event.currentTarget as HTMLElement
  const colEls = Array.from(boardEl.querySelectorAll<HTMLElement>('.column:not(.column-placeholder)')).filter(
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
  }
}

function onBoardDrop(event: DragEvent) {
  event.preventDefault()
  const columnId = draggedColumnId.value
  const index = columnDropIndex.value
  if (columnId != null && index != null) {
    moveColumn(columnId, index)
  }
  document.removeEventListener('dragover', onDocumentDragOver)
  stopEdgeScroll()
  draggedColumnId.value = null
  columnDropIndex.value = null
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
const cardKindId = ref<KindId>(DEFAULT_KIND)
const cardProgressStage = ref<ProgressId>(DEFAULT_PROGRESS)
const cardDeleteVisible = ref(false)
const cardDialogColumnId = ref<string | null>(null)
const cardDialogCardId = ref<string | null>(null)
const cardDialogRef = ref('')
const descEditing = ref(false)

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

function openCardDialog(columnId: string, cardId: string | null) {
  cardDialogColumnId.value = columnId
  cardDialogCardId.value = cardId
  if (cardId) {
    const card = findColumn(columnId)?.cards.find((c) => c.id === cardId)
    if (!card) return
    cardDialogTitle.value = 'Edit card'
    cardDialogRef.value = card.ref || ''
    cardTitle.value = card.title
    cardDesc.value = card.description || ''
    cardJiraKey.value = card.jiraKey || ''
    cardKindId.value = normalizeKind(card.kind)
    cardProgressStage.value = normalizeProgress(card.progress, cardKindId.value)
    cardDeleteVisible.value = true
    descEditing.value = false
  } else {
    cardDialogTitle.value = 'New card'
    cardDialogRef.value = ''
    cardTitle.value = ''
    cardDesc.value = ''
    cardJiraKey.value = ''
    cardDueBy.value = ''
    cardKindId.value = DEFAULT_KIND
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
  cardKindId.value = DEFAULT_KIND
  cardProgressStage.value = DEFAULT_PROGRESS
  descEditing.value = false
}

async function saveCardFromDialog() {
  await saveCard(
    cardDialogColumnId.value!,
    cardDialogCardId.value,
    cardTitle.value,
    cardDesc.value,
    cardJiraKey.value,
    cardDueBy.value,
    cardProgressStage.value,
    cardKindId.value
  )
  closeCardDialog()
}

async function deleteCardFromDialog() {
  if (cardDialogCardId.value) {
    await deleteCard(cardDialogCardId.value)
  }
  closeCardDialog()
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

function openColumnDialog(columnId: string | null) {
  const col = columnId ? findColumn(columnId) : null
  columnMode.value = col ? 'rename' : 'add'
  columnDialogColumnId.value = col?.id ?? null
  columnDialogTitle.value = col ? 'Rename column' : 'New column'
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

/** After scrolling a column, keep horizontal pan locked briefly so overscroll doesn't jump sideways. */
const COLUMN_SCROLL_UNLOCK_MS = 250
let columnScrollLockUntil = 0

/**
 * Wheel over a column scrolls that column vertically first.
 * Horizontal board pan unlocks 250ms after the last column scroll movement
 * (or immediately when not mid-column-scroll / outside a scrollable column).
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

  if (board.scrollWidth <= board.clientWidth + 1) return
  const delta = dominantHorizontal ? event.deltaX : event.deltaY
  if (!delta) return

  const max = board.scrollWidth - board.clientWidth
  const next = Math.min(max, Math.max(0, board.scrollLeft + delta))
  if (next === board.scrollLeft) return

  board.scrollLeft = next
  event.preventDefault()
}

watch(boardEl, (el, prev) => {
  prev?.removeEventListener('wheel', onBoardWheel)
  el?.addEventListener('wheel', onBoardWheel, { passive: false })
})

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown)
  loadBoard()
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMousedown)
  document.removeEventListener('dragover', onDocumentDragOver)
  stopEdgeScroll()
  boardEl.value?.removeEventListener('wheel', onBoardWheel)
})
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="logo"></span>
      <h1>PeteyPlan</h1>
    </div>
    <div class="topbar-actions">
      <label class="topbar-search">
        <span class="sr-only">Filter tasks</span>
        <input
          v-model="searchQuery"
          class="search-input"
          type="search"
          placeholder="Filter tasks…"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <button
        class="btn"
        :class="{ 'btn-active': releasesOpen }"
        :aria-expanded="releasesOpen"
        aria-controls="releases-panel"
        @click="toggleReleasesPanel"
      >Releases</button>
      <button class="btn btn-primary" @click="openColumnDialog(null)">+ Add Column</button>
      <button
        class="btn-icon board-menu-btn"
        :class="{ 'menu-open': !!boardMenu }"
        title="Board options"
        aria-label="Board options"
        @mousedown.stop
        @click="openBoardMenu($event)"
      >⋮</button>
    </div>
  </header>

  <div v-if="error" class="error-banner">
    <span>{{ error }}</span>
    <button class="btn-icon" title="Dismiss" @click="error = null">&times;</button>
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
      <button class="btn btn-primary" type="button" @click="addRelease">+ New release</button>
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
            >✎</button>
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
            >&times;</button>
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

  <main v-if="loading" class="board-loading">Loading board…</main>

  <main
    v-else
    ref="boardEl"
    class="board"
    aria-label="Kanban board"
    @dragover.prevent="onBoardDragOver"
    @dragleave="onBoardDragLeave"
    @drop.prevent="onBoardDrop"
  >
    <template v-for="(col, colIndex) in displayColumns" :key="col.id">
      <div v-if="isColumnDropIndicator(colIndex)" class="column column-placeholder" aria-hidden="true"></div>
      <section
        class="column"
        :class="{ dragging: draggedColumnId === col.id }"
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
          @mousedown.stop
          @click="openColumnMenu(col.id, $event)"
        >⋮</button>
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
            :class="{ dragging: draggingId === card.id }"
            :data-id="card.id"
            :draggable="!isSearching"
            @click="openCardUnlessLink($event, col.id, card.id)"
            @dragstart="onCardDragStart($event, col.id, card)"
            @dragend="onCardDragEnd"
          >
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
              class="card-status"
              @click.stop
              @mousedown.stop
            >
              <label class="card-kind">
                <span class="sr-only">Work type</span>
                <select
                  class="kind-select"
                  :value="cardKind(card)"
                  :title="'Work type'"
                  :aria-label="'Work type for ' + (card.title || 'card')"
                  @change="onCardKindChange(card.id, $event)"
                >
                  <option
                    v-for="kind in CARD_KINDS"
                    :key="kind.id"
                    :value="kind.id"
                  >{{ kind.label }}</option>
                </select>
              </label>
              <div
                class="card-progress"
                role="group"
                :aria-label="'Progress: ' + (cardStages(card).find((s) => s.id === cardProgress(card))?.label || 'Todo')"
              >
                <button
                  v-for="stage in cardStages(card)"
                  :key="stage.id"
                  type="button"
                  class="progress-pill"
                  :class="{
                    reached: isProgressReached(card, stage.id),
                    current: isProgressCurrent(card, stage.id),
                    done: cardProgress(card) === 'done' && stage.id === 'done',
                  }"
                  :title="stage.label"
                  :aria-label="'Set progress to ' + stage.label"
                  :aria-pressed="isProgressCurrent(card, stage.id)"
                  @click="setCardProgress(card.id, stage.id)"
                >{{ stage.label }}</button>
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
        <button class="add-card" @click="openCardDialog(col.id, null)">+ Add card</button>
      </div>
    </section>
    </template>
    <div
      v-if="isColumnDropIndicator(board.columns.length)"
      class="column column-placeholder"
      aria-hidden="true"
    ></div>
  </main>

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
                v-for="kind in CARD_KINDS"
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
        <div class="card-dialog-desc">
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
      <div class="dialog-actions">
        <button v-if="cardDeleteVisible" type="button" class="btn btn-danger" @click="deleteCardFromDialog">Archive</button>
        <span class="spacer"></span>
        <button type="button" class="btn" @click="closeCardDialog">Cancel</button>
        <button type="button" class="btn btn-primary" @click="saveCardFromDialog">Save</button>
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
          title="Monday of the release week — preprod that evening, prod next day"
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
    <button @click="renameColumnFromMenu">Rename column</button>
    <button :disabled="!canMoveColumnLeft" @click="moveColumnLeftFromMenu">Move left</button>
    <button :disabled="!canMoveColumnRight" @click="moveColumnRightFromMenu">Move right</button>
    <button
      class="danger"
      :disabled="columnMenuCardCount === 0"
      @click="clearColumnCardsFromMenu"
    >Archive all cards</button>
    <button class="danger" @click="deleteColumnFromMenu">Delete column</button>
  </div>

  <!-- Board dropdown menu -->
  <div
    v-if="boardMenu"
    ref="boardMenuEl"
    class="column-menu"
    :style="{ top: boardMenu.top + 'px', right: boardMenu.right + 'px' }"
  >
    <button @click="openArchiveFromMenu">Archive</button>
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