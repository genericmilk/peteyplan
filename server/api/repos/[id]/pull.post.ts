import { gitPull } from '../../../utils/git'
import { repoInfo, requireRepo, withGit } from '../../../utils/repo'

export default defineEventHandler(async (event) => {
  const repo = requireRepo(event)
  await withGit(() => gitPull(repo.path))
  return repoInfo(repo)
})
