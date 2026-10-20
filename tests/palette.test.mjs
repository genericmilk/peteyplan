import assert from 'node:assert/strict'
import { test } from 'node:test'

const { rankEntries, scoreEntry } = await import('../shared/palette.ts')

const entries = [
  { id: 'a-new-card', group: 'Actions', title: 'New card' },
  { id: 'a-theme', group: 'Actions', title: 'Switch to day mode', keywords: 'theme light' },
  { id: 'a-filter', group: 'Actions', title: 'Filter this board', anyQuery: true },
  { id: 'b-work', group: 'Boards', title: 'Work' },
  { id: 'c-1', group: 'Cards', title: 'Fix login redirect', keywords: 'PP-12 CX-1831 In Progress Work' },
  { id: 'c-2', group: 'Cards', title: 'Write card tests', keywords: 'PP-3 Backlog Personal' },
]
const ids = (query, perGroup) => rankEntries(entries, query, perGroup).map((entry) => entry.id)

test('an empty query lists everything except query-only entries', () => {
  assert.deepEqual(ids(''), ['a-new-card', 'a-theme', 'b-work', 'c-1', 'c-2'])
})

test('every word must match, in the title or keywords', () => {
  assert.deepEqual(ids('pp-12'), ['c-1', 'a-filter'])
  assert.deepEqual(ids('login cx-1831'), ['c-1', 'a-filter'])
  assert.deepEqual(ids('theme'), ['a-theme', 'a-filter'])
  assert.deepEqual(ids('login backlog'), ['a-filter'])
})

test('short terms only match at the start of a word', () => {
  const entries = [{ id: 'archive', group: 'Actions', title: 'Open archive', keywords: 'restore done' }]
  assert.deepEqual(rankEntries(entries, 'to').map((entry) => entry.id), [])
  assert.deepEqual(rankEntries(entries, 'do').map((entry) => entry.id), ['archive'])
  assert.deepEqual(rankEntries(entries, 'tor').map((entry) => entry.id), ['archive'])
})

test('title hits outrank keyword hits and groups keep their order', () => {
  // "work" is the Work board's title but only a keyword on c-1.
  assert.deepEqual(ids('work'), ['b-work', 'c-1', 'a-filter'])
  assert.ok(scoreEntry(entries[3], 'work') > scoreEntry(entries[4], 'work'))
  assert.deepEqual(ids('card'), ['a-new-card', 'a-filter', 'c-2'])
})

test('while typing, the group with the best match comes first', () => {
  // The card's title beats any action, so Cards leads.
  assert.deepEqual(ids('fix'), ['c-1', 'a-filter'])
})

test('groups are capped', () => {
  assert.deepEqual(ids('', 1), ['a-new-card', 'b-work', 'c-1'])
})
