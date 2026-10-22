import { cardRef, cardReleaseProblem, resolveCardId, setCardRelease } from '../../../db'

export default defineEventHandler(async (event) => {
  const releaseId = getRouterParam(event, 'id')
  const body = await readBody<{ cardId?: unknown }>(event)
  const cardId = typeof body?.cardId === 'string' ? resolveCardId(body.cardId) : ''

  if (!cardId) {
    throw createError({ statusCode: 400, statusMessage: 'cardId is required' })
  }

  const problem = cardReleaseProblem(cardId, releaseId!)
  if (problem) {
    throw createError({ statusCode: problem.endsWith('not found') ? 404 : 409, statusMessage: problem })
  }

  const card = setCardRelease(cardId, releaseId!)
  if (!card) {
    throw createError({ statusCode: 404, statusMessage: 'Card or release not found' })
  }

  return {
    id: card.id,
    number: card.number,
    ref: cardRef(card.number ?? 0),
    releaseId: card.release_id,
    columnId: card.column_id,
  }
})
