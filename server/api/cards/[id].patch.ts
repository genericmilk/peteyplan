import { cardRef, resolveCardId, updateCard } from '../../db'
import { normalizeDueBy } from '../../utils/due'
import { normalizeJiraKey } from '../../utils/jira'
import { normalizeKind, normalizeProgress } from '../../utils/progress'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const body = await readBody<{
    title?: unknown
    description?: unknown
    jiraKey?: unknown
    dueBy?: unknown
    kind?: unknown
    progress?: unknown
  }>(event)

  const changes: {
    title?: string
    description?: string
    jiraKey?: string
    dueBy?: string
    kind?: ReturnType<typeof normalizeKind>
    progress?: ReturnType<typeof normalizeProgress>
  } = {}
  if (body?.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) {
      throw createError({ statusCode: 400, statusMessage: 'Card title cannot be empty' })
    }
    changes.title = title
  }
  if (body?.description !== undefined) {
    changes.description = typeof body.description === 'string' ? body.description : ''
  }
  if (body?.jiraKey !== undefined) {
    changes.jiraKey = typeof body.jiraKey === 'string' ? normalizeJiraKey(body.jiraKey) : ''
  }
  if (body?.dueBy !== undefined) {
    changes.dueBy = typeof body.dueBy === 'string' ? normalizeDueBy(body.dueBy) : ''
  }
  if (body?.kind !== undefined) {
    changes.kind = normalizeKind(body.kind)
  }
  if (body?.progress !== undefined) {
    // Kind-aware validation happens in updateCard (uses new or existing kind).
    changes.progress =
      typeof body.progress === 'string'
        ? (body.progress as ReturnType<typeof normalizeProgress>)
        : normalizeProgress(undefined)
  }

  const card = updateCard(resolveCardId(id!), changes)
  if (!card) {
    throw createError({ statusCode: 404, statusMessage: 'Card not found' })
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
