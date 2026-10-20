import type { H3Event } from 'h3'
import { DEFAULT_BOARD_ID, hasBoard } from '../db'

export function requestBoardId(event: H3Event): string {
  const value = getQuery(event).boardId
  const id = value === undefined ? DEFAULT_BOARD_ID : value
  if (typeof id !== 'string' || !hasBoard(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Board not found' })
  }
  return id
}
