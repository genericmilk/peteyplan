import { getWorkTypes } from '../db'

export default defineEventHandler(() => ({ kinds: getWorkTypes() }))
