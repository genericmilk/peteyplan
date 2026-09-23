import { deleteCard } from '../../db'

/** Permanently delete an archived card. */
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!deleteCard(id!)) {
    throw createError({ statusCode: 404, statusMessage: 'Card not found' })
  }
  return { ok: true, deleted: true }
})
