import { addBoardRepo, hasBoard } from '../../../db'
import { resolveRepoRoot } from '../../../utils/git'
import { repoInfo, withGit } from '../../../utils/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  if (!hasBoard(id)) throw createError({ statusCode: 404, statusMessage: 'Board not found' })
  const body = await readBody<{ path?: unknown }>(event)
  if (typeof body?.path !== 'string' || !body.path.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'path is required' })
  }
  const root = await withGit(() => resolveRepoRoot(body.path as string))
  return repoInfo(addBoardRepo(id, root))
})
