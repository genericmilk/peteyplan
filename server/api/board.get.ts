import { getBoard } from '../db'

export default defineEventHandler(() => {
  return getBoard()
})