// Local-only research deployment: real files, production metadata builder, nginx, browser load.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { gzipSync } from 'node:zlib'
import { chromium } from '@playwright/test'
import * as codec from './fulltext-packed.mjs'
import { renderSummary } from './fulltext-load-summary.mjs'

const repository = path.resolve(import.meta.dirname, '..')
const labRoot = path.join(repository, '.local', 'fulltext-load')
const currentFile = path.join(labRoot, 'current.json')
const project = 'gap-fulltext-load'
const args = process.argv.slice(2), action = args.shift() ?? 'benchmark'
const options = { counts: [1000, 10000, 50000], iterations: 3, concurrency: 8, shards: 128, port: 4188, seed: 0x1a0f6bb, regenerate: false }
const explicitlySet = new Set()
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '')
  if (key === 'regenerate') { options.regenerate = true; continue }
  if (!(key in options)) throw new Error(`Unknown option: ${args[i]}`)
  const value = args[++i]
  if (value === undefined) throw new Error(`Missing --${key} value`)
  options[key] = key === 'counts' ? value.split(',').map(Number) : Number(value)
  explicitlySet.add(key)
}
assert(['generate', 'serve', 'benchmark', 'stop'].includes(action), 'Use generate, serve, benchmark, or stop')
assert(options.counts.every((n) => Number.isInteger(n) && n >= 10 && n <= 100000), 'counts must be 10..100000')
assert(new Set(options.counts).size === options.counts.length, 'counts must be unique')
for (const key of ['iterations', 'concurrency', 'shards', 'port', 'seed']) assert(Number.isSafeInteger(options[key]) && options[key] > 0, `Invalid ${key}`)
assert(options.concurrency <= 32 && options.shards <= 512 && options.port < 65536)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const gzip = (bytes) => gzipSync(bytes, { level: 9 })
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
const writeJSON = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2))
const escape = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const queries = ['cache', '再試行', 'body-only-000007', 'no-such-fulltext-token']

mkdirSync(labRoot, { recursive: true })
if (action === 'stop') {
  execFileSync('docker', ['compose', '-p', project, '-f', path.join(repository, 'docker-compose.yml'), 'down'], { cwd: repository, stdio: 'inherit' })
  process.exit(0)
}
let deployment = existsSync(currentFile) ? json(currentFile) : undefined
if (action === 'generate' || !deployment || options.regenerate || [...explicitlySet].some((key) => ['counts', 'shards', 'seed'].includes(key) && JSON.stringify(options[key]) !== JSON.stringify(deployment.options[key]))) deployment = generate()
if (explicitlySet.has('port')) deployment.options.port = options.port
if (action !== 'generate') {
  serve(deployment)
  if (action === 'benchmark') await benchmark(deployment)
}
console.log(`Search lab: http://127.0.0.1:${deployment.options.port}/search-lab.html`)
console.log(`Projection: ${deployment.runRoot}`)

function generate() {
  const runRoot = path.join(labRoot, `run-${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`)
  const storage = path.join(runRoot, 'storage'), web = path.join(runRoot, 'web'), preview = path.join(runRoot, 'previews')
  for (const dir of [storage, web, preview, path.join(runRoot, 'bin')]) mkdirSync(dir, { recursive: true })
  const binary = path.join(runRoot, 'bin', 'artifact-pages')
  console.log('Building the existing metadata builder…')
  execFileSync('go', ['build', '-o', binary, './cli/cmd/artifact-pages'], { cwd: repository, stdio: 'inherit' })
  const samples = JSON.parse(execFileSync('go', ['run', './scripts/fulltext-corpus', 'fixtures/storage/_artifacts'], { cwd: repository, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
  const vocabulary = [...new Set(samples.flatMap(({ text }) => codec.normalize(text).split(' ')))].filter((word) => word.length > 1 && word.length < 32)
  const sites = [], oracle = {}, buildReport = { sites: [], seed: options.seed, codecHash: hash(readFileSync(path.join(repository, 'scripts/fulltext-packed.mjs'))) }
  for (const count of options.counts) {
    const site = `load-${count}`, source = path.join(storage, '_artifacts', site), started = performance.now()
    mkdirSync(path.join(source, 'assets'), { recursive: true })
    writeFileSync(path.join(source, 'assets', 'style.css'), 'body{max-width:850px;margin:40px auto;padding:20px;font:16px/1.7 system-ui;color:#243650}#runtime{color:rgb(24,100,64)}')
    writeFileSync(path.join(source, 'assets', 'probe.js'), 'document.body.dataset.resources="ready";const p=document.createElement("p");p.id="runtime";p.textContent="runtime-only-noindex";document.body.append(p);')
    let state = options.seed, artifactBytes = 0
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0 }
    for (let i = 0; i < count; i++) {
      const number = String(i).padStart(6, '0'), format = i % 10 === 9 ? 'md' : 'html'
      const folder = path.join(source, 'reports', `group-${String(Math.floor(i / 100)).padStart(5, '0')}`)
      mkdirSync(folder, { recursive: true })
      const filename = i === 0 ? `page ${number} #?%+ 日本.html` : `page-${number}.${format}`
      const body = `${Array.from({ length: 180 }, () => vocabulary[random() % vocabulary.length]).join(' ')} body-only-${number} ${i % 100 === 0 ? '再試行 retry timeout' : ''} 障害調査ではログと応答時間を確認する。`
      const bytes = format === 'md'
        ? `# Load document ${number}\n\n## Evidence\n\n${body}\n\n## Recovery\n\nVerify this report against the source record.\n`
        : `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Load document ${number}</title><link rel="stylesheet" href="../../assets/style.css"><script src="../../assets/probe.js" defer></script></head><body><h1>Load document ${number}</h1><h2 id="evidence">Evidence</h2><p>${escape(body)}</p><p hidden>hidden-only-secret</p><h2 id="recovery">Recovery</h2><p>Verify this report against the source record.</p></body></html>`
      writeFileSync(path.join(folder, filename), bytes); artifactBytes += Buffer.byteLength(bytes)
      if ((i + 1) % 10000 === 0) console.log(`${site}: wrote ${i + 1} actual pages`)
    }
    const generateMs = performance.now() - started, metadataStarted = performance.now()
    // Keep builder output outside its source ancestor; the builder excludes its output tree.
    const metadataRoot = path.join(runRoot, 'metadata')
    const builderOutput = execFileSync(binary, ['index', 'build', '--site', site, '--site-title', `Fulltext load · ${count.toLocaleString()} pages`, '--source', source, '--out', metadataRoot], { cwd: repository, encoding: 'utf8', maxBuffer: 1024 * 1024 })
    const metadataBuildMs = performance.now() - metadataStarted
    mkdirSync(path.join(storage, '_indexes'), { recursive: true })
    renameSync(path.join(metadataRoot, '_indexes', site), path.join(storage, '_indexes', site))
    const indexPath = path.join(storage, '_indexes', site, 'index.json'), indexBytes = readFileSync(indexPath), index = JSON.parse(indexBytes)
    assert.equal(index.artifacts.length, count)
    const extractionStarted = performance.now()
    const extracted = JSON.parse(execFileSync('go', ['run', './scripts/fulltext-corpus', source], { cwd: repository, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }))
    const byPath = new Map(extracted.map(({ id, text }) => [path.relative(source, id).split(path.sep).join('/'), text]))
    const records = index.artifacts.map(({ id }) => { assert(byPath.has(id)); return { id, text: codec.normalize(byPath.get(id)) } })
    const extractionMs = performance.now() - extractionStarted, searchStarted = performance.now()
    const packed = codec.build(records), stable = codec.buildStable(packed, options.shards)
    const searchDir = path.join(storage, '_indexes', site, 'search'); mkdirSync(searchDir)
    const parts = stable.leaves.map((leaf, shard) => {
      if (!leaf.tokens.length) return null
      const bytes = gzip(codec.encodeBundle(leaf)), name = `p${shard}-${hash(bytes)}.gz`
      writeFileSync(path.join(searchDir, name), bytes)
      return { url: `/_indexes/${site}/search/${name}`, bytes: bytes.length }
    })
    const metadata = { version: 2, site, documents: count, documentPaths: records.map(({ id }) => id), indexHash: hash(indexBytes), generation: hash(JSON.stringify([records.map(({ id }) => id), parts])), parts }
    const root = gzip(codec.encodeRoot(metadata, stable.root)); writeFileSync(path.join(searchDir, 'root.gz'), root)
    const searchBuildMs = performance.now() - searchStarted
    const expected = Object.fromEntries(queries.map((query) => {
      const terms = codec.normalize(query).split(' ').filter(Boolean)
      return [query, records.flatMap(({ text }, i) => terms.every((term) => text.includes(term)) ? [i] : [])]
    }))
    oracle[site] = { expected, paths: records.map(({ id }) => id), specialPath: records[0].id }
    sites.push({ id: site, name: index.site.title, repository: 'local/fulltext-load', sourcePath: path.relative(repository, source).split(path.sep).join('/') })
    buildReport.sites.push({ site, count, artifactBytes, metadataRawBytes: indexBytes.length, metadataGzipBytes: gzip(indexBytes).length, searchBytes: root.length + parts.reduce((sum, part) => sum + (part?.bytes ?? 0), 0), rootBytes: root.length, searchObjects: 1 + parts.filter(Boolean).length, generateMs, metadataBuildMs, extractionMs, searchBuildMs, corpusHash: hash(JSON.stringify(records)), builderOutput: builderOutput.trim() })
    console.log(`${site}: metadata ${metadataBuildMs.toFixed(0)} ms, search ${(root.length / 1000).toFixed(1)} KB root, ${(buildReport.sites.at(-1).searchBytes / 1e6).toFixed(2)} MB total`)
  }
  mkdirSync(path.join(storage, '_indexes'), { recursive: true })
  writeJSON(path.join(storage, '_indexes', 'sites.json'), { schemaVersion: 1, sites })
    writeJSON(path.join(runRoot, 'oracle.json'), oracle); writeJSON(path.join(runRoot, 'build.json'), buildReport)
  const deployment = { project, runRoot, storage, web, preview, options, sites, generatedAt: new Date().toISOString() }
  writeJSON(currentFile, deployment)
  return deployment
}

function compose(deployment, command) {
  execFileSync('docker', ['compose', '-p', project, '-f', path.join(repository, 'docker-compose.yml'), '-f', path.join(deployment.runRoot, 'compose.override.json'), ...command], { cwd: repository, env: { ...process.env, WEB_ROOT: deployment.web, STORAGE_ROOT: deployment.storage, PREVIEW_ROOT: deployment.preview, WEB_PORT: String(deployment.options.port) }, stdio: 'inherit' })
}
function serve(deployment) {
  console.log('Building the real SPA and starting the isolated nginx deployment…')
  const buildOutput = execFileSync('npm', ['run', 'build'], { cwd: repository, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(path.join(deployment.runRoot, 'web-build.log'), buildOutput)
  console.log('SPA build passed; full output saved to web-build.log')
  cpSync(path.join(repository, 'web', 'dist'), deployment.web, { recursive: true })
  const labDir = path.join(deployment.web, 'fulltext-lab'); mkdirSync(labDir, { recursive: true })
  const html = readFileSync(path.join(repository, 'scripts/fulltext-load/index.html'), 'utf8').replace('__SITE_OPTIONS__', deployment.sites.map((site) => `<option value="${site.id}">${escape(site.name)}</option>`).join(''))
  writeFileSync(path.join(deployment.web, 'search-lab.html'), html)
  for (const [source, target] of [['scripts/fulltext-load/client.js', 'client.js'], ['scripts/fulltext-packed.mjs', 'codec.js']]) {
    const bytes = readFileSync(path.join(repository, source)); writeFileSync(path.join(labDir, target), bytes); writeFileSync(path.join(labDir, `${target}.gz`), gzip(bytes))
  }
  // Compression is an experiment-only override; the existing local profile is unchanged.
  const nginx = readFileSync(path.join(repository, 'docker/nginx/default.conf'), 'utf8').replace('  listen 80;', '  listen 80;\n  gzip on;\n  gzip_comp_level 6;\n  gzip_types application/json application/javascript text/javascript text/css;\n  gzip_static on;')
  const config = path.join(deployment.runRoot, 'nginx.conf'); writeFileSync(config, nginx)
  writeJSON(path.join(deployment.runRoot, 'compose.override.json'), { services: { web: { volumes: [`${config}:/etc/nginx/conf.d/default.conf:ro`] } } })
  writeJSON(currentFile, deployment)
  compose(deployment, ['up', '-d'])
}

async function benchmark(deployment) {
  const url = `http://127.0.0.1:${deployment.options.port}`, oracle = json(path.join(deployment.runRoot, 'oracle.json'))
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${url}/search-lab.html`)).ok) break } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); if (i === 39) throw new Error('nginx did not become ready') }
  const browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] })
  const report = { url, generatedAt: deployment.generatedAt, options: { ...deployment.options, iterations: options.iterations, concurrency: options.concurrency }, browserVersion: browser.version(), build: json(path.join(deployment.runRoot, 'build.json')), cold: [], warm: [], concurrent: [] }
  const save = () => writeJSON(path.join(deployment.runRoot, 'results.json'), report)
  try {
    for (const site of deployment.sites) {
      for (const profile of ['local', 'constrained']) {
        for (let iteration = 0; iteration < options.iterations; iteration++) {
          for (const query of queries) {
            const sample = await runQuery(browser, site.id, query, profile)
            report.cold.push({ site: site.id, profile, iteration: iteration + 1, query, ...sample.cold })
            report.warm.push({ site: site.id, profile, iteration: iteration + 1, query, ...sample.warm })
          }
          save(); console.log(`${site.id} ${profile}: iteration ${iteration + 1}/${options.iterations} passed`)
        }
      }
      await verifyReader(browser, site.id)
    }
    const site = deployment.sites.at(-1)
    await verifyControls(browser, site.id)
    report.controlsVerified = true
    for (const concurrency of [...new Set([1, options.concurrency])]) {
      const started = performance.now()
      const samples = await Promise.all(Array.from({ length: concurrency }, () => runQuery(browser, site.id, 'cache', 'local', false)))
      report.concurrent.push({ site: site.id, clients: concurrency, wallMs: performance.now() - started, samples: samples.map(({ cold }) => cold) })
      console.log(`${site.id}: ${concurrency} concurrent browser clients passed`)
    }
    report.readerVerified = true
    save()
    writeFileSync(path.join(deployment.runRoot, 'summary.md'), renderSummary(report))
  } finally { await browser.close() }
  console.log(`Results: ${path.join(deployment.runRoot, 'results.json')}`)

  async function runQuery(browser, site, query, profile, warm = true) {
    const page = await browser.newPage(), cdp = await page.context().newCDPSession(page)
    if (profile === 'constrained') {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      await cdp.send('Network.enable')
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 2_500_000 / 8, uploadThroughput: 1_000_000 / 8 })
    }
    const requested = [], failures = []
    page.on('request', (req) => { const p = new URL(req.url()).pathname; if (p.includes('/search/') || p === '/fulltext-lab/codec.js') requested.push(p) })
    page.on('pageerror', (error) => failures.push(String(error)))
    try {
      await page.goto(`${url}/search-lab.html`)
      await page.getByRole('combobox').selectOption(site)
      await page.getByRole('textbox').fill(query)
      assert.equal(requested.length, 0, 'No search payload or decoder before submit')
      await cdp.send('HeapProfiler.collectGarbage')
      const initial = await cdp.send('Runtime.getHeapUsage')
      await page.getByRole('textbox').press('Enter')
      await page.waitForFunction(() => window.fulltextLab.state === 'ready' || window.fulltextLab.state === 'error', null, { timeout: 120000 })
      const cold = await sample()
      assert.deepEqual(cold.ids, oracle[site].expected[query], `${site}: ${query}`)
      assert.equal(failures.length, 0, failures.join('\n'))
      delete cold.ids
      const retained = await cdp.send('Runtime.getHeapUsage')
      cold.heapDeltaBytes = retained.usedSize - initial.usedSize
      cold.requestCount = requested.length
      let repeated
      if (warm) {
        requested.length = 0
        await page.evaluate(() => { performance.clearResourceTimings() })
        await page.getByRole('textbox').press('Enter')
        await page.waitForFunction(() => window.fulltextLab.state === 'ready')
        repeated = await sample(); assert.deepEqual(repeated.ids, oracle[site].expected[query]); delete repeated.ids
        assert.equal(requested.length, 0, 'Repeated query must reuse cache'); repeated.requestCount = 0
      }
      return { cold, warm: repeated }
    } finally { await page.close() }

    async function sample() {
      const state = await page.evaluate(() => {
        const resources = performance.getEntriesByType('resource').filter((r) => new URL(r.name).pathname.includes('/search/') || new URL(r.name).pathname === '/fulltext-lab/codec.js')
        return { ...window.fulltextLab, resources: resources.map(({ name, encodedBodySize, decodedBodySize, transferSize, duration }) => ({ path: new URL(name).pathname, encodedBodySize, decodedBodySize, transferSize, duration })) }
      })
      assert.equal(state.state, 'ready', state.error)
      await cdp.send('HeapProfiler.collectGarbage')
      return { ids: state.ids, hits: state.ids.length, computeMs: state.computeMs, inputToPaintMs: state.inputToPaintMs, observedHeapMax: state.observedHeapMax, payloadBytes: state.resources.reduce((sum, r) => sum + r.encodedBodySize, 0), transferBytesIncludingHTTP: state.resources.reduce((sum, r) => sum + r.transferSize, 0), resources: state.resources }
    }
  }
  async function verifyReader(browser, site) {
    const page = await browser.newPage()
    try {
      await page.goto(`${url}/search-lab.html`); await page.getByRole('combobox').selectOption(site)
      await page.getByRole('textbox').fill('body-only-000007'); await page.getByRole('textbox').press('Enter')
      await page.waitForFunction(() => window.fulltextLab.state === 'ready')
      const link = page.getByRole('list', { name: '検索結果' }).getByRole('link').first(), href = await link.getAttribute('href')
      assert(href.startsWith(`/${site}/`) && !href.includes('/_artifacts/'))
      await link.click()
      await page.locator('iframe').first().waitFor()
      const frame = page.frameLocator('iframe').first()
      await frame.getByRole('heading', { name: 'Load document 000007', exact: true }).waitFor()
      await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.body.dataset.resources === 'ready')
      assert.equal(await frame.locator('#runtime').evaluate((element) => getComputedStyle(element).color), 'rgb(24, 100, 64)')
      await page.reload(); await frame.getByRole('heading', { name: 'Load document 000007', exact: true }).waitFor()
      const special = oracle[site].specialPath.split('/').map(encodeURIComponent).join('/')
      await page.goto(`${url}/${site}/${special}`)
      await page.frameLocator('iframe').first().getByRole('heading', { name: 'Load document 000000', exact: true }).waitFor()
      const markdown = oracle[site].paths.find((sourcePath) => sourcePath.endsWith('page-000009.md'))
      await page.goto(`${url}/${site}/${markdown.split('/').map(encodeURIComponent).join('/')}`)
      await page.getByTestId('markdown-document').getByRole('heading', { name: 'Load document 000009', exact: true }).waitFor()
    } finally { await page.close() }
  }
  async function verifyControls(browser, site) {
    const page = await browser.newPage(), rootPattern = `**/_indexes/${site}/search/root.gz`
    try {
      await page.goto(`${url}/search-lab.html`); await page.getByRole('combobox').selectOption(site)
      await page.route(rootPattern, (route) => route.fulfill({ status: 503, body: 'Temporary failure' }))
      await page.getByRole('textbox').fill('cache'); await page.getByRole('textbox').press('Enter')
      await page.waitForFunction(() => window.fulltextLab.state === 'error')
      await page.unroute(rootPattern)
      await page.getByRole('textbox').press('Enter'); await page.waitForFunction(() => window.fulltextLab.state === 'ready')
      assert.deepEqual(await page.evaluate(() => window.fulltextLab.ids), oracle[site].expected.cache)
      for (const query of ['hidden-only-secret', 'runtime-only-noindex']) {
        await page.getByRole('textbox').fill(query); await page.getByRole('textbox').press('Enter')
        await page.waitForFunction(() => window.fulltextLab.state === 'ready')
        assert.deepEqual(await page.evaluate(() => window.fulltextLab.ids), [])
      }
      await page.getByRole('textbox').fill('再試行'); await page.getByRole('textbox').press('Enter')
      await page.getByRole('textbox').fill('no-such-fulltext-token'); await page.getByRole('textbox').press('Enter')
      await page.waitForFunction(() => window.fulltextLab.state === 'ready' && window.fulltextLab.query === 'no-such-fulltext-token')
      assert.deepEqual(await page.evaluate(() => window.fulltextLab.ids), [])
      await page.getByRole('textbox').fill('再試行'); await page.getByRole('textbox').press('Enter')
      await page.waitForFunction(() => window.fulltextLab.state === 'ready')
      assert.deepEqual(await page.evaluate(() => window.fulltextLab.ids), oracle[site].expected['再試行'])
      await page.screenshot({ path: path.join(deployment.runRoot, 'search-lab.png'), fullPage: false })
    } finally { await page.close() }
  }
}
