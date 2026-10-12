import { updateRelease } from '../../db'
import { normalizeJiraKey } from '../../utils/jira'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const body = await readBody<{
    title?: unknown
    weekStart?: unknown
    preprodKey?: unknown
    prodKey?: unknown
  }>(event)

  const changes: {
    title?: string
    weekStart?: string
    preprodKey?: string
    prodKey?: string
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

  const release = updateRelease(id!, changes)
  if (!release) {
    throw createError({ statusCode: 404, statusMessage: 'Release not found' })
  }
  return release
})
