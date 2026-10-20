import { getBoards } from '../db'

export default defineEventHandler(() => ({ boards: getBoards() }))
