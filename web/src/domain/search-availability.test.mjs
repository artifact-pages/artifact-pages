import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'

// The web sources use extensionless relative imports (bundler resolution); map them to .ts.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) {
    try { return await next(specifier + '.ts', context) } catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error }
  }
  return next(specifier, context)
}`))

const { IndexLoadError } = await import('../data/indexes.ts')
const { UnsupportedSchemaError } = await import('../data/schema.ts')
const { describeDiscoveryError, searchAvailability } = await import('./search-availability.ts')

const withMeta = { site: { id: 's', title: 's' }, schemaVersion: 1, generatedAt: 'x', artifactCount: 1, artifactIndexUrl: '/i' }

test('while discovery loads the page is loading, never unavailable', () => {
  assert.equal(searchAvailability('loading', undefined, false), 'loading')
  assert.equal(searchAvailability('loading', withMeta, false), 'loading')
})

test('a failed discovery is a load failure, not "published without page text search"', () => {
  assert.equal(searchAvailability('error', undefined, false), 'discovery-error')
})

test('a site whose own metadata is unavailable is a load failure', () => {
  assert.equal(searchAvailability('success', { site: withMeta.site, status: 'metadata-unavailable' }, false), 'discovery-error')
})

test('loaded discovery without a full-text client says search is unavailable', () => {
  assert.equal(searchAvailability('success', withMeta, false), 'unavailable')
  assert.equal(searchAvailability('success', undefined, false), 'unavailable')
})

test('loaded discovery with a client is available', () => {
  assert.equal(searchAvailability('success', { ...withMeta, fullTextUrl: '/_indexes/s/search/manifest.json' }, true), 'available')
})

test('an unsupported registry format asks the administrator and cannot be retried', () => {
  const d = describeDiscoveryError(new UnsupportedSchemaError('registry', 99, '/_indexes/sites.json'))
  assert.equal(d.kind, 'unsupported')
  assert.equal(d.retryable, false)
  assert.match(d.detail, /administrator/)
})

test('a damaged catalog asks the administrator and cannot be retried', () => {
  const d = describeDiscoveryError(new IndexLoadError('bad', '/_indexes/sites.json', { invalidData: true }))
  assert.equal(d.kind, 'invalid-data')
  assert.equal(d.retryable, false)
  assert.match(d.detail, /registry sync/)
})

test('timeouts, HTTP failures and network failures stay retryable', () => {
  const timed = describeDiscoveryError(new IndexLoadError('t', '/u', { timedOut: true }))
  const http = describeDiscoveryError(new IndexLoadError('h', '/u', { status: 500 }))
  const net = describeDiscoveryError(new TypeError('Failed to fetch'))
  assert.deepEqual([timed.kind, http.kind, net.kind], ['timed-out', 'http', 'network'])
  assert.ok(timed.retryable && http.retryable && net.retryable)
  assert.match(http.detail, /HTTP 500/)
  assert.equal(describeDiscoveryError(undefined).retryable, true)
})
