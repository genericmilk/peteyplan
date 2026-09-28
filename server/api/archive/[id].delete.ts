import { deleteCard, resolveCardId } from '../../db'

/** Permanently delete an archived card. Accepts card id or `PP-n` ref. */
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!deleteCard(resolveCardId(id!))) {
    throw createError({ statusCode: 404, statusMessage: 'Card not found' })
  }
  return { ok: true, deleted: true }
})
