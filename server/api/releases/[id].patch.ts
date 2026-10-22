import { updateRelease } from '../../db'
import { normalizeJiraKey } from '../../utils/jira'
import { readBoardScope } from '../../utils/release'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const body = await readBody<{
    title?: unknown
    weekStart?: unknown
    preprodKey?: unknown
    prodKey?: unknown
    boardScope?: unknown
    done?: unknown
    completeCards?: unknown
  }>(event)

  const changes: {
    title?: string
    weekStart?: string
    preprodKey?: string
    prodKey?: string
    boardScope?: string | null
    done?: boolean
    completeCards?: boolean
  } = {}

  if (body?.title !== undefined) {
    changes.title = typeof body.title === 'string' ? body.title.trim() : ''
  }
  if (body?.weekStart !== undefined) {
    const weekStart = typeof body.weekStart === 'string' ? body.weekStart.trim() : ''
    if (weekStart && !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      throw createError({ statusCode: 400, statusMessage: 'weekStart must be YYYY-MM-DD' })
    }
    changes.weekStart = weekStart
  }
  if (body?.preprodKey !== undefined) {
    changes.preprodKey =
      typeof body.preprodKey === 'string' ? normalizeJiraKey(body.preprodKey) : ''
  }
  if (body?.prodKey !== undefined) {
    changes.prodKey = typeof body.prodKey === 'string' ? normalizeJiraKey(body.prodKey) : ''
  }

  if (body?.boardScope !== undefined) {
    changes.boardScope = readBoardScope(body.boardScope)
  }
  if (body?.done !== undefined) {
    if (typeof body.done !== 'boolean') {
      throw createError({ statusCode: 400, statusMessage: 'done must be true or false' })
    }
    changes.done = body.done
    changes.completeCards = body.completeCards === true
  }

  const release = updateRelease(id!, changes)
  if (!release) {
    throw createError({ statusCode: 404, statusMessage: 'Release not found' })
  }
  return release
})
