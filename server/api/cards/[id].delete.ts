import { archiveCard } from '../../db'

/** Soft-archive a card (recoverable from /api/archive). */
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!archiveCard(id!)) {
    throw createError({ statusCode: 404, statusMessage: 'Card not found' })
  }
  return { ok: true, archived: true }
})
