import { clearColumnCards } from '../../../db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!clearColumnCards(id!)) {
    throw createError({ statusCode: 404, statusMessage: 'Column not found' })
  }
  return { ok: true }
})
