import { archiveCard, resolveCardId } from '../../db'

/** Soft-archive a card (recoverable from /api/archive). Accepts card id or `PP-n` ref. */
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!archiveCard(resolveCardId(id!))) {
    throw createError({ statusCode: 404, statusMessage: 'Card not found' })
  }
  return { ok: true, archived: true }
})
