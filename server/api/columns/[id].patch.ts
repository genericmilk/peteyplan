import { renameColumn } from '../../db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const body = await readBody<{ title?: unknown }>(event)
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  if (!title) {
    throw createError({ statusCode: 400, statusMessage: 'Column title is required' })
  }
  if (!renameColumn(id!, title)) {
    throw createError({ statusCode: 404, statusMessage: 'Column not found' })
  }
  return { ok: true }
})