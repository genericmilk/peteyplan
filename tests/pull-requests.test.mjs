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

const dataDir = mkdtempSync(path.join(tmpdir(), 'peteyplan-prs-test-'))
const previousDataDir = process.env.DATA_DIR
process.env.DATA_DIR = dataDir
after(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const { normalizePullRequests, parsePullRequest, PULL_REQUESTS_MAX } = await import('../shared/pullRequests.ts')
const db = await import('../server/db.ts')

test('labels pull request links from common hosts', () => {
  const label = (url) => parsePullRequest(url)?.label
  assert.deepEqual(parsePullRequest('https://github.com/acme/web/pull/123/files'), {
    url: 'https://github.com/acme/web/pull/123/files', provider: 'github', label: 'acme/web#123', number: 123,
  })
  assert.equal(parsePullRequest('https://github.example.com/acme/web/pull/9').provider, 'other')
  assert.equal(label('https://github.example.com/acme/web/pull/9'), 'acme/web#9')
  assert.equal(label('https://gitlab.com/group/sub/app/-/merge_requests/45'), 'group/sub/app!45')
  assert.equal(label('https://bitbucket.org/team/api/pull-requests/7/overview'), 'team/api#7')
  assert.equal(label('https://dev.azure.com/org/Project/_git/service/pullrequest/42'), 'service!42')
  assert.equal(label('https://review.example.com/c/project/+/9001'), 'review.example.com/…/9001')
  assert.equal(parsePullRequest('not a url'), null)
  assert.equal(parsePullRequest('javascript:alert(1)'), null)
  assert.equal(parsePullRequest('ftp://example.com/pull/1'), null)
})

test('normalizes untrusted pull request lists', () => {
  const pr = 'https://github.com/acme/web/pull/1'
  assert.deepEqual(normalizePullRequests([pr, pr, ' ', 'nope', 5, { url: 'https://github.com/acme/web/pull/2' }]), [
    pr, 'https://github.com/acme/web/pull/2',
  ])
  assert.deepEqual(normalizePullRequests(JSON.stringify([pr])), [pr])
  assert.deepEqual(normalizePullRequests('garbage'), [])
  assert.deepEqual(normalizePullRequests({ url: pr }), [])
  const many = Array.from({ length: 15 }, (_, i) => `https://github.com/acme/web/pull/${i + 1}`)
  assert.equal(normalizePullRequests(many).length, PULL_REQUESTS_MAX)
})

test('stores pull requests on cards and keeps them through edits and archive', () => {
  const column = db.getBoard().columns[0].id
  const pr = 'https://github.com/acme/web/pull/12'
  const created = db.addCard(column, 'With PR', '', '', '', 'todo', 'chore', false, [], [pr, 'bad'])
  const card = () => db.getBoard().columns[0].cards.find((c) => c.id === created.id)
  assert.deepEqual(card().pullRequests, [pr])
  db.updateCard(created.id, { title: 'Renamed' })
  assert.deepEqual(card().pullRequests, [pr])
  db.updateCard(created.id, { pullRequests: [pr, 'https://gitlab.com/g/a/-/merge_requests/3'] })
  assert.equal(card().pullRequests.length, 2)
  db.archiveCard(created.id)
  assert.equal(db.getArchivedCards().find((c) => c.id === created.id).pullRequests.length, 2)
  assert.equal(db.getSearchIndex().cards.find((c) => c.id === created.id).pullRequests.length, 2)
})
