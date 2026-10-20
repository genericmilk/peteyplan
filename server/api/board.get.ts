import { getBoard } from '../db'
import { requestBoardId } from '../utils/board'

export default defineEventHandler((event) => {
  return getBoard(requestBoardId(event))
})