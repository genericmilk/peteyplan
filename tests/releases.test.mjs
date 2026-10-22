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

const dataDir = mkdtempSync(path.join(tmpdir(), 'peteyplan-releases-test-'))
const previousDataDir = process.env.DATA_DIR
process.env.DATA_DIR = dataDir
after(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

// A database from before releases could be shared: one release on the default board.
const legacy = new Database(path.join(dataDir, 'peteyplan.db'))
legacy.exec(`
  CREATE TABLE releases (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, week_start TEXT NOT NULL,
    preprod_key TEXT NOT NULL DEFAULT '', prod_key TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
    board_id TEXT NOT NULL DEFAULT 'board-default'
  );
  INSERT INTO releases (id, title, week_start) VALUES ('rel-legacy', 'Legacy', '2026-01-05');
`)
legacy.close()

const db = await import('../server/db.ts')
const defaultId = db.DEFAULT_BOARD_ID
const ids = (releases) => releases.map((rel) => rel.id)

test('releases can be shared across boards or pinned to one', async (t) => {
  const other = db.createBoard('Other', '🌱', '#22aa77')
  const home = db.addColumn('Home')
  const away = db.addColumn('Away', other.id)
  const homeCard = db.addCard(home.id, 'Home card', '')
  const awayCard = db.addCard(away.id, 'Away card', '')
  const shared = db.addRelease({ title: 'Shared' })
  const pinned = db.addRelease({ title: 'Pinned', boardScope: other.id })

  await t.test('keeps legacy releases pinned to their board', () => {
    const rel = db.getReleases(defaultId).find((r) => r.id === 'rel-legacy')
    assert.equal(rel.boardId, defaultId)
    assert.equal(rel.doneAt, null)
    assert.ok(!ids(db.getReleases(other.id)).includes('rel-legacy'))
  })

  await t.test('shows shared releases on every board and pinned ones only on theirs', () => {
    assert.equal(shared.boardId, null)
    assert.ok(ids(db.getBoard(defaultId).releases).includes(shared.id))
    assert.ok(ids(db.getBoard(other.id).releases).includes(shared.id))
    assert.ok(!ids(db.getBoard(defaultId).releases).includes(pinned.id))
    assert.ok(ids(db.getBoard(other.id).releases).includes(pinned.id))
  })

  await t.test('shared releases collect cards from any board, pinned only from their own', () => {
    assert.ok(db.setCardRelease(homeCard.id, shared.id))
    assert.ok(db.setCardRelease(awayCard.id, shared.id))
    const rel = db.getReleases(defaultId).find((r) => r.id === shared.id)
    assert.deepEqual(rel.cards.map((c) => [c.title, c.boardId]).sort(), [['Away card', other.id], ['Home card', defaultId]])
    assert.match(db.cardReleaseProblem(homeCard.id, pinned.id), /own board/)
    assert.equal(db.setCardRelease(homeCard.id, pinned.id), undefined)
    assert.equal(db.updateCard(homeCard.id, { releaseId: pinned.id }), undefined)
  })

  await t.test('shared releases follow cards across boards; pinned ones drop them', () => {
    const traveller = db.addCard(away.id, 'Traveller', '')
    db.setCardRelease(traveller.id, pinned.id)
    assert.equal(db.transferBoardItem(defaultId, other.id, 'card', homeCard.id, away.id), true)
    assert.equal(db.getCardRow(homeCard.id).release_id, shared.id)
    assert.equal(db.transferBoardItem(other.id, defaultId, 'card', homeCard.id, home.id), true)
    assert.equal(db.transferBoardItem(other.id, defaultId, 'card', traveller.id, home.id), true)
    assert.equal(db.getCardRow(traveller.id).release_id, null)
  })

  await t.test('pinning a shared release unassigns cards from other boards', () => {
    const rel = db.updateRelease(shared.id, { boardScope: defaultId })
    assert.equal(rel.boardId, defaultId)
    assert.deepEqual(rel.cards.map((c) => c.id), [homeCard.id])
    assert.equal(db.getCardRow(awayCard.id).release_id, null)
    db.updateRelease(shared.id, { boardScope: null })
  })

  await t.test('keeps archived cards in the release', () => {
    const shipped = db.addCard(home.id, 'Shipped', '')
    db.setCardRelease(shipped.id, shared.id)
    db.archiveCard(shipped.id)
    const card = db.getReleases(defaultId).find((r) => r.id === shared.id).cards.find((c) => c.id === shipped.id)
    assert.ok(card.archivedAt)
  })

  await t.test('marking done freezes the release and can complete its cards', () => {
    const rel = db.updateRelease(shared.id, { done: true, completeCards: true })
    assert.ok(rel.doneAt)
    assert.equal(db.getCardRow(homeCard.id).progress, 'done')
    assert.ok(db.getCardRow(homeCard.id).completed_at)
    assert.match(db.cardReleaseProblem(awayCard.id, shared.id), /done/)
    assert.equal(db.setCardRelease(homeCard.id, null), undefined)
    assert.equal(db.updateCard(homeCard.id, { releaseId: null }), undefined)
    // Done releases sort after open ones.
    const order = ids(db.getReleases(defaultId))
    assert.equal(order.at(-1), shared.id)

    const reopened = db.updateRelease(shared.id, { done: false })
    assert.equal(reopened.doneAt, null)
    assert.ok(db.setCardRelease(homeCard.id, null))
  })

  await t.test('marking done without completeCards leaves card progress alone', () => {
    db.setCardRelease(awayCard.id, shared.id)
    db.updateRelease(shared.id, { done: true })
    assert.equal(db.getCardRow(awayCard.id).progress, 'todo')
    db.updateRelease(shared.id, { done: false })
  })

  await t.test('deleting a board removes its pinned releases but keeps shared ones', () => {
    assert.equal(db.deleteBoard(other.id), true)
    assert.equal(db.getRelease(pinned.id), undefined)
    assert.ok(db.getRelease(shared.id))
  })
})

test('links repository folders to boards and unlinks them', () => {
  const board = db.createBoard('Code', '💻', '#3366ff')
  const repo = db.addBoardRepo(board.id, '/tmp/example')
  assert.deepEqual(db.addBoardRepo(board.id, '/tmp/example'), repo)
  db.addBoardRepo(board.id, '/tmp/second')
  assert.deepEqual(db.getBoardRepos(board.id).map((r) => r.path), ['/tmp/example', '/tmp/second'])
  assert.equal(db.removeBoardRepo(repo.id), true)
  assert.equal(db.getRepo(repo.id), undefined)
  db.deleteBoard(board.id)
  assert.deepEqual(db.getBoardRepos(board.id), [])
})
