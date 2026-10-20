import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { after, test } from 'node:test'
import 'better-sqlite3'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !path.extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const dataDir = mkdtempSync(path.join(tmpdir(), 'peteyplan-work-types-test-'))
const previousDataDir = process.env.DATA_DIR
process.env.DATA_DIR = dataDir
after(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const db = await import('../server/db.ts')
const { normalizeKinds, normalizeKind, normalizeProgress } = await import('../shared/progress.ts')

const column = db.getBoard().columns[0].id
const cardOf = (id) => db.getBoard().columns[0].cards.find((card) => card.id === id)
const draftOf = (kinds) => kinds.map(({ id, label, stages }) => ({ id, label, stages: stages.slice(1, -1) }))

test('seeds the three default work types', () => {
  assert.deepEqual(db.getWorkTypes().map((kind) => kind.id), ['development', 'chore', 'managing'])
  assert.equal(normalizeKind('Chore'), 'chore')
  assert.equal(normalizeProgress('Follow-up', 'managing'), 'followup')
})

test('normalizeKinds pins Todo and Done and rejects unusable lists', () => {
  const [kind] = normalizeKinds([{ label: '  Support  ticket ', stages: [{ label: 'Triage' }, { id: 'done', label: 'Fake' }, { label: '' }] }])
  assert.equal(kind.id, 'support-ticket')
  assert.equal(kind.label, 'Support ticket')
  assert.deepEqual(kind.stages.map((stage) => stage.id), ['todo', 'triage', 'done'])
  assert.throws(() => normalizeKinds([]), /at least one/)
  assert.throws(() => normalizeKinds([{ label: '' }]), /needs a name/)
  assert.throws(() => normalizeKinds([{ label: 'A' }, { label: 'a' }]), /two work types/)
})

test('saving work types migrates cards off removed stages and types', () => {
  const review = db.addCard(column, 'In review', '', '', '', 'review', 'development')
  const qa = db.addCard(column, 'In QA', '', '', '', 'qa', 'development')
  const waiting = db.addCard(column, 'Waiting', '', '', '', 'waiting', 'managing')
  const done = db.addCard(column, 'Finished', '', '', '', 'done', 'managing')

  const draft = draftOf(db.getWorkTypes())
  // Development loses Review and QA; Managing is removed; a new type is added first.
  draft[0].stages = draft[0].stages.filter((stage) => !['review', 'qa'].includes(stage.id))
  draft.splice(2, 1)
  draft.unshift({ label: 'Support', stages: [{ label: 'Building' }] })
  const saved = db.saveWorkTypes(draft)

  assert.deepEqual(saved.map((kind) => kind.id), ['support', 'development', 'chore'])
  assert.equal(normalizeKind(undefined), 'support')
  assert.equal(cardOf(review.id).progress, 'building')
  assert.equal(cardOf(qa.id).progress, 'deploy')
  // Managing cards move to the first type, keeping shared stages and Done.
  assert.equal(cardOf(waiting.id).kind, 'support')
  assert.equal(cardOf(waiting.id).progress, 'todo')
  assert.equal(cardOf(done.id).kind, 'support')
  assert.equal(cardOf(done.id).progress, 'done')
  assert.ok(cardOf(done.id).completedAt)
  assert.deepEqual(db.getWorkTypes(), saved)
})
