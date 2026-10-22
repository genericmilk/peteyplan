import { gitCommitAll } from '../../../utils/git'
import { repoInfo, requireRepo, withGit } from '../../../utils/repo'

export default defineEventHandler(async (event) => {
  const repo = requireRepo(event)
  const body = await readBody<{ message?: unknown; push?: unknown }>(event)
  const message = typeof body?.message === 'string' ? body.message : ''
  await withGit(() => gitCommitAll(repo.path, message, body?.push === true))
  return repoInfo(repo)
})
