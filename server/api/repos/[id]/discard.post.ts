import { gitDiscard } from '../../../utils/git'
import { repoInfo, requireRepo, withGit } from '../../../utils/repo'

export default defineEventHandler(async (event) => {
  const repo = requireRepo(event)
  const body = await readBody<{ includeUntracked?: unknown }>(event)
  await withGit(() => gitDiscard(repo.path, body?.includeUntracked === true))
  return repoInfo(repo)
})
