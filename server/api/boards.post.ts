import { createBoard } from '../db'
import { isBoardEmoji } from '../../shared/boards'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: unknown; emoji?: unknown; color?: unknown }>(event)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const emoji = typeof body?.emoji === 'string' ? body.emoji.trim() : '📋'
  const color = typeof body?.color === 'string' ? body.color.trim() : '#5b8cff'

  if (!name || name.length > 60) {
    throw createError({ statusCode: 400, statusMessage: 'Board name must be between 1 and 60 characters' })
  }
  if (emoji.length > 32 || !isBoardEmoji(emoji)) {
    throw createError({ statusCode: 400, statusMessage: 'Choose a single emoji for the board' })
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw createError({ statusCode: 400, statusMessage: 'Board color must be a 6-digit hex color' })
  }

  return createBoard(name, emoji, color)
})
