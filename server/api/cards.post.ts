import { addCard, cardRef } from '../db'
import { normalizeDueBy } from '../utils/due'
import { normalizeJiraKey } from '../utils/jira'
import { DEFAULT_KIND, DEFAULT_PROGRESS, normalizeKind, normalizeProgress } from '../utils/progress'

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    columnId?: unknown
    title?: unknown
    description?: unknown
    jiraKey?: unknown
    dueBy?: unknown
    kind?: unknown
    progress?: unknown
    /** UI create: mark as viewed so the unread dot is not shown */
    markViewed?: unknown
  }>(event)
  const columnId = typeof body?.columnId === 'string' ? body.columnId : ''
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  const description = typeof body?.description === 'string' ? body.description : ''
  const jiraKey =
    typeof body?.jiraKey === 'string' ? normalizeJiraKey(body.jiraKey) : ''
  const dueBy = typeof body?.dueBy === 'string' ? normalizeDueBy(body.dueBy) : ''
  const kind = body?.kind !== undefined ? normalizeKind(body.kind) : DEFAULT_KIND
  const progress =
    body?.progress !== undefined ? normalizeProgress(body.progress, kind) : DEFAULT_PROGRESS
  const markViewed = body?.markViewed === true

  if (!columnId || !title) {
    throw createError({ statusCode: 400, statusMessage: 'columnId and title are required' })
  }

  const card = addCard(columnId, title, description, jiraKey, dueBy, progress, kind, markViewed)
  if (!card) {
    throw createError({ statusCode: 404, statusMessage: 'Column not found' })
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
    viewedAt: card.viewed_at,
    columnId: card.column_id,
    position: card.position,
  }
})
