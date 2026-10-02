import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { chromium } from '@playwright/test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const viteCli = path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const previewPort = Number(process.env.PREVIEW_DISCOVERY_BENCH_PORT ?? 4193)
const previewUrl = `http://127.0.0.1:${previewPort}`
const options = parseArguments(process.argv.slice(2))
const outputPath = path.resolve(repositoryRoot, options.output ?? path.join(
  '.local',
  'preview-discovery-benchmark',
  `${new Date().toISOString().replace(/[-:.TZ]/gu, '')}-${randomUUID().slice(0, 8)}-seed-${slugify(options.seed)}.jsonl`,
))

let previewProcess
let browser
let output

try {
  await mkdir(path.dirname(outputPath), { recursive: true })
  output = await open(outputPath, 'wx')
  const runId = path.basename(outputPath, '.jsonl')
  const scenarios = [
    await createCommittedFixtureDataset(options.siteCount, options.seed),
    ...options.groupCounts.map((groupCount) => createSyntheticDataset(options.siteCount, groupCount, options.seed)),
  ]

  previewProcess = startPreview()
  await waitForPreview(previewProcess)
  browser = await chromium.launch({ headless: true })

  await appendRow(output, {
    type: 'run',
    schemaVersion: 1,
    runId,
    seed: options.seed,
    sites: options.siteCount,
    scenarios: scenarios.map(({ id }) => id),
    runsPerSurface: options.runs,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      browser: browser.version(),
      viewport: { width: 1280, height: 900 },
      localUrl: previewUrl,
    },
    limitations: [
      'Preview and index API responses are fulfilled in-process by Playwright; byte counts are uncompressed UTF-8 response-body bytes.',
      'This measures browser parsing, validation, list/palette rendering, and request scope, not nginx, provider, CDN, or public-network latency.',
    ],
  })

  for (const dataset of scenarios) {
    await appendRow(output, {
      type: 'scenario-payload',
      scenario: dataset.id,
      source: dataset.source,
      seed: options.seed,
      siteCount: dataset.sites.length,
      selectedSiteId: dataset.selectedSiteId,
      catalogGroupCount: dataset.catalogs.get(dataset.selectedSiteId).groupCount,
      uniqueSelectedManifestCount: dataset.selectedManifestCount,
      expectedVisibleGroupCount: dataset.expectedVisibleGroupCount,
      payloadBytes: dataset.payloadBytes,
      statusMix: dataset.statusMix,
    })

    for (let run = 1; run <= options.runs; run += 1) {
      const listResult = await measurePreviewList(browser, dataset, run)
      await appendRow(output, {
        type: 'measurement',
        scenario: dataset.id,
        surface: 'preview-list',
        run,
        ...listResult,
      })

      const paletteResult = await measurePaletteCommand(browser, dataset)
      await appendRow(output, {
        type: 'measurement',
        scenario: dataset.id,
        surface: 'palette-open-previews-command',
        run,
        ...paletteResult,
      })
    }
  }

  console.log(`Wrote preview discovery benchmark JSONL: ${path.relative(repositoryRoot, outputPath)}`)
  console.log(`Scenarios: ${scenarios.map(({ id }) => id).join(', ')}`)
  console.log(`Sites: ${options.siteCount}; runs per surface: ${options.runs}; seed: ${options.seed}`)
} finally {
  await output?.close()
  await browser?.close()
  if (previewProcess && previewProcess.exitCode === null) {
    previewProcess.kill('SIGTERM')
    await new Promise((resolve) => previewProcess.once('exit', resolve))
  }
}

function parseArguments(args) {
  const values = {
    siteCount: 20,
    groupCounts: [100, 500],
    runs: 1,
    seed: '20260927',
    output: undefined,
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') {
      console.log('Usage: npm run benchmark:preview-discovery -- [--sites 20] [--groups 100,500,1000] [--runs 1] [--seed text] [--output path.jsonl]')
      console.log('The committed SRE fixture baseline runs first. Output defaults to .local/preview-discovery-benchmark/.')
      process.exit(0)
    }
    const [flag, inlineValue] = argument.split('=', 2)
    if (!['--sites', '--groups', '--runs', '--seed', '--output'].includes(flag)) {
      throw new Error(`Unknown argument: ${argument}`)
    }
    const value = inlineValue ?? args[++index]
    if (!value) throw new Error(`Missing value for ${flag}.`)
    if (flag === '--sites') values.siteCount = Number(value)
    else if (flag === '--groups') values.groupCounts = value.split(',').map(Number)
    else if (flag === '--runs') values.runs = Number(value)
    else if (flag === '--seed') values.seed = value
    else values.output = value
  }

  if (!Number.isSafeInteger(values.siteCount) || values.siteCount < 1 || values.siteCount > 200) {
    throw new Error('--sites must be a whole number between 1 and 200.')
  }
  if (!values.groupCounts.length || values.groupCounts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 10_000)) {
    throw new Error('--groups must contain one or more whole numbers between 1 and 10000.')
  }
  if (new Set(values.groupCounts).size !== values.groupCounts.length) throw new Error('--groups must not contain duplicates.')
  if (!Number.isSafeInteger(values.runs) || values.runs < 1 || values.runs > 10) {
    throw new Error('--runs must be a whole number between 1 and 10.')
  }
  if (!values.seed.trim()) throw new Error('--seed must not be empty.')
  if (previewPort < 1 || previewPort > 65_535) throw new Error('PREVIEW_DISCOVERY_BENCH_PORT must be a valid TCP port.')
  return values
}

async function createCommittedFixtureDataset(siteCount, seed) {
  const previewRoot = path.join(repositoryRoot, 'fixtures', 'storage', '_previews', 'sre')
  const catalogBody = await readFile(path.join(previewRoot, 'catalog.json'), 'utf8')
  const catalog = JSON.parse(catalogBody)
  const manifestBodies = new Map()
  const statusByHead = new Map()
  for (const group of catalog.groups) {
    if (statusByHead.has(group.headSha)) continue
    const manifestPath = path.join(previewRoot, 'revisions', group.headSha, 'manifest.json')
    try {
      manifestBodies.set(group.headSha, await readFile(manifestPath, 'utf8'))
      statusByHead.set(group.headSha, 200)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      statusByHead.set(group.headSha, 404)
    }
  }

  const decoySiteCount = Math.max(0, siteCount - 1)
  const sites = [makeSite('sre', 'SRE', 'benchmark/fixture-sre')]
  for (let index = 1; index <= decoySiteCount; index += 1) {
    const ordinal = String(index).padStart(4, '0')
    sites.push(makeSite(`site-${ordinal}`, `Benchmark site ${ordinal}`, `benchmark/site-${ordinal}`))
  }
  sites.sort((left, right) => left.id.localeCompare(right.id))

  const data = createBaseDataset(sites, 'sre', seed)
  const fixtureCatalog = { body: catalogBody, groupCount: catalog.groups.length }
  data.catalogs.set('sre', fixtureCatalog)
  for (const [headSha, status] of statusByHead) {
    data.manifests.set(manifestPath('sre', headSha), status === 200
      ? { status, body: manifestBodies.get(headSha), contentType: 'application/json; charset=utf-8' }
      : { status, body: 'Not found', contentType: 'text/plain; charset=utf-8' })
  }
  data.manifestStatusBySite.set('sre', statusByHead)
  for (const site of sites) {
    if (site.id === 'sre') continue
    const decoy = createSyntheticSiteRecords(site, 1, seed)
    data.catalogs.set(site.id, decoy.catalog)
    for (const [url, response] of decoy.manifests) data.manifests.set(url, response)
    data.manifestStatusBySite.set(site.id, decoy.statusByHead)
  }
  installIndexPayloads(data)
  return finalizeDataset(data, 'committed-fixture-baseline', 'committed-fixtures')
}

function createSyntheticDataset(siteCount, groupCount, seed) {
  const sites = Array.from({ length: siteCount }, (_, index) => {
    const ordinal = String(index + 1).padStart(4, '0')
    return makeSite(`site-${ordinal}`, `Benchmark site ${ordinal}`, `benchmark/site-${ordinal}`)
  })
  const data = createBaseDataset(sites, sites[0].id, seed)
  for (const site of sites) {
    const records = createSyntheticSiteRecords(site, site.id === data.selectedSiteId ? groupCount : 1, seed)
    data.catalogs.set(site.id, records.catalog)
    for (const [url, response] of records.manifests) data.manifests.set(url, response)
    data.manifestStatusBySite.set(site.id, records.statusByHead)
  }
  installIndexPayloads(data)
  return finalizeDataset(data, `synthetic-${siteCount}-sites-${groupCount}-groups`, 'deterministic-synthetic')
}

function createBaseDataset(sites, selectedSiteId, seed) {
  const registry = {
    schemaVersion: 1,
    sites: sites.map(({ id, name, repository, sourcePath }) => ({ id, name, repository, sourcePath })),
  }
  const registryBody = `${JSON.stringify(registry)}\n`
  const metadata = new Map()
  for (const site of sites) {
    metadata.set(site.id, `${JSON.stringify({
      schemaVersion: 1,
      site: { id: site.id, title: site.name },
      generatedAt: '2026-09-27T00:00:00.000Z',
      artifactCount: 0,
      artifactIndexUrl: `/_indexes/${site.id}/index.json`,
    })}\n`)
  }
  return {
    sites,
    selectedSiteId,
    seed,
    registryBody,
    metadata,
    indexes: new Map(),
    catalogs: new Map(),
    manifests: new Map(),
    manifestStatusBySite: new Map(),
  }
}

function createSyntheticSiteRecords(site, groupCount, seed) {
  const groups = []
  const manifests = new Map()
  const statusByHead = new Map()
  for (let index = 1; index <= groupCount; index += 1) {
    const headSha = createHash('sha1').update(`${seed}:${site.id}:${index}`).digest('hex')
    const ordinal = String(index).padStart(6, '0')
    const document = {
      path: `docs/preview-group-${ordinal}.md`,
      title: `Benchmark preview group ${ordinal}`,
      format: 'markdown',
    }
    const group = {
      id: `pr:${index}`,
      kind: 'pull-request',
      headSha,
      prUrl: `https://github.com/benchmark/${site.id}/pull/${index}`,
      updatedAt: new Date(Date.UTC(2026, 8, 27) - index * 60_000).toISOString(),
      documents: [document],
    }
    groups.push(group)
    const fileSha = createHash('sha256').update(`${seed}:${site.id}:${document.path}`).digest('hex')
    const manifest = {
      schemaVersion: 1,
      site: site.id,
      headSha,
      defaultHeadSha: createHash('sha1').update(`${seed}:${site.id}:default`).digest('hex'),
      mergeBaseSha: createHash('sha1').update(`${seed}:${site.id}:merge-base`).digest('hex'),
      createdAt: group.updatedAt,
      bundleDigest: `sha256:${createHash('sha256').update(`${seed}:${site.id}:${headSha}:bundle`).digest('hex')}`,
      files: [{ path: document.path, sha256: fileSha, contentType: 'text/markdown; charset=utf-8' }],
      documents: [document],
    }
    const availability = index % 10
    const status = availability === 8 ? 404 : availability === 9 ? 503 : 200
    manifests.set(manifestPath(site.id, headSha), status === 200
      ? {
          status,
          body: `${JSON.stringify(manifest)}\n`,
          contentType: 'application/json; charset=utf-8',
        }
      : {
          status,
          body: status === 404 ? 'Not found' : 'Temporarily unavailable',
          contentType: 'text/plain; charset=utf-8',
        })
    statusByHead.set(headSha, status)
  }
  return {
    catalog: { body: `${JSON.stringify({ schemaVersion: 1, site: site.id, groups })}\n`, groupCount },
    manifests,
    statusByHead,
  }
}

function installIndexPayloads(data) {
  for (const site of data.sites) {
    data.indexes.set(`/_indexes/${site.id}/index.json`, `${JSON.stringify({
      schemaVersion: 1,
      site: { id: site.id, title: site.name },
      generatedAt: '2026-09-27T00:00:00.000Z',
      artifacts: [],
    })}\n`)
  }
}

function finalizeDataset(data, id, source) {
  const selectedCatalog = data.catalogs.get(data.selectedSiteId)
  const selectedStatuses = data.manifestStatusBySite.get(data.selectedSiteId)
  const expectedVisibleGroupCount = selectedCatalog.groupCount
    ? JSON.parse(selectedCatalog.body).groups.filter(({ headSha }) => {
      const status = selectedStatuses.get(headSha)
      return status === 200 || status === 503
    }).length
    : 0
  const selectedManifestCount = selectedStatuses.size
  const allCatalogBytes = [...data.catalogs.values()].reduce((total, { body }) => total + utf8Bytes(body), 0)
  const selectedCatalogBytes = utf8Bytes(selectedCatalog.body)
  const allManifestResponseBytes = [...data.manifests.values()]
    .reduce((total, { body }) => total + utf8Bytes(body), 0)
  const selectedManifestBytes = [...data.manifests.entries()]
    .filter(([url]) => url.startsWith(`/_previews/${data.selectedSiteId}/`))
    .reduce((total, [, { body }]) => total + utf8Bytes(body), 0)
  data.id = id
  data.source = source
  data.expectedVisibleGroupCount = expectedVisibleGroupCount
  data.selectedManifestCount = selectedManifestCount
  data.payloadBytes = {
    registry: utf8Bytes(data.registryBody),
    metadataAllSites: [...data.metadata.values()].reduce((total, body) => total + utf8Bytes(body), 0),
    selectedSiteIndex: utf8Bytes(data.indexes.get(`/_indexes/${data.selectedSiteId}/index.json`)),
    selectedCatalog: selectedCatalogBytes,
    catalogAllSites: allCatalogBytes,
    selectedManifestResponseBodies: selectedManifestBytes,
    manifestResponseBodiesAllSites: allManifestResponseBytes,
    selectedCatalogAndManifests: selectedCatalogBytes + selectedManifestBytes,
    allCatalogAndManifestPayloads: allCatalogBytes + allManifestResponseBytes,
  }
  data.statusMix = {
    selectedSite: countStatuses(selectedStatuses),
    allSites: [...data.manifestStatusBySite.values()].reduce((total, statuses) => addStatuses(total, countStatuses(statuses)), { http200: 0, http404: 0, http503: 0 }),
  }
  return data
}

function makeSite(id, name, repository) {
  return { id, name, repository, sourcePath: 'docs' }
}

function countStatuses(statuses) {
  const counts = { http200: 0, http404: 0 }
  for (const status of statuses.values()) counts[`http${status}`] = (counts[`http${status}`] ?? 0) + 1
  return counts
}

function addStatuses(target, next) {
  target.http200 += next.http200 ?? 0
  target.http404 += next.http404 ?? 0
  target.http503 += next.http503 ?? 0
  return target
}

function manifestPath(siteId, headSha) {
  return `/_previews/${siteId}/revisions/${headSha}/manifest.json`
}

async function measurePreviewList(browserInstance, dataset, run) {
  const session = await openMeasuredPage(browserInstance, dataset)
  const { page, cdp, routeEvents, pageErrors } = session
  try {
    const homeHeapBytes = await readJsHeapBytes(cdp)
    const firstMeasuredEvent = routeEvents.length
    const startedAt = await page.evaluate(() => performance.now())
    await page.locator('.site-home-preview-link').click()
    await page.getByRole('heading', { name: 'Previews', exact: true }).waitFor({ state: 'visible' })
    await page.waitForFunction((count) => document.querySelectorAll('.preview-group').length === count, dataset.expectedVisibleGroupCount)
    await nextPaint(page)
    const domReady = await page.evaluate((startedAtValue) => performance.now() - startedAtValue, startedAt)
    const listMetrics = await page.evaluate(() => ({
      visibleGroups: document.querySelectorAll('.preview-group').length,
      visibleDocuments: document.querySelectorAll('.preview-document-list a').length,
      loading: Boolean(document.querySelector('.preview-page [role="status"]')),
    }))
    const afterPreviewHeapBytes = await readJsHeapBytes(cdp)
    if (pageErrors.length) throw new Error(`Browser page error: ${pageErrors[0]}`)
    const requestCounts = summarizeRequests(routeEvents.slice(firstMeasuredEvent), dataset.selectedSiteId)
    assertDiscoveryRequests(dataset, requestCounts)
    return {
      selectedSiteId: dataset.selectedSiteId,
      requestCounts,
      jsonParse: await readPreviewJsonParseMetrics(page),
      render: {
        listInputToPaintMs: round(domReady),
        manifestAvailability: await readManifestAvailabilityMetrics(page, dataset.selectedSiteId),
        visibleGroups: listMetrics.visibleGroups,
        visibleDocuments: listMetrics.visibleDocuments,
        loadingIndicatorPresent: listMetrics.loading,
      },
      cdpHeapBytes: {
        siteHomeAfterGc: homeHeapBytes,
        previewListAfterGc: afterPreviewHeapBytes,
        deltaFromSiteHome: delta(afterPreviewHeapBytes, homeHeapBytes),
      },
      pageErrors,
    }
  } finally {
    await session.context.close()
  }
}

// The palette no longer lists preview documents; it reaches the preview list
// through the "Open previews" command. Opening the palette must not fetch
// preview data; the command then loads the same list as the site-home link.
async function measurePaletteCommand(browserInstance, dataset) {
  const session = await openMeasuredPage(browserInstance, dataset)
  const { page, cdp, routeEvents, pageErrors } = session
  try {
    const homeHeapBytes = await readJsHeapBytes(cdp)
    const previewRequestsBeforePalette = routeEvents.filter(({ category }) => category === 'preview').length
    await page.getByRole('button', { name: `Jump to a page in ${pageTitle(dataset)}` }).first().click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.waitFor({ state: 'visible' })
    await nextPaint(page)
    const previewRequestsWhilePaletteOpen = routeEvents.filter(({ category }) => category === 'preview').length - previewRequestsBeforePalette
    if (previewRequestsWhilePaletteOpen !== 0) {
      throw new Error(`Opening the palette requested ${previewRequestsWhilePaletteOpen} preview resource(s).`)
    }
    const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
    await search.fill('Open previews')
    const command = palette.getByRole('option', { name: /^Open previews/u })
    await command.waitFor({ state: 'visible' })
    const firstMeasuredEvent = routeEvents.length
    const startedAt = await page.evaluate(() => performance.now())
    await command.click()
    await page.getByRole('heading', { name: 'Previews', exact: true }).waitFor({ state: 'visible' })
    await page.waitForFunction((count) => document.querySelectorAll('.preview-group').length === count, dataset.expectedVisibleGroupCount)
    await nextPaint(page)
    const commandToPaintMs = await page.evaluate((startedAtValue) => performance.now() - startedAtValue, startedAt)
    const afterPreviewHeapBytes = await readJsHeapBytes(cdp)
    if (pageErrors.length) throw new Error(`Browser page error: ${pageErrors[0]}`)
    const requestCounts = summarizeRequests(routeEvents.slice(firstMeasuredEvent), dataset.selectedSiteId)
    assertDiscoveryRequests(dataset, requestCounts)
    return {
      selectedSiteId: dataset.selectedSiteId,
      requestCounts,
      jsonParse: await readPreviewJsonParseMetrics(page),
      render: {
        previewRequestsWhilePaletteOpen,
        commandToListPaintMs: round(commandToPaintMs),
        manifestAvailability: await readManifestAvailabilityMetrics(page, dataset.selectedSiteId),
        visibleGroups: await page.locator('.preview-group').count(),
      },
      cdpHeapBytes: {
        siteHomeAfterGc: homeHeapBytes,
        previewListAfterGc: afterPreviewHeapBytes,
        deltaFromSiteHome: delta(afterPreviewHeapBytes, homeHeapBytes),
      },
      pageErrors,
    }
  } finally {
    await session.context.close()
  }
}

function pageTitle(dataset) {
  return dataset.sites.find(({ id }) => id === dataset.selectedSiteId)?.name ?? dataset.selectedSiteId
}

async function openMeasuredPage(browserInstance, dataset) {
  const context = await browserInstance.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  const routeEvents = []
  const pageErrors = []
  const apiResponses = new Map()
  apiResponses.set('/_indexes/sites.json', { status: 200, body: dataset.registryBody, contentType: 'application/json; charset=utf-8' })
  for (const [siteId, body] of dataset.metadata) apiResponses.set(`/_indexes/${siteId}/meta.json`, { status: 200, body, contentType: 'application/json; charset=utf-8' })
  for (const [url, body] of dataset.indexes) apiResponses.set(url, { status: 200, body, contentType: 'application/json; charset=utf-8' })
  for (const [siteId, catalog] of dataset.catalogs) apiResponses.set(`/_previews/${siteId}/catalog.json`, {
    status: 200,
    body: catalog.body,
    contentType: 'application/json; charset=utf-8',
  })
  for (const [url, response] of dataset.manifests) apiResponses.set(url, response)

  await cdp.send('HeapProfiler.enable')
  await cdp.send('Performance.enable')
  await page.addInitScript(installJsonParseInstrumentation)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (!url.pathname.startsWith('/_indexes/') && !url.pathname.startsWith('/_previews/')) {
      await route.continue()
      return
    }
    const response = apiResponses.get(url.pathname) ?? {
      status: 404,
      body: 'Not found',
      contentType: 'text/plain; charset=utf-8',
    }
    routeEvents.push({
      pathname: url.pathname,
      status: response.status,
      bytes: utf8Bytes(response.body),
      category: url.pathname.startsWith('/_previews/') ? 'preview' : 'index',
    })
    await route.fulfill({
      status: response.status,
      body: response.body,
      contentType: response.contentType,
      headers: { 'cache-control': 'no-store' },
    })
  })

  await page.goto(`${previewUrl}/${encodeURIComponent(dataset.selectedSiteId)}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.site-home h1').waitFor({ state: 'visible', timeout: 60_000 })
  // The site home discovers previews for its "View previews" link, and one of
  // those fetches may never report completion, so 'networkidle' is not usable.
  // Wait for a quiet period in the fulfilled API traffic instead; measured
  // request counts start after this point.
  for (let seen = -1, deadline = Date.now() + 15_000; seen !== routeEvents.length && Date.now() < deadline;) {
    seen = routeEvents.length
    await page.waitForTimeout(500)
  }
  return { context, page, cdp, routeEvents, pageErrors }
}

function installJsonParseInstrumentation() {
  performance.setResourceTimingBufferSize(50_000)
  const originalJson = Response.prototype.json
  const originalText = Response.prototype.text
  const metrics = { previewJsonParses: [] }
  Object.defineProperty(window, '__previewDiscoveryBench', { value: metrics, configurable: true })
  Response.prototype.json = async function (...args) {
    let pathname = ''
    try { pathname = new URL(this.url).pathname } catch { return originalJson.apply(this, args) }
    if (!pathname.startsWith('/_previews/')) return originalJson.apply(this, args)
    const body = await originalText.call(this)
    const parseStartedAt = performance.now()
    const payload = JSON.parse(body)
    const parseMs = performance.now() - parseStartedAt
    metrics.previewJsonParses.push({ pathname, bytes: new TextEncoder().encode(body).byteLength, parseMs })
    return payload
  }
}

async function readPreviewJsonParseMetrics(page) {
  return page.evaluate(() => {
    const entries = window.__previewDiscoveryBench?.previewJsonParses ?? []
    const catalogs = entries.filter(({ pathname }) => pathname.endsWith('/catalog.json'))
    const manifests = entries.filter(({ pathname }) => pathname.endsWith('/manifest.json'))
    const summarize = (values) => ({
      responsesParsed: values.length,
      bytesParsed: values.reduce((total, entry) => total + entry.bytes, 0),
      parseSamplesMs: values.map(({ parseMs }) => Number(parseMs.toFixed(3))),
      parseTotalMs: Number(values.reduce((total, entry) => total + entry.parseMs, 0).toFixed(3)),
    })
    return {
      ...summarize(entries),
      catalog: summarize(catalogs),
      manifests: summarize(manifests),
    }
  })
}

async function readManifestAvailabilityMetrics(page, selectedSiteId) {
  return page.evaluate((siteId) => {
    const prefix = `${window.location.origin}/_previews/${encodeURIComponent(siteId)}/revisions/`
    const resources = performance.getEntriesByType('resource')
      .filter((entry) => entry.name.startsWith(prefix) && entry.name.endsWith('/manifest.json'))
    if (!resources.length) return { requests: 0, envelopeMs: null }
    const firstStart = Math.min(...resources.map(({ startTime }) => startTime))
    const lastEnd = Math.max(...resources.map(({ responseEnd }) => responseEnd))
    return {
      requests: resources.length,
      envelopeMs: Number((lastEnd - firstStart).toFixed(3)),
    }
  }, selectedSiteId)
}

function summarizeRequests(events, selectedSiteId) {
  const previewEvents = events.filter(({ category }) => category === 'preview')
  const selectedPrefix = `/_previews/${selectedSiteId}/`
  const selectedEvents = previewEvents.filter(({ pathname }) => pathname.startsWith(selectedPrefix))
  const nonSelectedPreviewEvents = previewEvents.filter(({ pathname }) => !pathname.startsWith(selectedPrefix))
  const indexEvents = events.filter(({ category }) => category === 'index')
  return {
    index: {
      total: indexEvents.length,
      registry: indexEvents.filter(({ pathname }) => pathname === '/_indexes/sites.json').length,
      metadata: indexEvents.filter(({ pathname }) => pathname.endsWith('/meta.json')).length,
      siteIndexes: indexEvents.filter(({ pathname }) => pathname.endsWith('/index.json')).length,
    },
    preview: {
      total: previewEvents.length,
      selectedSite: selectedEvents.length,
      selectedCatalogs: selectedEvents.filter(({ pathname }) => pathname.endsWith('/catalog.json')).length,
      selectedManifests: selectedEvents.filter(({ pathname }) => pathname.endsWith('/manifest.json')).length,
      selectedManifestResponses: countEventStatuses(selectedEvents.filter(({ pathname }) => pathname.endsWith('/manifest.json'))),
      otherSitePreviewRequests: nonSelectedPreviewEvents.length,
      otherSitePaths: [...new Set(nonSelectedPreviewEvents.map(({ pathname }) => pathname))],
      responseBytes: previewEvents.reduce((total, event) => total + event.bytes, 0),
      selectedResponseBytes: selectedEvents.reduce((total, event) => total + event.bytes, 0),
      paths: previewEvents.map(({ pathname, status, bytes }) => ({ pathname, status, bytes })),
    },
  }
}

function assertDiscoveryRequests(dataset, requestCounts) {
  const actual = requestCounts.preview.selectedManifestResponses
  const expected = dataset.statusMix.selectedSite
  const statusesMatch = ['http200', 'http404', 'http503'].every((status) => (actual[status] ?? 0) === (expected[status] ?? 0))
  if (
    requestCounts.preview.selectedCatalogs !== 1 ||
    requestCounts.preview.selectedManifests !== dataset.selectedManifestCount ||
    requestCounts.preview.otherSitePreviewRequests !== 0 ||
    !statusesMatch
  ) {
    throw new Error(`Preview discovery request contract failed for ${dataset.id}: ${JSON.stringify({
      expectedCatalogs: 1,
      expectedManifests: dataset.selectedManifestCount,
      expectedStatuses: expected,
      actual: requestCounts.preview,
    })}`)
  }
}

function countEventStatuses(events) {
  return events.reduce((counts, { status }) => {
    const key = `http${status}`
    counts[key] = (counts[key] ?? 0) + 1
    return counts
  }, {})
}

async function readJsHeapBytes(cdp) {
  await cdp.send('HeapProfiler.collectGarbage')
  const { metrics } = await cdp.send('Performance.getMetrics')
  const value = metrics.find(({ name }) => name === 'JSHeapUsedSize')?.value
  return value === undefined ? null : Math.round(value)
}

async function nextPaint(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

function delta(value, baseline) {
  return value === null || baseline === null ? null : value - baseline
}

function round(value) {
  return Number(value.toFixed(3))
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/gu, '-')
}

async function appendRow(file, value) {
  await file.write(`${JSON.stringify(value)}\n`)
}

function startPreview() {
  return spawn(process.execPath, [viteCli, 'preview', '--config', path.join(repositoryRoot, 'web/vite.config.ts'), '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'], {
    cwd: repositoryRoot,
    stdio: 'ignore',
  })
}

async function waitForPreview(child) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite preview exited with status ${child.exitCode}; check port ${previewPort}.`)
    try {
      const response = await fetch(previewUrl)
      if (response.ok) return
    } catch {
      // The preview server may still be binding its local port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for Vite preview on ${previewUrl}.`)
}
