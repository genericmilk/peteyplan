import { gitVersion } from '../utils/git'

export default defineEventHandler(async () => {
  const version = await gitVersion()
  return { available: !!version, version }
})
