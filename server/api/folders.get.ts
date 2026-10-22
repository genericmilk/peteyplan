import { FolderError, folderRoots, listFolders } from '../utils/folders'

export default defineEventHandler(async (event) => {
  const query = getQuery(event).path
  try {
    return { ...listFolders(typeof query === 'string' ? query : ''), roots: await folderRoots() }
  } catch (err) {
    if (err instanceof FolderError) throw createError({ statusCode: 400, statusMessage: err.message })
    throw err
  }
})
