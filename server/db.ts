import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  ARCHIVE_AFTER_DAYS,
  DEFAULT_KIND,
  DEFAULT_PROGRESS,
  normalizeKind,
  normalizeProgress,
  progressForKindChange,
  type KindId,
  type ProgressId,
} from './utils/progress'
import { normalizeChecklist, type ChecklistItem } from '../shared/checklist'

/**
 * SQLite data layer for PeteyPlan.
 *
 * The database file lives in the directory pointed to by DATA_DIR
 * (defaults to <project>/data). Persist that directory as a Docker
 * volume so the board survives container restarts / upgrades.
 */

const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data')
mkdirSync(dataDir, { recursive: true })

const db = new Database(path.join(dataDir, 'peteyplan.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS columns (
    id       TEXT PRIMARY KEY,
    title    TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS cards (
    id            TEXT PRIMARY KEY,
    column_id     TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
    number        INTEGER,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    jira_key      TEXT NOT NULL DEFAULT '',
    due_by        TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL DEFAULT 'development',
    progress      TEXT NOT NULL DEFAULT 'todo',
    position      INTEGER NOT NULL DEFAULT 0,
    completed_at  TEXT,
    archived_at   TEXT,
    viewed_at     TEXT,
    checklist     TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS releases (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    week_start   TEXT NOT NULL,
    preprod_key  TEXT NOT NULL DEFAULT '',
    prod_key     TEXT NOT NULL DEFAULT '',
    position     INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_columns_position ON columns (position);
  CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards (column_id, position);
  CREATE INDEX IF NOT EXISTS idx_releases_week ON releases (week_start);
  CREATE INDEX IF NOT EXISTS idx_releases_position ON releases (position);
`)

// Lightweight migrations for DBs created before newer card columns existed.
const cardColumns = db.prepare('PRAGMA table_info(cards)').all() as { name: string }[]
const cardColumnNames = new Set(cardColumns.map((c) => c.name))
if (!cardColumnNames.has('jira_key')) {
  db.exec(`ALTER TABLE cards ADD COLUMN jira_key TEXT NOT NULL DEFAULT ''`)
}
if (!cardColumnNames.has('due_by')) {
  db.exec(`ALTER TABLE cards ADD COLUMN due_by TEXT NOT NULL DEFAULT ''`)
}
if (!cardColumnNames.has('progress')) {
  db.exec(`ALTER TABLE cards ADD COLUMN progress TEXT NOT NULL DEFAULT 'todo'`)
}
if (!cardColumnNames.has('kind')) {
  db.exec(`ALTER TABLE cards ADD COLUMN kind TEXT NOT NULL DEFAULT 'development'`)
}
if (!cardColumnNames.has('completed_at')) {
  db.exec(`ALTER TABLE cards ADD COLUMN completed_at TEXT`)
}
if (!cardColumnNames.has('archived_at')) {
  db.exec(`ALTER TABLE cards ADD COLUMN archived_at TEXT`)
}
if (!cardColumnNames.has('release_id')) {
  db.exec(`ALTER TABLE cards ADD COLUMN release_id TEXT`)
}
if (!cardColumnNames.has('viewed_at')) {
  // NULL = unopened since creation (or since this migration for pre-existing cards).
  db.exec(`ALTER TABLE cards ADD COLUMN viewed_at TEXT`)
}
if (!cardColumnNames.has('checklist')) {
  db.exec(`ALTER TABLE cards ADD COLUMN checklist TEXT NOT NULL DEFAULT '[]'`)
}
if (!cardColumnNames.has('number')) {
  db.exec(`ALTER TABLE cards ADD COLUMN number INTEGER`)
  // Backfill existing cards in creation order so refs are stable.
  db.exec(`
    UPDATE cards
    SET number = (
      SELECT COUNT(*) FROM cards c2 WHERE c2.rowid <= cards.rowid
    )
    WHERE number IS NULL
  `)
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_cards_release ON cards (release_id)`)

// Monotonic card-number counter — never reuses numbers of deleted cards.
db.exec(`CREATE TABLE IF NOT EXISTS card_counter (id INTEGER PRIMARY KEY CHECK (id = 1), next INTEGER NOT NULL)`)
{
  const maxRow = db.prepare('SELECT COALESCE(MAX(number), 0) AS m FROM cards').get() as { m: number }
  const row = db.prepare('SELECT next FROM card_counter WHERE id = 1').get() as { next: number } | undefined
  if (!row) {
    db.prepare('INSERT INTO card_counter (id, next) VALUES (1, ?)').run(maxRow.m + 1)
  } else if (row.next <= maxRow.m) {
    db.prepare('UPDATE card_counter SET next = ? WHERE id = 1').run(maxRow.m + 1)
  }
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_number ON cards (number)`)
 
// Index depends on archived_at / number — create only after migrations above.
 db.exec(`CREATE INDEX IF NOT EXISTS idx_cards_archived ON cards (archived_at)`)

export { ARCHIVE_AFTER_DAYS }

function nowIso(): string {
  return new Date().toISOString()
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

// Existing Done cards without a completion time start the 5-day clock now.
db.prepare(
  `UPDATE cards
   SET completed_at = ?
   WHERE progress = 'done' AND completed_at IS NULL AND archived_at IS NULL`
).run(nowIso())

export const DEFAULT_BOARD_ID = 'board-default'

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    color TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );
`)
const firstBoardMigration = !db.prepare('SELECT 1 FROM boards WHERE id = ?').get(DEFAULT_BOARD_ID)
db.prepare('INSERT OR IGNORE INTO boards (id, name, emoji, color) VALUES (?, ?, ?, ?)').run(
  DEFAULT_BOARD_ID, 'Default Board', '📋', '#5b8cff'
)
for (const table of ['columns', 'releases']) {
  const fields = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!fields.some((field) => field.name === 'board_id')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN board_id TEXT NOT NULL DEFAULT 'board-default'`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_board ON ${table} (board_id, position)`)
}

// Seed only a fresh database, not an intentionally empty default board.
const DEFAULT_COLUMNS = [
  { id: 'col-backlog', title: 'Backlog' },
  { id: 'col-todo', title: 'To Do' },
  { id: 'col-progress', title: 'In Progress' },
  { id: 'col-done', title: 'Done' },
]

const colCount = db.prepare('SELECT COUNT(*) AS n FROM columns').get() as { n: number }
if (colCount.n === 0 && firstBoardMigration) {
  const insert = db.prepare('INSERT INTO columns (id, title, position) VALUES (?, ?, ?)')
  db.transaction(() => {
    DEFAULT_COLUMNS.forEach((col, i) => insert.run(col.id, col.title, i))
  })()
}

export interface BoardInfo {
  id: string
  name: string
  emoji: string
  color: string
  isDefault: boolean
}

export function getBoards(): BoardInfo[] {
  return (db.prepare('SELECT id, name, emoji, color FROM boards ORDER BY position, rowid').all() as
    Omit<BoardInfo, 'isDefault'>[]).map((board) => ({ ...board, isDefault: board.id === DEFAULT_BOARD_ID }))
}

export function hasBoard(id: string): boolean {
  return !!db.prepare('SELECT 1 FROM boards WHERE id = ?').get(id)
}

export function createBoard(name: string, emoji: string, color: string): BoardInfo {
  const id = uid('board')
  const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM boards').get() as { n: number }).n
  db.prepare('INSERT INTO boards (id, name, emoji, color, position) VALUES (?, ?, ?, ?, ?)').run(id, name, emoji, color, position)
  return { id, name, emoji, color, isDefault: false }
}

export function updateBoard(id: string, changes: { name?: string; emoji?: string; color?: string }): BoardInfo | undefined {
  const board = getBoards().find((entry) => entry.id === id)
  if (!board) return undefined
  const updated = { ...board, ...changes }
  db.prepare('UPDATE boards SET name = ?, emoji = ?, color = ? WHERE id = ?').run(updated.name, updated.emoji, updated.color, id)
  return updated
}

export function deleteBoard(id: string): boolean {
  if (id === DEFAULT_BOARD_ID || !hasBoard(id)) return false
  db.transaction(() => {
    db.prepare('DELETE FROM columns WHERE board_id = ?').run(id)
    db.prepare('DELETE FROM releases WHERE board_id = ?').run(id)
    db.prepare('DELETE FROM boards WHERE id = ?').run(id)
  })()
  return true
}

/* ── Public types ──────────────────────────────────────────────────────────── */

export interface Column {
  id: string
  title: string
  cards: Card[]
}

export interface Card {
  id: string
  /** Monotonic card number; user-facing ref is `PP-<number>` */
  number: number
  /** Stable human ref, e.g. `PP-12` — use in MCP/API/UI */
  ref: string
  title: string
  description: string
  jiraKey: string
  /** ISO date YYYY-MM-DD, or '' if unset */
  dueBy: string
  /** Work kind: development | chore | managing */
  kind: KindId
  /** Kind-specific progress stage */
  progress: ProgressId
  /** ISO datetime when progress became Done, or null */
  completedAt: string | null
  /** ISO datetime when soft-archived, or null */
  archivedAt: string | null
  /** ISO datetime when first opened in the UI, or null if never viewed */
  viewedAt: string | null
  columnId: string
  /** Assigned release folder id, or null */
  releaseId: string | null
  /** To-do items inside the card */
  checklist: ChecklistItem[]
}

export interface Release {
  id: string
  title: string
  /** Monday of the release week (YYYY-MM-DD) */
  weekStart: string
  /** Fixed schedule labels for the UI */
  preprodSchedule: string
  prodSchedule: string
  /** Atlassian Jira keys (preprod release + prod CM ticket) */
  preprodKey: string
  prodKey: string
  cards: Card[]
}

export interface ArchivedCard extends Card {
  columnTitle: string | null
}

interface ColumnRow { id: string; title: string; position: number; board_id: string }
interface ReleaseRow {
  board_id: string
  id: string
  title: string
  week_start: string
  preprod_key: string
  prod_key: string
  position: number
}
interface CardRow {
  id: string
  column_id: string
  number: number | null
  title: string
  description: string
  jira_key: string
  due_by: string
  kind: string
  progress: string
  position: number
  completed_at: string | null
  archived_at: string | null
  release_id: string | null
  viewed_at: string | null
  checklist: string
}

/** Prefix for user-facing card refs (`PP-12`). */
export const CARD_REF_PREFIX = 'PP'

export function cardRef(number: number): string {
  return `${CARD_REF_PREFIX}-${number}`
}

/** Parse `PP-12` (case-insensitive, surrounding whitespace ok) to `12`, else `null`. */
export function parseCardRef(ref: string): number | null {
  const m = /^\s*PP-(\d+)\s*$/i.exec(ref)
  if (!m) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Preprod window: Monday 17:00. Prod go-live: Tuesday 17:00. */
export const PREPROD_SCHEDULE_LABEL = 'Monday 17:00'
export const PROD_SCHEDULE_LABEL = 'Tuesday 17:00'

function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Next Monday on/after `from` (local calendar date). */
export function nextMondayIso(from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const day = d.getDay() // 0 Sun … 6 Sat
  const add = day === 0 ? 1 : day === 1 ? 0 : 8 - day
  d.setDate(d.getDate() + add)
  return isoDate(d)
}

/** Monday strictly after `weekStart` (YYYY-MM-DD). */
export function mondayAfter(weekStart: string): string {
  const [y, m, d] = weekStart.split('-').map(Number)
  const date = new Date(y, (m || 1) - 1, d || 1)
  date.setDate(date.getDate() + 7)
  return isoDate(date)
}

export function defaultReleaseTitle(weekStart: string): string {
  const [y, m, d] = weekStart.split('-').map(Number)
  if (!y || !m || !d) return `Release ${weekStart}`
  const label = new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  return `Release ${label}`
}

function toCard(row: CardRow): Card {
  const kind = normalizeKind(row.kind)
  const number = row.number ?? 0
  return {
    id: row.id,
    number,
    ref: cardRef(number),
    title: row.title,
    description: row.description,
    jiraKey: row.jira_key || '',
    dueBy: row.due_by || '',
    kind,
    progress: normalizeProgress(row.progress, kind),
    completedAt: row.completed_at || null,
    archivedAt: row.archived_at || null,
    viewedAt: row.viewed_at || null,
    columnId: row.column_id,
    releaseId: row.release_id || null,
    checklist: normalizeChecklist(row.checklist),
  }
}

function toRelease(row: ReleaseRow, cards: Card[] = []): Release {
  return {
    id: row.id,
    title: row.title,
    weekStart: row.week_start,
    preprodSchedule: PREPROD_SCHEDULE_LABEL,
    prodSchedule: PROD_SCHEDULE_LABEL,
    preprodKey: row.preprod_key || '',
    prodKey: row.prod_key || '',
    cards,
  }
}

/** Sort: soonest due first, undated last, then manual position. */
const CARD_ORDER_SQL = `
  CASE WHEN due_by IS NULL OR due_by = '' THEN 1 ELSE 0 END ASC,
  due_by ASC,
  position ASC,
  rowid ASC
`

/* ── Helpers ───────────────────────────────────────────────────────────────── */

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Rewrite positions in a column so sooner due dates sit nearer the top.
 * Undated cards keep relative order below dated ones.
 */
export function rerankColumnByDue(columnId: string): void {
  const ordered = db
    .prepare(
      `SELECT id FROM cards
       WHERE column_id = ? AND archived_at IS NULL
       ORDER BY ${CARD_ORDER_SQL}`
    )
    .all(columnId) as { id: string }[]
  const update = db.prepare('UPDATE cards SET position = ? WHERE id = ?')
  db.transaction(() => {
    ordered.forEach((row, index) => update.run(index, row.id))
  })()
}

/**
 * Soft-archive Done cards whose completed_at is older than ARCHIVE_AFTER_DAYS.
 * Called opportunistically on board/archive reads.
 */
export function archiveStaleDoneCards(): number {
  const cutoff = daysAgoIso(ARCHIVE_AFTER_DAYS)
  const res = db
    .prepare(
      `UPDATE cards
       SET archived_at = ?
       WHERE archived_at IS NULL
         AND progress = 'done'
         AND completed_at IS NOT NULL
         AND completed_at <= ?`
    )
    .run(nowIso(), cutoff)
  return res.changes
}

function resolveCompletedAt(
  progress: ProgressId,
  previousProgress: string,
  previousCompletedAt: string | null
): string | null {
  if (progress === 'done') {
    return previousProgress === 'done' && previousCompletedAt ? previousCompletedAt : nowIso()
  }
  return null
}

/** Atomically claim the next monotonic card number. */
function nextCardNumber(): number {
  const row = db
    .prepare('UPDATE card_counter SET next = next + 1 WHERE id = 1 RETURNING next - 1 AS n')
    .get() as { n: number } | undefined
  if (row) return row.n
  // Counter row missing (unexpected) — rebuild from max and retry.
  const maxRow = db.prepare('SELECT COALESCE(MAX(number), 0) AS m FROM cards').get() as { m: number }
  db.prepare('INSERT OR IGNORE INTO card_counter (id, next) VALUES (1, ?)').run(maxRow.m + 1)
  return (db.prepare('UPDATE card_counter SET next = next + 1 WHERE id = 1 RETURNING next - 1 AS n').get() as { n: number }).n
}
/** Map a user-facing `PP-12` ref (or raw card id) to the internal card id. */
export function resolveCardId(refOrId: string): string {
  const n = parseCardRef(refOrId)
  if (n === null) return refOrId
  const row = db.prepare('SELECT id FROM cards WHERE number = ?').get(n) as { id: string } | undefined
  return row ? row.id : refOrId
}

/* ── Queries ───────────────────────────────────────────────────────────────── */

export function getBoard(boardId = DEFAULT_BOARD_ID): { columns: Column[]; releases: Release[] } {
  archiveStaleDoneCards()

  const columns = db
    .prepare('SELECT * FROM columns WHERE board_id = ? ORDER BY position ASC, rowid ASC')
    .all(boardId) as ColumnRow[]
  const cards = db
    .prepare(
      `SELECT id, column_id, number, title, description, jira_key, due_by, kind, progress, position,
              completed_at, archived_at, release_id, viewed_at, checklist
       FROM cards
       WHERE archived_at IS NULL AND column_id IN (SELECT id FROM columns WHERE board_id = ?)
       ORDER BY ${CARD_ORDER_SQL}`
    )
    .all(boardId) as CardRow[]

  const byColumn = new Map<string, Card[]>()
  const cardById = new Map<string, Card>()
  for (const row of cards) {
    const card = toCard(row)
    cardById.set(card.id, card)
    const list = byColumn.get(row.column_id) || []
    list.push(card)
    byColumn.set(row.column_id, list)
  }

  return {
    columns: columns.map((col) => ({
      id: col.id,
      title: col.title,
      cards: byColumn.get(col.id) || [],
    })),
    releases: getReleases(cardById, boardId),
  }
}

export function getRelease(id: string): ReleaseRow | undefined {
  return db
    .prepare('SELECT * FROM releases WHERE id = ?')
    .get(id) as ReleaseRow | undefined
}

export function getCardRow(id: string): CardRow | undefined {
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
}

export function getReleases(cardById?: Map<string, Card>, boardId = DEFAULT_BOARD_ID): Release[] {
  const rows = db
    .prepare(
      `SELECT *
       FROM releases
       WHERE board_id = ?
       ORDER BY week_start ASC, position ASC, rowid ASC`
    )
    .all(boardId) as ReleaseRow[]

  let cardsMap = cardById
  if (!cardsMap) {
    const cards = db
      .prepare(
        `SELECT id, column_id, number, title, description, jira_key, due_by, kind, progress, position,
                completed_at, archived_at, release_id, viewed_at, checklist
         FROM cards
         WHERE archived_at IS NULL AND release_id IS NOT NULL
         ORDER BY ${CARD_ORDER_SQL}`
      )
      .all() as CardRow[]
    cardsMap = new Map(cards.map((row) => [row.id, toCard(row)]))
  }

  const byRelease = new Map<string, Card[]>()
  for (const card of cardsMap.values()) {
    if (!card.releaseId) continue
    const list = byRelease.get(card.releaseId) || []
    list.push(card)
    byRelease.set(card.releaseId, list)
  }

  return rows.map((row) => toRelease(row, byRelease.get(row.id) || []))
}

/** First unused Monday on/after today (or after the latest existing release). */
export function suggestNextWeekStart(boardId = DEFAULT_BOARD_ID): string {
  const latest = db
    .prepare('SELECT week_start FROM releases WHERE board_id = ? ORDER BY week_start DESC LIMIT 1')
    .get(boardId) as { week_start: string } | undefined
  let candidate = nextMondayIso()
  if (latest?.week_start && latest.week_start >= candidate) {
    candidate = mondayAfter(latest.week_start)
  }
  while (db.prepare('SELECT 1 FROM releases WHERE week_start = ? AND board_id = ?').get(candidate, boardId)) {
    candidate = mondayAfter(candidate)
  }
  return candidate
}

export function addRelease(input: {
  title?: string
  weekStart?: string
  preprodKey?: string
  prodKey?: string
}, boardId = DEFAULT_BOARD_ID): Release {
  const weekStart = input.weekStart && /^\d{4}-\d{2}-\d{2}$/.test(input.weekStart)
    ? input.weekStart
    : suggestNextWeekStart(boardId)
  const title = (input.title || '').trim() || defaultReleaseTitle(weekStart)
  const position =
    (db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM releases').get() as { m: number }).m + 1
  const row: ReleaseRow = {
    board_id: boardId,
    id: uid('rel'),
    title,
    week_start: weekStart,
    preprod_key: input.preprodKey || '',
    prod_key: input.prodKey || '',
    position,
  }
  db.prepare(
    `INSERT INTO releases (id, title, week_start, preprod_key, prod_key, position, board_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.title, row.week_start, row.preprod_key, row.prod_key, row.position, boardId)
  return toRelease(row, [])
}

export function updateRelease(
  id: string,
  changes: {
    title?: string
    weekStart?: string
    preprodKey?: string
    prodKey?: string
  }
): Release | undefined {
  const existing = getRelease(id)
  if (!existing) return undefined

  const title = changes.title !== undefined ? changes.title.trim() || existing.title : existing.title
  const week_start =
    changes.weekStart !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(changes.weekStart)
      ? changes.weekStart
      : existing.week_start
  const preprod_key = changes.preprodKey !== undefined ? changes.preprodKey : existing.preprod_key
  const prod_key = changes.prodKey !== undefined ? changes.prodKey : existing.prod_key

  db.prepare(
    `UPDATE releases SET title = ?, week_start = ?, preprod_key = ?, prod_key = ? WHERE id = ?`
  ).run(title, week_start, preprod_key, prod_key, id)

  const updated = getRelease(id)!
  const cards = getReleases(undefined, existing.board_id).find((r) => r.id === id)?.cards || []
  return toRelease(updated, cards)
}

export function deleteRelease(id: string): boolean {
  if (!getRelease(id)) return false
  db.transaction(() => {
    db.prepare('UPDATE cards SET release_id = NULL WHERE release_id = ?').run(id)
    db.prepare('DELETE FROM releases WHERE id = ?').run(id)
  })()
  return true
}

export function setCardRelease(cardId: string, releaseId: string | null): CardRow | undefined {
  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as CardRow | undefined
  if (!existing || existing.archived_at) return undefined
  if (releaseId && getRelease(releaseId)?.board_id !== getColumn(existing.column_id)?.board_id) return undefined
  db.prepare('UPDATE cards SET release_id = ? WHERE id = ?').run(releaseId, cardId)
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as CardRow
}

export function getArchivedCards(boardId = DEFAULT_BOARD_ID): ArchivedCard[] {
  archiveStaleDoneCards()

  const rows = db
    .prepare(
      `SELECT c.id, c.column_id, c.number, c.title, c.description, c.jira_key, c.due_by, c.kind, c.progress,
              c.position, c.completed_at, c.archived_at, c.release_id, c.viewed_at, c.checklist, col.title AS column_title
       FROM cards c
       LEFT JOIN columns col ON col.id = c.column_id
       WHERE c.archived_at IS NOT NULL AND col.board_id = ?
       ORDER BY c.archived_at DESC, c.rowid DESC`
    )
    .all(boardId) as (CardRow & { column_title: string | null })[]

  return rows.map((row) => ({
    ...toCard(row),
    columnTitle: row.column_title,
  }))
}

export function getColumn(id: string): ColumnRow | undefined {
  return db.prepare('SELECT * FROM columns WHERE id = ?').get(id) as ColumnRow | undefined
}

/* ── Column mutations ─────────────────────────────────────────────────────── */

export function addColumn(title: string, boardId = DEFAULT_BOARD_ID): Column {
  const col: ColumnRow = { id: uid('col'), title, position: 0, board_id: boardId }
  col.position = (db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM columns WHERE board_id = ?').get(boardId) as { m: number }).m + 1
  db.prepare('INSERT INTO columns (id, title, position, board_id) VALUES (?, ?, ?, ?)').run(col.id, col.title, col.position, boardId)
  return { id: col.id, title: col.title, cards: [] }
}

export function renameColumn(id: string, title: string): boolean {
  const res = db.prepare('UPDATE columns SET title = ? WHERE id = ?').run(title, id)
  return res.changes > 0
}

export function deleteColumn(id: string): boolean {
  const res = db.prepare('DELETE FROM columns WHERE id = ?').run(id)
  return res.changes > 0
}

/** Soft-archive every active card in a column; keeps the column itself. */
export function clearColumnCards(columnId: string): boolean {
  if (!getColumn(columnId)) return false
  const ts = nowIso()
  db.prepare(
    `UPDATE cards
     SET archived_at = ?, completed_at = COALESCE(completed_at, ?)
     WHERE column_id = ? AND archived_at IS NULL`
  ).run(ts, ts, columnId)
  return true
}

/**
 * Sets the full left-to-right column order. `orderedIds` must be the complete
 * list of column ids (client truth after a drag & drop).
 */
export function reorderColumns(orderedIds: string[], boardId = DEFAULT_BOARD_ID): boolean {
  if (orderedIds.length === 0) return false

  const existing = db.prepare('SELECT id FROM columns WHERE board_id = ?').all(boardId) as { id: string }[]
  const existingIds = new Set(existing.map((row) => row.id))
  if (orderedIds.length !== existingIds.size) return false
  if (new Set(orderedIds).size !== orderedIds.length) return false
  if (!orderedIds.every((id) => existingIds.has(id))) return false

  const update = db.prepare('UPDATE columns SET position = ? WHERE id = ?')
  db.transaction(() => {
    orderedIds.forEach((id, index) => update.run(index, id))
  })()
  return true
}

/* ── Card mutations ───────────────────────────────────────────────────────── */

export function addCard(
  columnId: string,
  title: string,
  description: string,
  jiraKey = '',
  dueBy = '',
  progress: ProgressId = DEFAULT_PROGRESS,
  kind: KindId = DEFAULT_KIND,
  /** When true (UI create), card starts viewed so no unread dot. MCP/API leave null. */
  markViewed = false,
  checklist: ChecklistItem[] = []
): CardRow | undefined {
  if (!getColumn(columnId)) return undefined
  const position =
    (db
      .prepare(
        `SELECT COALESCE(MAX(position), -1) AS m FROM cards
         WHERE column_id = ? AND archived_at IS NULL`
      )
      .get(columnId) as { m: number }).m + 1
  const normalizedKind = normalizeKind(kind)
  const normalizedProgress = normalizeProgress(progress, normalizedKind)
  const completed_at = normalizedProgress === 'done' ? nowIso() : null
  const viewed_at = markViewed ? nowIso() : null
  const card: CardRow = {
    id: uid('card'),
    column_id: columnId,
    number: nextCardNumber(),
    title,
    description,
    jira_key: jiraKey,
    due_by: dueBy,
    kind: normalizedKind,
    progress: normalizedProgress,
    position,
    completed_at,
    archived_at: null,
    release_id: null,
    viewed_at,
    checklist: JSON.stringify(normalizeChecklist(checklist)),
  }
  db.prepare(
    `INSERT INTO cards
     (id, column_id, number, title, description, jira_key, due_by, kind, progress, position, completed_at, archived_at, release_id, viewed_at, checklist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    card.id,
    card.column_id,
    card.number,
    card.title,
    card.description,
    card.jira_key,
    card.due_by,
    card.kind,
    card.progress,
    card.position,
    card.completed_at,
    card.archived_at,
    card.release_id,
    card.viewed_at,
    card.checklist
  )
  rerankColumnByDue(columnId)
  const ranked = db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id) as CardRow
  return ranked
}

export function updateCard(
  id: string,
  changes: {
    title?: string
    description?: string
    jiraKey?: string
    dueBy?: string
    kind?: KindId
    progress?: ProgressId
    column_id?: string
    releaseId?: string | null
    /** Set true to mark the card as viewed */
    viewed?: boolean
    checklist?: ChecklistItem[]
  }
): CardRow | undefined {
  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
  if (!existing || existing.archived_at) return undefined

  const title = changes.title !== undefined ? changes.title : existing.title
  const description = changes.description !== undefined ? changes.description : existing.description
  const jira_key = changes.jiraKey !== undefined ? changes.jiraKey : existing.jira_key
  const due_by = changes.dueBy !== undefined ? changes.dueBy : existing.due_by
  const fromKind = normalizeKind(existing.kind)
  const kind = changes.kind !== undefined ? normalizeKind(changes.kind) : fromKind
  const progress =
    changes.progress !== undefined
      ? normalizeProgress(changes.progress, kind)
      : changes.kind !== undefined
        ? progressForKindChange(existing.progress, fromKind, kind)
        : normalizeProgress(existing.progress, kind)
  const completed_at = resolveCompletedAt(progress, existing.progress, existing.completed_at)
  let release_id = existing.release_id
  if (changes.releaseId !== undefined) {
    if (changes.releaseId && getRelease(changes.releaseId)?.board_id !== getColumn(existing.column_id)?.board_id) return undefined
    release_id = changes.releaseId
  }
  const viewed_at =
    changes.viewed === true && !existing.viewed_at ? nowIso() : existing.viewed_at
  const checklist =
    changes.checklist !== undefined ? JSON.stringify(normalizeChecklist(changes.checklist)) : existing.checklist
  db.prepare(
    `UPDATE cards
     SET title = ?, description = ?, jira_key = ?, due_by = ?, kind = ?, progress = ?, completed_at = ?, release_id = ?, viewed_at = ?, checklist = ?
     WHERE id = ?`
  ).run(title, description, jira_key, due_by, kind, progress, completed_at, release_id, viewed_at, checklist, id)

  rerankColumnByDue(existing.column_id)
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow
}

/** Soft-archive a card (recoverable from the archive screen). */
export function archiveCard(id: string): boolean {
  const existing = db.prepare('SELECT column_id, archived_at FROM cards WHERE id = ?').get(id) as
    | { column_id: string; archived_at: string | null }
    | undefined
  if (!existing || existing.archived_at) return false
  const ts = nowIso()
  const res = db
    .prepare(
      `UPDATE cards
       SET archived_at = ?, completed_at = COALESCE(completed_at, ?)
       WHERE id = ?`
    )
    .run(ts, ts, id)
  if (res.changes > 0) rerankColumnByDue(existing.column_id)
  return res.changes > 0
}

/** Restore a soft-archived card onto the board. */
export function restoreCard(id: string, columnId?: string): CardRow | undefined {
  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
  if (!existing || !existing.archived_at) return undefined

  const targetColumnId = columnId || existing.column_id
  if (!getColumn(targetColumnId) || getColumn(targetColumnId)?.board_id !== getColumn(existing.column_id)?.board_id) {
    return undefined
  }

  const position =
    (db
      .prepare(
        `SELECT COALESCE(MAX(position), -1) AS m FROM cards
         WHERE column_id = ? AND archived_at IS NULL`
      )
      .get(targetColumnId) as { m: number }).m + 1

  // Leaving Done clears the clock; staying Done restarts the 5-day auto-archive window.
  const progress = normalizeProgress(existing.progress, normalizeKind(existing.kind))
  const completed_at = progress === 'done' ? nowIso() : null

  db.prepare(
    `UPDATE cards
     SET column_id = ?, position = ?, archived_at = NULL, completed_at = ?
     WHERE id = ?`
  ).run(targetColumnId, position, completed_at, id)

  rerankColumnByDue(targetColumnId)
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow
}

/** Permanently remove a card (active or archived). */
export function deleteCard(id: string): boolean {
  const existing = db.prepare('SELECT column_id, archived_at FROM cards WHERE id = ?').get(id) as
    | { column_id: string; archived_at: string | null }
    | undefined
  const res = db.prepare('DELETE FROM cards WHERE id = ?').run(id)
  if (res.changes > 0 && existing && !existing.archived_at) {
    rerankColumnByDue(existing.column_id)
  }
  return res.changes > 0
}

/**
 * Sets the full card order for a column. `orderedIds` is the complete,
 * final list of card ids for that column (client truth after a drag & drop,
 * which handles both cross-column moves and intra-column reordering).
 * After applying the drop, the column is re-ranked by due date so sooner
 * dues stay nearer the top (manual order is kept among equal/undated cards).
 */
export function reorderCards(columnId: string, orderedIds: string[]): boolean {
  const column = getColumn(columnId)
  if (!column) return false
  if (new Set(orderedIds).size !== orderedIds.length) return false
  if (!orderedIds.every((id) => {
    const card = getCardRow(id)
    return card && !card.archived_at && getColumn(card.column_id)?.board_id === column.board_id
  })) return false
  const markDone = column.title.trim().toLowerCase() === 'done'
  const completedAt = nowIso()

  const tx = db.transaction(() => {
    const update = db.prepare(
      `UPDATE cards SET column_id = ?, position = ?
       WHERE id = ? AND archived_at IS NULL`
    )
    const markDoneStmt = db.prepare(
      `UPDATE cards
       SET progress = 'done', completed_at = ?
       WHERE id = ? AND archived_at IS NULL AND progress != 'done'`
    )
    orderedIds.forEach((id, index) => {
      update.run(columnId, index, id)
      if (markDone) markDoneStmt.run(completedAt, id)
    })
  })
  tx()
  rerankColumnByDue(columnId)
  return true
}

export function transferBoardItem(
  fromBoardId: string,
  toBoardId: string,
  type: 'card' | 'column',
  itemId: string,
  targetColumnId?: string,
  targetPosition?: number
): boolean | 'missing-target-column' {
  if (!hasBoard(fromBoardId) || !hasBoard(toBoardId)) return false
  const card = type === 'card' ? getCardRow(resolveCardId(itemId)) : undefined
  const source = getColumn(card ? card.column_id : itemId)
  if (!source || source.board_id !== fromBoardId || (type === 'card' && (!card || card.archived_at))) return false
  if (type === 'column') {
    db.transaction(() => {
      const ids = (db.prepare('SELECT id FROM columns WHERE board_id = ? AND id != ? ORDER BY position, rowid')
        .all(toBoardId, source.id) as { id: string }[]).map((col) => col.id)
      ids.splice(Math.min(targetPosition ?? ids.length, ids.length), 0, source.id)
      db.prepare('UPDATE columns SET board_id = ? WHERE id = ?').run(toBoardId, source.id)
      if (fromBoardId !== toBoardId) {
        db.prepare('UPDATE cards SET release_id = NULL WHERE column_id = ?').run(source.id)
      }
      reorderColumns(ids, toBoardId)
    })()
    return true
  }
  let destination = targetColumnId ? getColumn(targetColumnId) : undefined
  if (targetColumnId && (!destination || destination.board_id !== toBoardId)) return 'missing-target-column'
  if (!destination && db.prepare('SELECT 1 FROM columns WHERE board_id = ?').get(toBoardId)) return 'missing-target-column'
  const moved = card!
  db.transaction(() => {
    if (!destination) destination = getColumn(addColumn('To Do', toBoardId).id)!
    const target = destination
    const ids = (db.prepare('SELECT id FROM cards WHERE column_id = ? AND archived_at IS NULL AND id != ? ORDER BY position, rowid')
      .all(target.id, moved.id) as { id: string }[]).map((entry) => entry.id)
    ids.splice(Math.min(targetPosition ?? ids.length, ids.length), 0, moved.id)
    db.prepare('UPDATE cards SET column_id = ?, release_id = ? WHERE id = ?').run(
      target.id, fromBoardId === toBoardId ? moved.release_id : null, moved.id
    )
    reorderCards(target.id, ids)
    rerankColumnByDue(source.id)
  })()
  return true
}
