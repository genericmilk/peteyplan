import { gitPush } from '../../../utils/git'
import { repoInfo, requireRepo, withGit } from '../../../utils/repo'

export default defineEventHandler(async (event) => {
  const repo = requireRepo(event)
  await withGit(() => gitPush(repo.path))
  return repoInfo(repo)
})
