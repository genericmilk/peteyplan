import path from 'node:path'
import type { H3Event } from 'h3'
import { getRepo, type BoardRepo } from '../db'
import { GitError, gitStatus, type GitStatus } from './git'

export interface RepoInfo extends BoardRepo {
  name: string
  status: GitStatus | null
  /** Why status couldn't be read (folder moved, git missing…) */
  error: string | null
}

/** The linked repo named by the `id` route param. */
export function requireRepo(event: H3Event): BoardRepo {
  const repo = getRepo(getRouterParam(event, 'id') || '')
  if (!repo) throw createError({ statusCode: 404, statusMessage: 'Linked folder not found' })
  return repo
}

/** Run a git operation, turning git failures into HTTP errors with git's message. */
export async function withGit<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (err) {
    if (err instanceof GitError) throw createError({ statusCode: err.status, statusMessage: err.message })
    throw err
  }
}

export async function repoInfo(repo: BoardRepo): Promise<RepoInfo> {
  const base = { ...repo, name: path.basename(repo.path) }
  try {
    return { ...base, status: await gitStatus(repo.path), error: null }
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    return { ...base, status: null, error: err.message }
  }
}
