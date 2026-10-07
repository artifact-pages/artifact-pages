// Checks that every reader's accepted schemaVersions are exactly the ones listed in
// supported-schema-versions.json (the table the web release manifest publishes as `reads`).
// Run with: node --experimental-transform-types --no-warnings --test web/src/data/supported-schema-versions.test.mjs
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

const table = JSON.parse(readFileSync(new URL('./supported-schema-versions.json', import.meta.url), 'utf8'))
const { UnsupportedSchemaError, SUPPORTED_SCHEMA_VERSIONS } = await import('./schema.ts')
const { discoverSites, loadSiteIndex } = await import('./indexes.ts')
const { loadPreviewCatalog, loadPreviewManifest } = await import('./previews.ts')
const { createSiteFullTextSearch, FullTextSearchError } = await import('./fulltext.ts')

const FORMATS = ['registry', 'site-metadata', 'artifact-index', 'full-text-manifest', 'preview-catalog', 'preview-manifest']
const SHA = 'a'.repeat(40)
const json = (body) => ({ ok: true, status: 200, json: async () => body })
const notFound = { ok: false, status: 404, json: async () => ({}) }

// Each entry builds a minimal valid payload at `version` and runs the reader; `read` resolves
// when the version is accepted and rejects with UnsupportedSchemaError (or FullTextSearchError
// 'needs-republish') when it is not.
const readers = {
  registry: (version) => discoverSites(async (url) => json({ schemaVersion: version, sites: [] })).then(() => undefined),
  'site-metadata': async (version) => {
    const sites = await discoverSites(async (url) => url.endsWith('sites.json')
      ? json({ schemaVersion: 1, sites: [{ id: 'sre', name: 'SRE', repository: 'o/r', sourcePath: '.' }] })
      : json({ schemaVersion: version, site: { id: 'sre', title: 'SRE' }, generatedAt: '2026-01-01T00:00:00Z', artifactCount: 0, artifactIndexUrl: '/_indexes/sre/index.json' }))
    // discoverSites turns an unsupported metadata version into a 'needs-republish' entry.
    if (sites[0].status === 'needs-republish') throw new UnsupportedSchemaError('site-metadata', version, 'meta.json')
    assert.equal(sites[0].status, 'available')
  },
  'artifact-index': (version) => loadSiteIndex('sre', async () => json({ schemaVersion: version, site: { id: 'sre', title: 'SRE' }, generatedAt: '2026-01-01T00:00:00Z', artifacts: [] })),
  'preview-catalog': (version) => loadPreviewCatalog('sre', async () => json({ schemaVersion: version, site: 'sre', groups: [] })),
  'preview-manifest': (version) => loadPreviewManifest('sre', SHA, async () => json({
    schemaVersion: version, site: 'sre', headSha: SHA, defaultHeadSha: SHA, mergeBaseSha: SHA,
    createdAt: '2026-01-01T00:00:00Z', bundleDigest: `sha256:${'b'.repeat(64)}`, files: [], documents: [],
  })),
  'full-text-manifest': async (version) => {
    const search = createSiteFullTextSearch(
      { site: { id: 'sre', title: 'SRE' }, fullTextUrl: '/_indexes/sre/search/manifest.json' },
      { fetcher: async (url) => url.endsWith('manifest.json') ? json({
        version, generation: 'c'.repeat(64), site: 'sre', documents: 0,
        root: { url: `/_indexes/sre/search/root-${'d'.repeat(64)}.gz`, sha256: 'd'.repeat(64), bytes: 1, rawBytes: 1 },
        shards: Array(128).fill(null),
      }) : notFound },
    )
    try { await search.search('x') } catch (error) {
      // Past the manifest check the reader goes on to fetch the root object, which fails here.
      if (error instanceof FullTextSearchError && error.code === 'needs-republish') throw new UnsupportedSchemaError('full-text-manifest', version, 'manifest.json')
      if (!(error instanceof FullTextSearchError)) throw error
    }
  },
}

test('the table lists exactly the six public formats with non-empty integer version arrays', () => {
  assert.equal(table.schemaVersion, 1)
  assert.deepEqual(Object.keys(table.reads).sort(), [...FORMATS].sort())
  for (const [format, versions] of Object.entries(table.reads)) {
    assert.ok(Array.isArray(versions) && versions.length > 0, `${format} is a non-empty array`)
    assert.ok(versions.every((v) => Number.isSafeInteger(v) && v > 0), `${format} holds positive integers`)
    assert.equal(new Set(versions).size, versions.length, `${format} has no duplicates`)
  }
  assert.deepEqual(SUPPORTED_SCHEMA_VERSIONS, table.reads)
})

for (const format of FORMATS) {
  test(`${format} reader accepts exactly the listed versions`, async () => {
    for (const version of table.reads[format]) {
      await readers[format](version)
    }
    const unlisted = Math.max(...table.reads[format]) + 1
    await assert.rejects(() => readers[format](unlisted), (error) => {
      assert.ok(error instanceof UnsupportedSchemaError, `${format} v${unlisted} raises UnsupportedSchemaError, got ${error}`)
      assert.equal(error.format, format)
      return true
    })
  })
}

// A missing or non-integer version is malformed data, not an unreadable newer format: it must
// never surface as UnsupportedSchemaError ("needs to be republished").
for (const format of FORMATS) {
  test(`${format} reader treats non-integer versions as invalid data, not unsupported`, async () => {
    for (const version of ['1', 1.5, null]) {
      let error
      try { await readers[format](version) } catch (caught) { error = caught }
      assert.ok(!(error instanceof UnsupportedSchemaError), `${format} version ${JSON.stringify(version)} must not be UnsupportedSchemaError`)
      if (format !== 'full-text-manifest') assert.ok(error, `${format} version ${JSON.stringify(version)} is rejected`)
    }
  })
}
