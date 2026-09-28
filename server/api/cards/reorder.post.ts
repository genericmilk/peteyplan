import { reorderCards, resolveCardId } from '../../db'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ columnId?: unknown; orderedIds?: unknown }>(event)
  const columnId = typeof body?.columnId === 'string' ? body.columnId : ''
  const orderedIds = Array.isArray(body?.orderedIds)
    ? body.orderedIds.filter((id): id is string => typeof id === 'string').map((id) => resolveCardId(id))
    : []

  if (!columnId || orderedIds.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'columnId and a non-empty orderedIds list are required' })
  }

  if (!reorderCards(columnId, orderedIds)) {
    throw createError({ statusCode: 404, statusMessage: 'Column not found' })
  }
  return { ok: true }
})