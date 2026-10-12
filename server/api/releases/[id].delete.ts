import { deleteRelease } from '../../db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!deleteRelease(id!)) {
    throw createError({ statusCode: 404, statusMessage: 'Release not found' })
  }
  return { ok: true }
})
