import type { StorageDriver } from '~/lib/storage/storage-driver'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'

import { pipeline } from 'node:stream/promises'

import { z } from 'zod'
import { BASE_FOLDER, parseEnv, UPLOAD_FOLDER } from '~/lib/storage/storage-driver'

export const FilesystemStorageDriver = {
  async create() {
    const options = parseEnv(
      z.object({
        STORAGE_FILESYSTEM_PATH: z.string().default('.data/storage/filesystem'),
      }),
    )

    const rootFolder = options.STORAGE_FILESYSTEM_PATH
    await fs.mkdir(path.join(rootFolder, BASE_FOLDER), {
      recursive: true,
    })
    await fs.mkdir(path.join(rootFolder, BASE_FOLDER, UPLOAD_FOLDER), {
      recursive: true,
    })

    return <StorageDriver>{
      async uploadPart(opts) {
        const folderPath = path.join(rootFolder, BASE_FOLDER, UPLOAD_FOLDER, opts.uploadId)
        await fs.mkdir(folderPath, { recursive: true })
        const writeStream = await createWriteStream(
          path.join(folderPath, `part_${opts.partNumber}`),
        )
        await pipeline(opts.data, writeStream)
        return null
      },

      async completeMultipartUpload(opts) {
        const outputPath = path.join(rootFolder, BASE_FOLDER, opts.cacheFileName)
        const writeStream = createWriteStream(outputPath)

        for (const partNumber of opts.partNumbers) {
          const partPath = path.join(
            rootFolder,
            BASE_FOLDER,
            UPLOAD_FOLDER,
            opts.uploadId,
            `part_${partNumber}`,
          )
          await pipeline(createReadStream(partPath), writeStream, { end: false })
        }

        writeStream.end()
        await new Promise<void>((resolve, reject) => {
          writeStream.on('finish', resolve)
          writeStream.on('error', reject)
        })

        await this.cleanupMultipartUpload(opts.uploadId)
      },

      async cleanupMultipartUpload(uploadId) {
        await fs.rm(path.join(rootFolder, BASE_FOLDER, UPLOAD_FOLDER, uploadId), {
          force: true,
          recursive: true,
        })
      },

      async delete(cacheFileNames): Promise<void> {
        await Promise.all(
          cacheFileNames.map((cacheFileName) =>
            fs.rm(path.join(rootFolder, BASE_FOLDER, cacheFileName), { force: true }),
          ),
        )
      },

      async createReadStream(cacheFileName) {
        const filePath = path.join(rootFolder, BASE_FOLDER, cacheFileName)
        try {
          await fs.access(filePath)
          return createReadStream(filePath)
        } catch {
          return null
        }
      },
    }
  },
}
