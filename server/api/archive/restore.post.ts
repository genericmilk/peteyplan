import { cardRef, resolveCardId, restoreCard } from '../../db'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ cardId?: unknown; columnId?: unknown }>(event)
  const cardId = typeof body?.cardId === 'string' ? body.cardId : ''
  const columnId = typeof body?.columnId === 'string' && body.columnId ? body.columnId : undefined

  if (!cardId) {
    throw createError({ statusCode: 400, statusMessage: 'cardId is required' })
  }

  const card = restoreCard(resolveCardId(cardId), columnId)
  if (!card) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Archived card not found, or its column no longer exists',
    })
  }
  return {
    id: card.id,
    number: card.number,
    ref: cardRef(card.number ?? 0),
    title: card.title,
    description: card.description,
    jiraKey: card.jira_key,
    dueBy: card.due_by,
    kind: card.kind,
    progress: card.progress,
    completedAt: card.completed_at,
    archivedAt: card.archived_at,
    columnId: card.column_id,
    position: card.position,
  }
})
