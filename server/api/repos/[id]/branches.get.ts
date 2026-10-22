import { gitBranches } from '../../../utils/git'
import { requireRepo, withGit } from '../../../utils/repo'

export default defineEventHandler((event) => {
  const repo = requireRepo(event)
  return withGit(() => gitBranches(repo.path))
})
