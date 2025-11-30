import type { Readable } from 'node:stream'
import type { z } from 'zod'
import { formatZodError } from '~/lib/env'
import { logger } from '~/lib/logger'

export type CacheFileName = string & { __brand: 'cacheFileName' }
export const BASE_FOLDER = 'gh-actions-cache'
export const UPLOAD_FOLDER = '.uploads'

export interface StorageDriver {
  delete: (cacheFileNames: CacheFileName[]) => Promise<void>
  createReadStream: (cacheFileName: CacheFileName) => Promise<ReadableStream | Readable | null>
  createDownloadUrl?: (cacheFileName: CacheFileName) => Promise<string>
  initiateMultipartUpload?: (
    uploadId: string,
    cacheFileName: CacheFileName,
  ) => Promise<string | null>
  uploadPart: (opts: {
    uploadId: string
    partNumber: number
    data: ReadableStream
    driverUploadId?: string | null
    cacheFileName?: CacheFileName
    contentLength?: number
  }) => Promise<string | null>
  completeMultipartUpload: (opts: {
    cacheFileName: CacheFileName
    uploadId: string
    partNumbers: number[]
    driverUploadId?: string | null
    partETags?: Array<{ partNumber: number; eTag: string }>
  }) => Promise<void>
  cleanupMultipartUpload: (uploadId: string, driverUploadId?: string | null) => Promise<void>
}

export function parseEnv<Schema extends z.ZodTypeAny>(schema: Schema) {
  const env = schema.safeParse(process.env)
  if (!env.success) {
    logger.error(`Invalid environment variables:\n${formatZodError(env.error)}`)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
  return env.data as z.output<Schema>
}
