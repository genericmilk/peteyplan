import { cardRef, getCardRow, getRelease, resolveCardId, setCardRelease } from '../../../../db'

export default defineEventHandler((event) => {
  const releaseId = getRouterParam(event, 'id')
  const cardIdParam = getRouterParam(event, 'cardId')
  const release = getRelease(releaseId!)
  if (!release) {
    throw createError({ statusCode: 404, statusMessage: 'Release not found' })
  }
  if (release.done_at) {
    throw createError({ statusCode: 409, statusMessage: 'This release is done. Reopen it to change its cards.' })
  }

  const cardId = resolveCardId(cardIdParam!)
  const existing = getCardRow(cardId)
  if (!existing || existing.archived_at || existing.release_id !== releaseId) {
    throw createError({ statusCode: 404, statusMessage: 'Card not in this release' })
  }

  const card = setCardRelease(cardId, null)
  if (!card) {
    throw createError({ statusCode: 404, statusMessage: 'Card not found' })
  }

  return {
    id: card.id,
    number: card.number,
    ref: cardRef(card.number ?? 0),
    releaseId: null,
    columnId: card.column_id,
  }
})
