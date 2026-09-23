import { getArchivedCards } from '../db'

export default defineEventHandler(() => {
  return { cards: getArchivedCards() }
})
