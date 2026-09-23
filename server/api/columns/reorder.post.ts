import { reorderColumns } from '../../db'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ orderedIds?: unknown }>(event)
  const orderedIds = Array.isArray(body?.orderedIds)
    ? body.orderedIds.filter((id): id is string => typeof id === 'string')
    : []

  if (orderedIds.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'A non-empty orderedIds list is required' })
  }

  if (!reorderColumns(orderedIds)) {
    throw createError({ statusCode: 400, statusMessage: 'orderedIds must list every column exactly once' })
  }
  return { ok: true }
})
