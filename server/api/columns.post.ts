import { addColumn } from '../db'
import { requestBoardId } from '../utils/board'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ title?: unknown }>(event)
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  if (!title) {
    throw createError({ statusCode: 400, statusMessage: 'Column title is required' })
  }
  return addColumn(title, requestBoardId(event))
})