import { getBoardRepos, hasBoard } from '../../../db'
import { repoInfo } from '../../../utils/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  if (!hasBoard(id)) throw createError({ statusCode: 404, statusMessage: 'Board not found' })
  return { repos: await Promise.all(getBoardRepos(id).map(repoInfo)) }
})
