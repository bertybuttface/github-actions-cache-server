import { z } from 'zod'
import { ENV } from '~/lib/env'
import { useStorageAdapter } from '~/lib/storage'

const bodySchema = z.object({
  key: z.string(),
  version: z.string(),
})

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) as unknown
  const parsedBody = bodySchema.safeParse(body)
  if (!parsedBody.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid body: ${parsedBody.error.message}`,
    })

  const { key, version } = parsedBody.data

  const adapter = await useStorageAdapter()
  const reservation = await adapter.reserveCache({ key, version })
  if (!reservation.cacheId) {
    console.log('CreateCacheEntry: Cache already exists or reservation failed', { key, version })
    return {
      ok: false,
    }
  }

  const response = {
    ok: true,
    signed_upload_url: `${ENV.API_BASE_URL}/upload/${reservation.cacheId}`,
  }

  console.log('CreateCacheEntry: Success', {
    key,
    version,
    cacheId: reservation.cacheId,
    signed_upload_url: response.signed_upload_url,
  })

  return response
})
