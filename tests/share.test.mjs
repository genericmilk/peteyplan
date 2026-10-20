import assert from 'node:assert/strict'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !path.extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { decodeSharedCard, encodeSharedCard, shareTokenFrom } = await import('../shared/share.ts')

const card = {
  title: 'Fix login redirect 🚪',
  description: 'Steps:\n1. Sign in\n2. See **wrong** page',
  jiraKey: 'CX-1831',
  dueBy: '2026-11-02',
  kind: 'development',
  kindLabel: 'Development task',
  progress: 'building',
  progressLabel: 'Building',
  checklist: [{ text: 'Reproduce', done: true }, { text: 'Patch', done: false }],
  ref: 'PP-12',
}

test('a shared card survives a round trip through a link', async () => {
  const token = await encodeSharedCard(card)
  assert.match(token, /^[A-Za-z0-9_-]+$/)
  const link = `http://localhost:3000/#card=${token}`
  assert.deepEqual(await decodeSharedCard(shareTokenFrom(new URL(link).hash)), card)
})

test('minimal cards omit empty fields and decode with defaults', async () => {
  const token = await encodeSharedCard({ ...card, description: '', jiraKey: '', dueBy: '', checklist: [], ref: '' })
  const decoded = await decodeSharedCard(token)
  assert.equal(decoded.title, card.title)
  assert.deepEqual(decoded.checklist, [])
  assert.equal(decoded.description, '')
})

test('malformed tokens decode to null', async () => {
  assert.equal(await decodeSharedCard('not-a-real-token'), null)
  assert.equal(await decodeSharedCard(''), null)
  assert.equal(shareTokenFrom('#board=1'), null)
})
