import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !path.extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const dataDir = mkdtempSync(path.join(tmpdir(), 'peteyplan-boards-test-'))
const previousDataDir = process.env.DATA_DIR
process.env.DATA_DIR = dataDir
after(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const legacy = new Database(path.join(dataDir, 'peteyplan.db'))
legacy.exec(`
  CREATE TABLE columns (id TEXT PRIMARY KEY, title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO columns (id, title) VALUES ('legacy-column', 'Existing work');
  INSERT INTO cards (id, column_id, title) VALUES ('legacy-card', 'legacy-column', 'Keep this card');
`)
legacy.close()
const db = await import('../server/db.ts')
const { isBoardEmoji } = await import('../shared/boards.ts')
const { normalizeChecklist } = await import('../shared/checklist.ts')
const defaultId = db.DEFAULT_BOARD_ID

test('boards preserve data, isolate content and transfer items safely', async (t) => {
  await t.test('migrates legacy columns and cards into the protected default board', () => {
    assert.deepEqual(db.getBoards(), [{
      id: defaultId, name: 'Default Board', emoji: '📋', color: '#5b8cff', isDefault: true,
    }])
    assert.equal(db.getBoard().columns[0].cards[0].title, 'Keep this card')
    assert.equal(db.getBoard().columns[0].cards[0].ref, 'PP-1')
    assert.equal(db.deleteBoard(defaultId), false)
    db.updateBoard(defaultId, { name: 'My work', emoji: '💼', color: '#ff9900' })
    assert.equal(db.getBoards()[0].name, 'My work')
  })

  const other = db.createBoard('Personal', '🌱', '#22aa77')
  const empty = db.createBoard('Empty', '🌙', '#9966cc')
  const target = db.addColumn('Done', other.id)
  const source = db.addColumn('Source')
  const second = db.addColumn('Second', other.id)
  const card = db.addCard(source.id, 'Move me', 'Description', 'PP-123', '', 'building')
  const archived = db.addCard(source.id, 'Archived', '')
  const release = db.addRelease({ title: 'Default release' })
  const otherRelease = db.addRelease({ title: 'Other release' }, other.id)

  await t.test('isolates columns, releases, archive and complete column reordering', () => {
    assert.deepEqual(db.getBoard(empty.id), { columns: [], releases: [] })
    assert.deepEqual(db.getBoard(other.id).columns.map((col) => col.id), [target.id, second.id])
    assert.equal(db.getBoard().releases[0].id, release.id)
    assert.equal(db.getBoard(other.id).releases[0].id, otherRelease.id)
    assert.equal(db.reorderColumns([second.id, target.id], other.id), true)
    assert.equal(db.reorderColumns([target.id, target.id], other.id), false)
    assert.equal(db.reorderColumns([source.id], other.id), false)
    assert.equal(db.setCardRelease(card.id, otherRelease.id), undefined)
    assert.ok(db.setCardRelease(card.id, release.id))
    db.archiveCard(archived.id)
    assert.equal(db.getArchivedCards().length, 1)
    assert.equal(db.getArchivedCards(other.id).length, 0)
    assert.equal(db.restoreCard(archived.id, target.id), undefined)
    assert.equal(db.reorderCards(target.id, [card.id]), false)
  })

  await t.test('moves cards between boards preserving identity and marking Done', () => {
    assert.equal(db.transferBoardItem(defaultId, other.id, 'card', card.id, source.id), 'missing-target-column')
    assert.equal(db.transferBoardItem(other.id, defaultId, 'card', card.id, source.id), false)
    assert.equal(db.transferBoardItem(defaultId, other.id, 'card', card.id, target.id, 0), true)
    const moved = db.getBoard(other.id).columns.find((col) => col.id === target.id).cards[0]
    assert.equal(moved.id, card.id)
    assert.equal(moved.number, card.number)
    assert.equal(moved.description, 'Description')
    assert.equal(moved.progress, 'done')
    assert.ok(moved.completedAt)
    assert.equal(moved.releaseId, null)
    assert.equal(db.getBoard().columns.find((col) => col.id === source.id).cards.length, 0)
  })

  await t.test('moves entire columns including archives and clears foreign release links', () => {
    const active = db.addCard(source.id, 'Active', '')
    db.setCardRelease(active.id, release.id)
    assert.equal(db.transferBoardItem(defaultId, other.id, 'column', source.id, undefined, 1), true)
    assert.deepEqual(db.getBoard(other.id).columns.map((col) => col.id), [second.id, source.id, target.id])
    assert.equal(db.getCardRow(active.id).release_id, null)
    assert.equal(db.getArchivedCards().length, 0)
    assert.equal(db.getArchivedCards(other.id)[0].id, archived.id)
  })

  await t.test('creates a destination column only for a valid card on an empty board', () => {
    assert.equal(db.transferBoardItem(other.id, empty.id, 'card', 'missing-card'), false)
    assert.equal(db.getBoard(empty.id).columns.length, 0)
    assert.equal(db.transferBoardItem(other.id, empty.id, 'card', card.id), true)
    assert.equal(db.getBoard(empty.id).columns[0].title, db.UNTITLED_COLUMN_TITLE)
    assert.equal(db.getBoard(empty.id).columns[0].cards[0].id, card.id)
  })

  await t.test('stores checklists on cards, keeping item ids and dropping blank items', () => {
    assert.deepEqual(db.getBoard(empty.id).columns[0].cards[0].checklist, [])
    db.updateCard(card.id, { checklist: [
      { id: 'a', text: '  Write  tests ', done: true },
      { id: 'b', text: '   ' },
      { id: 'c', text: 'Ship it' },
    ] })
    assert.deepEqual(db.getBoard(empty.id).columns[0].cards[0].checklist, [
      { id: 'a', text: 'Write tests', done: true },
      { id: 'c', text: 'Ship it', done: false },
    ])
    db.updateCard(card.id, { title: 'Renamed' })
    assert.equal(db.getBoard(empty.id).columns[0].cards[0].checklist.length, 2)
    const created = db.addCard(db.getBoard(empty.id).columns[0].id, 'With list', '', '', '', 'todo', 'chore', true, [{ text: 'First' }])
    assert.equal(db.getBoard(empty.id).columns[0].cards.find((entry) => entry.id === created.id).checklist[0].text, 'First')
    db.deleteCard(created.id)
  })

  await t.test('persists settings and does not reseed intentionally empty boards', async () => {
    db.deleteColumn('legacy-column')
    const reopened = await import('../server/db.ts?reopen')
    assert.equal(reopened.getBoards()[0].name, 'My work')
    assert.equal(reopened.getBoard().columns.length, 0)
    assert.equal(reopened.getBoard(empty.id).columns[0].cards[0].id, card.id)
    assert.equal(reopened.getBoard(empty.id).columns[0].cards[0].checklist.length, 2)
  })

  await t.test('deletes nondefault board contents without affecting other boards', () => {
    assert.equal(db.deleteBoard(other.id), true)
    assert.equal(db.hasBoard(other.id), false)
    assert.equal(db.getColumn(source.id), undefined)
    assert.equal(db.getCardRow(archived.id), undefined)
    assert.equal(db.getRelease(otherRelease.id), undefined)
    assert.ok(db.hasBoard(defaultId))
    assert.equal(db.getBoard(empty.id).columns[0].cards[0].id, card.id)
  })
})

test('requires one emoji, including flags and joined sequences', () => {
  for (const emoji of ['📋', '🌱', '🇬🇧', '👩🏽‍💻', '1️⃣']) assert.equal(isBoardEmoji(emoji), true, emoji)
  for (const text of ['', 'abc', '#', '🌱🌙', 'hello 📋']) assert.equal(isBoardEmoji(text), false, text)
})

test('normalizes untrusted checklist input', () => {
  assert.deepEqual(normalizeChecklist('not json'), [])
  assert.deepEqual(normalizeChecklist({ text: 'x' }), [])
  const items = normalizeChecklist(['Plain', { id: 'dup', text: 'One' }, { id: 'dup', text: 'Two', done: 'yes' }, 5, null])
  assert.deepEqual(items.map((item) => [item.text, item.done]), [['Plain', false], ['One', false], ['Two', false]])
  assert.equal(new Set(items.map((item) => item.id)).size, 3)
  assert.equal(normalizeChecklist(Array.from({ length: 150 }, (_, i) => `Item ${i}`)).length, 100)
})

test('derives readable accent palettes from any board colour', async () => {
  const { accentPalette, contrast, parseHex } = await import('../shared/accent.ts')
  const surfaces = { dark: ['#1e222c', '#1a1d26'], light: ['#ffffff', '#eef0f5'] }
  for (const color of ['#4f7cff', '#2fae74', '#e0863a', '#8b6cf0', '#f5d90a', '#ffffff', '#000000', '#ff2d55', '#5b8cff']) {
    for (const theme of ['dark', 'light']) {
      const palette = accentPalette(color, theme)
      const c = (name) => parseHex(palette[name])
      assert.ok(contrast(c('--accent-fill'), c('--on-accent')) >= 4.5, `${color} ${theme} button text`)
      for (const surface of surfaces[theme]) {
        assert.ok(contrast(c('--accent'), parseHex(surface)) >= 4.5, `${color} ${theme} accent on ${surface}`)
        assert.ok(contrast(c('--brand-ink'), parseHex(surface)) >= 3, `${color} ${theme} logo on ${surface}`)
      }
    }
  }
  assert.equal(accentPalette('not a colour', 'dark'), null)
})

test('dropping a card past the last column creates a new Untitled column', () => {
  const from = db.createBoard('From', '📤', '#3366ff')
  const to = db.createBoard('To', '📥', '#ff6633')
  const source = db.addColumn('Source', from.id)
  const existing = db.addColumn('Existing', to.id)
  const card = db.addCard(source.id, 'New home', '')
  assert.equal(db.transferBoardItem(from.id, to.id, 'card', card.id), 'missing-target-column')
  assert.equal(db.transferBoardItem(from.id, to.id, 'card', card.id, existing.id, 0, true), true)
  assert.deepEqual(db.getBoard(to.id).columns.map((col) => [col.title, col.cards.map((c) => c.title)]), [
    ['Existing', []],
    [db.UNTITLED_COLUMN_TITLE, ['New home']],
  ])
})
