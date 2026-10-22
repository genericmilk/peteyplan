import { addRelease } from '../db'
import { normalizeJiraKey } from '../utils/jira'
import { requestBoardId } from '../utils/board'
import { readBoardScope } from '../utils/release'

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    title?: unknown
    weekStart?: unknown
    preprodKey?: unknown
    prodKey?: unknown
    boardScope?: unknown
  }>(event)

  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  const weekStart = typeof body?.weekStart === 'string' ? body.weekStart.trim() : ''
  const preprodKey =
    typeof body?.preprodKey === 'string' ? normalizeJiraKey(body.preprodKey) : ''
  const prodKey = typeof body?.prodKey === 'string' ? normalizeJiraKey(body.prodKey) : ''

  if (weekStart && !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw createError({ statusCode: 400, statusMessage: 'weekStart must be YYYY-MM-DD' })
  }

  const boardScope = body?.boardScope === undefined ? null : readBoardScope(body.boardScope)

  return addRelease({
    title: title || undefined,
    weekStart: weekStart || undefined,
    preprodKey,
    prodKey,
    boardScope,
  }, requestBoardId(event))
})
