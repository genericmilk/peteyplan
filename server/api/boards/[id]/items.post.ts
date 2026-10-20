import { transferBoardItem } from '../../../db'

export default defineEventHandler(async (event) => {
  const toBoardId = getRouterParam(event, 'id')!
  const body = await readBody<{
    fromBoardId?: unknown
    type?: unknown
    itemId?: unknown
    targetColumnId?: unknown
    targetPosition?: unknown
    newColumn?: unknown
  }>(event)
  const fromBoardId = typeof body?.fromBoardId === 'string' ? body.fromBoardId : ''
  const type = body?.type === 'card' || body?.type === 'column' ? body.type : null
  const itemId = typeof body?.itemId === 'string' ? body.itemId : ''
  const targetColumnId = typeof body?.targetColumnId === 'string' ? body.targetColumnId : undefined
  const targetPosition = body?.targetPosition
  if (!fromBoardId || !type || !itemId) {
    throw createError({ statusCode: 400, statusMessage: 'fromBoardId, type, and itemId are required' })
  }
  if (targetPosition !== undefined && (typeof targetPosition !== 'number' || !Number.isInteger(targetPosition) || targetPosition < 0)) {
    throw createError({ statusCode: 400, statusMessage: 'targetPosition must be a non-negative integer' })
  }

  const result = transferBoardItem(
    fromBoardId,
    toBoardId,
    type,
    itemId,
    targetColumnId,
    typeof targetPosition === 'number' ? targetPosition : undefined,
    body?.newColumn === true
  )
  if (result === 'missing-target-column') {
    throw createError({ statusCode: 409, statusMessage: 'No valid destination column exists on this board' })
  }
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: 'Board or item not found' })
  }
  return { ok: true }
})
