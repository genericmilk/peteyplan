import { removeBoardRepo } from '../../db'
import { requireRepo } from '../../utils/repo'

export default defineEventHandler((event) => {
  removeBoardRepo(requireRepo(event).id)
  return { ok: true }
})
