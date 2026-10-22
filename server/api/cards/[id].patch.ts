import { normalizeChecklist } from '../../../shared/checklist'
import { normalizePullRequests } from '../../../shared/pullRequests'
import { cardRef, cardReleaseProblem, getCardRow, getRelease, resolveCardId, updateCard } from '../../db'
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
    releaseId?: unknown
    viewed?: unknown
    checklist?: unknown
    pullRequests?: unknown
  }>(event)

  const changes: {
    title?: string
    description?: string
    jiraKey?: string
    dueBy?: string
    kind?: ReturnType<typeof normalizeKind>
    progress?: ReturnType<typeof normalizeProgress>
    releaseId?: string | null
    viewed?: boolean
    checklist?: ReturnType<typeof normalizeChecklist>
    pullRequests?: string[]
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
  if (body?.releaseId !== undefined) {
    if (body.releaseId === null || body.releaseId === '') {
      changes.releaseId = null
    } else if (typeof body.releaseId === 'string') {
      changes.releaseId = body.releaseId
    } else {
      throw createError({ statusCode: 400, statusMessage: 'releaseId must be a string or null' })
    }
  }
  if (body?.viewed === true) {
    changes.viewed = true
  }
  if (body?.checklist !== undefined) {
    if (!Array.isArray(body.checklist)) {
      throw createError({ statusCode: 400, statusMessage: 'checklist must be an array' })
    }
    changes.checklist = normalizeChecklist(body.checklist)
  }
  if (body?.pullRequests !== undefined) {
    if (!Array.isArray(body.pullRequests)) {
      throw createError({ statusCode: 400, statusMessage: 'pullRequests must be an array of URLs' })
    }
    changes.pullRequests = normalizePullRequests(body.pullRequests)
  }

  const cardId = resolveCardId(id!)
  const current = getCardRow(cardId)
  if (current && changes.releaseId !== undefined && changes.releaseId !== current.release_id) {
    if (current.release_id && getRelease(current.release_id)?.done_at) {
      throw createError({ statusCode: 409, statusMessage: 'Its release is done. Reopen it to change its cards.' })
    }
    const problem = changes.releaseId && cardReleaseProblem(cardId, changes.releaseId)
    if (problem) throw createError({ statusCode: problem.endsWith('not found') ? 404 : 409, statusMessage: problem })
  }

  const card = updateCard(cardId, changes)
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
    viewedAt: card.viewed_at,
    checklist: normalizeChecklist(card.checklist),
    pullRequests: normalizePullRequests(card.pull_requests),
    columnId: card.column_id,
    releaseId: card.release_id,
    position: card.position,
  }
})
