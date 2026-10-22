import { hasBoard } from '../db'

/** Read a `boardScope` body field: a board id, or null for a shared release. */
export function readBoardScope(value: unknown): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !hasBoard(value)) {
    throw createError({ statusCode: 400, statusMessage: 'boardScope must be a board id or null' })
  }
  return value
}
