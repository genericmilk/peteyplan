import { getReleases } from '../db'
import { requestBoardId } from '../utils/board'

export default defineEventHandler((event) => {
  return { releases: getReleases(undefined, requestBoardId(event)) }
})
