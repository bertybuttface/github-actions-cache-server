import type { Buffer } from 'node:buffer'

import type { CacheFileName } from './storage-driver'

import cluster from 'node:cluster'
import { randomBytes, randomInt } from 'node:crypto'
import { createSingletonPromise } from '@antfu/utils'
import consola from 'consola'
import {
  findKeyMatch,
  findStaleKeys,
  getUpload,
  pruneKeys,
  touchKey,
  updateOrCreateKey,
  useDB,
} from '~/lib/db'

import { ENV } from '~/lib/env'
import { logger } from '~/lib/logger'
import { getStorageDriver } from '~/lib/storage/drivers'
import { getCacheFileName } from '~/lib/utils'

export const useStorageAdapter = createSingletonPromise(async () => {
  try {
    const driverName = ENV.STORAGE_DRIVER
    const driverClass = getStorageDriver(driverName)
    if (!driverClass) {
      consola.error(`No storage driver found for ${driverName}`)
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(1)
    }
    if (cluster.isPrimary) logger.info(`Using storage driver: ${driverName}`)

    const driver = await driverClass.create()
    const db = await useDB()

    return {
      driver,
      async reserveCache({ key, version }: { key: string; version: string }) {
        logger.debug('Reserve:', { key, version })

        if (await getUpload(db, { key, version })) {
          logger.debug(`Reserve: Already reserved. Ignoring...`, { key, version })
          return {
            cacheId: null,
          }
        }

        const uploadId = randomInt(1_000_000_000, 9_999_999_999)
        const cacheFileName = getCacheFileName(key, version)

        // Initiate multipart upload if driver supports it
        let driverUploadId: string | null = null
        if (driver.initiateMultipartUpload) {
          driverUploadId = await driver.initiateMultipartUpload(uploadId.toString(), cacheFileName)
        }

        await db
          .insertInto('uploads')
          .values({
            created_at: new Date().toISOString(),
            id: uploadId.toString(),
            key,
            version,
            driver_upload_id: driverUploadId,
          })
          .execute()

        logger.debug(`Reserve:`, {
          key,
          version,
          uploadId,
          driverUploadId,
        })

        return {
          cacheId: uploadId,
        }
      },
      async uploadChunk({
        uploadId,
        chunkStream,
        chunkStart,
        chunkIndex,
        contentLength,
      }: {
        uploadId: number
        chunkStream: ReadableStream<Buffer>
        chunkStart: number
        chunkIndex: number
        contentLength?: number
      }) {
        logger.debug('Upload: Starting chunk upload', {
          uploadId,
          chunkIndex,
          chunkStart,
          contentLength,
        })

        const upload = await db
          .selectFrom('uploads')
          .selectAll()
          .where('id', '=', uploadId.toString())
          .executeTakeFirst()
        if (!upload) {
          logger.debug(`Upload: Upload not found. Ignoring...`, {
            uploadId,
          })
          return
        }

        const partNumber = chunkIndex + 1
        const cacheFileName = getCacheFileName(upload.key, upload.version)

        logger.debug('Upload: Found upload record', {
          uploadId,
          key: upload.key,
          version: upload.version,
          partNumber,
          cacheFileName,
          driverUploadId: upload.driver_upload_id,
        })

        try {
          const eTag = await driver.uploadPart({
            uploadId: upload.id,
            partNumber,
            data: chunkStream,
            driverUploadId: upload.driver_upload_id,
            cacheFileName,
            contentLength,
          })
          logger.debug('Upload: Driver uploadPart completed', {
            uploadId,
            partNumber,
            eTag,
            contentLength,
          })

          await db
            .insertInto('upload_parts')
            .values({
              part_number: partNumber,
              upload_id: uploadId.toString(),
              e_tag: eTag,
            })
            .execute()

          logger.info('Upload: Chunk uploaded successfully', {
            uploadId,
            chunkStart,
            partNumber,
            eTag,
          })
        } catch (err) {
          logger.error('Upload: Error', {
            uploadId,
            chunkStart,
            partNumber,
            error: err,
          })
          throw err
        }
      },
      async commitCache(uploadId: number | string) {
        logger.info('Commit: Starting', { uploadId })

        const upload = await db
          .selectFrom('uploads')
          .selectAll()
          .where('id', '=', uploadId.toString())
          .executeTakeFirst()

        if (!upload) {
          logger.debug('Commit: Upload not found. Ignoring...', { uploadId })
          return
        }

        logger.debug('Commit: Found upload', {
          uploadId,
          key: upload.key,
          version: upload.version,
          driverUploadId: upload.driver_upload_id,
        })

        const parts = await db
          .selectFrom('upload_parts')
          .selectAll()
          .where('upload_id', '=', upload.id)
          .orderBy('part_number', 'asc')
          .execute()

        logger.info('Commit: Found parts', {
          uploadId,
          partCount: parts.length,
          partNumbers: parts.map((p) => p.part_number),
          hasETags: parts.filter((p) => p.e_tag !== null).length,
        })

        await db.transaction().execute(async (tx) => {
          logger.debug('Commit: Starting transaction', { uploadId })

          await tx.deleteFrom('uploads').where('id', '=', upload.id).execute()
          await updateOrCreateKey(tx, {
            key: upload.key,
            version: upload.version,
          })

          logger.debug('Commit: Calling driver.completeMultipartUpload', {
            uploadId,
            cacheFileName: getCacheFileName(upload.key, upload.version),
            partCount: parts.length,
          })

          await driver.completeMultipartUpload({
            cacheFileName: getCacheFileName(upload.key, upload.version),
            uploadId: upload.id,
            partNumbers: parts.map((part) => part.part_number),
            driverUploadId: upload.driver_upload_id,
            partETags: parts
              .filter((part) => part.e_tag !== null)
              .map((part) => ({
                partNumber: part.part_number,
                eTag: part.e_tag as string,
              })),
          })

          logger.info('Commit: Successfully completed', {
            uploadId,
            key: upload.key,
            version: upload.version,
          })
        })
      },
      async getCacheEntry({ keys, version }: { keys: string[]; version: string }) {
        const primaryKey = keys[0]
        const restoreKeys = keys.length > 1 ? keys.slice(1) : undefined

        const cacheKey = await findKeyMatch(db, { key: primaryKey, version, restoreKeys })

        if (!cacheKey) {
          logger.debug('Get: Cache entry not found', { keys, version })
          return null
        }

        await touchKey(db, { key: cacheKey.key, version: cacheKey.version })

        const cacheFileName = getCacheFileName(cacheKey.key, cacheKey.version)

        logger.debug('Get: Found', cacheKey)

        return {
          archiveLocation:
            ENV.ENABLE_DIRECT_DOWNLOADS && driver.createDownloadUrl
              ? await driver.createDownloadUrl(cacheFileName)
              : createLocalDownloadUrl(cacheFileName),
          cacheKey: cacheKey.key,
        }
      },
      async download(cacheFileName: CacheFileName) {
        logger.debug('Download:', cacheFileName)
        return driver.createReadStream(cacheFileName)
      },
      async pruneCaches(olderThanDays?: number) {
        logger.debug('Prune:', {
          olderThanDays,
        })

        const keys = await findStaleKeys(db, { olderThanDays })
        if (keys.length === 0) {
          logger.debug('Prune: No caches to prune')
          return
        }

        await driver.delete(keys.map((key) => getCacheFileName(key.key, key.version)))
        await pruneKeys(db, keys)

        logger.debug('Prune: Caches pruned', {
          olderThanDays,
        })
      },
      async pruneUploads(olderThanDate: Date) {
        logger.debug('Prune uploads')

        // uploads older than 24 hours
        const uploads = await db
          .selectFrom('uploads')
          .selectAll()
          .where('created_at', '<', olderThanDate.toISOString())
          .execute()

        for (const upload of uploads) {
          try {
            await driver.cleanupMultipartUpload(upload.id, upload.driver_upload_id)
            await db.deleteFrom('uploads').where('id', '=', upload.id).execute()
          } catch (err) {
            logger.error('Failed to cleanup upload', upload, err)
          }
        }
      },
    }
  } catch (err) {
    consola.error('Failed to initialize storage driver:', err)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
})

function createLocalDownloadUrl(cacheFileName: CacheFileName) {
  return `${ENV.API_BASE_URL}/download/${randomBytes(64).toString('hex')}/${cacheFileName}`
}
