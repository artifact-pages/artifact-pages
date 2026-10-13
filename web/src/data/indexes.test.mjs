// Row validation of the artifact index and bounded site discovery (ISSUE-091, ISSUE-092).
// Run with: node --experimental-transform-types --no-warnings --test web/src/data/indexes.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'

// The web sources use extensionless relative imports (bundler resolution); map them to .ts.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) {
    try { return await next(specifier + '.ts', context) } catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error }
  }
  return next(specifier, context)
}`))

const { IndexLoadError, SITE_METADATA_CONCURRENCY, clearSiteIndexCache, discoverSites, loadSiteIndex } = await import('./indexes.ts')

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/storage/_indexes/sre/index.json', import.meta.url), 'utf8'))
const json = (body) => ({ ok: true, status: 200, json: async () => body })
const load = (body) => loadSiteIndex('sre', async () => json(body))

const row = (overrides = {}) => ({
  id: 'a.html',
  title: 'A',
  path: 'a.html',
  format: 'html',
  artifactUrl: '/_artifacts/sre/a.html',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
})
const indexWith = (artifacts) => ({ ...fixture, artifacts })

test.beforeEach(() => clearSiteIndexCache())

async function assertInvalid(body) {
  await assert.rejects(load(body), (error) => {
    assert.ok(error instanceof IndexLoadError)
    assert.equal(error.invalidData, true)
    return true
  })
}

test('a row missing required fields rejects the whole index', async () => {
  await assertInvalid({ ...fixture, artifacts: [{ id: 'broken' }] })
})

test('duplicate ids are rejected', async () => {
  await assertInvalid(indexWith([row(), row({ path: 'b.html' })]))
})

test('duplicate paths are rejected', async () => {
  await assertInvalid(indexWith([row(), row({ id: 'b.html' })]))
})

test('a protocol-relative artifactUrl is rejected', async () => {
  await assertInvalid(indexWith([row({ artifactUrl: '//evil.example/x' })]))
})

test('a path with a dot-dot segment is rejected', async () => {
  await assertInvalid(indexWith([row({ path: '../x' })]))
})

test('a valid row with an unknown extra field loads', async () => {
  const index = await load(indexWith([row({ futureField: { x: 1 } })]))
  assert.equal(index.artifacts.length, 1)
})

test('the published sre fixture loads', async () => {
  const index = await load(fixture)
  assert.equal(index.artifacts.length, fixture.artifacts.length)
})

test('an HTTP failure is not marked as invalid data', async () => {
  await assert.rejects(
    loadSiteIndex('sre', async () => ({ ok: false, status: 503, json: async () => ({}) })),
    (error) => error instanceof IndexLoadError && error.invalidData === undefined && error.status === 503,
  )
})

test('a path with a literal backslash loads', async () => {
  const index = await load(indexWith([row({ id: 'notes/a\\b.md', path: 'notes/a\\b.md', format: 'markdown', artifactUrl: '/_artifacts/sre/notes/a%5Cb.md' })]))
  assert.equal(index.artifacts.length, 1)
})

test('artifactUrl must be under this site\'s /_artifacts/ prefix', async () => {
  for (const artifactUrl of ['/', '/_indexes/sites.json', '/_artifacts/other/x.html', '/_artifacts/sre/', '/_artifacts/sre/x.html?a=1', '/_artifacts/sre/x.html#h']) {
    await assertInvalid(indexWith([row({ artifactUrl })]))
  }
})

// --- bounded site discovery (ISSUE-092) ---

const registryOf = (ids) => ({
  schemaVersion: 1,
  sites: ids.map((id) => ({ id, name: id.toUpperCase(), repository: 'o/r', sourcePath: id })),
})
const metaOf = (id) => ({
  schemaVersion: 1,
  site: { id, title: id.toUpperCase() },
  generatedAt: '2026-01-01T00:00:00Z',
  artifactCount: 1,
  artifactIndexUrl: `/_indexes/${id}/index.json`,
})

test('a metadata request that never completes ends as metadata-unavailable after the timeout', async () => {
  const ids = ['alpha', 'beta', 'slow']
  const fetcher = (url, init) => {
    if (url.endsWith('sites.json')) return Promise.resolve(json(registryOf(ids)))
    const id = url.split('/')[2]
    if (id !== 'slow') return Promise.resolve(json(metaOf(id)))
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
  const sites = await discoverSites(fetcher, { metadataTimeoutMs: 50 })
  assert.equal(sites.length, 3)
  const byId = Object.fromEntries(sites.map((entry) => [entry.site.id, entry.status]))
  assert.deepEqual(byId, { alpha: 'available', beta: 'available', slow: 'metadata-unavailable' })
})

test('at most SITE_METADATA_CONCURRENCY metadata requests are in flight', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `site-${String(i).padStart(2, '0')}`)
  let inFlight = 0
  let maxInFlight = 0
  const fetcher = async (url) => {
    if (url.endsWith('sites.json')) return json(registryOf(ids))
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 10))
    inFlight -= 1
    return json(metaOf(url.split('/')[2]))
  }
  const sites = await discoverSites(fetcher)
  assert.equal(sites.length, 10)
  assert.ok(sites.every((entry) => entry.status === 'available'))
  assert.ok(maxInFlight <= SITE_METADATA_CONCURRENCY, `max in flight ${maxInFlight}`)
  assert.ok(maxInFlight > 1)
})

test('the timeout is an overall deadline, not per batch', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `site-${String(i).padStart(2, '0')}`)
  const fetcher = (url, init) => {
    if (url.endsWith('sites.json')) return Promise.resolve(json(registryOf(ids)))
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
  const started = Date.now()
  const sites = await discoverSites(fetcher, { metadataTimeoutMs: 50 })
  assert.ok(Date.now() - started < 500)
  assert.equal(sites.length, 10)
  assert.ok(sites.every((entry) => entry.status === 'metadata-unavailable'))
})
