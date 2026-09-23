import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_KIND,
  DEFAULT_PROGRESS,
  normalizeKind,
  normalizeProgress,
  progressForKindChange,
  type KindId,
  type ProgressId,
} from './utils/progress'

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
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    jira_key      TEXT NOT NULL DEFAULT '',
    due_by        TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL DEFAULT 'development',
    progress      TEXT NOT NULL DEFAULT 'todo',
    position      INTEGER NOT NULL DEFAULT 0,
    completed_at  TEXT,
    archived_at   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_columns_position ON columns (position);
  CREATE INDEX IF NOT EXISTS idx_cards_column_position ON cards (column_id, position);
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

// Index depends on archived_at — create only after migrations above.
db.exec(`CREATE INDEX IF NOT EXISTS idx_cards_archived ON cards (archived_at)`)

/** Days a card stays Done on the board before soft-archiving. */
export const ARCHIVE_AFTER_DAYS = 5

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

// Seed the default board on first run.
const DEFAULT_COLUMNS = [
  { id: 'col-backlog', title: 'Backlog' },
  { id: 'col-todo', title: 'To Do' },
  { id: 'col-progress', title: 'In Progress' },
  { id: 'col-done', title: 'Done' },
]

const colCount = db.prepare('SELECT COUNT(*) AS n FROM columns').get() as { n: number }
if (colCount.n === 0) {
  const insert = db.prepare('INSERT INTO columns (id, title, position) VALUES (?, ?, ?)')
  db.transaction(() => {
    DEFAULT_COLUMNS.forEach((col, i) => insert.run(col.id, col.title, i))
  })()
}

/* ── Public types ──────────────────────────────────────────────────────────── */

export interface Column {
  id: string
  title: string
  cards: Card[]
}

export interface Card {
  id: string
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
  columnId: string
}

export interface ArchivedCard extends Card {
  columnTitle: string | null
}

interface ColumnRow { id: string; title: string; position: number }
interface CardRow {
  id: string
  column_id: string
  title: string
  description: string
  jira_key: string
  due_by: string
  kind: string
  progress: string
  position: number
  completed_at: string | null
  archived_at: string | null
}

function toCard(row: CardRow): Card {
  const kind = normalizeKind(row.kind)
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    jiraKey: row.jira_key || '',
    dueBy: row.due_by || '',
    kind,
    progress: normalizeProgress(row.progress, kind),
    completedAt: row.completed_at || null,
    archivedAt: row.archived_at || null,
    columnId: row.column_id,
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

/* ── Queries ───────────────────────────────────────────────────────────────── */

export function getBoard(): { columns: Column[] } {
  archiveStaleDoneCards()

  const columns = db
    .prepare('SELECT id, title, position FROM columns ORDER BY position ASC, rowid ASC')
    .all() as ColumnRow[]
  const cards = db
    .prepare(
      `SELECT id, column_id, title, description, jira_key, due_by, kind, progress, position,
              completed_at, archived_at
       FROM cards
       WHERE archived_at IS NULL
       ORDER BY ${CARD_ORDER_SQL}`
    )
    .all() as CardRow[]

  const byColumn = new Map<string, Card[]>()
  for (const card of cards) {
    const list = byColumn.get(card.column_id) || []
    list.push(toCard(card))
    byColumn.set(card.column_id, list)
  }

  return {
    columns: columns.map((col) => ({
      id: col.id,
      title: col.title,
      cards: byColumn.get(col.id) || [],
    })),
  }
}

export function getArchivedCards(): ArchivedCard[] {
  archiveStaleDoneCards()

  const rows = db
    .prepare(
      `SELECT c.id, c.column_id, c.title, c.description, c.jira_key, c.due_by, c.kind, c.progress,
              c.position, c.completed_at, c.archived_at, col.title AS column_title
       FROM cards c
       LEFT JOIN columns col ON col.id = c.column_id
       WHERE c.archived_at IS NOT NULL
       ORDER BY c.archived_at DESC, c.rowid DESC`
    )
    .all() as (CardRow & { column_title: string | null })[]

  return rows.map((row) => ({
    ...toCard(row),
    columnTitle: row.column_title,
  }))
}

export function getColumn(id: string): ColumnRow | undefined {
  return db.prepare('SELECT id, title, position FROM columns WHERE id = ?').get(id) as ColumnRow | undefined
}

/* ── Column mutations ─────────────────────────────────────────────────────── */

export function addColumn(title: string): Column {
  const col: ColumnRow = { id: uid('col'), title, position: 0 }
  col.position = (db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM columns').get() as { m: number }).m + 1
  db.prepare('INSERT INTO columns (id, title, position) VALUES (?, ?, ?)').run(col.id, col.title, col.position)
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
export function reorderColumns(orderedIds: string[]): boolean {
  if (orderedIds.length === 0) return false

  const existing = db.prepare('SELECT id FROM columns').all() as { id: string }[]
  const existingIds = new Set(existing.map((row) => row.id))
  if (orderedIds.length !== existingIds.size) return false
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
  kind: KindId = DEFAULT_KIND
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
  const card: CardRow = {
    id: uid('card'),
    column_id: columnId,
    title,
    description,
    jira_key: jiraKey,
    due_by: dueBy,
    kind: normalizedKind,
    progress: normalizedProgress,
    position,
    completed_at,
    archived_at: null,
  }
  db.prepare(
    `INSERT INTO cards
     (id, column_id, title, description, jira_key, due_by, kind, progress, position, completed_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    card.id,
    card.column_id,
    card.title,
    card.description,
    card.jira_key,
    card.due_by,
    card.kind,
    card.progress,
    card.position,
    card.completed_at,
    card.archived_at
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
  db.prepare(
    `UPDATE cards
     SET title = ?, description = ?, jira_key = ?, due_by = ?, kind = ?, progress = ?, completed_at = ?
     WHERE id = ?`
  ).run(title, description, jira_key, due_by, kind, progress, completed_at, id)

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
  if (!getColumn(targetColumnId)) {
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
  if (!getColumn(columnId)) return false

  const tx = db.transaction(() => {
    const update = db.prepare(
      `UPDATE cards SET column_id = ?, position = ?
       WHERE id = ? AND archived_at IS NULL`
    )
    orderedIds.forEach((id, index) => update.run(columnId, index, id))
  })
  tx()
  rerankColumnByDue(columnId)
  return true
}
