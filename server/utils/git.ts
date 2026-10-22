import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'

/**
 * Thin wrapper around the git CLI for linked project folders.
 *
 * Everything goes through execFile (never a shell) with prompts disabled, so
 * a push that needs credentials fails fast instead of hanging the server.
 */

export class GitError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export interface GitFile {
  path: string
  /** Original path for renames/copies */
  from?: string
  /** Staged state (porcelain X), '.' when unchanged */
  index: string
  /** Working tree state (porcelain Y), '.' when unchanged */
  worktree: string
  untracked: boolean
}

export interface GitStatus {
  /** Branch name, or null when detached */
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  /** True until the first commit exists */
  initial: boolean
  files: GitFile[]
  lastCommit: { hash: string; subject: string } | null
}

const TIMEOUT_MS = 30_000
const PUSH_TIMEOUT_MS = 120_000

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    // Status polling shouldn't take index.lock while you're using git yourself.
    GIT_OPTIONAL_LOCKS: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
  }
}

/** `\\wsl.localhost\Ubuntu\home\me` (or `\\wsl$\…`) → distro + Linux path. */
export function parseWslPath(input: string): { distro: string; linuxPath: string } | null {
  const m = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)(.*)$/i.exec(input)
  if (!m) return null
  return { distro: m[1]!, linuxPath: m[2]!.replace(/\\/g, '/').replace(/\/+$/, '') || '/' }
}

/** Linux path inside a distro → the Windows UNC path for it. */
export function wslUncPath(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

function run(cwd: string, args: string[], timeout = TIMEOUT_MS): Promise<string> {
  // Repos inside WSL run the distro's own git (and its credentials), not Windows git over UNC.
  const wsl = parseWslPath(cwd)
  const [file, argv, dir] = wsl
    ? ['wsl.exe', ['-d', wsl.distro, '--cd', wsl.linuxPath, '--exec', 'git', ...args], undefined]
    : ['git', args, cwd]
  const env = gitEnv()
  if (wsl) env.WSLENV = [process.env.WSLENV, 'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS'].filter(Boolean).join(':')
  return new Promise((resolve, reject) => {
    execFile(file, argv, { cwd: dir, timeout, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(new GitError(wsl ? 'wsl.exe is not available on the server' : 'git is not installed on the server', 503))
      }
      if (err.killed) return reject(new GitError(`git ${args[0]} timed out`, 504))
      const message = (stderr || stdout || err.message).trim().split('\n').slice(-6).join('\n')
      reject(new GitError(message || `git ${args[0]} failed`))
    })
  })
}

// One operation at a time per repo, so a status poll never races a commit.
const queues = new Map<string, Promise<unknown>>()
function serial<T>(root: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(root) || Promise.resolve()).catch(() => {}).then(task)
  queues.set(root, next)
  next.finally(() => { if (queues.get(root) === next) queues.delete(root) }).catch(() => {})
  return next
}

let version: Promise<string | null> | undefined
/** Installed git version, or null when git isn't available. Cached. */
export function gitVersion(): Promise<string | null> {
  const clean = (out: string) => out.trim().replace(/^git version /, '')
  version ??= run(process.cwd(), ['--version']).then(clean, () =>
    // Windows without Git for Windows can still reach repos through WSL's git.
    process.platform === 'win32'
      ? new Promise<string | null>((resolve) => execFile('wsl.exe', ['--exec', 'git', '--version'], { timeout: TIMEOUT_MS },
        (err, out) => resolve(err ? null : `${clean(out)} (WSL)`)))
      : null)
  return version
}

/** Resolve an absolute folder path to its repository's top level. */
export async function resolveRepoRoot(input: string): Promise<string> {
  const folder = input.trim()
  if (!path.isAbsolute(folder)) throw new GitError('Use an absolute folder path')
  let isDir = false
  try { isDir = statSync(folder).isDirectory() } catch {}
  if (!isDir) throw new GitError(`No folder at ${folder}`)
  try {
    const top = (await run(folder, ['rev-parse', '--show-toplevel'])).trim()
    const wsl = parseWslPath(folder)
    if (wsl) return wslUncPath(wsl.distro, top)
    // Windows git prints C:/like/this.
    return process.platform === 'win32' ? path.resolve(top) : top
  } catch (err) {
    if (err instanceof GitError && err.status !== 400) throw err
    throw new GitError(`${folder} isn't inside a git repository`)
  }
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseGitStatus(output: string): Omit<GitStatus, 'lastCommit'> {
  const status: Omit<GitStatus, 'lastCommit'> = {
    branch: null, upstream: null, ahead: 0, behind: 0, initial: false, files: [],
  }
  const entries = output.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    if (entry.startsWith('# ')) {
      const [key, ...rest] = entry.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') status.initial = value === '(initial)'
      else if (key === 'branch.head') status.branch = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') status.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) { status.ahead = Number(m[1]); status.behind = Number(m[2]) }
      }
      continue
    }
    const type = entry[0]
    if (type === '?') {
      status.files.push({ path: entry.slice(2), index: '?', worktree: '?', untracked: true })
    } else if (type === '1' || type === '2' || type === 'u') {
      // Fixed fields before the path: 1 → 8, 2 → 9, u → 10.
      const fieldCount = type === '1' ? 8 : type === '2' ? 9 : 10
      const parts = entry.split(' ')
      const xy = parts[1] || '..'
      const file: GitFile = {
        path: parts.slice(fieldCount).join(' '),
        index: xy[0] || '.',
        worktree: xy[1] || '.',
        untracked: false,
      }
      if (type === '2') file.from = entries[++i]
      status.files.push(file)
    }
  }
  return status
}

export function gitStatus(root: string): Promise<GitStatus> {
  return serial(root, async () => {
    const parsed = parseGitStatus(await run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']))
    let lastCommit: GitStatus['lastCommit'] = null
    if (!parsed.initial) {
      const [hash, subject] = (await run(root, ['log', '-1', '--format=%h%x00%s'])).trim().split('\0')
      lastCommit = { hash: hash || '', subject: subject || '' }
    }
    return { ...parsed, lastCommit }
  })
}

async function pushUnlocked(root: string): Promise<void> {
  const upstream = await run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')
  if (upstream.trim()) {
    await run(root, ['push'], PUSH_TIMEOUT_MS)
    return
  }
  const remotes = (await run(root, ['remote'])).split('\n').map((r) => r.trim()).filter(Boolean)
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]
  if (!remote) throw new GitError('This repository has no remote to push to')
  await run(root, ['push', '-u', remote, 'HEAD'], PUSH_TIMEOUT_MS)
}

export function gitPush(root: string): Promise<void> {
  return serial(root, () => pushUnlocked(root))
}

/** Stage everything, commit with `message`, and optionally push. */
export function gitCommitAll(root: string, message: string, push: boolean): Promise<void> {
  const text = message.trim()
  if (!text) return Promise.reject(new GitError('Write a commit message first'))
  return serial(root, async () => {
    await run(root, ['add', '-A'])
    await run(root, ['commit', '-m', text])
    if (push) await pushUnlocked(root)
  })
}

/** Throw away local changes. Untracked files go too only when asked; ignored files always stay. */
export function gitDiscard(root: string, includeUntracked: boolean): Promise<void> {
  return serial(root, async () => {
    const { initial } = parseGitStatus(await run(root, ['status', '--porcelain=v2', '--branch', '-z']))
    if (initial) throw new GitError('There is no commit to go back to yet')
    await run(root, ['reset', '--hard', 'HEAD'])
    if (includeUntracked) await run(root, ['clean', '-fd'])
  })
}

export interface GitBranches {
  current: string | null
  /** Local branches, most recently committed first */
  local: { name: string; upstream: string | null }[]
  /** Remote branches with no local branch yet, e.g. `origin/feature` */
  remote: string[]
}

export function gitBranches(root: string): Promise<GitBranches> {
  return serial(root, async () => {
    const out = await run(root, [
      'for-each-ref', '--sort=-committerdate',
      '--format=%(refname)%00%(refname:short)%00%(upstream:short)%00%(HEAD)',
      'refs/heads', 'refs/remotes',
    ])
    const branches: GitBranches = { current: null, local: [], remote: [] }
    const remote: string[] = []
    for (const line of out.split('\n')) {
      const [ref, name, upstream, head] = line.split('\0')
      if (!ref || !name || ref.endsWith('/HEAD')) continue
      if (ref.startsWith('refs/heads/')) {
        branches.local.push({ name, upstream: upstream || null })
        if (head === '*') branches.current = name
      } else {
        remote.push(name)
      }
    }
    const tracked = new Set(branches.local.flatMap((b) => [b.upstream, b.name]))
    // origin/feature is already covered by a local `feature` or one tracking it.
    branches.remote = remote.filter((name) => !tracked.has(name) && !tracked.has(name.slice(name.indexOf('/') + 1)))
    return branches
  })
}

async function checkBranchName(root: string, name: string): Promise<string> {
  const branch = name.trim()
  if (!branch || branch.startsWith('-')) throw new GitError('That isn\'t a valid branch name')
  try {
    return (await run(root, ['check-ref-format', '--branch', branch])).trim()
  } catch {
    throw new GitError(`"${branch}" isn't a valid branch name`)
  }
}

/**
 * Switch branches. `create` makes a new branch from HEAD; `remote` checks out
 * a remote branch (`origin/x`) as a local tracking branch. Uncommitted changes
 * come along unless they'd clash, in which case git refuses and says why.
 */
export function gitSwitch(root: string, branch: string, mode: 'local' | 'create' | 'remote' = 'local'): Promise<void> {
  return serial(root, async () => {
    const name = await checkBranchName(root, branch)
    if (mode === 'create') await run(root, ['switch', '-c', name])
    else if (mode === 'remote') await run(root, ['switch', '--track', name])
    else await run(root, ['switch', name])
  })
}

/** Refresh remote branches and ahead/behind counts. */
export function gitFetch(root: string): Promise<void> {
  return serial(root, async () => { await run(root, ['fetch', '--all', '--prune'], PUSH_TIMEOUT_MS) })
}
