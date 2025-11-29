import { randomBytes } from 'node:crypto'

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000'
const CACHE_SIZE_MB = Number(process.env.CACHE_SIZE_MB) || 100
const CHUNK_SIZE_MB = Number(process.env.CHUNK_SIZE_MB) || 32
const ITERATIONS = Number(process.env.ITERATIONS) || 10

const CACHE_SIZE = CACHE_SIZE_MB * 1024 * 1024
const CHUNK_SIZE = CHUNK_SIZE_MB * 1024 * 1024

interface BenchmarkResult {
  operation: string
  sizeMB: number
  durationMs: number
  throughputMBps: number
}

interface BenchmarkStats {
  operation: string
  sizeMB: number
  iterations: number
  mean: number
  stdDev: number
  min: number
  max: number
  median: number
}

function calculateStats(operation: string, results: BenchmarkResult[]): BenchmarkStats {
  const throughputs = results.map((r) => r.throughputMBps).sort((a, b) => a - b)
  const mean = throughputs.reduce((a, b) => a + b, 0) / throughputs.length
  const variance = throughputs.reduce((sum, val) => sum + (val - mean) ** 2, 0) / throughputs.length
  const stdDev = Math.sqrt(variance)
  const median = throughputs[Math.floor(throughputs.length / 2)]

  return {
    operation,
    sizeMB: results[0].sizeMB,
    iterations: results.length,
    mean,
    stdDev,
    min: Math.min(...throughputs),
    max: Math.max(...throughputs),
    median,
  }
}

async function reserveCache(key: string, version: string): Promise<number> {
  const res = await fetch(`${BASE_URL}/_apis/artifactcache/caches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, version }),
  })

  if (!res.ok) {
    throw new Error(`Reserve failed: ${res.status} ${await res.text()}`)
  }

  const data = (await res.json()) as { cacheId: number | null }
  if (!data.cacheId) {
    throw new Error('Cache already reserved')
  }

  return data.cacheId
}

async function uploadChunk(
  cacheId: number,
  chunk: Buffer,
  start: number,
  end: number,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/_apis/artifactcache/caches/${cacheId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/*`,
    },
    body: chunk,
  })

  if (!res.ok) {
    throw new Error(`Upload chunk failed: ${res.status} ${await res.text()}`)
  }
}

async function commitCache(cacheId: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/_apis/artifactcache/caches/${cacheId}`, {
    method: 'POST',
  })

  if (!res.ok) {
    throw new Error(`Commit failed: ${res.status} ${await res.text()}`)
  }
}

async function getCacheEntry(key: string, version: string): Promise<string> {
  const res = await fetch(
    `${BASE_URL}/_apis/artifactcache/cache?keys=${encodeURIComponent(key)}&version=${encodeURIComponent(version)}`,
  )

  if (res.status === 204) {
    throw new Error('Cache not found')
  }

  if (!res.ok) {
    throw new Error(`Get cache failed: ${res.status} ${await res.text()}`)
  }

  const data = (await res.json()) as { archiveLocation: string }
  let downloadUrl = data.archiveLocation

  // Rewrite localhost/127.0.0.1 in download URL to match API_BASE_URL host
  // This allows remote benchmarking when S3 is on localhost (e.g., LocalStack)
  if (downloadUrl.includes('localhost') || downloadUrl.includes('127.0.0.1')) {
    const baseUrlObj = new URL(BASE_URL)
    const downloadUrlObj = new URL(downloadUrl)

    // Replace host but keep port (to preserve S3/LocalStack port)
    downloadUrlObj.hostname = baseUrlObj.hostname
    downloadUrl = downloadUrlObj.toString()
  }

  return downloadUrl
}

async function downloadCache(url: string): Promise<number> {
  const res = await fetch(url)

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status}`)
  }

  let totalBytes = 0
  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.length
  }

  return totalBytes
}

async function benchmarkUpload(key: string, version: string): Promise<BenchmarkResult> {
  console.log(`\nUploading ${CACHE_SIZE_MB}MB in ${CHUNK_SIZE_MB}MB chunks...`)

  const startTime = performance.now()

  // Reserve cache
  const cacheId = await reserveCache(key, version)
  console.log(`  Reserved cache ID: ${cacheId}`)

  // Upload chunks
  let uploaded = 0
  let chunkNum = 0
  while (uploaded < CACHE_SIZE) {
    const remaining = CACHE_SIZE - uploaded
    const thisChunkSize = Math.min(CHUNK_SIZE, remaining)
    const chunk = randomBytes(thisChunkSize)

    const start = uploaded
    const end = uploaded + thisChunkSize - 1

    await uploadChunk(cacheId, chunk, start, end)
    uploaded += thisChunkSize
    chunkNum++

    const progress = ((uploaded / CACHE_SIZE) * 100).toFixed(1)
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    process.stdout.write(`\r  Uploaded chunk ${chunkNum}: ${progress}% (${elapsed}s)`)
  }
  console.log()

  // Commit cache
  await commitCache(cacheId)
  console.log(`  Committed cache`)

  const endTime = performance.now()
  const durationMs = endTime - startTime
  const throughputMBps = CACHE_SIZE_MB / (durationMs / 1000)

  return {
    operation: 'upload',
    sizeMB: CACHE_SIZE_MB,
    durationMs,
    throughputMBps,
  }
}

async function benchmarkDownload(key: string, version: string): Promise<BenchmarkResult> {
  console.log(`\nDownloading cache...`)

  const startTime = performance.now()

  // Get cache entry
  const downloadUrl = await getCacheEntry(key, version)
  console.log(`  Got download URL`)

  // Download
  const downloadedBytes = await downloadCache(downloadUrl)
  const downloadedMB = downloadedBytes / (1024 * 1024)
  console.log(`  Downloaded ${downloadedMB.toFixed(2)}MB`)

  const endTime = performance.now()
  const durationMs = endTime - startTime
  const throughputMBps = downloadedMB / (durationMs / 1000)

  return {
    operation: 'download',
    sizeMB: downloadedMB,
    durationMs,
    throughputMBps,
  }
}

function printResults(stats: BenchmarkStats[]) {
  console.log(`\n${'='.repeat(70)}`)
  console.log('BENCHMARK RESULTS')
  console.log('='.repeat(70))

  for (const s of stats) {
    console.log(`\n${s.operation.toUpperCase()}:`)
    console.log(`  Size:       ${s.sizeMB.toFixed(2)} MB`)
    console.log(`  Iterations: ${s.iterations}`)
    console.log(`  Mean:       ${s.mean.toFixed(2)} MB/s`)
    console.log(`  Median:     ${s.median.toFixed(2)} MB/s`)
    console.log(
      `  Std Dev:    ${s.stdDev.toFixed(2)} MB/s (±${((s.stdDev / s.mean) * 100).toFixed(1)}%)`,
    )
    console.log(`  Min:        ${s.min.toFixed(2)} MB/s`)
    console.log(`  Max:        ${s.max.toFixed(2)} MB/s`)
  }

  console.log(`\n${'='.repeat(70)}`)
}

async function main() {
  console.log('Cache Server Benchmark')
  console.log(`  Server:     ${BASE_URL}`)
  console.log(`  Cache size: ${CACHE_SIZE_MB}MB`)
  console.log(`  Chunk size: ${CHUNK_SIZE_MB}MB`)
  console.log(`  Iterations: ${ITERATIONS}`)

  const uploadResults: BenchmarkResult[] = []
  const downloadResults: BenchmarkResult[] = []

  try {
    for (let i = 1; i <= ITERATIONS; i++) {
      const key = `benchmark-${Date.now()}-${i}`
      const version = randomBytes(16).toString('hex')

      console.log(`\n--- Iteration ${i}/${ITERATIONS} ---`)

      // Benchmark upload and download
      const uploadResult = await benchmarkUpload(key, version)
      const downloadResult = await benchmarkDownload(key, version)

      uploadResults.push(uploadResult)
      downloadResults.push(downloadResult)

      console.log(`  Upload:   ${uploadResult.throughputMBps.toFixed(2)} MB/s`)
      console.log(`  Download: ${downloadResult.throughputMBps.toFixed(2)} MB/s`)
    }

    // Calculate and print statistics
    const uploadStats = calculateStats('upload', uploadResults)
    const downloadStats = calculateStats('download', downloadResults)

    printResults([uploadStats, downloadStats])
  } catch (err) {
    console.error('\nBenchmark failed:', err)
    throw err
  }
}

// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch(() => {
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1)
})
