import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'
import { logger } from '~/lib/logger'

import { useStorageAdapter } from '~/lib/storage'

// https://github.com/actions/toolkit/blob/340a6b15b5879eefe1412ee6c8606978b091d3e8/packages/cache/src/cache.ts#L470
const MB = 1024 * 1024

const pathParamsSchema = z.object({
  cacheId: z.coerce.number(),
})

export default defineEventHandler(async (event) => {
  const parsedPathParams = pathParamsSchema.safeParse(event.context.params)
  if (!parsedPathParams.success)
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid path parameters: ${parsedPathParams.error.message}`,
    })

  const { cacheId } = parsedPathParams.data
  const query = getQuery(event)

  logger.debug('Upload request:', {
    cacheId,
    query,
    method: event.method,
    userAgent: getHeader(event, 'user-agent'),
  })

  if (query.comp === 'blocklist') {
    // Azure Blob Storage Put Block List acknowledgment
    // Note: This does NOT commit the cache - FinalizeCacheEntryUpload does that
    logger.debug(`Blocklist acknowledgment for cache ${cacheId}`)
    setResponseStatus(event, 201)
    // prevent random EOF error with in tonistiigi/go-actions-cache caused by missing request id
    setHeader(event, 'x-ms-request-id', randomUUID())
    return
  }

  const blockId = query.blockid as string
  // if no block id, upload smaller than chunk size
  const chunkIndex = blockId ? getChunkIndexFromBlockId(blockId) : 0
  if (chunkIndex === undefined) {
    logger.error('Invalid block id:', { blockId })
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid block id: ${blockId}`,
    })
  }

  logger.debug('Uploading block:', { cacheId, blockId, chunkIndex })

  const stream = getRequestWebStream(event)
  if (!stream) {
    logger.debug('Upload: Request body is not a stream')
    throw createError({ statusCode: 400, statusMessage: 'Request body must be a stream' })
  }

  const userAgent = getHeader(event, 'user-agent')
  const contentLengthHeader = getHeader(event, 'content-length')
  const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined

  // 1 MB for docker buildx
  // 64 MB for everything else
  const chunkSize = userAgent && userAgent.startsWith('azsdk-go-azblob') ? MB : 64 * MB
  const start = chunkIndex * chunkSize

  logger.debug('Upload chunk details:', {
    cacheId,
    chunkIndex,
    chunkStart: start,
    chunkSize,
    contentLength,
    isAzureSdk: userAgent?.startsWith('azsdk-go-azblob'),
    userAgent,
  })

  const adapter = await useStorageAdapter()
  try {
    await adapter.uploadChunk({
      uploadId: cacheId,
      chunkStream: stream as ReadableStream<Buffer>,
      chunkStart: start,
      chunkIndex,
      contentLength,
    })
    logger.info(`Chunk ${chunkIndex} uploaded successfully for cache ${cacheId}`)
  } catch (err) {
    logger.error('Upload chunk failed:', { cacheId, chunkIndex, error: err })
    throw err
  }

  // prevent random EOF error with in tonistiigi/go-actions-cache caused by missing request id
  setHeader(event, 'x-ms-request-id', randomUUID())
  setResponseStatus(event, 201)
})

function getChunkIndexFromBlockId(blockIdBase64: string) {
  const base64Decoded = Buffer.from(blockIdBase64, 'base64')

  // 64 bytes used by docker buildx
  // 48 bytes used by everything else
  if (base64Decoded.length === 64) {
    return base64Decoded.readUInt32BE(16)
  } else if (base64Decoded.length === 48) {
    const decoded = base64Decoded.toString('utf8')

    // slice off uuid and convert to number
    const index = Number.parseInt(decoded.slice(36))
    if (Number.isNaN(index)) return

    return index
  }
}
