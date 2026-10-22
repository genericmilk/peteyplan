import { repoInfo, requireRepo } from '../../../utils/repo'

export default defineEventHandler((event) => repoInfo(requireRepo(event)))
