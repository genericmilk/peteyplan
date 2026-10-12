import { getReleases } from '../db'

export default defineEventHandler(() => {
  return { releases: getReleases() }
})
