import { hasBoard, updateBoard } from '../../db'
import { isBoardEmoji } from '../../../shared/boards'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ name?: unknown; emoji?: unknown; color?: unknown }>(event)
  if (!hasBoard(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Board not found' })
  }

  const changes: { name?: string; emoji?: string; color?: string } = {}
  if (body?.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 60) {
      throw createError({ statusCode: 400, statusMessage: 'Board name must be between 1 and 60 characters' })
    }
    changes.name = name
  }
  if (body?.emoji !== undefined) {
    const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : ''
    if (emoji.length > 32 || !isBoardEmoji(emoji)) {
      throw createError({ statusCode: 400, statusMessage: 'Choose a single emoji for the board' })
    }
    changes.emoji = emoji
  }
  if (body?.color !== undefined) {
    const color = typeof body.color === 'string' ? body.color.trim() : ''
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      throw createError({ statusCode: 400, statusMessage: 'Board color must be a 6-digit hex color' })
    }
    changes.color = color
  }
  if (Object.keys(changes).length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'At least one board setting is required' })
  }

  return updateBoard(id, changes)
})
