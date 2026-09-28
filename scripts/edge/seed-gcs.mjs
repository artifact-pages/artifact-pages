import { promises as fs } from 'node:fs'
import path from 'node:path'

const apiBase = (process.env.GCS_API_URL ?? 'http://127.0.0.1:4443').replace(/\/$/u, '')
const bucket = process.env.GCS_BUCKET ?? 'artifact-pages'
const storageRoot = process.argv[2]
if (!storageRoot) throw new Error('Usage: node seed-gcs.mjs <fixture-storage-directory>')

async function request(url, options = {}) {
  const response = await fetch(url, options)
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${options.method ?? 'GET'} ${url} failed with HTTP ${response.status}: ${detail.slice(0, 400)}`)
  }
  return response
}

async function listFiles(directory, prefix = '') {
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(absolute, relative))
    else if (entry.isFile()) files.push({ absolute, key: relative })
    else throw new Error(`Fixture tree contains a non-regular entry: ${absolute}`)
  }
  return files
}

function contentType(key) {
  const extension = path.extname(key).toLowerCase()
  return ({
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
  })[extension] ?? 'application/octet-stream'
}

function cacheControl(key) {
  if (key.startsWith('_indexes/')) return 'public, max-age=0, s-maxage=60, must-revalidate'
  if (key.startsWith('_artifacts/')) return 'public, max-age=0, s-maxage=300, must-revalidate'
  return 'no-store'
}

async function ensureBucket() {
  const bucketURL = `${apiBase}/storage/v1/b/${encodeURIComponent(bucket)}`
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const created = await fetch(`${apiBase}/storage/v1/b?project=local`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: bucket }),
    })
    if (created.ok) return
    if (created.status !== 409) {
      const detail = await created.text()
      throw new Error(`Create bucket ${bucket} failed with HTTP ${created.status}: ${detail.slice(0, 400)}`)
    }

    // The filesystem backend can report a stale duplicate while it restores
    // bucket metadata after a container restart. Accept 409 only when the
    // bucket is readable; otherwise retry creation and surface the final error.
    const existing = await fetch(bucketURL)
    if (existing.ok) return
    if (existing.status !== 404) {
      const detail = await existing.text()
      throw new Error(`Check bucket ${bucket} after create conflict failed with HTTP ${existing.status}: ${detail.slice(0, 400)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
  }
  throw new Error(`Bucket ${bucket} creation kept returning a conflict but remained unreadable.`)
}
await ensureBucket()

// fake-gcs-server's filesystem backend may retain bucket metadata across a
// restart. Clear objects through its API so every profile run starts clean.
let pageToken = ''
do {
  const query = new URLSearchParams({ maxResults: '1000' })
  if (pageToken) query.set('pageToken', pageToken)
  const listing = await request(`${apiBase}/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`)
  const page = await listing.json()
  for (const object of page.items ?? []) {
    const objectPath = encodeURIComponent(object.name)
    const deleted = await fetch(`${apiBase}/storage/v1/b/${encodeURIComponent(bucket)}/o/${objectPath}`, { method: 'DELETE' })
    if (!deleted.ok && deleted.status !== 404) {
      throw new Error(`Delete existing fixture object ${object.name} failed with HTTP ${deleted.status}`)
    }
  }
  pageToken = page.nextPageToken ?? ''
} while (pageToken)

const files = (await listFiles(storageRoot)).sort((left, right) => left.key.localeCompare(right.key))
for (const { absolute, key } of files) {
  const bytes = await fs.readFile(absolute)
  const boundary = `artifact-pages-${crypto.randomUUID()}`
  const metadata = Buffer.from(JSON.stringify({
    name: key,
    contentType: contentType(key),
    cacheControl: cacheControl(key),
  }))
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    metadata,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${contentType(key)}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const query = new URLSearchParams({ uploadType: 'multipart', name: key })
  await request(`${apiBase}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`, {
    method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body,
  })
}
console.log(`Seeded ${files.length} fixture objects into gs://${bucket} via the JSON API.`)
