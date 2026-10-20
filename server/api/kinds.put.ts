import { saveWorkTypes } from '../db'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ kinds?: unknown }>(event)
  try {
    return { kinds: saveWorkTypes(body?.kinds) }
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: err instanceof Error ? err.message : 'Invalid work types' })
  }
})
