import { deleteBoard, getBoards, hasBoard } from '../../db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  if (!hasBoard(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Board not found' })
  }
  if (getBoards().find((board) => board.id === id)?.isDefault) {
    throw createError({ statusCode: 400, statusMessage: 'The default board cannot be deleted' })
  }
  if (!deleteBoard(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Board could not be deleted' })
  }
  return { ok: true }
})
