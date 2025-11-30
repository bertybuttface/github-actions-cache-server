import type { StorageDriver } from '~/lib/storage/storage-driver'

import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import * as R from 'remeda'
import { z } from 'zod'
import { BASE_FOLDER, parseEnv } from '~/lib/storage/storage-driver'

export const S3StorageDriver = {
  async create() {
    const options = parseEnv(
      z.object({
        STORAGE_S3_BUCKET: z.string().min(1),
        // AWS SDK requires an AWS_REGION to be set, even if you're using a custom endpoint
        AWS_REGION: z.string().default('us-east-1'),
      }),
    )

    const s3 = new S3Client({
      forcePathStyle: true,
      region: options.AWS_REGION,
    })

    try {
      await s3.send(
        new HeadBucketCommand({
          Bucket: options.STORAGE_S3_BUCKET,
        }),
      )
      // bucket exists
    } catch (err: any) {
      if (err.name === 'NotFound') {
        throw new Error(`Bucket ${options.STORAGE_S3_BUCKET} does not exist`)
      }
      throw err
    }

    async function deleteMany(objectNames: string[]) {
      return await Promise.all(
        R.chunk(objectNames, 1000).map((chunkedObjectNames) =>
          s3.send(
            new DeleteObjectsCommand({
              Bucket: options.STORAGE_S3_BUCKET,
              Delete: {
                Objects: chunkedObjectNames.map((objectName) => ({
                  Key: objectName,
                })),
                Quiet: true,
              },
            }),
          ),
        ),
      )
    }

    return <StorageDriver>{
      async delete(cacheFileNames) {
        await deleteMany(cacheFileNames.map((fileName) => `${BASE_FOLDER}/${fileName}`))
      },

      async createReadStream(cacheFileName) {
        const response = await s3.send(
          new GetObjectCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Key: `${BASE_FOLDER}/${cacheFileName}`,
          }),
        )

        return response.Body as ReadableStream
      },
      async createDownloadUrl(cacheFileName) {
        return getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Key: `${BASE_FOLDER}/${cacheFileName}`,
          }),
          {
            expiresIn: 5 * 60 * 1000, // 5 minutes
          },
        )
      },
      async initiateMultipartUpload(uploadId, cacheFileName) {
        const result = await s3.send(
          new CreateMultipartUploadCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Key: `${BASE_FOLDER}/${cacheFileName}`,
          }),
        )
        return result.UploadId || null
      },

      async uploadPart(opts) {
        if (!opts.driverUploadId) {
          throw new Error('S3 driver requires driverUploadId for uploadPart')
        }
        if (!opts.cacheFileName) {
          throw new Error('S3 driver requires cacheFileName for uploadPart')
        }

        try {
          // Upload directly without buffering - S3 accepts ReadableStream
          const result = await s3.send(
            new UploadPartCommand({
              Bucket: options.STORAGE_S3_BUCKET,
              Key: `${BASE_FOLDER}/${opts.cacheFileName}`,
              UploadId: opts.driverUploadId,
              PartNumber: opts.partNumber,
              Body: opts.data as any,
            }),
          )

          return result.ETag || null
        } catch (err) {
          console.error('S3 uploadPart failed:', {
            bucket: options.STORAGE_S3_BUCKET,
            key: `${BASE_FOLDER}/${opts.cacheFileName}`,
            uploadId: opts.driverUploadId,
            partNumber: opts.partNumber,
            error: err,
          })
          throw err
        }
      },

      async completeMultipartUpload(opts) {
        if (!opts.driverUploadId) {
          throw new Error('S3 driver requires driverUploadId for completeMultipartUpload')
        }
        if (!opts.partETags || opts.partETags.length === 0) {
          throw new Error('S3 driver requires partETags for completeMultipartUpload')
        }

        // CompleteMultipartUpload assembles the parts server-side - no download/re-upload needed!
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: options.STORAGE_S3_BUCKET,
            Key: `${BASE_FOLDER}/${opts.cacheFileName}`,
            UploadId: opts.driverUploadId,
            MultipartUpload: {
              Parts: opts.partETags.map((part) => ({
                ETag: part.eTag,
                PartNumber: part.partNumber,
              })),
            },
          }),
        )
      },
      async cleanupMultipartUpload(uploadId, driverUploadId) {
        // If driverUploadId is provided, abort the S3 multipart upload
        // We don't know the cacheFileName here, so we can't abort properly
        // This is a limitation - we'll need to store cacheFileName in the uploads table
        // For now, list and delete any orphaned multipart uploads manually or via lifecycle policies
        if (driverUploadId) {
          // Can't abort without knowing the key - S3 limitation
          // AbortMultipartUpload requires both Key and UploadId
          // Multipart uploads should be cleaned up via S3 lifecycle rules
        }
      },
    }
  },
}
