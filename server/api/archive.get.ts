import { getArchivedCards } from '../db'
import { requestBoardId } from '../utils/board'

export default defineEventHandler((event) => {
  return { cards: getArchivedCards(requestBoardId(event)) }
})
