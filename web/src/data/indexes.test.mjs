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

const { IndexLoadError, clearSiteIndexCache, loadSiteIndex } = await import('./indexes.ts')

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
