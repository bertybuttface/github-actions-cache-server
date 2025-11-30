import { z } from 'zod'
import { getUpload, useDB } from '~/lib/db'
import { useStorageAdapter } from '~/lib/storage'

const bodySchema = z.object({
  key: z.string(),
  version: z.string(),
})

export default defineEventHandler(async (event) => {
  const parsedBody = bodySchema.safeParse(await readBody(event))
  if (!parsedBody.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${parsedBody.error.message}`,
    })

  const { key, version } = parsedBody.data

  console.log('FinalizeCacheEntryUpload: Request received', { key, version })

  const db = await useDB()
  const adapter = await useStorageAdapter()
  const upload = await getUpload(db, { key, version })

  if (!upload) {
    console.log('FinalizeCacheEntryUpload: Upload not found', { key, version })
    throw createError({
      statusCode: 404,
      statusMessage: 'Upload not found',
    })
  }

  console.log('FinalizeCacheEntryUpload: Committing cache', { key, version, uploadId: upload.id })

  try {
    await adapter.commitCache(upload.id)
    console.log('FinalizeCacheEntryUpload: Success', { key, version, entryId: upload.id })
  } catch (err) {
    console.error('FinalizeCacheEntryUpload: Commit failed', {
      key,
      version,
      uploadId: upload.id,
      error: err,
    })
    throw err
  }

  return {
    ok: true,
    entry_id: upload.id,
  }
})
