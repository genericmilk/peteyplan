import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const { GitError, gitBranches, gitCommitAll, gitDiscard, gitFetch, gitPull, gitPush, gitStatus, gitSwitch, parseGitStatus, parseWslPath, resolveRepoRoot, wslUncPath } =
  await import('../server/utils/git.ts')
const { FolderError, listFolders } = await import('../server/utils/folders.ts')

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'peteyplan-git-test-')))
after(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
function makeRepo(name) {
  const dir = path.join(root, name)
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}
const write = (dir, file, text) => writeFileSync(path.join(dir, file), text)

test('parses porcelain v2 status output', () => {
  const out = [
    '# branch.oid abc123',
    '# branch.head feature/x',
    '# branch.upstream origin/feature/x',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/app file.ts',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
    'old name.ts',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts',
    '? notes.md',
    '',
  ].join('\0')
  assert.deepEqual(parseGitStatus(out), {
    branch: 'feature/x', upstream: 'origin/feature/x', ahead: 2, behind: 1, initial: false,
    files: [
      { path: 'src/app file.ts', index: '.', worktree: 'M', untracked: false },
      { path: 'new name.ts', from: 'old name.ts', index: 'R', worktree: '.', untracked: false },
      { path: 'conflict.ts', index: 'U', worktree: 'U', untracked: false },
      { path: 'notes.md', index: '?', worktree: '?', untracked: true },
    ],
  })
  assert.equal(parseGitStatus('# branch.oid (initial)\0# branch.head (detached)\0').initial, true)
  assert.equal(parseGitStatus('# branch.head (detached)\0').branch, null)
})

test('resolves folders to their repository root and rejects others', async () => {
  const repo = makeRepo('resolve')
  mkdirSync(path.join(repo, 'nested'))
  assert.equal(await resolveRepoRoot(path.join(repo, 'nested')), repo)
  await assert.rejects(resolveRepoRoot('relative/path'), /absolute/)
  await assert.rejects(resolveRepoRoot(path.join(root, 'missing')), /No folder/)
  const plain = path.join(root, 'plain')
  mkdirSync(plain)
  await assert.rejects(resolveRepoRoot(plain), GitError)
})

test('commits, pushes and discards changes', async (t) => {
  const remote = path.join(root, 'remote.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  const repo = makeRepo('work')

  await t.test('reports a brand-new repository', async () => {
    write(repo, 'a.txt', 'one\n')
    const status = await gitStatus(repo)
    assert.equal(status.initial, true)
    assert.equal(status.lastCommit, null)
    assert.deepEqual(status.files.map((f) => [f.path, f.untracked]), [['a.txt', true]])
    await assert.rejects(gitDiscard(repo, true), /no commit/)
  })

  await t.test('needs a message and a remote', async () => {
    await assert.rejects(gitCommitAll(repo, '  ', true), /message/)
    await assert.rejects(gitCommitAll(repo, 'First', true), /no remote/)
    // The commit itself landed even though the push couldn't.
    assert.equal((await gitStatus(repo)).lastCommit.subject, 'First')
  })

  await t.test('pushes without an upstream by setting one', async () => {
    git(repo, 'remote', 'add', 'origin', remote)
    await gitPush(repo)
    const status = await gitStatus(repo)
    assert.equal(status.upstream, 'origin/main')
    assert.equal(status.ahead, 0)
    assert.equal(git(remote, 'log', '-1', '--format=%s').trim(), 'First')
  })

  await t.test('commits everything and pushes in one go', async () => {
    write(repo, 'a.txt', 'two\n')
    write(repo, 'b.txt', 'new\n')
    assert.equal((await gitStatus(repo)).files.length, 2)
    await gitCommitAll(repo, 'Second', true)
    const status = await gitStatus(repo)
    assert.deepEqual(status.files, [])
    assert.equal(status.ahead, 0)
    assert.equal(git(remote, 'log', '-1', '--format=%s').trim(), 'Second')
  })

  await t.test('discards tracked changes and keeps untracked files unless asked', async () => {
    write(repo, 'a.txt', 'scribble\n')
    write(repo, 'scratch.txt', 'temp\n')
    await gitDiscard(repo, false)
    assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'two\n')
    assert.ok(existsSync(path.join(repo, 'scratch.txt')))
    await gitDiscard(repo, true)
    assert.equal(existsSync(path.join(repo, 'scratch.txt')), false)
    assert.deepEqual((await gitStatus(repo)).files, [])
  })

  await t.test('shows commits waiting to be pushed', async () => {
    write(repo, 'a.txt', 'three\n')
    await gitCommitAll(repo, 'Third', false)
    assert.equal((await gitStatus(repo)).ahead, 1)
  })
})

test('maps WSL UNC paths to a distro and Linux path and back', () => {
  assert.deepEqual(parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\app'), { distro: 'Ubuntu', linuxPath: '/home/me/app' })
  assert.deepEqual(parseWslPath('\\\\wsl$\\Debian\\'), { distro: 'Debian', linuxPath: '/' })
  assert.deepEqual(parseWslPath('//wsl.localhost/Ubuntu-22.04/srv'), { distro: 'Ubuntu-22.04', linuxPath: '/srv' })
  assert.equal(parseWslPath('C:\\Users\\me'), null)
  assert.equal(parseWslPath('/home/me'), null)
  assert.equal(wslUncPath('Ubuntu', '/home/me/app'), '\\\\wsl.localhost\\Ubuntu\\home\\me\\app')
})

test('lists folders, flags repositories and hides dot folders', () => {
  const base = path.join(root, 'browse')
  mkdirSync(path.join(base, 'Beta', '.git'), { recursive: true })
  mkdirSync(path.join(base, 'alpha'))
  mkdirSync(path.join(base, '.hidden'))
  mkdirSync(path.join(base, 'node_modules'))
  write(base, 'file.txt', 'not a folder')
  const listing = listFolders(base)
  assert.equal(listing.path, base)
  assert.equal(listing.parent, root)
  assert.equal(listing.repo, false)
  assert.deepEqual(listing.folders.map((f) => [f.name, f.repo]), [['alpha', false], ['Beta', true]])
  assert.equal(listFolders(path.join(base, 'Beta')).repo, true)
  assert.equal(listFolders('/').parent, null)
  assert.throws(() => listFolders(path.join(base, 'file.txt')), FolderError)
})

test('pulls the upstream fast-forward only', async () => {
  const remote = path.join(root, 'pull-remote.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  const repo = makeRepo('pull')
  write(repo, 'a.txt', 'one\n')
  await gitCommitAll(repo, 'First', false)
  await assert.rejects(gitPull(repo), /no upstream/)
  git(repo, 'remote', 'add', 'origin', remote)
  await gitPush(repo)

  const other = path.join(root, 'pull-clone')
  git(root, 'clone', '-q', remote, other)
  git(other, 'config', 'user.email', 'o@example.com')
  git(other, 'config', 'user.name', 'Other')
  const pushFromOther = (file, text) => {
    write(other, file, text)
    git(other, 'add', '.')
    git(other, '-c', 'commit.gpgsign=false', 'commit', '-qm', `Add ${file}`)
    git(other, 'push', '-q')
  }

  pushFromOther('b.txt', 'theirs\n')
  await gitFetch(repo)
  assert.equal((await gitStatus(repo)).behind, 1)
  // Uncommitted edits to other files come along.
  write(repo, 'a.txt', 'local edit\n')
  await gitPull(repo)
  const status = await gitStatus(repo)
  assert.equal(status.behind, 0)
  assert.equal(readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'theirs\n')
  assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'local edit\n')

  // Both sides move on: refuse rather than merge.
  await gitCommitAll(repo, 'Mine', false)
  pushFromOther('c.txt', 'more\n')
  await assert.rejects(gitPull(repo), (err) => err instanceof GitError && err.status === 409 && /both moved on/.test(err.message))
  assert.equal(existsSync(path.join(repo, 'c.txt')), false)
})

test('lists, creates and switches branches', async () => {
  const remote = path.join(root, 'branches-remote.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  const repo = makeRepo('branches')
  write(repo, 'a.txt', 'one\n')
  await gitCommitAll(repo, 'First', false)
  git(repo, 'remote', 'add', 'origin', remote)
  await gitPush(repo)

  // Someone else pushes a branch we don't have yet.
  const other = path.join(root, 'branches-clone')
  git(root, 'clone', '-q', remote, other)
  git(other, 'config', 'user.email', 'o@example.com')
  git(other, 'config', 'user.name', 'Other')
  git(other, 'switch', '-q', '-c', 'their-feature')
  write(other, 'b.txt', 'theirs\n')
  git(other, 'add', '.')
  git(other, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Theirs')
  git(other, 'push', '-q', '-u', 'origin', 'their-feature')

  let branches = await gitBranches(repo)
  assert.equal(branches.current, 'main')
  assert.deepEqual(branches.local, [{ name: 'main', upstream: 'origin/main' }])
  assert.deepEqual(branches.remote, [])

  await gitFetch(repo)
  branches = await gitBranches(repo)
  assert.deepEqual(branches.remote, ['origin/their-feature'])

  await gitSwitch(repo, 'origin/their-feature', 'remote')
  branches = await gitBranches(repo)
  assert.equal(branches.current, 'their-feature')
  assert.deepEqual(branches.remote, [])
  assert.equal((await gitStatus(repo)).upstream, 'origin/their-feature')

  // Uncommitted edits come along to a new branch.
  write(repo, 'a.txt', 'edited\n')
  await gitSwitch(repo, 'my-work', 'create')
  assert.equal((await gitStatus(repo)).branch, 'my-work')
  assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'edited\n')
  await gitSwitch(repo, 'main')
  assert.equal((await gitBranches(repo)).current, 'main')

  await assert.rejects(gitSwitch(repo, '--force'), /valid branch name/)
  await assert.rejects(gitSwitch(repo, 'bad..name', 'create'), /valid branch name/)
  await assert.rejects(gitSwitch(repo, 'does-not-exist'), GitError)
})
