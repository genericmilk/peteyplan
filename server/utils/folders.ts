import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Folder browsing for the "Link folder" picker. Lists directory names only
 * (never file contents) and flags which ones are git repositories.
 */

export interface FolderRoot {
  label: string
  path: string
  kind: 'home' | 'root' | 'drive' | 'wsl' | 'code'
}

export interface FolderEntry { name: string; path: string; repo: boolean }

export interface FolderListing {
  path: string
  parent: string | null
  /** This folder is itself a repository root */
  repo: boolean
  folders: FolderEntry[]
  /** True when the list was cut short */
  truncated: boolean
}

const MAX_ENTRIES = 500
const SKIP = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information'])

export class FolderError extends Error {}

function isRepo(dir: string): boolean {
  return existsSync(path.join(dir, '.git'))
}

/** Distros from `wsl.exe -l -q` (UTF-16 output), minus Docker's internal ones. */
function wslDistros(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([])
      resolve(stdout.toString('utf16le').replace(/\0/g, '').split(/\r?\n/)
        .map((name) => name.trim())
        .filter((name) => name && !/^docker-desktop/i.test(name)))
    })
  })
}

let rootsCache: { at: number; roots: FolderRoot[] } | undefined

export async function folderRoots(): Promise<FolderRoot[]> {
  if (rootsCache && Date.now() - rootsCache.at < 30_000) return rootsCache.roots
  const roots: FolderRoot[] = [{ label: 'Home', path: os.homedir(), kind: 'home' }]
  if (process.env.CODE_DIR && existsSync(process.env.CODE_DIR)) {
    roots.push({ label: 'Code folder', path: process.env.CODE_DIR, kind: 'code' })
  }
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`
      if (existsSync(drive)) roots.push({ label: `${letter}:`, path: drive, kind: 'drive' })
    }
    for (const distro of await wslDistros()) {
      roots.push({ label: distro, path: `\\\\wsl.localhost\\${distro}\\`, kind: 'wsl' })
    }
  } else {
    roots.push({ label: 'Computer', path: '/', kind: 'root' })
  }
  rootsCache = { at: Date.now(), roots }
  return roots
}

export function listFolders(input: string): FolderListing {
  const dir = path.resolve(input.trim() || os.homedir())
  let isDir = false
  try { isDir = statSync(dir).isDirectory() } catch {}
  if (!isDir) throw new FolderError(`No folder at ${dir}`)

  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name))
      .map((entry) => entry.name)
  } catch {
    throw new FolderError(`Can't open ${dir}`)
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
  const shown = names.slice(0, MAX_ENTRIES)
  const parent = path.dirname(dir)
  return {
    path: dir,
    parent: parent !== dir ? parent : null,
    repo: isRepo(dir),
    folders: shown.map((name) => {
      const full = path.join(dir, name)
      return { name, path: full, repo: isRepo(full) }
    }),
    truncated: names.length > shown.length,
  }
}
