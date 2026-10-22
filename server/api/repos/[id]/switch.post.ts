import { gitSwitch } from '../../../utils/git'
import { repoInfo, requireRepo, withGit } from '../../../utils/repo'

export default defineEventHandler(async (event) => {
  const repo = requireRepo(event)
  const body = await readBody<{ branch?: unknown; mode?: unknown }>(event)
  if (typeof body?.branch !== 'string' || !body.branch.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'branch is required' })
  }
  const mode = body.mode === 'create' || body.mode === 'remote' ? body.mode : 'local'
  await withGit(() => gitSwitch(repo.path, body.branch as string, mode))
  return repoInfo(repo)
})
