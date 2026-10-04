import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const repository = process.cwd()
const runRoot = path.join(repository, '.local/fulltext-core', randomUUID())
const source = path.join(runRoot, 'source'), storage = path.join(runRoot, 'storage')
mkdirSync(source, { recursive: true })
const binary = path.join(runRoot, 'artifact-pages')
execFileSync('go', ['build', '-o', binary, './cli/cmd/artifact-pages'], { cwd: repository })
const build = (site, source) => execFileSync(binary, ['index', 'build', '--site', site, '--source', source, '--out', storage], { cwd: repository, encoding: 'utf8' })
const records = []
for (let i = 0; i < 40; i++) {
  const filename = i === 0 ? 'a #?%+ 日本.html' : i === 1 ? 'b\\literal.html' : `page-${String(i).padStart(6, '0')}.${i === 10 ? 'md' : 'html'}`
  const title = `Page ${i}`
  const terms = ['ＣＡＣＨＥ', `unique-marker-${String(i).padStart(6, '0')}`]
  if (i % 2 === 0) terms.push('retry')
  if (i % 5 === 0) terms.push('再試行')
  if (i % 4 === 0) terms.push('bitmap')
  if (i !== 5) terms.push('complement')
  if (i >= 5 && i <= 15) terms.push('runs')
  if (i === 0) terms.push('ΟΣ', 'İ', 'ｶﾀｶﾅ', 'supplementary𐐀')
  const visible = `${title} ${terms.join(' ')} alpha beta`
  const body = i === 10
    ? `# ${title}\n\n${terms.join(' ')}\n\nalpha\n\nbeta\n\n<script>runtimeonly</script><div hidden>hiddenonly</div>`
    : `<title>${title}</title><p>${terms.join(' ').replace('retry', 're<span>try</span>')}</p><p>alpha</p><p>beta</p><p hidden>hiddenonly</p><p aria-hidden=true>ariaonly</p><div data-search-ignore>ignoredonly</div><script>runtimeonly</script><template>templateonly</template>`
  writeFileSync(path.join(source, filename), body)
  records.push({ path: filename, text: visible.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim() })
}
records.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
console.log(build('core-one', source).trim())
build('core-two', source)
const emptySource = path.join(runRoot, 'empty-source')
mkdirSync(emptySource)
build('core-empty', emptySource)
const metadata = (site) => JSON.parse(readFileSync(path.join(storage, '_indexes', site, 'meta.json'), 'utf8'))
const manifest = () => JSON.parse(readFileSync(path.join(storage, '_indexes/core-one/search/manifest.json'), 'utf8'))
const expected = (query) => {
  const terms = query.normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean)
  return records.filter(({ text }) => terms.every((term) => text.includes(term))).map(({ path }) => path)
}
process.env.GAP_LOCAL_STORAGE_ROOT = storage
const server = await createServer({
  configFile: path.join(repository, 'web/vite.config.ts'), server: { port: 0, strictPort: false, host: '127.0.0.1' },
  plugins: [{ name: 'fulltext-core-test-shell', configureServer(server) {
    // Match the nginx content-plane 404 contract; Vite otherwise falls back to the SPA.
    server.middlewares.use((req, res, next) => {
      const pathname = new URL(req.url, 'http://localhost').pathname
      if (pathname.startsWith('/_indexes/core-') && !existsSync(path.join(storage, pathname))) { res.statusCode = 404; res.end('Not found'); return }
      next()
    })
    server.middlewares.use('/core-test.html', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Full-text core verification</title>') })
  } }],
})
await server.listen()
const url = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const requests = []
page.on('request', (request) => { if (request.url().includes('/_indexes/') || request.url().includes('fulltext-codec')) requests.push(request.url()) })
try {
  await page.goto(`${url}/core-test.html`)
  await page.evaluate(async (meta) => {
    const { createSiteFullTextSearch } = await import('/src/data/fulltext.ts')
    window.api = createSiteFullTextSearch(meta)
    window.createSearch = createSiteFullTextSearch
  }, metadata('core-one'))
  assert.equal(requests.length, 0, `construction fetched search data/decoder: ${requests}`)
  const discovery = await page.evaluate(async (meta) => {
    const { discoverSites } = await import('/src/data/indexes.ts')
    const registry = { schemaVersion: 1, sites: [{ id: 'core-one', name: 'Core', repository: 'local/test', sourcePath: 'source' }] }
    const calls = []
    const fetcher = async (url) => { calls.push(url); return new Response(JSON.stringify(url.endsWith('sites.json') ? registry : meta)) }
    const valid = await discoverSites(fetcher)
    meta.fullTextUrl = '/_indexes/core-two/search/manifest.json'
    const invalid = await discoverSites(fetcher)
    return { pointer: valid[0].fullTextUrl, invalid: invalid[0].status, calls }
  }, metadata('core-one'))
  assert.equal(discovery.pointer, '/_indexes/core-one/search/manifest.json')
  assert.equal(discovery.invalid, 'metadata-unavailable')
  assert(discovery.calls.every((url) => url.endsWith('/sites.json') || url.endsWith('/meta.json')))

  assert.equal((await page.evaluate(() => window.api.search('　\t '))).total, 0)
  assert.equal(requests.length, 0, 'blank query fetched search data/decoder')
  for (const query of ['cache', 'page', 'TRY', '再試行 cache', 'bitmap', 'complement', 'runs', 'unique-marker-000007', 'ΟΣ', 'İ', 'カタカナ', 'supplementary𐐨', 'alphabeta', 'hiddenonly', 'ariaonly', 'ignoredonly', 'runtimeonly', 'templateonly', 'never-exists']) {
    const result = await page.evaluate((query) => window.api.search(query, { limit: 100 }), query)
    assert.deepEqual(result.hits.map(({ id }) => id), expected(query), query)
    assert.equal(result.total, expected(query).length)
  }
  const requestCount = requests.length
  const paged = await page.evaluate(() => window.api.search('cache', { offset: 20, limit: 7 }))
  assert.deepEqual(paged.hits.map(({ id }) => id), expected('cache').slice(20, 27))
  assert.equal(paged.hasMore, true)
  assert.equal(requests.length, requestCount, 'warm query fetched search data')
  const first = await page.evaluate(() => window.api.search('cache'))
  assert.equal(first.hits[0].href, '/core-one/a%20%23%3F%25%2B%20%E6%97%A5%E6%9C%AC.html')
  assert.equal(first.hits[1].href, '/core-one/b%5Cliteral.html')
  const disabled = await page.evaluate(async () => {
    const api = window.createSearch({ site: { id: 'disabled', title: 'Disabled' } })
    try { await api.search('cache'); return null } catch (error) { return { available: api.available, code: error.code } }
  })
  assert.deepEqual(disabled, { available: false, code: 'unavailable' })
  assert.equal(requests.length, requestCount)
  const empty = await page.evaluate(async (meta) => window.createSearch(meta).search('cache'), metadata('core-empty'))
  assert.equal(empty.total, 0)

  // A corrupt blob must fail before decoding, and its rejected cache must recover.
  await page.route('**/_indexes/core-one/search/root-*.gz', async (route) => {
    const response = await route.fetch(), body = await response.body(); body[body.length - 1] ^= 1
    await route.fulfill({ response, body })
  })
  await page.evaluate(() => window.api.clear())
  assert.equal(await page.evaluate(async () => { try { await window.api.search('cache'); return null } catch (e) { return e.code } }), 'invalid-data')
  await page.unroute('**/_indexes/core-one/search/root-*.gz')
  assert.equal((await page.evaluate(() => window.api.search('cache'))).total, 40)

  // No external URL, wrong site, or unsupported version may be followed.
  const validManifest = manifest()
  for (const mutation of [
    { ...validManifest, version: 'x' }, { ...validManifest, site: 'core-two' },
    { ...validManifest, root: { ...validManifest.root, url: 'https://example.invalid/search.gz' } },
  ]) {
    await page.route('**/_indexes/core-one/search/manifest.json', (route) => route.fulfill({ json: mutation }))
    await page.evaluate(() => window.api.clear())
    assert.equal(await page.evaluate(async () => { try { await window.api.search('cache'); return null } catch (e) { return e.code } }), 'invalid-data')
    await page.unroute('**/_indexes/core-one/search/manifest.json')
  }
  // An unknown integer version is a confirmed but unreadable format, not invalid data.
  await page.route('**/_indexes/core-one/search/manifest.json', (route) => route.fulfill({ json: { ...validManifest, version: 9 } }))
  await page.evaluate(() => window.api.clear())
  assert.equal(await page.evaluate(async () => { try { await window.api.search('cache'); return null } catch (e) { return e.code } }), 'needs-republish')
  await page.unroute('**/_indexes/core-one/search/manifest.json')
  await page.route('**/_indexes/core-one/search/manifest.json', (route) => route.fulfill({ status: 503, body: 'temporarily unavailable' }))
  assert.equal(await page.evaluate(async () => { try { await window.api.search('cache'); return null } catch (e) { return e.status } }), 503)
  await page.unroute('**/_indexes/core-one/search/manifest.json')
  assert.equal((await page.evaluate(() => window.api.search('cache'))).total, 40)

  // Cancellation of one caller must not cancel/poison another sharing the root.
  let releaseRoot, rootRequested
  const rootGate = new Promise((resolve) => { releaseRoot = resolve })
  const rootSeen = new Promise((resolve) => { rootRequested = resolve })
  await page.route('**/_indexes/core-one/search/root-*.gz', async (route) => { rootRequested(); await rootGate; await route.continue() })
  await page.evaluate(() => {
    window.api.clear(); window.cancel = new AbortController()
    window.cancelled = window.api.search('cache', { signal: window.cancel.signal }).then(() => 'unexpected', (e) => e.name)
    window.shared = window.api.search('cache')
  })
  await rootSeen
  await page.evaluate(() => window.cancel.abort())
  assert.equal(await page.evaluate(() => window.cancelled), 'AbortError')
  releaseRoot()
  assert.equal((await page.evaluate(() => window.shared)).total, 40)
  await page.unroute('**/_indexes/core-one/search/root-*.gz')

  // Site handles cannot reuse another site's root, leaves, or routes.
  const beforeOther = requests.length
  const other = await page.evaluate(async (meta) => window.createSearch(meta).search('cache'), metadata('core-two'))
  assert.equal(other.total, 40); assert(other.hits.every((h) => h.href.startsWith('/core-two/')))
  assert(requests.slice(beforeOther).some((r) => r.includes('/core-two/search/')))

  // Pin an old root, rebuild, then request an old leaf. 404 forces one refresh.
  await page.evaluate(() => window.api.clear())
  await page.evaluate(() => window.api.search('unique-marker-000007')) // singleton, no leaves
  const old = manifest()
  writeFileSync(path.join(source, 'a #?%+ 日本.html'), '<title>New generation</title><p>freshbody</p>')
  build('core-one', source)
  const searchDir = path.join(storage, '_indexes/core-one/search')
  assert(!readdirSync(searchDir).includes(path.basename(old.root.url)), 'local build kept stale root')
  assert.equal((await page.evaluate(() => window.api.search('cache', { limit: 100 }))).total, 39)
  assert.equal((await page.evaluate(() => window.api.search('freshbody'))).total, 1)

  // Expiry revalidates even a cached generation whose needed leaf is present.
  const expiry = await page.evaluate(async (meta) => {
    window.testNow = 0
    window.expiry = window.createSearch(meta, { now: () => window.testNow })
    return window.expiry.search('freshbody')
  }, metadata('core-one'))
  writeFileSync(path.join(source, 'a #?%+ 日本.html'), '<title>Next generation</title><p>newbody</p>')
  build('core-one', source)
  await page.evaluate(() => { window.testNow = 60_001 })
  const refreshed = await page.evaluate(() => window.expiry.search('newbody'))
  assert.equal(refreshed.total, 1); assert.notEqual(expiry.generation, refreshed.generation)

  // The binary decoder must reject malformed counts, references, and trailing data.
  const malformed = await page.evaluate(async () => {
    const c = await import('/src/domain/fulltext-codec.ts')
    const rejected = (fn) => { try { fn(); return false } catch { return true } }
    return [
      rejected(() => c.decodeRoot(new TextEncoder().encode('GAPSR1'))),
      rejected(() => c.decodePosting(new Uint8Array([0, 2, 0, 0]), 4)),
      rejected(() => c.decodePosting(new Uint8Array([2, 2, 1, 3, 2]), 4)),
      rejected(() => c.decodePosting(new Uint8Array([4, 4, 0]), 4)),
      rejected(() => c.decodeLeaf(new Uint8Array([...new TextEncoder().encode('GAPSL1'), 40, 0, 0]), 41)),
    ]
  })
  assert(malformed.every(Boolean))
  // Data is always built: a plain build (no flag) advertises it, even for an empty site.
  assert.equal(metadata('core-one').fullTextUrl, '/_indexes/core-one/search/manifest.json')
  assert(readdirSync(searchDir).includes('manifest.json'))
  assert.equal(metadata('core-empty').fullTextUrl, '/_indexes/core-empty/search/manifest.json')
  console.log('Full-text core: extraction, Unicode, AND/substring, paging, lazy fetch, cache, integrity, cancellation, site scope, update recovery, empty-site, always-on and malformed data checks passed.')

  const scaleArg = process.argv.indexOf('--scale-source')
  if (scaleArg >= 0) {
    const scaleSource = path.resolve(process.argv[scaleArg + 1]), started = performance.now()
    console.log(build('core-scale', scaleSource).trim())
    const buildMs = performance.now() - started
    const scaleMeta = metadata('core-scale')
    const scaleManifest = JSON.parse(readFileSync(path.join(storage, '_indexes/core-scale/search/manifest.json')))
    const oraclePath = path.resolve(scaleSource, '../../..', 'oracle.json')
    const scaleOracle = existsSync(oraclePath) ? JSON.parse(readFileSync(oraclePath))[path.basename(scaleSource)] : undefined
    const samples = []
    for (const query of ['cache', '再試行', 'body-only-000007', 'no-such-fulltext-token']) {
      const sample = await page.evaluate(async ({ meta, query }) => {
        const api = window.createSearch(meta), start = performance.now(), result = await api.search(query)
        return { query, total: result.total, paths: result.hits.map((h) => h.path), ms: performance.now() - start }
      }, { meta: scaleMeta, query })
      if (scaleOracle) {
        const ids = scaleOracle.expected[query]
        assert.equal(sample.total, ids.length, `scale total: ${query}`)
        assert.deepEqual(sample.paths, ids.slice(0, 20).map((id) => scaleOracle.paths[id]), `scale routes: ${query}`)
      }
      delete sample.paths
      samples.push(sample)
    }
    const scale = { documents: scaleMeta.artifactCount, buildMs, rootBytes: scaleManifest.root.bytes, manifestBytes: readFileSync(path.join(storage, '_indexes/core-scale/search/manifest.json')).length, searchBytes: readFileSync(path.join(storage, '_indexes/core-scale/search/manifest.json')).length + scaleManifest.root.bytes + scaleManifest.shards.reduce((n, r) => n + (r?.bytes ?? 0), 0), samples }
    writeFileSync(path.join(runRoot, 'scale.json'), JSON.stringify(scale, null, 2))
    console.log(JSON.stringify(scale))
  }
  console.log(`Evidence: ${runRoot}`)
} finally {
  await browser.close(); await server.close()
}
