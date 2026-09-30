import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { chromium } from '@playwright/test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const outputRoot = path.join(repositoryRoot, '.local', 'palette-load-fixtures')
const previewPort = Number(process.env.PALETTE_BENCH_PORT ?? 4185)
const previewUrl = `http://127.0.0.1:${previewPort}`
const fixturePort = previewPort + 1
const viteCli = path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js')

const adjectives = [
  'amber', 'ancient', 'balanced', 'brisk', 'calm', 'careful', 'cedar', 'clear', 'coastal', 'crisp',
  'distant', 'eager', 'elastic', 'even', 'faint', 'familiar', 'gentle', 'granite', 'hidden', 'honest',
  'indigo', 'kind', 'lunar', 'mellow', 'narrow', 'patient', 'quiet', 'rapid', 'silver', 'steady',
  'subtle', 'tidy', 'useful', 'velvet', 'warm', 'winding', 'young', 'zonal',
]
const topics = [
  'accessibility', 'architecture', 'atlas', 'content', 'diagram', 'incident', 'index', 'network',
  'platform', 'release', 'research', 'review', 'security', 'service', 'system', 'workflow',
]
const nouns = [
  'archive', 'beacon', 'bridge', 'canvas', 'catalog', 'circuit', 'cluster', 'compass', 'delta', 'engine',
  'field', 'forest', 'gateway', 'harbor', 'horizon', 'journal', 'kernel', 'lantern', 'ledger', 'meadow',
  'meridian', 'notebook', 'ocean', 'orchard', 'origin', 'packet', 'pathway', 'quartz', 'signal', 'vector',
  'vessel', 'voyage', 'window', 'workbench', 'yellowwood', 'zenith',
]
const areas = [
  'analysis', 'architecture', 'design', 'guides', 'incidents', 'operations', 'policies', 'product',
  'reference', 'reports', 'research', 'services', 'systems', 'techniques', 'workflows', 'workspace',
]
const queries = [
  { label: 'common term', value: 'atlas', expectResults: true },
  { label: 'fuzzy subsequence', value: 'pltfrm', expectResults: true },
  { label: 'no match', value: 'zzzzzzzzzzzzzzzz', expectResults: false },
]
const sequentialQueries = ['atlas', 'pltfrm', 'zzzz']

const options = parseArguments(process.argv.slice(2))
let browser
let preview
let fixtureServer

try {
  await mkdir(outputRoot, { recursive: true })
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/gu, '')}-${randomUUID().slice(0, 8)}-seed-${slugify(options.seed)}`
  const runRoot = path.join(outputRoot, runId)
  await mkdir(runRoot)

  const scenarios = [
    ...options.counts.map((artifactsPerSite) => ({
      label: `single-${artifactsPerSite}`,
      siteCount: 1,
      artifactsPerSite,
      recentReadsPerSite: options.recentReadsPerSite,
    })),
    ...(options.siteCount === undefined ? [] : [{
      label: `multi-${options.siteCount}-by-${options.artifactsPerSite}`,
      siteCount: options.siteCount,
      artifactsPerSite: options.artifactsPerSite,
      recentReadsPerSite: options.recentReadsPerSite,
    }]),
  ]
  const datasets = []
  for (const scenario of scenarios) datasets.push(await generateDataset(runRoot, scenario, options.seed, options.paletteIndexMatrix))
  for (const chunkSize of options.chunkSizes) {
    for (const scenario of scenarios.filter(({ siteCount }) => siteCount === 1)) {
      datasets.push(await generateDataset(runRoot, {
        ...scenario,
        label: `${scenario.label}-chunks-${chunkSize}`,
        chunkSize,
      }, options.seed))
    }
  }

  console.log(`Generated index-only fixtures: ${path.relative(repositoryRoot, runRoot)}`)
  console.log(`Seed: ${options.seed}`)

  if (!options.generateOnly) {
    preview = startPreview()
    await waitForPreview(preview)
    fixtureServer = await startFixtureServer()
    browser = await chromium.launch({ headless: true })

    for (const dataset of datasets) {
      fixtureServer.setDataset(dataset)
      for (let loadIteration = 0; loadIteration < options.loads; loadIteration += 1) {
        const result = options.paletteScoreMatrix || options.paletteScopeMatrix || options.paletteIndexMatrix || options.paletteBaselineMatrix
          ? await benchmarkPaletteScoringUiMatrix(browser, dataset, options.iterations, fixtureServer.url, loadIteration + 1, options.paletteScopeMatrix, options.paletteIndexMatrix, options.paletteBaselineMatrix)
          : await benchmarkDataset(browser, dataset, options.iterations, fixtureServer.url)
        console.log(JSON.stringify({ loadIteration: loadIteration + 1, ...result }))
      }
    }

    console.log(`Iterations per query and scenario: ${options.iterations}`)
  }
} finally {
  await fixtureServer?.close()
  await browser?.close()
  if (preview && preview.exitCode === null) {
    preview.kill('SIGTERM')
    await new Promise((resolve) => preview.once('exit', resolve))
  }
}

async function generateDataset(runRoot, scenario, seed, includePaletteScoringProfile = false) {
  const generationStarted = performance.now()
  const scenarioRoot = path.join(runRoot, scenario.label, 'storage', '_indexes')
  const sites = []
  const metadataPayloads = new Map()
  const currentArtifactPayloads = new Map()
  const recentReadsBySite = Object.create(null)
  const pinnedArtifactIdsBySite = Object.create(null)
  let searchRecords = []
  let currentIndexBytes = 0
  let baselineCurrentIndexBytes = 0
  let currentIndexGzipBytes = 0
  let profileProjectionBytes = 0
  let profileProjectionGzipBytes = 0
  let profileProjectionBuildMs = 0
  let activeProfileProjectionBuildMs = 0
  let totalIndexBytes = 0

  for (let offset = 0; offset < scenario.siteCount; offset += 1) {
    const ordinal = offset + 1
    const siteId = scenario.siteCount === 1 ? 'search-lab' : `site-${String(ordinal).padStart(4, '0')}`
    const title = scenario.siteCount === 1
      ? `Search Load Lab (${scenario.artifactsPerSite})`
      : `Search Lab ${String(ordinal).padStart(4, '0')}`
    const index = generateSiteIndex(scenario.artifactsPerSite, seed, siteId, title)
    const unprojectedIndexPayload = `${JSON.stringify(index)}\n`
    if (includePaletteScoringProfile) {
      const profileStarted = performance.now()
      index.paletteScoringProfile = generateSerializedPaletteProfiles(index.artifacts)
      const profileElapsedMs = performance.now() - profileStarted
      profileProjectionBuildMs += profileElapsedMs
      if (offset === 0) activeProfileProjectionBuildMs = profileElapsedMs
    }
    const recentReads = index.artifacts
      .slice(0, scenario.recentReadsPerSite)
      .map((artifact, readIndex) => ({
        artifactId: artifact.id,
        viewedAt: Date.now() - readIndex * 60 * 60 * 1_000,
      }))
    if (recentReads.length) recentReadsBySite[siteId] = recentReads
    if (offset === 0) pinnedArtifactIdsBySite[siteId] = index.artifacts.slice(20, 40).map(({ id }) => id)
    if (offset === 0) {
      searchRecords = index.artifacts.map(({ id, title: artifactTitle, path: artifactPath, updatedAt }) => ({
        id,
        title: artifactTitle,
        path: artifactPath,
        updatedAt,
      }))
    }
    const indexPath = path.join(scenarioRoot, siteId, 'index.json')
    await mkdir(path.dirname(indexPath), { recursive: true })
    let indexBytes = 0
    if (scenario.chunkSize) {
      await mkdir(path.join(scenarioRoot, siteId, 'chunks'), { recursive: true })
      const artifactChunks = []
      for (let start = 0; start < index.artifacts.length; start += scenario.chunkSize) {
        const chunkNumber = Math.floor(start / scenario.chunkSize)
        const chunkName = `part-${String(chunkNumber + 1).padStart(4, '0')}.json`
        const chunkUrl = `/_indexes/${siteId}/chunks/${chunkName}`
        const chunkPayload = `${JSON.stringify(index.artifacts.slice(start, start + scenario.chunkSize))}\n`
        await writeFile(path.join(scenarioRoot, siteId, 'chunks', chunkName), chunkPayload, { flag: 'wx' })
        artifactChunks.push(chunkUrl)
        indexBytes += Buffer.byteLength(chunkPayload)
        if (offset === 0) currentArtifactPayloads.set(chunkUrl, chunkPayload)
      }
      const manifestPayload = `${JSON.stringify({
        schemaVersion: index.schemaVersion,
        site: index.site,
        generatedAt: index.generatedAt,
        artifactChunks,
      })}\n`
      await writeFile(indexPath, manifestPayload, { flag: 'wx' })
      indexBytes += Buffer.byteLength(manifestPayload)
      if (offset === 0) currentArtifactPayloads.set(`/_indexes/${siteId}/index.json`, manifestPayload)
    } else {
      const indexPayload = includePaletteScoringProfile
        ? `${JSON.stringify(index)}\n`
        : unprojectedIndexPayload
      await writeFile(indexPath, indexPayload, { flag: 'wx' })
      indexBytes = Buffer.byteLength(indexPayload)
      if (offset === 0) {
        currentArtifactPayloads.set(`/_indexes/${siteId}/index.json`, indexPayload)
        baselineCurrentIndexBytes = Buffer.byteLength(unprojectedIndexPayload)
        currentIndexGzipBytes = gzipSync(indexPayload).byteLength
        if (includePaletteScoringProfile) {
          profileProjectionBytes = indexBytes - baselineCurrentIndexBytes
          profileProjectionGzipBytes = gzipSync(`${JSON.stringify(index.paletteScoringProfile)}\n`).byteLength
        }
      }
    }
    totalIndexBytes += indexBytes
    if (offset === 0) {
      currentIndexBytes = indexBytes
    }

    const metadata = {
      schemaVersion: 1,
      site: { id: siteId, title },
      generatedAt: '2026-09-24T12:00:00.000Z',
      artifactCount: scenario.artifactsPerSite,
      artifactIndexUrl: `/_indexes/${siteId}/index.json`,
    }
    const metadataPayload = `${JSON.stringify(metadata)}\n`
    const metadataPath = path.join(scenarioRoot, siteId, 'meta.json')
    await writeFile(metadataPath, metadataPayload, { flag: 'wx' })
    metadataPayloads.set(siteId, metadataPayload)
    sites.push(metadata)
  }

  if (currentArtifactPayloads.size === 0) throw new Error('A benchmark scenario must contain at least one site.')
  return {
    ...scenario,
    sites,
    metadataPayloads,
    currentArtifactPayloads,
    searchRecords,
    currentSiteId: sites[0].site.id,
    currentIndexBytes,
    baselineCurrentIndexBytes,
    currentIndexGzipBytes,
    profileProjectionBytes,
    profileProjectionGzipBytes,
    profileProjectionBuildMs,
    activeProfileProjectionBuildMs,
    expectedArtifactIndexRequests: currentArtifactPayloads.size,
    recentReadsBySite,
    pinnedArtifactIdsBySite,
    recentReadCountPerSite: Math.min(scenario.recentReadsPerSite, scenario.artifactsPerSite),
    recentReadCountTotal: Object.values(recentReadsBySite).reduce((total, reads) => total + reads.length, 0),
    recentHistoryStorageBytes: Object.keys(recentReadsBySite).length
      ? Buffer.byteLength(JSON.stringify(recentReadsBySite))
      : 0,
    totalIndexBytes,
    metadataBytes: [...metadataPayloads.values()].reduce((total, payload) => total + Buffer.byteLength(payload), 0),
    generationMs: performance.now() - generationStarted,
    outputPath: path.relative(repositoryRoot, path.dirname(scenarioRoot)),
  }
}

async function benchmarkDataset(browserInstance, dataset, iterations, fixtureUrl) {
  const page = await browserInstance.newPage({ viewport: { width: 1440, height: 960 } })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.enable')
  await cdp.send('Performance.enable')
  const initialHeapBytes = await readJsHeapBytes(cdp)
  const metadataRequests = []
  const artifactIndexRequests = []
  let pageError
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (/^\/_indexes\/[^/]+\/meta\.json$/u.test(pathname)) metadataRequests.push(pathname)
    if (pathname.startsWith('/_indexes/') && pathname.endsWith('.json') && !pathname.endsWith('/meta.json')) {
      artifactIndexRequests.push(pathname)
    }
  })
  page.on('pageerror', (error) => { pageError = error.message })
  await page.addInitScript(({ maxResourceEntries, chunked, recentReadsBySite }) => {
    if (window.top !== window) return
    const recentStorageKey = 'git-artifact-pages:recent-artifacts:v1'
    if (Object.keys(recentReadsBySite).length) {
      localStorage.setItem(recentStorageKey, JSON.stringify(recentReadsBySite))
    } else {
      localStorage.removeItem(recentStorageKey)
    }
    performance.setResourceTimingBufferSize(maxResourceEntries)
    const metrics = {
      jsonLoads: [],
      fetches: [],
      recentStorageOps: { set: [] },
      initialHeapBytes: performance.memory?.usedJSHeapSize ?? null,
    }
    Object.defineProperty(window, '__paletteBenchMetrics', { value: metrics })
    document.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('[role="option"]')) {
        metrics.recentStorageOps.lastOptionClickAt = performance.now()
      }
    }, true)
    const nativeStorageSet = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key !== recentStorageKey) return nativeStorageSet.call(this, key, value)
      const started = performance.now()
      const result = nativeStorageSet.call(this, key, value)
      const elapsedMs = performance.now() - started
      const clickToPersistMs = metrics.recentStorageOps.lastOptionClickAt === undefined
        ? null
        : performance.now() - metrics.recentStorageOps.lastOptionClickAt
      const valueText = String(value)
      const measurement = {
        elapsedMs,
        clickToPersistMs,
        utf8Bytes: new TextEncoder().encode(valueText).byteLength,
        immediateReadBackMatches: this.getItem(key) === valueText,
      }
      metrics.recentStorageOps.lastOptionClickAt = undefined
      metrics.recentStorageOps.set.push(measurement)
      window.dispatchEvent(new CustomEvent('palette-bench:recent-history-write', { detail: measurement }))
      return result
    }
    const nativeFetch = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const started = performance.now()
      const response = await nativeFetch(...args)
      const pathname = new URL(response.url).pathname
      if (pathname.startsWith('/_indexes/')) {
        metrics.fetches.push({ pathname, elapsedMs: performance.now() - started })
      }
      if (chunked && pathname.endsWith('/index.json')) {
        // Benchmark-only adapter: measure eager chunk transport while keeping the app's index contract unchanged.
        const manifest = await response.clone().json()
        if (Array.isArray(manifest.artifactChunks)) {
          const chunks = await Promise.all(manifest.artifactChunks.map(async (chunkUrl) => {
            const chunkResponse = await window.fetch(chunkUrl)
            if (!chunkResponse.ok) throw new Error(`Chunk request failed: ${chunkUrl}`)
            return chunkResponse.json()
          }))
          const completeIndex = {
            schemaVersion: manifest.schemaVersion,
            site: manifest.site,
            generatedAt: manifest.generatedAt,
            artifacts: chunks.flat(),
          }
          const combinedResponse = new Response(null, { status: 200, headers: response.headers })
          Object.defineProperty(combinedResponse, 'json', { value: async () => completeIndex })
          return combinedResponse
        }
      }
      return response
    }
    Response.prototype.json = async function () {
      const readStarted = performance.now()
      const text = await this.text()
      const bodyReadMs = performance.now() - readStarted
      const parseStarted = performance.now()
      const payload = JSON.parse(text)
      const parseMs = performance.now() - parseStarted
      metrics.jsonLoads.push({
        pathname: new URL(this.url).pathname,
        bytes: new TextEncoder().encode(text).byteLength,
        bodyReadMs,
        parseMs,
      })
      return payload
    }
  }, {
    maxResourceEntries: Math.max(250, dataset.siteCount + 100),
    chunked: Boolean(dataset.chunkSize),
    recentReadsBySite: dataset.recentReadsBySite,
  })
  const loadStarted = performance.now()
  await page.goto(`${fixtureUrl}/${dataset.currentSiteId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.site-home h1').waitFor({ state: 'visible', timeout: 60_000 })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const pageReadyMs = performance.now() - loadStarted
  await page.waitForFunction((siteCount) => {
    const metadataLoads = window.__paletteBenchMetrics.jsonLoads.filter(({ pathname }) => (
      pathname.endsWith('/meta.json')
    ))
    return metadataLoads.length === siteCount
  }, dataset.siteCount)
  const discoveryCompleteMs = performance.now() - loadStarted
  const heapAfterSiteLoadBytes = await readJsHeapBytes(cdp)
  const siteHomeMetrics = await page.evaluate(() => ({
    artifactRows: document.querySelectorAll('.site-home .tree-artifact').length,
    directoryRows: document.querySelectorAll('.site-home .tree-directory-button').length,
    virtualList: Boolean(document.querySelector('.site-home .is-virtualized-path-list')),
  }))
  const pageMetrics = await readPerformanceMetrics(cdp)

  const paletteOpenStarted = performance.now()
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.waitFor({ state: 'visible' })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const paletteOpenMs = performance.now() - paletteOpenStarted
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  const typingResults = []
  for (const sequence of sequentialQueries) {
    typingResults.push(await benchmarkTyping(search, iterations, sequence))
  }
  const queryResults = []
  const siteQuery = `@${dataset.sites.at(-1).site.id}`

  for (const query of [...queries, { label: 'site lookup', value: siteQuery, expectResults: true }]) {
    const processingSamples = []
    const paintSamples = []
    let visibleOptions = 0
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await search.fill('')
      const measurement = await search.evaluate((input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        if (!setter) throw new Error('Could not access the native input value setter.')
        const started = performance.now()
        setter.call(input, value)
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
        const processingMilliseconds = performance.now() - started
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve({
            processingMilliseconds,
            inputToPaintMilliseconds: performance.now() - started,
            inputValue: input.value,
            optionCount: document.querySelectorAll('[role="dialog"] [role="option"]').length,
          })
        })))
      }, query.value)

      if (measurement.inputValue !== query.value) throw new Error(`Input did not update for query ${query.value}.`)
      if (query.expectResults && measurement.optionCount === 0) throw new Error(`Expected results for query ${query.value}.`)
      if (!query.expectResults && measurement.optionCount !== 0) throw new Error(`Expected no results for query ${query.value}.`)
      processingSamples.push(measurement.processingMilliseconds)
      paintSamples.push(measurement.inputToPaintMilliseconds)
      visibleOptions = measurement.optionCount
    }

    queryResults.push({
      query: query.label,
      value: query.value,
      visibleOptions,
      firstSampleJsMs: round(processingSamples[0]),
      firstSampleInputToPaintMs: round(paintSamples[0]),
      warmJsP50Ms: round(percentile(processingSamples.slice(1), 0.50)),
      warmJsP95Ms: round(percentile(processingSamples.slice(1), 0.95)),
      inputToPaintP50Ms: round(percentile(paintSamples, 0.50)),
      inputToPaintP95Ms: round(percentile(paintSamples, 0.95)),
    })
  }

  await search.fill('')
  await palette.getByRole('button', { name: /Recently read pages/ }).click()
  const recentVisibleOptions = await palette.getByRole('option').count()
  const expectedRecentVisibleOptions = Math.min(8, dataset.recentReadCountPerSite)
  if (recentVisibleOptions !== expectedRecentVisibleOptions) {
    throw new Error(`Expected ${expectedRecentVisibleOptions} visible recent results, received ${recentVisibleOptions}.`)
  }
  await palette.getByRole('button', { name: /All pages/ }).click()

  if (metadataRequests.length !== dataset.siteCount) {
    throw new Error(`Expected ${dataset.siteCount} discovery metadata requests, received ${metadataRequests.length}.`)
  }
  if (
    artifactIndexRequests.length !== dataset.expectedArtifactIndexRequests ||
    !artifactIndexRequests.includes(`/_indexes/${dataset.currentSiteId}/index.json`)
  ) {
    throw new Error(`Expected ${dataset.expectedArtifactIndexRequests} detailed index request(s), received: ${artifactIndexRequests.join(', ') || '(none)'}.`)
  }

  const loadMetrics = await page.evaluate(() => {
    const metrics = window.__paletteBenchMetrics
    const jsonLoads = metrics.jsonLoads
    const detailed = jsonLoads.filter(({ pathname }) => (
      pathname.startsWith('/_indexes/') && !pathname.endsWith('/meta.json')
    ))
    const metadata = jsonLoads.filter(({ pathname }) => pathname.endsWith('/meta.json'))
    const detailBodyReadDurations = detailed.map(({ bodyReadMs }) => bodyReadMs)
    const resourceTiming = performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/_indexes/'))
    const fetchHeaderDurations = metrics.fetches
      .filter(({ pathname }) => pathname.endsWith('.json'))
      .map(({ elapsedMs }) => elapsedMs)
      .sort((left, right) => left - right)
    const percentile = (values, fraction) => values.length
      ? values[Math.min(values.length - 1, Math.ceil(fraction * values.length) - 1)]
      : 0
    return {
      jsonRequestCount: jsonLoads.length,
      metadataJsonBytes: metadata.reduce((total, metric) => total + metric.bytes, 0),
      detailJsonBytes: detailed.reduce((total, metric) => total + metric.bytes, 0),
      totalJsonBytes: jsonLoads.reduce((total, metric) => total + metric.bytes, 0),
      metadataParseMs: metadata.reduce((total, metric) => total + metric.parseMs, 0),
      detailParseMs: detailed.reduce((total, metric) => total + metric.parseMs, 0),
      totalParseMs: jsonLoads.reduce((total, metric) => total + metric.parseMs, 0),
      totalBodyReadMs: jsonLoads.reduce((total, metric) => total + metric.bodyReadMs, 0),
      maxDetailBodyReadMs: detailBodyReadDurations.reduce((maximum, value) => Math.max(maximum, value), 0),
      fetchHeadersP50Ms: percentile(fetchHeaderDurations, 0.5),
      fetchHeadersP95Ms: percentile(fetchHeaderDurations, 0.95),
      indexResourceCount: resourceTiming.length,
      resourceTransferMs: resourceTiming.reduce((total, resource) => total + Math.max(0, resource.responseEnd - resource.responseStart), 0),
      resourceTransferBytes: resourceTiming.reduce((total, resource) => total + resource.transferSize, 0),
      resourceResponseBytes: resourceTiming.reduce((total, resource) => total + resource.decodedBodySize, 0),
    }
  })
  const heapAfterSearchBytes = await readJsHeapBytes(cdp)
  const siteIndexRequestsAfterLookup = [...artifactIndexRequests]
  await page.keyboard.press('Escape')
  const browseVirtualization = await verifyBrowseVirtualization(page, dataset.artifactsPerSite)
  const indexedSearchExperiment = await benchmarkSearchIndexCandidates(page, cdp, dataset.searchRecords, iterations)
  const contextScoringExperiment = await benchmarkContextScoringIndexesExpanded(
    page,
    cdp,
    dataset.searchRecords,
    dataset.searchRecords.find(({ path: artifactPath }) => artifactPath.endsWith('.md')) ?? dataset.searchRecords[0],
    dataset.recentReadsBySite[dataset.currentSiteId] ?? [],
    iterations,
  )

  await page.keyboard.press('Control+k')
  const writePalette = page.getByRole('dialog', { name: 'Command palette' })
  const writeSearch = writePalette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  const targetArtifact = dataset.searchRecords.find(({ path }) => path.endsWith('.md'))
    ?? dataset.searchRecords[0]
  await writeSearch.fill(targetArtifact.path)
  const targetOption = writePalette.getByRole('option').filter({ hasText: targetArtifact.path }).first()
  await targetOption.waitFor({ state: 'visible' })
  const recentHistoryWrite = page.evaluate(() => new Promise((resolve) => {
    window.addEventListener('palette-bench:recent-history-write', (event) => {
      resolve(event.detail)
    }, { once: true })
  }))
  await targetOption.click()
  const storageWrite = await recentHistoryWrite
  const recentHistoryAfterWrite = await page.evaluate(({ artifactId, siteId }) => {
    const key = 'git-artifact-pages:recent-artifacts:v1'
    const rawStore = window.localStorage.getItem(key)
    const store = JSON.parse(rawStore ?? '{}')
    const reads = store[siteId] ?? []
    const artifactPath = artifactId.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    return {
      recentReadCount: reads.length,
      openedArtifactIsMostRecent: reads[0]?.artifactId === artifactId,
      routeMatchesOpenedArtifact: window.location.pathname === `/${encodeURIComponent(siteId)}/${artifactPath}`,
      storedSiteIds: Object.keys(store),
      rawLength: rawStore?.length ?? 0,
      rawPrefix: rawStore?.slice(0, 120) ?? '',
    }
  }, { artifactId: targetArtifact.path, siteId: dataset.currentSiteId })
  const expectedStoredReadCount = Math.max(1, dataset.recentReadCountPerSite)
  if (
    !storageWrite.immediateReadBackMatches ||
    !recentHistoryAfterWrite.openedArtifactIsMostRecent ||
    !recentHistoryAfterWrite.routeMatchesOpenedArtifact ||
    recentHistoryAfterWrite.recentReadCount !== expectedStoredReadCount
  ) {
    throw new Error(`Opening ${targetArtifact.path} did not navigate and move it to the top of recent reads: ${JSON.stringify({
      recentHistoryAfterWrite,
      storageWrite,
      expectedStoredReadCount,
      currentPath: await page.evaluate(() => window.location.pathname),
    })}.`)
  }

  const artifactPaletteOpenStarted = performance.now()
  await page.keyboard.press('Control+k')
  const artifactPalette = page.getByRole('dialog', { name: 'Command palette' })
  await artifactPalette.waitFor({ state: 'visible' })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const artifactPaletteOpenMs = performance.now() - artifactPaletteOpenStarted
  const artifactContextSearch = artifactPalette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  const artifactContextTyping = await benchmarkTyping(artifactContextSearch, 1, 'atlas')

  await cdp.detach()
  await page.close()
  if (pageError) throw new Error(`Browser error in ${dataset.siteCount} sites × ${dataset.artifactsPerSite} artifacts: ${pageError}`)
  return {
    layout: dataset.chunkSize ? 'eager-chunks' : 'monolithic',
    chunkSize: dataset.chunkSize ?? null,
    sites: dataset.siteCount,
    artifactsPerSite: dataset.artifactsPerSite,
    totalArtifacts: dataset.siteCount * dataset.artifactsPerSite,
    recentReadsPerSite: dataset.recentReadCountPerSite,
    recentReadsTotal: dataset.recentReadCountTotal,
    recentHistoryStorageBytes: dataset.recentHistoryStorageBytes,
    recentVisibleOptions,
    recentHistoryUpdate: {
      openedArtifactId: targetArtifact.path,
      clickToPersistMs: storageWrite.clickToPersistMs === null ? null : roundHundredths(storageWrite.clickToPersistMs),
      storageWriteMs: roundHundredths(storageWrite.elapsedMs),
      storageBytesAfterWrite: storageWrite.utf8Bytes,
      storedReadCount: recentHistoryAfterWrite.recentReadCount,
      openedArtifactIsMostRecent: recentHistoryAfterWrite.openedArtifactIsMostRecent,
    },
    paletteOpenMs: round(paletteOpenMs),
    artifactPaletteOpenMs: round(artifactPaletteOpenMs),
    artifactContextFirstCharacterJsMs: artifactContextTyping.firstCharacterJsMs,
    artifactContextFirstCharacterInputToPaintMs: artifactContextTyping.firstCharacterInputToPaintMs,
    generatedIndexBytesAcrossAllSites: dataset.totalIndexBytes,
    currentSiteIndexBytes: dataset.currentIndexBytes,
    discoveryMetadataBytes: dataset.metadataBytes,
    generatedMs: round(dataset.generationMs),
    pageReadyMs: round(pageReadyMs),
    discoveryCompleteMs: round(discoveryCompleteMs),
    discoveryMetadataRequests: metadataRequests.length,
    artifactIndexRequests: artifactIndexRequests.length,
    siteHomeMetrics,
    browseVirtualization,
    pageMetrics,
    indexedSearchExperiment,
    contextScoringExperiment,
    siteIndexRequestsAfterLookup,
    loadMetrics: {
      ...loadMetrics,
      metadataParseMs: round(loadMetrics.metadataParseMs),
      detailParseMs: round(loadMetrics.detailParseMs),
      totalParseMs: round(loadMetrics.totalParseMs),
      totalBodyReadMs: round(loadMetrics.totalBodyReadMs),
      maxDetailBodyReadMs: round(loadMetrics.maxDetailBodyReadMs),
      fetchHeadersP50Ms: round(loadMetrics.fetchHeadersP50Ms),
      fetchHeadersP95Ms: round(loadMetrics.fetchHeadersP95Ms),
      heap: {
        initialBytes: initialHeapBytes,
        afterSiteLoadBytes: heapAfterSiteLoadBytes,
        afterSearchBytes: heapAfterSearchBytes,
        siteLoadDeltaBytes: initialHeapBytes === null || heapAfterSiteLoadBytes === null
          ? null
          : heapAfterSiteLoadBytes - initialHeapBytes,
        searchDeltaBytes: heapAfterSiteLoadBytes === null || heapAfterSearchBytes === null
          ? null
          : heapAfterSearchBytes - heapAfterSiteLoadBytes,
      },
      resourceTransferMs: round(loadMetrics.resourceTransferMs),
    },
    typingResults,
    queryResults,
    fixture: dataset.outputPath,
  }
}

async function readJsHeapBytes(cdp) {
  await cdp.send('HeapProfiler.collectGarbage')
  const { metrics } = await cdp.send('Performance.getMetrics')
  const value = metrics.find(({ name }) => name === 'JSHeapUsedSize')?.value
  return value === undefined ? null : Math.round(value)
}

async function readBackingStorageBytes(cdp) {
  await cdp.send('HeapProfiler.collectGarbage')
  const { backingStorageSize } = await cdp.send('Runtime.getHeapUsage')
  return Math.round(backingStorageSize)
}

async function readPerformanceMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics')
  const selectedMetrics = new Set(['Nodes', 'ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration', 'TaskDuration'])
  return Object.fromEntries(metrics
    .filter(({ name }) => selectedMetrics.has(name))
    .map(({ name, value }) => [name, round(value)]))
}

async function verifyBrowseVirtualization(page, expectedItemCount) {
  const result = await page.evaluate(async () => {
    const list = document.querySelector('.site-home .is-virtualized-path-list')
    const scrollContainer = list?.closest('.site-home')
    if (!(list instanceof HTMLElement) || !(scrollContainer instanceof HTMLElement)) {
      return { enabled: false, initialRows: document.querySelectorAll('.site-home .tree-artifact').length }
    }

    const total = Number(list.querySelector('[aria-setsize]')?.getAttribute('aria-setsize'))
    const originalScrollTop = scrollContainer.scrollTop
    const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const initialRows = list.querySelectorAll('[role="listitem"]').length
    scrollContainer.scrollTop = scrollContainer.scrollHeight
    await nextPaint()
    const lastPosition = Number(list.querySelector('[role="listitem"]:last-child')?.getAttribute('aria-posinset'))
    scrollContainer.scrollTop = originalScrollTop
    await nextPaint()
    return { enabled: true, total, initialRows, lastPosition }
  })

  if (expectedItemCount > 100 && (!result.enabled || result.total !== expectedItemCount || result.lastPosition !== expectedItemCount)) {
    throw new Error(`Virtualized Browse did not reveal the final row: ${JSON.stringify(result)}.`)
  }
  return result
}

async function benchmarkSearchIndexCandidates(page, cdp, records, iterations) {
  const heapBeforeBytes = await readJsHeapBytes(cdp)
  const built = await page.evaluate((searchRecords) => {
    const started = performance.now()
    const normalize = (value) => value.split(/[\s/-]+/u).filter(Boolean).map((word) => word.toLocaleLowerCase()).join('\0')
    const prepared = searchRecords.map(({ title, path }, id) => ({
      id,
      title: normalize(title),
      path: normalize(path),
    }))
    const characters = new Map()
    const terms = new Map()

    for (const artifact of prepared) {
      const fields = { title: artifact.title.split('\0'), path: artifact.path.split('\0') }
      const allCharacters = new Set()
      for (const [fieldName, words] of Object.entries(fields)) {
        for (const word of new Set(words)) {
          if (!word) continue
          let entry = terms.get(word)
          if (!entry) {
            entry = { title: [], path: [] }
            terms.set(word, entry)
          }
          entry[fieldName].push(artifact.id)
          for (const character of Array.from(word)) allCharacters.add(character)
        }
      }
      for (const character of allCharacters) {
        let posting = characters.get(character)
        if (!posting) {
          posting = []
          characters.set(character, posting)
        }
        posting.push(artifact.id)
      }
    }

    const dictionary = [...terms.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    const characterPayloadBytes = new TextEncoder().encode(JSON.stringify([...characters])).byteLength
    const sortedTermPayloadBytes = new TextEncoder().encode(JSON.stringify(dictionary)).byteLength
    const buildMs = performance.now() - started
    window.__paletteSearchIndexTrial = { prepared, characters, dictionary }
    return {
      buildMs: Number(buildMs.toFixed(2)),
      recordCount: prepared.length,
      uniqueCharacters: characters.size,
      uniqueTerms: dictionary.length,
      characterPayloadBytes,
      sortedTermPayloadBytes,
    }
  }, records)
  const heapAfterBytes = await readJsHeapBytes(cdp)
  const queryRuns = await page.evaluate(({ iterations: repeatCount, sequences }) => {
    const { prepared, characters, dictionary } = window.__paletteSearchIndexTrial
    const compareTop = (left, right) => left.length === right.length && left.every((id, index) => id === right[index])
    const parseTerms = (query) => query.toLocaleLowerCase().trim().split(/[\s/-]+/u).filter(Boolean)
    const lowerBound = (word) => {
      let low = 0
      let high = dictionary.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (dictionary[middle][0] < word) low = middle + 1
        else high = middle
      }
      return low
    }
    const candidatesForPrefix = (query) => {
      const queryTerms = parseTerms(query)
      const fieldCandidates = []
      for (const fieldName of ['title', 'path']) {
        let intersection
        for (const queryTerm of queryTerms) {
          const union = new Set()
          for (let index = lowerBound(queryTerm); index < dictionary.length; index += 1) {
            const [word, postings] = dictionary[index]
            if (!word.startsWith(queryTerm)) break
            for (const id of postings[fieldName]) union.add(id)
          }
          intersection = intersection === undefined
            ? union
            : new Set([...intersection].filter((id) => union.has(id)))
          if (intersection.size === 0) break
        }
        if (intersection) fieldCandidates.push(intersection)
      }
      return [...new Set(fieldCandidates.flatMap((set) => [...set]))].sort((left, right) => left - right)
    }
    const candidatesForCharacters = (query) => {
      const uniqueCharacters = [...new Set(Array.from(parseTerms(query).join('')))]
      if (uniqueCharacters.length === 0) return []
      const postings = uniqueCharacters.map((character) => characters.get(character) ?? [])
      postings.sort((left, right) => left.length - right.length)
      if (postings[0].length === 0) return []
      const remaining = postings.slice(1).map((posting) => new Set(posting))
      return postings[0].filter((id) => remaining.every((posting) => posting.has(id)))
    }
    const scoreText = (text, queryTerms) => {
      if (queryTerms.length === 0) return undefined
      let total = 0
      for (const term of queryTerms) {
        const termCharacters = Array.from(term)
        let best = Number.NEGATIVE_INFINITY
        let start = 0
        while (start < text.length) {
          const separator = text.indexOf('\0', start)
          const end = separator < 0 ? text.length : separator
          const first = text.indexOf(termCharacters[0], start)
          if (first >= 0 && first < end) {
            let previous = first
            let pairs = 0
            let matched = true
            for (let character = 1; character < termCharacters.length; character += 1) {
              const previousCharacterLength = termCharacters[character - 1].length
              const next = text.indexOf(termCharacters[character], previous + previousCharacterLength)
              if (next < 0 || next >= end) {
                matched = false
                break
              }
              if (next === previous + previousCharacterLength) pairs += 1
              previous = next
            }
            if (matched) {
              const length = end - start
              const startsWithTerm = term.length <= length && text.startsWith(term, start)
              const base = startsWithTerm ? (length === term.length ? 100 : 80) : 50
              const hasAstralCharacter = /[\u{10000}-\u{10FFFF}]/u.test(text.slice(start, end))
              const lastPosition = hasAstralCharacter
                ? Array.from(text.slice(start, previous)).length
                : previous - start
              best = Math.max(best, base + pairs * 3 - lastPosition * 0.15)
            }
          }
          start = end + 1
        }
        if (best === Number.NEGATIVE_INFINITY) return undefined
        total += best
      }
      return total
    }
    const searchCandidates = (ids, query) => {
      const queryTerms = parseTerms(query)
      const matches = []
      const matchingIds = []
      for (const id of ids) {
        const artifact = prepared[id]
        const titleScore = scoreText(artifact.title, queryTerms)
        const pathScore = scoreText(artifact.path, queryTerms)
        if (titleScore === undefined && pathScore === undefined) continue
        matchingIds.push(id)
        const score = (titleScore ?? 0) * 1.12 + (pathScore ?? 0)
        let position = 0
        while (position < matches.length && matches[position].score >= score) position += 1
        if (position < 8) {
          matches.splice(position, 0, { id, score })
          if (matches.length > 8) matches.pop()
        }
      }
      return { topIds: matches.map(({ id }) => id), matchingIds }
    }
    const scanSequence = (sequence) => {
      const samples = []
      const finalQuery = sequence
      let cache
      for (let characterIndex = 0; characterIndex < sequence.length; characterIndex += 1) {
        const query = sequence.slice(0, characterIndex + 1)
        const ids = cache ?? prepared.map(({ id }) => id)
        const started = performance.now()
        const result = searchCandidates(ids, query)
        const elapsedMs = performance.now() - started
        cache = result.matchingIds
        samples.push({ characterIndex, elapsedMs, candidateCount: ids.length, topIds: result.topIds })
      }
      return { samples, topIds: searchCandidates(prepared.map(({ id }) => id), finalQuery).topIds }
    }
    const indexedSequence = (sequence, strategy) => {
      const samples = []
      for (let characterIndex = 0; characterIndex < sequence.length; characterIndex += 1) {
        const query = sequence.slice(0, characterIndex + 1)
        const started = performance.now()
        const candidates = strategy === 'character-postings'
          ? candidatesForCharacters(query)
          : candidatesForPrefix(query)
        const topIds = searchCandidates(candidates, query).topIds
        samples.push({ characterIndex, elapsedMs: performance.now() - started, candidateCount: candidates.length, topIds })
      }
      return { samples }
    }
    const percentile = (values, fraction) => {
      const sorted = [...values].sort((left, right) => left - right)
      return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0
    }
    const summaries = []
    for (const sequence of sequences) {
      const strategySamples = { 'cached-full-scan': [], 'character-postings': [], 'sorted-prefix-dictionary': [] }
      const finalRun = {}
      for (let iteration = 0; iteration < repeatCount; iteration += 1) {
        const scan = scanSequence(sequence)
        const character = indexedSequence(sequence, 'character-postings')
        const prefix = indexedSequence(sequence, 'sorted-prefix-dictionary')
        finalRun.scan = scan
        finalRun.character = character
        finalRun.prefix = prefix
        for (const [key, result] of Object.entries({
          'cached-full-scan': scan,
          'character-postings': character,
          'sorted-prefix-dictionary': prefix,
        })) {
          result.samples.forEach((sample) => strategySamples[key].push(sample))
        }
      }
      const referenceIds = new Set(finalRun.scan.topIds)
      summaries.push({
        sequence,
        strategies: Object.fromEntries(Object.entries(strategySamples).map(([name, samples]) => {
          const finalSamples = samples.filter(({ characterIndex }) => characterIndex === sequence.length - 1)
          const latest = name === 'cached-full-scan' ? finalRun.scan : name === 'character-postings' ? finalRun.character : finalRun.prefix
          const candidateFinal = latest.samples.at(-1)?.topIds ?? []
          return [name, {
            finalCandidateCount: latest.samples.at(-1)?.candidateCount ?? 0,
            finalTop8Recall: candidateFinal.filter((id) => referenceIds.has(id)).length,
            referenceTop8Count: referenceIds.size,
            finalTop8Identical: compareTop(finalRun.scan.topIds, candidateFinal),
            jsP50MsPerCharacter: Number(percentile(samples.map(({ elapsedMs }) => elapsedMs), 0.5).toFixed(2)),
            jsP95MsPerCharacter: Number(percentile(samples.map(({ elapsedMs }) => elapsedMs), 0.95).toFixed(2)),
            finalCharacterJsP50Ms: Number(percentile(finalSamples.map(({ elapsedMs }) => elapsedMs), 0.5).toFixed(2)),
            candidateCountsByCharacter: latest.samples.map(({ candidateCount }) => candidateCount),
          }]
        })),
      })
    }
    return summaries
  }, { iterations, sequences: sequentialQueries })
  for (const query of queryRuns) {
    if (!query.strategies['character-postings'].finalTop8Identical) {
      throw new Error(`Character-posting candidate filter changed fuzzy results for ${query.sequence}.`)
    }
  }
  const experimentHeapBytes = await readJsHeapBytes(cdp)
  await page.evaluate(() => { delete window.__paletteSearchIndexTrial })
  await readJsHeapBytes(cdp)

  return {
    scope: 'benchmark-only; current product search remains unchanged',
    indexing: built,
    additionalRetainedHeapBytes: heapAfterBytes === null || heapBeforeBytes === null ? null : heapAfterBytes - heapBeforeBytes,
    retainedHeapAfterBuildBytes: experimentHeapBytes,
    queries: queryRuns,
  }
}

async function benchmarkContextScoringIndexesExpanded(page, cdp, records, currentArtifact, recentReads, iterations) {
  const nowMs = Date.now()
  const pinnedArtifactIds = records.slice(20, 40).map(({ id }) => id)
  await page.evaluate((payload) => {
    const records = payload.records.map((record) => ({
      ...record,
      // Freshness dates are changed only in this benchmark copy, never in the served fixture.
      updatedAt: new Date(payload.nowMs - 30 * 86_400_000).toISOString(),
    }))
    const freshIndex = Math.min(records.length - 1, Math.max(payload.recentReads.length + payload.pinnedArtifactIds.length + 1, 50))
    const weekIndex = Math.min(records.length - 1, freshIndex + 16)
    records[freshIndex] = { ...records[freshIndex], updatedAt: new Date(payload.nowMs - 6 * 3_600_000).toISOString() }
    if (weekIndex !== freshIndex) {
      records[weekIndex] = { ...records[weekIndex], updatedAt: new Date(payload.nowMs - 3 * 86_400_000).toISOString() }
    }
    const currentIndex = records.findIndex(({ path }) => path === payload.currentPath)
    if (currentIndex < 0) throw new Error('Could not find context artifact ' + payload.currentPath + '.')
    window.__contextScoringTrial = {
      records,
      currentIndex,
      recentReads: payload.recentReads,
      pinnedArtifactIds: payload.pinnedArtifactIds,
      freshnessTargets: [
        { artifactId: records[freshIndex].id, boost: 2 },
        ...(weekIndex === freshIndex ? [] : [{ artifactId: records[weekIndex].id, boost: 1 }]),
      ],
      nowMs: payload.nowMs,
    }
  }, { records, currentPath: currentArtifact.path, recentReads, pinnedArtifactIds, nowMs })
  const heapBeforeIndexBytes = await readJsHeapBytes(cdp)
  const backingBeforeIndexBytes = await readBackingStorageBytes(cdp)

  const profileIndex = await page.evaluate(async () => {
    const trial = window.__contextScoringTrial
    const ignored = new Set([
      'the', 'and', 'for', 'with', 'from', 'into', 'index', 'html', 'md',
      'incidents', 'architecture', 'reports', 'guides', 'runbooks', 'diagrams', 'docs',
    ])
    const wordDictionary = new Map()
    const folderDictionary = new Map()
    const intern = (dictionary, value) => {
      if (!dictionary.has(value)) dictionary.set(value, dictionary.size)
      return dictionary.get(value)
    }
    const words = (value) => [...new Set(value.toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4 && !ignored.has(word)))]
    const started = performance.now()
    const profiles = trial.records.map((artifact) => ({
      wordIds: [...new Set([...words(artifact.title), ...words(artifact.path)])]
        .map((word) => intern(wordDictionary, word)),
      folderIds: artifact.path.split('/').filter(Boolean).slice(0, -1)
        .map((folder) => intern(folderDictionary, folder)),
    }))
    const buildMs = performance.now() - started
    const profileJson = JSON.stringify(profiles.map(({ wordIds, folderIds }) => [wordIds, folderIds]))
    const gzip = await new Response(new Blob([profileJson]).stream()
      .pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
    trial.profiles = profiles
    trial.wordVocabularySize = wordDictionary.size
    trial.folderVocabularySize = folderDictionary.size
    return {
      buildMs: Number(buildMs.toFixed(2)),
      recordCount: profiles.length,
      wordVocabularySize: wordDictionary.size,
      folderVocabularySize: folderDictionary.size,
      currentWordCount: profiles[trial.currentIndex].wordIds.length,
      currentFolderCount: profiles[trial.currentIndex].folderIds.length,
      profileJsonBytes: new TextEncoder().encode(profileJson).byteLength,
      profileGzipBytes: gzip.byteLength,
    }
  })
  const heapAfterProfileBytes = await readJsHeapBytes(cdp)
  const backingAfterProfileBytes = await readBackingStorageBytes(cdp)

  const postingIndex = await page.evaluate(async () => {
    const trial = window.__contextScoringTrial
    const started = performance.now()
    const wordPostings = new Map()
    const pathPrefixPostings = [new Map(), new Map(), new Map()]
    const append = (map, key, id) => {
      let ids = map.get(key)
      if (!ids) {
        ids = []
        map.set(key, ids)
      }
      ids.push(id)
    }
    trial.profiles.forEach((profile, id) => {
      profile.wordIds.forEach((wordId) => append(wordPostings, wordId, id))
      for (let level = 1; level <= Math.min(3, profile.folderIds.length); level += 1) {
        append(pathPrefixPostings[level - 1], JSON.stringify(profile.folderIds.slice(0, level)), id)
      }
    })
    const buildMs = performance.now() - started
    const profilePayload = JSON.stringify(trial.profiles.map(({ wordIds, folderIds }) => [wordIds, folderIds]))
    const payload = JSON.stringify({
      profiles: trial.profiles.map(({ wordIds, folderIds }) => [wordIds, folderIds]),
      wordPostings: [...wordPostings],
      pathPrefixPostings: pathPrefixPostings.map((map) => [...map]),
    })
    const [profileGzip, invertedGzip] = await Promise.all([
      new Response(new Blob([profilePayload]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
      new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
    ])
    trial.wordPostings = wordPostings
    trial.pathPrefixPostings = pathPrefixPostings
    return {
      buildMs: Number(buildMs.toFixed(2)),
      indexedWordReferences: [...wordPostings.values()].reduce((sum, ids) => sum + ids.length, 0),
      indexedPathPrefixes: pathPrefixPostings.reduce((sum, map) => sum
        + [...map.values()].reduce((subtotal, ids) => subtotal + ids.length, 0), 0),
      profileJsonBytes: new TextEncoder().encode(profilePayload).byteLength,
      profileGzipBytes: profileGzip.byteLength,
      invertedJsonBytes: new TextEncoder().encode(payload).byteLength,
      invertedGzipBytes: invertedGzip.byteLength,
      invertedAdditionalJsonBytes: new TextEncoder().encode(payload).byteLength
        - new TextEncoder().encode(profilePayload).byteLength,
      invertedAdditionalGzipBytes: invertedGzip.byteLength - profileGzip.byteLength,
    }
  })
  const heapAfterPostingBytes = await readJsHeapBytes(cdp)
  const backingAfterPostingBytes = await readBackingStorageBytes(cdp)

  const queryResults = await page.evaluate(async (repeatCount) => {
    const trial = window.__contextScoringTrial
    const { records, profiles, currentIndex, wordPostings, pathPrefixPostings } = trial
    const current = records[currentIndex]
    const currentProfile = profiles[currentIndex]
    const ignored = new Set([
      'the', 'and', 'for', 'with', 'from', 'into', 'index', 'html', 'md',
      'incidents', 'architecture', 'reports', 'guides', 'runbooks', 'diagrams', 'docs',
    ])
    const words = (value) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4 && !ignored.has(word))
    const recentReadById = new Map(trial.recentReads.map(({ artifactId, viewedAt }) => [artifactId, viewedAt]))
    const pinnedIds = new Set(trial.pinnedArtifactIds)
    const normalizedRecords = records.map(({ title, path }) => ({
      title: normalizeText(title),
      path: normalizeText(path),
    }))
    const queries = ['', 'a', 'atlas', 'pltfrm', 'zzzz']
    const contextStarted = performance.now()
    const indexedContextScores = new Uint8Array(records.length)
    const wordScores = new Uint8Array(records.length)
    for (const wordId of currentProfile.wordIds) {
      for (const id of wordPostings.get(wordId) ?? []) wordScores[id] = Math.min(6, wordScores[id] + 2)
    }
    const increments = [6, 2, 2]
    for (let level = 1; level <= Math.min(3, currentProfile.folderIds.length); level += 1) {
      const key = JSON.stringify(currentProfile.folderIds.slice(0, level))
      for (const id of pathPrefixPostings[level - 1].get(key) ?? []) indexedContextScores[id] += increments[level - 1]
    }
    for (let id = 0; id < records.length; id += 1) indexedContextScores[id] += wordScores[id]
    const currentContextBuildMs = performance.now() - contextStarted

    const dynamicSignal = (id, selected = 'all') => {
      const artifact = records[id]
      let score = 0
      if (selected === 'all' || selected === 'recency') {
        const viewedAt = recentReadById.get(artifact.id)
        if (viewedAt !== undefined) {
          const ageHours = Math.max(0, (trial.nowMs - viewedAt) / 3_600_000)
          score += 24 * Math.pow(0.5, ageHours / 24)
        }
      }
      if ((selected === 'all' || selected === 'pin') && pinnedIds.has(artifact.id)) score += 5
      if (selected === 'all' || selected === 'freshness') {
        const timestamp = Date.parse(artifact.updatedAt)
        if (Number.isFinite(timestamp)) {
          const ageDays = Math.max(0, (trial.nowMs - timestamp) / 86_400_000)
          if (ageDays <= 1) score += 2
          else if (ageDays <= 7) score += 1
        }
      }
      return score
    }
    const signalVector = new Float64Array(records.length)
    const freshnessVector = new Uint8Array(records.length)
    const signalBuildStarted = performance.now()
    for (let id = 0; id < records.length; id += 1) {
      const artifact = records[id]
      const viewedAt = recentReadById.get(artifact.id)
      const ageHours = viewedAt === undefined ? Infinity : Math.max(0, (trial.nowMs - viewedAt) / 3_600_000)
      const recency = viewedAt === undefined ? 0 : 24 * Math.pow(0.5, ageHours / 24)
      const pin = pinnedIds.has(artifact.id) ? 5 : 0
      const timestamp = Date.parse(artifact.updatedAt)
      const ageDays = Number.isFinite(timestamp) ? Math.max(0, (trial.nowMs - timestamp) / 86_400_000) : Infinity
      const freshness = ageDays <= 1 ? 2 : ageDays <= 7 ? 1 : 0
      freshnessVector[id] = freshness
      signalVector[id] = recency + pin + freshness
    }
    const signalVectorBuildMs = performance.now() - signalBuildStarted

    const rawContextScore = (id) => {
      const artifact = records[id]
      const pathFolders = artifact.path.split('/').filter(Boolean).slice(0, -1)
      const currentFolders = current.path.split('/').filter(Boolean).slice(0, -1)
      let sharedFolders = 0
      while (sharedFolders < pathFolders.length && sharedFolders < currentFolders.length
        && pathFolders[sharedFolders] === currentFolders[sharedFolders]) sharedFolders += 1
      const pathScore = sharedFolders === 0 ? 0 : Math.min(10, 4 + sharedFolders * 2)
      const currentWords = new Set([...words(current.title), ...words(current.path)])
      const candidateWords = new Set([...words(artifact.title), ...words(artifact.path)])
      const sharedCount = [...candidateWords].filter((word) => currentWords.has(word)).length
      return pathScore + Math.min(6, sharedCount * 2)
    }
    const currentFolderIds = currentProfile.folderIds
    const currentWordIds = new Set(currentProfile.wordIds)
    const profileContextScore = (id) => {
      const profile = profiles[id]
      let sharedFolders = 0
      while (sharedFolders < profile.folderIds.length && sharedFolders < currentFolderIds.length
        && profile.folderIds[sharedFolders] === currentFolderIds[sharedFolders]) sharedFolders += 1
      let sharedCount = 0
      profile.wordIds.forEach((wordId) => { if (currentWordIds.has(wordId)) sharedCount += 1 })
      return (sharedFolders === 0 ? 0 : Math.min(10, 4 + sharedFolders * 2)) + Math.min(6, sharedCount * 2)
    }

    const csrBuildStarted = performance.now()
    const wordOffsets = new Uint32Array(records.length + 1)
    const folderOffsets = new Uint32Array(records.length + 1)
    const wordRefCount = profiles.reduce((sum, profile) => sum + profile.wordIds.length, 0)
    const folderRefCount = profiles.reduce((sum, profile) => sum + profile.folderIds.length, 0)
    const WordIdArray = trial.wordVocabularySize <= 65_536 ? Uint16Array : Uint32Array
    const FolderIdArray = trial.folderVocabularySize <= 65_536 ? Uint16Array : Uint32Array
    const packedWordIds = new WordIdArray(wordRefCount)
    const packedFolderIds = new FolderIdArray(folderRefCount)
    let wordOffset = 0
    let folderOffset = 0
    profiles.forEach((profile, id) => {
      wordOffsets[id] = wordOffset
      folderOffsets[id] = folderOffset
      packedWordIds.set(profile.wordIds, wordOffset)
      packedFolderIds.set(profile.folderIds, folderOffset)
      wordOffset += profile.wordIds.length
      folderOffset += profile.folderIds.length
    })
    wordOffsets[records.length] = wordOffset
    folderOffsets[records.length] = folderOffset
    const csrContextScore = (id) => {
      let sharedFolders = 0
      let candidateOffset = folderOffsets[id]
      let currentOffset = folderOffsets[currentIndex]
      while (candidateOffset < folderOffsets[id + 1] && currentOffset < folderOffsets[currentIndex + 1]
        && packedFolderIds[candidateOffset] === packedFolderIds[currentOffset]) {
        sharedFolders += 1
        candidateOffset += 1
        currentOffset += 1
      }
      let sharedCount = 0
      for (let offset = wordOffsets[id]; offset < wordOffsets[id + 1]; offset += 1) {
        if (currentWordIds.has(packedWordIds[offset])) sharedCount += 1
      }
      return (sharedFolders === 0 ? 0 : Math.min(10, 4 + sharedFolders * 2)) + Math.min(6, sharedCount * 2)
    }
    const typedArrayBytes = wordOffsets.byteLength + packedWordIds.byteLength
      + folderOffsets.byteLength + packedFolderIds.byteLength
    const csrBuildMs = performance.now() - csrBuildStarted
    const projectionStarted = performance.now()
    const csrProjection = JSON.stringify({
      wordOffsets: Array.from(wordOffsets),
      wordIds: Array.from(packedWordIds),
      folderOffsets: Array.from(folderOffsets),
      folderIds: Array.from(packedFolderIds),
    })
    const csrGzip = await new Response(new Blob([csrProjection]).stream()
      .pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
    const binaryParts = [wordOffsets, packedWordIds, folderOffsets, packedFolderIds]
    const binaryGzip = await new Response(new Blob(binaryParts).stream()
      .pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
    const projectionAndCompressionMs = performance.now() - projectionStarted
    const csr = {
      wordIdType: packedWordIds.constructor.name,
      folderIdType: packedFolderIds.constructor.name,
      wordReferenceCount: wordRefCount,
      folderReferenceCount: folderRefCount,
      typedArrayBytes,
      base64PayloadBytesApprox: Math.ceil(typedArrayBytes / 3) * 4,
      binaryGzipBytes: binaryGzip.byteLength,
      expandedJsonBytes: new TextEncoder().encode(csrProjection).byteLength,
      expandedJsonGzipBytes: csrGzip.byteLength,
      csrBuildMs: Number(csrBuildMs.toFixed(2)),
      projectionAndCompressionMs: Number(projectionAndCompressionMs.toFixed(2)),
    }

    const scoreMismatches = { profile: 0, csr: 0, inverted: 0 }
    for (let id = 0; id < records.length; id += 1) {
      const baseline = rawContextScore(id)
      if (profileContextScore(id) !== baseline) scoreMismatches.profile += 1
      if (csrContextScore(id) !== baseline) scoreMismatches.csr += 1
      if (indexedContextScores[id] !== baseline) scoreMismatches.inverted += 1
    }
    if (Object.values(scoreMismatches).some((count) => count !== 0)) {
      throw new Error('Context score mismatch: ' + JSON.stringify(scoreMismatches))
    }
    const compareTop = (left, right) => left.length === right.length && left.every((id, index) => id === right[index])
    const top = (matches, context, signal) => {
      const entries = []
      for (const { id, queryScore } of matches) {
        const score = queryScore + context(id) + signal(id)
        let position = 0
        while (position < entries.length && entries[position].score >= score) position += 1
        if (position < 8) {
          entries.splice(position, 0, { id, score })
          if (entries.length > 8) entries.pop()
        }
      }
      return entries.map(({ id }) => id)
    }
    const strategies = {
      raw: [rawContextScore, (id) => dynamicSignal(id)],
      profile: [profileContextScore, (id) => dynamicSignal(id)],
      profileWithSignalVector: [profileContextScore, (id) => signalVector[id]],
      csr: [csrContextScore, (id) => dynamicSignal(id)],
      inverted: [(id) => indexedContextScores[id], (id) => dynamicSignal(id)],
      csrWithSignalVector: [csrContextScore, (id) => signalVector[id]],
      invertedWithSignalVector: [(id) => indexedContextScores[id], (id) => signalVector[id]],
    }
    const signalImpact = []
    const queryResults = []
    for (const query of queries) {
      const matches = matchingRecords(normalizedRecords, query, normalizeText(current.path))
      const queryTimingSamples = Object.fromEntries(Object.keys(strategies).map((name) => [name, []]))
      const noSignalTop = top(matches, rawContextScore, () => 0)
      const signalResult = {}
      for (const signal of ['recency', 'pin', 'freshness', 'all']) {
        const ids = top(matches, rawContextScore, (id) => dynamicSignal(id, signal))
        signalResult[signal] = {
          changedTop8: !compareTop(noSignalTop, ids),
          boostedCandidateCount: matches.reduce((sum, { id }) => sum
            + (dynamicSignal(id, signal) > 0 ? 1 : 0), 0),
        }
      }
      signalImpact.push({ query, ...signalResult })

      const lastAll = {}
      for (let iteration = 0; iteration < repeatCount; iteration += 1) {
        for (const [name, [context, signal]] of Object.entries(strategies)) {
          const started = performance.now()
          lastAll[name] = top(matches, context, signal)
          queryTimingSamples[name].push(performance.now() - started)
        }
      }
      const queryTimingP50Ms = Object.fromEntries(Object.entries(queryTimingSamples).map(([name, samples]) => {
        const sorted = [...samples].sort((left, right) => left - right)
        return [name, Number((sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(2))]
      }))
      const baseline = lastAll.raw
      const allParity = Object.fromEntries(Object.entries(lastAll)
        .map(([name, ids]) => [name, compareTop(baseline, ids)]))
      if (Object.values(allParity).some((same) => !same)) {
        throw new Error('Full-signal all-scope top-eight mismatch for query ' + query)
      }
      const scopeParity = { all: allParity }
      const scopeCounts = { all: matches.length }
      for (const scope of ['recent', 'pinned']) {
        const scoped = matches.filter(({ id }) => scope === 'recent'
          ? recentReadById.has(records[id].id)
          : pinnedIds.has(records[id].id))
        scopeCounts[scope] = scoped.length
        const scopedTop = Object.fromEntries(Object.entries(strategies)
          .map(([name, [context, signal]]) => [name, top(scoped, context, signal)]))
        const scopedBaseline = scopedTop.raw
        scopeParity[scope] = Object.fromEntries(Object.entries(scopedTop)
          .map(([name, ids]) => [name, compareTop(scopedBaseline, ids)]))
        if (Object.values(scopeParity[scope]).some((same) => !same)) {
          throw new Error('Full-signal ' + scope + '-scope top-eight mismatch for query ' + query)
        }
      }
      queryResults.push({
        query,
        matchingCandidates: matches.length,
        fullSignalRankingP50Ms: queryTimingP50Ms,
        scopeCandidateCounts: scopeCounts,
        allScopesTop8Identical: scopeParity,
      })
    }
    const freshnessBranchCounts = { twoPoint: 0, onePoint: 0, zero: 0 }
    for (const score of freshnessVector) {
      if (score === 2) freshnessBranchCounts.twoPoint += 1
      else if (score === 1) freshnessBranchCounts.onePoint += 1
      else freshnessBranchCounts.zero += 1
    }
    const freshnessTargets = trial.freshnessTargets
    trial.packed = { wordOffsets, wordIds: packedWordIds, folderOffsets, folderIds: packedFolderIds }
    trial.indexedContextScores = indexedContextScores
    trial.signalVector = signalVector
    trial.profiles = null
    trial.wordPostings = null
    trial.pathPrefixPostings = null
    return {
      currentContextBuildMs: Number(currentContextBuildMs.toFixed(2)),
      currentContextLookupBytes: indexedContextScores.byteLength,
      contextScoreMismatches: scoreMismatches,
      csr,
      signalVectorBuildMs: Number(signalVectorBuildMs.toFixed(2)),
      signalVectorBytes: signalVector.byteLength,
      dynamicSignals: {
        recentReadCount: trial.recentReads.length,
        pinnedCount: trial.pinnedArtifactIds.length,
        freshnessTargets,
        freshnessBranchCounts,
      },
      signalImpact,
      queries: queryResults,
    }

    function normalizeText(value) {
      return value.split(/[\s/-]+/u).filter(Boolean).map((word) => word.toLocaleLowerCase()).join('\0')
    }
    function scoreText(text, queryTerms) {
      if (queryTerms.length === 0) return undefined
      let score = 0
      for (const term of queryTerms) {
        const characters = Array.from(term)
        let best = Number.NEGATIVE_INFINITY
        let start = 0
        while (start < text.length) {
          const separator = text.indexOf('\0', start)
          const end = separator < 0 ? text.length : separator
          const first = text.indexOf(characters[0], start)
          if (first >= 0 && first < end) {
            let previous = first
            let consecutivePairs = 0
            let matchesTerm = true
            for (let index = 1; index < characters.length; index += 1) {
              const position = text.indexOf(characters[index], previous + characters[index - 1].length)
              if (position < 0 || position >= end) {
                matchesTerm = false
                break
              }
              if (position === previous + characters[index - 1].length) consecutivePairs += 1
              previous = position
            }
            if (matchesTerm) {
              const wordLength = end - start
              const startsWithTerm = term.length <= wordLength && text.startsWith(term, start)
              const baseScore = startsWithTerm
                ? wordLength === term.length ? 100 : 80
                : 50
              const word = text.slice(start, end)
              const lastPosition = /[\u{10000}-\u{10FFFF}]/u.test(word)
                ? Array.from(text.slice(start, previous)).length
                : previous - start
              best = Math.max(best, baseScore + consecutivePairs * 3 - lastPosition * 0.15)
            }
          }
          start = end + 1
        }
        if (best === Number.NEGATIVE_INFINITY) return undefined
        score += best
      }
      return score
    }
    function matchingRecords(prepared, query, currentPath) {
      const terms = query.toLocaleLowerCase().trim().split(/[\s/-]+/u).filter(Boolean)
      if (terms.length === 0) {
        return prepared.flatMap((artifact, id) => artifact.path === currentPath ? [] : [{ id, queryScore: 0 }])
      }
      const matches = []
      for (const [id, artifact] of prepared.entries()) {
        const titleScore = scoreText(artifact.title, terms)
        const pathScore = scoreText(artifact.path, terms)
        if (titleScore === undefined && pathScore === undefined) continue
        matches.push({ id, queryScore: (titleScore ?? 0) * 1.12 + (pathScore ?? 0) })
      }
      return matches
    }
  }, iterations)
  const heapAfterPackedBytes = await readJsHeapBytes(cdp)
  const backingAfterPackedBytes = await readBackingStorageBytes(cdp)
  await page.evaluate(() => {
    delete window.__contextScoringTrial.indexedContextScores
    delete window.__contextScoringTrial.signalVector
  })
  const heapAfterCsrOnlyBytes = await readJsHeapBytes(cdp)
  const backingAfterCsrOnlyBytes = await readBackingStorageBytes(cdp)
  const unicodeParity = await page.evaluate(() => {
    const corpus = [
      { id: 'u1', title: '検索体験:設計', path: 'docs/検索体験/設計.md', updatedAt: '2026-09-26T06:00:00.000Z' },
      { id: 'u2', title: '検索体験:東京の地図', path: 'docs/検索体験/東京.md', updatedAt: '2026-09-23T12:00:00.000Z' },
      { id: 'u3', title: '東京の検索ガイド 𠮷野家', path: 'docs/東京/𠮷野家/検索.md', updatedAt: '2026-09-26T06:00:00.000Z' },
      { id: 'u4', title: '𠮷野家のガイド', path: 'docs/東京/𠮷野家/guide.md', updatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'u5', title: '東京 emoji 😀 の検索メモ', path: 'docs/東京/emoji-😀/search-notes.md', updatedAt: '2026-09-25T12:00:00.000Z' },
      { id: 'u6', title: '日本語の検索リファレンス', path: 'docs/reference/日本語検索.md', updatedAt: '2026-09-22T12:00:00.000Z' },
      { id: 'u7', title: 'Guide to search and navigation', path: 'docs/guides/search-navigation.md', updatedAt: '2026-09-20T12:00:00.000Z' },
      { id: 'u8', title: '😀atlas release note', path: 'docs/emoji-atlas/release.md', updatedAt: '2026-09-24T12:00:00.000Z' },
      { id: 'u9', title: 'xatlas release note', path: 'docs/legacy/xatlas.md', updatedAt: '2026-09-20T12:00:00.000Z' },
      { id: 'u10', title: 'Dot folder alpha', path: 'docs/a.b/alpha.md', updatedAt: '2026-09-20T12:00:00.000Z' },
      { id: 'u11', title: 'Dot folder beta', path: 'docs/a/b.c/beta.md', updatedAt: '2026-09-20T12:00:00.000Z' },
    ]
    const ignored = new Set([
      'the', 'and', 'for', 'with', 'from', 'into', 'index', 'html', 'md',
      'incidents', 'architecture', 'reports', 'guides', 'runbooks', 'diagrams', 'docs',
    ])
    const words = (value) => [...new Set(value.toLowerCase().split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4 && !ignored.has(word)))]
    const wordDictionary = new Map()
    const folderDictionary = new Map()
    const intern = (dictionary, value) => {
      if (!dictionary.has(value)) dictionary.set(value, dictionary.size)
      return dictionary.get(value)
    }
    const profiles = corpus.map((artifact) => ({
      wordIds: [...new Set([...words(artifact.title), ...words(artifact.path)])]
        .map((word) => intern(wordDictionary, word)),
      folderIds: artifact.path.split('/').filter(Boolean).slice(0, -1)
        .map((folder) => intern(folderDictionary, folder)),
    }))
    const wordPostings = new Map()
    const pathPostings = [new Map(), new Map(), new Map()]
    const append = (map, key, id) => {
      const ids = map.get(key) ?? []
      ids.push(id)
      map.set(key, ids)
    }
    profiles.forEach((profile, id) => {
      profile.wordIds.forEach((wordId) => append(wordPostings, wordId, id))
      for (let level = 1; level <= Math.min(3, profile.folderIds.length); level += 1) {
        append(pathPostings[level - 1], JSON.stringify(profile.folderIds.slice(0, level)), id)
      }
    })
    const wordOffsets = new Uint32Array(corpus.length + 1)
    const folderOffsets = new Uint32Array(corpus.length + 1)
    const wordIds = new Uint16Array(profiles.reduce((sum, profile) => sum + profile.wordIds.length, 0))
    const folderIds = new Uint16Array(profiles.reduce((sum, profile) => sum + profile.folderIds.length, 0))
    let wordOffset = 0
    let folderOffset = 0
    profiles.forEach((profile, id) => {
      wordOffsets[id] = wordOffset
      folderOffsets[id] = folderOffset
      wordIds.set(profile.wordIds, wordOffset)
      folderIds.set(profile.folderIds, folderOffset)
      wordOffset += profile.wordIds.length
      folderOffset += profile.folderIds.length
    })
    wordOffsets[corpus.length] = wordOffset
    folderOffsets[corpus.length] = folderOffset
    const recent = new Map([['u2', Date.parse('2026-09-26T10:00:00.000Z')], ['u5', Date.parse('2026-09-26T11:00:00.000Z')]])
    const pinned = new Set(['u3', 'u6'])
    const now = Date.parse('2026-09-26T12:00:00.000Z')
    const dynamicSignal = (artifact) => {
      const viewedAt = recent.get(artifact.id)
      const recency = viewedAt === undefined ? 0 : 24 * Math.pow(0.5, Math.max(0, now - viewedAt) / 3_600_000 / 24)
      const ageDays = Math.max(0, (now - Date.parse(artifact.updatedAt)) / 86_400_000)
      return recency + (pinned.has(artifact.id) ? 5 : 0) + (ageDays <= 1 ? 2 : ageDays <= 7 ? 1 : 0)
    }
    const equalIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index])
    const queries = ['', '検索', '東京', '𠮷', 'guide', 'atl', 'tl', 'alpha']
    let pairwiseContextScoresCompared = 0
    let unicodeQueryRankingComparisons = 0
    let queryScoresEvaluated = 0
    const fuzzyScore = (value, query) => {
      const text = value.split(/[\s/-]+/u).filter(Boolean).map((word) => word.toLocaleLowerCase()).join('\0')
      const terms = query.toLocaleLowerCase().split(/[\s/-]+/u).filter(Boolean)
        .map((normalized) => ({ normalized, characters: Array.from(normalized) }))
      if (terms.length === 0) return undefined
      let score = 0
      for (const term of terms) {
        let bestScore = Number.NEGATIVE_INFINITY
        let start = 0
        while (start < text.length) {
          const separator = text.indexOf('\0', start)
          const end = separator < 0 ? text.length : separator
          const firstPosition = text.indexOf(term.characters[0], start)
          if (firstPosition >= 0 && firstPosition < end) {
            let previousPosition = firstPosition
            let consecutivePairs = 0
            let matchesTerm = true
            for (let index = 1; index < term.characters.length; index += 1) {
              const position = text.indexOf(
                term.characters[index],
                previousPosition + term.characters[index - 1].length,
              )
              if (position < 0 || position >= end) {
                matchesTerm = false
                break
              }
              if (position === previousPosition + term.characters[index - 1].length) consecutivePairs += 1
              previousPosition = position
            }
            if (matchesTerm) {
              const wordLength = end - start
              const startsWithTerm = term.normalized.length <= wordLength
                && text.startsWith(term.normalized, start)
              const baseScore = startsWithTerm
                ? wordLength === term.normalized.length ? 100 : 80
                : 50
              const word = text.slice(start, end)
              const lastPosition = /[\u{10000}-\u{10FFFF}]/u.test(word)
                ? Array.from(text.slice(start, previousPosition)).length
                : previousPosition - start
              bestScore = Math.max(bestScore, baseScore + consecutivePairs * 3 - lastPosition * 0.15)
            }
          }
          start = end + 1
        }
        if (bestScore === Number.NEGATIVE_INFINITY) return undefined
        score += bestScore
      }
      return score
    }
    const astralQueryScore = fuzzyScore('😀atlas', 'atl')
    if (astralQueryScore !== 55.55) {
      throw new Error('Astral fuzzy score should use code-point positions; received ' + astralQueryScore)
    }
    for (let currentIndex = 0; currentIndex < corpus.length; currentIndex += 1) {
      const current = corpus[currentIndex]
      const currentProfile = profiles[currentIndex]
      const sharedCurrentWords = new Set(currentProfile.wordIds)
      const rawContext = (id) => {
        const candidate = corpus[id]
        const candidateFolders = candidate.path.split('/').filter(Boolean).slice(0, -1)
        const currentFolders = current.path.split('/').filter(Boolean).slice(0, -1)
        let sharedFolders = 0
        while (sharedFolders < candidateFolders.length && sharedFolders < currentFolders.length
          && candidateFolders[sharedFolders] === currentFolders[sharedFolders]) sharedFolders += 1
        const currentWords = new Set([...words(current.title), ...words(current.path)])
        const candidateWords = new Set([...words(candidate.title), ...words(candidate.path)])
        const sharedCount = [...candidateWords].filter((word) => currentWords.has(word)).length
        return (sharedFolders === 0 ? 0 : Math.min(10, 4 + sharedFolders * 2)) + Math.min(6, sharedCount * 2)
      }
      const profileContext = (id) => {
        let sharedFolders = 0
        while (sharedFolders < profiles[id].folderIds.length && sharedFolders < currentProfile.folderIds.length
          && profiles[id].folderIds[sharedFolders] === currentProfile.folderIds[sharedFolders]) sharedFolders += 1
        let sharedCount = 0
        profiles[id].wordIds.forEach((wordId) => { if (sharedCurrentWords.has(wordId)) sharedCount += 1 })
        return (sharedFolders === 0 ? 0 : Math.min(10, 4 + sharedFolders * 2)) + Math.min(6, sharedCount * 2)
      }
      const csrContext = (id) => {
        let sharedFolders = 0
        let candidateOffset = folderOffsets[id]
        let currentOffset = folderOffsets[currentIndex]
        while (candidateOffset < folderOffsets[id + 1] && currentOffset < folderOffsets[currentIndex + 1]
          && folderIds[candidateOffset] === folderIds[currentOffset]) {
          sharedFolders += 1
          candidateOffset += 1
          currentOffset += 1
        }
        let sharedCount = 0
        for (let offset = wordOffsets[id]; offset < wordOffsets[id + 1]; offset += 1) {
          if (sharedCurrentWords.has(wordIds[offset])) sharedCount += 1
        }
        return (sharedFolders === 0 ? 0 : Math.min(10, 4 + sharedFolders * 2)) + Math.min(6, sharedCount * 2)
      }
      const indexedScores = new Uint8Array(corpus.length)
      const sharedWordScores = new Uint8Array(corpus.length)
      currentProfile.wordIds.forEach((wordId) => {
        ;(wordPostings.get(wordId) ?? []).forEach((id) => { sharedWordScores[id] = Math.min(6, sharedWordScores[id] + 2) })
      })
      const increments = [6, 2, 2]
      for (let level = 1; level <= Math.min(3, currentProfile.folderIds.length); level += 1) {
        const key = JSON.stringify(currentProfile.folderIds.slice(0, level))
        ;(pathPostings[level - 1].get(key) ?? []).forEach((id) => { indexedScores[id] += increments[level - 1] })
      }
      indexedScores.forEach((value, id) => { indexedScores[id] = value + sharedWordScores[id] })
      const invertedContext = (id) => indexedScores[id]
      for (let id = 0; id < corpus.length; id += 1) {
        pairwiseContextScoresCompared += 1
        const baseline = rawContext(id)
        if (profileContext(id) !== baseline || csrContext(id) !== baseline || invertedContext(id) !== baseline) {
          throw new Error('Unicode score mismatch at current ' + current.id + ', candidate ' + corpus[id].id)
        }
      }
      for (const query of queries) {
        const matches = corpus.flatMap((artifact, id) => {
          if (!query && id === currentIndex) return []
          if (!query) return [{ id, queryScore: 0 }]
          const titleScore = fuzzyScore(artifact.title, query)
          const pathScore = fuzzyScore(artifact.path, query)
          queryScoresEvaluated += 2
          if (titleScore === undefined && pathScore === undefined) return []
          return [{ id, queryScore: (titleScore ?? 0) * 1.12 + (pathScore ?? 0) }]
        })
        const rank = (context) => {
          const entries = []
          matches.forEach(({ id, queryScore }) => {
            const score = queryScore + context(id) + dynamicSignal(corpus[id])
            let position = 0
            while (position < entries.length && entries[position].score >= score) position += 1
            if (position < 8) {
              entries.splice(position, 0, { id, score })
              if (entries.length > 8) entries.pop()
            }
          })
          return entries.map(({ id }) => id)
        }
        const baseline = rank(rawContext)
        for (const context of [profileContext, csrContext, invertedContext]) {
          unicodeQueryRankingComparisons += 1
          if (!equalIds(baseline, rank(context))) {
            throw new Error('Unicode top-eight mismatch at current ' + current.id + ', query ' + query)
          }
        }
      }
    }
    return {
      corpusSize: corpus.length,
      currentArtifactsChecked: corpus.length,
      pairwiseContextScoresCompared,
      unicodeQueryRankingComparisons,
      queryScoresEvaluated,
      queries,
      astralFuzzyQuery: { text: '😀atlas', query: 'atl', score: astralQueryScore },
      includesJapaneseAndAstralCharacters: true,
      contextScoresAndTop8Identical: true,
    }
  })
  await page.evaluate(() => { delete window.__contextScoringRecords; delete window.__contextScoringTrial })
  await readJsHeapBytes(cdp)
  return {
    scope: 'benchmark-only; full score includes query fit, context, recency, pin, and freshness',
    profileIndex: {
      ...profileIndex,
      additionalRetainedHeapBytes: heapBeforeIndexBytes === null || heapAfterProfileBytes === null
        ? null
        : heapAfterProfileBytes - heapBeforeIndexBytes,
      additionalBackingStorageBytes: backingAfterProfileBytes - backingBeforeIndexBytes,
    },
    invertedIndex: {
      ...postingIndex,
      additionalRetainedHeapBytes: heapAfterPostingBytes === null || heapAfterProfileBytes === null
        ? null
        : heapAfterPostingBytes - heapAfterProfileBytes,
      additionalBackingStorageBytes: backingAfterPostingBytes - backingAfterProfileBytes,
    },
    packedProfile: {
      ...queryResults.csr,
      additionalV8HeapBytes: heapBeforeIndexBytes === null || heapAfterCsrOnlyBytes === null
        ? null
        : heapAfterCsrOnlyBytes - heapBeforeIndexBytes,
      additionalBackingStorageBytes: backingAfterCsrOnlyBytes - backingBeforeIndexBytes,
      additionalTotalMemoryBytes: (heapAfterCsrOnlyBytes - heapBeforeIndexBytes)
        + (backingAfterCsrOnlyBytes - backingBeforeIndexBytes),
      v8HeapBytesAfterPack: heapAfterCsrOnlyBytes,
      backingStorageAfterPackBytes: backingAfterCsrOnlyBytes,
      scoringVectorsV8HeapBytes: heapAfterPackedBytes - heapAfterCsrOnlyBytes,
      scoringVectorsBackingStorageBytes: backingAfterPackedBytes - backingAfterCsrOnlyBytes,
      scoringVectorsTotalMemoryBytes: (heapAfterPackedBytes - heapAfterCsrOnlyBytes)
        + (backingAfterPackedBytes - backingAfterCsrOnlyBytes),
      dynamicSignalVectorBytes: queryResults.signalVectorBytes,
      signalVectorBuildMs: queryResults.signalVectorBuildMs,
    },
    dynamicSignals: queryResults.dynamicSignals,
    currentContextLookupMs: queryResults.currentContextBuildMs,
    currentContextLookupBytes: queryResults.currentContextLookupBytes,
    contextScoreMismatches: queryResults.contextScoreMismatches,
    fullSignalRankingP50MsByQuery: Object.fromEntries(queryResults.queries
      .map(({ query, fullSignalRankingP50Ms }) => [query || '(empty)', fullSignalRankingP50Ms])),
    signalImpactByQuery: queryResults.signalImpact,
    totalJsHeapAfterExperimentBytes: heapAfterCsrOnlyBytes,
    queries: queryResults.queries,
    unicodeParity,
  }
}

async function benchmarkPaletteScoringUiMatrix(browserInstance, dataset, iterations, fixtureUrl, loadIteration, scopeMatrix = false, indexMatrix = false, baselineOnly = false) {
  const contextStrategies = indexMatrix ? ['indexed'] : ['raw', 'profile', 'csr', 'inverted']
  const signalStrategies = ['dynamic', 'float64', 'float32', 'split', 'sparse', 'lazy']
  const strategies = baselineOnly
    ? [{ context: 'baseline', signals: 'dynamic', candidateScope: 'scan', scopeCounts: 'live' }]
    : scopeMatrix
    ? [
      { context: 'baseline', signals: 'dynamic', candidateScope: 'scan', scopeCounts: 'live' },
      { context: 'baseline', signals: 'dynamic', candidateScope: 'prefilter', scopeCounts: 'live' },
      { context: 'baseline', signals: 'dynamic', candidateScope: 'scan', scopeCounts: 'memo' },
      { context: 'baseline', signals: 'dynamic', candidateScope: 'prefilter', scopeCounts: 'memo' },
    ]
    : [
      { context: 'baseline', signals: 'dynamic', candidateScope: 'scan', scopeCounts: 'live' },
      ...contextStrategies.flatMap((context) => signalStrategies.map((signals) => ({
        context,
        signals,
        candidateScope: 'scan',
        scopeCounts: 'live',
      }))),
    ]
  const rotation = baselineOnly ? 0 : ((loadIteration - 1) * (scopeMatrix ? 1 : indexMatrix ? 2 : 8) + 3) % strategies.length
  const orderedStrategies = [...strategies.slice(rotation), ...strategies.slice(0, rotation)]
  const targetArtifact = dataset.searchRecords.find(({ path: artifactPath }) => artifactPath.endsWith('.md'))
    ?? dataset.searchRecords[0]
  const route = `/${encodeURIComponent(dataset.currentSiteId)}/${targetArtifact.path.split('/').map(encodeURIComponent).join('/')}`
  const rows = []

  for (const {
    context: contextStrategy,
    signals: signalStrategy,
    candidateScope,
    scopeCounts,
  } of orderedStrategies) {
      const page = await browserInstance.newPage({ viewport: { width: 1440, height: 960 } })
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('HeapProfiler.enable')
      await cdp.send('Performance.enable')
      const heapBeforeBytes = await readJsHeapBytes(cdp)
      const backingBeforeBytes = await readBackingStorageBytes(cdp)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.addInitScript(({ recentReadsBySite, pinnedArtifactIdsBySite }) => {
        localStorage.setItem('git-artifact-pages:recent-artifacts:v1', JSON.stringify(recentReadsBySite))
        localStorage.setItem('git-artifact-pages:pinned-artifacts:v1', JSON.stringify(pinnedArtifactIdsBySite))
      }, {
        recentReadsBySite: dataset.recentReadsBySite,
        pinnedArtifactIdsBySite: dataset.pinnedArtifactIdsBySite,
      })

      const loadStarted = performance.now()
      const candidateQuery = candidateScope === 'prefilter' ? '&paletteCandidateScope=prefilter' : ''
      const countsQuery = scopeCounts === 'memo' ? '&paletteScopeCounts=memo' : ''
      const targetUrl = `${fixtureUrl}${route}?paletteContext=${contextStrategy}&paletteSignals=${signalStrategy}${candidateQuery}${countsQuery}`
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' })
      await page.locator('main.stage.has-artifact').waitFor({ state: 'visible', timeout: 60_000 })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const pageReadyMs = performance.now() - loadStarted
      const heapBeforePaletteBytes = await readJsHeapBytes(cdp)
      const backingBeforePaletteBytes = await readBackingStorageBytes(cdp)

      const paletteOpenStarted = performance.now()
      await page.keyboard.press('Control+k')
      const palette = page.getByRole('dialog', { name: 'Command palette' })
      await palette.waitFor({ state: 'visible' })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const paletteOpenMs = performance.now() - paletteOpenStarted
      const metrics = await palette.evaluate((dialog) => ({
        context: dialog.getAttribute('data-palette-context-strategy'),
        signals: dialog.getAttribute('data-palette-signal-strategy'),
        setupMs: Number(dialog.getAttribute('data-palette-scoring-setup-ms')),
        contextBuildMs: Number(dialog.getAttribute('data-palette-context-build-ms')),
        signalBuildMs: Number(dialog.getAttribute('data-palette-signal-build-ms')),
        typedArrayBytes: Number(dialog.getAttribute('data-palette-typed-array-bytes')),
        contextVectorBytes: Number(dialog.getAttribute('data-palette-context-vector-bytes')),
        signalVectorBytes: Number(dialog.getAttribute('data-palette-signal-vector-bytes')),
      }))
      if (contextStrategy !== 'baseline' && (metrics.context !== contextStrategy || metrics.signals !== signalStrategy)) {
        throw new Error(`Palette scoring mode was not enabled in a palette-bench build: ${contextStrategy}/${signalStrategy}.`)
      }
      const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
      const firstCharacterSamples = []
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        await measurePaletteQuery(search, '')
        firstCharacterSamples.push(await measurePaletteQuery(search, 'a'))
      }
      const queryNames = [
        { name: '(empty)', value: '' },
        { name: 'a', value: 'a' },
        { name: 'atlas', value: 'atlas' },
        { name: 'pltfrm', value: 'pltfrm' },
        { name: 'zzzz', value: 'zzzz' },
      ]
      const rankingByScope = Object.create(null)
      const timingByScopeAndQuery = Object.create(null)
      const scopeSwitchAtA = []

      for (const scope of ['all', 'recent', 'pinned']) {
        const accessibleName = scope === 'all' ? /^All pages/ : scope === 'recent' ? /^Recently read pages/ : /^Pinned pages/
        await palette.getByRole('button', { name: accessibleName }).click()
        rankingByScope[scope] = Object.create(null)
        timingByScopeAndQuery[scope] = Object.create(null)
        for (const query of queryNames) {
          const measurement = await search.evaluate(async (input, value) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            if (!setter) throw new Error('Could not access the native input value setter.')
            const started = performance.now()
            if (input.value !== value) {
              setter.call(input, value)
              input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
            }
            const processingMilliseconds = performance.now() - started
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            return {
              processingMilliseconds,
              inputToPaintMilliseconds: performance.now() - started,
              inputValue: input.value,
              ids: [...document.querySelectorAll('[role="option"][data-palette-entry-id^="artifact:"]')]
                .map((entry) => entry.getAttribute('data-palette-entry-id')),
            }
          }, query.value)
          if (measurement.inputValue !== query.value) throw new Error(`Scoring matrix input failed for ${query.name}.`)
          rankingByScope[scope][query.name] = measurement.ids
          timingByScopeAndQuery[scope][query.name] = {
            jsMs: roundHundredths(measurement.processingMilliseconds),
            inputToPaintMs: roundHundredths(measurement.inputToPaintMilliseconds),
          }
        }
      }

      await palette.getByRole('button', { name: /^All pages/ }).click()
      await measurePaletteQuery(search, 'a')
      for (const scope of ['recent', 'pinned', 'all']) {
        const accessibleName = scope === 'all' ? /^All pages/ : scope === 'recent' ? /^Recently read pages/ : /^Pinned pages/
        const button = await palette.getByRole('button', { name: accessibleName }).elementHandle()
        const switchMeasurement = await button.evaluate(async (element) => {
          const started = performance.now()
          element.click()
          const jsMs = performance.now() - started
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          return {
            jsMs,
            inputToPaintMs: performance.now() - started,
            ids: [...document.querySelectorAll('[role="option"][data-palette-entry-id^="artifact:"]')]
              .map((entry) => entry.getAttribute('data-palette-entry-id')),
          }
        })
        scopeSwitchAtA.push({ scope, jsMs: roundHundredths(switchMeasurement.jsMs), inputToPaintMs: roundHundredths(switchMeasurement.inputToPaintMs), ids: switchMeasurement.ids })
      }

      const heapAfterBytes = await readJsHeapBytes(cdp)
      const backingAfterBytes = await readBackingStorageBytes(cdp)
      const row = {
        context: contextStrategy,
        signals: signalStrategy,
        candidateScope,
        scopeCounts,
        pageReadyMs: round(pageReadyMs),
        paletteOpenMs: round(paletteOpenMs),
        firstCharacterJsMs: roundHundredths(percentile(firstCharacterSamples.map(({ jsMs }) => jsMs), 0.5)),
        firstCharacterJsP95Ms: roundHundredths(percentile(firstCharacterSamples.map(({ jsMs }) => jsMs), 0.95)),
        firstCharacterInputToPaintMs: roundHundredths(percentile(firstCharacterSamples.map(({ inputToPaintMs }) => inputToPaintMs), 0.5)),
        firstCharacterInputToPaintP95Ms: roundHundredths(percentile(firstCharacterSamples.map(({ inputToPaintMs }) => inputToPaintMs), 0.95)),
        setup: metrics,
        scopeSwitchAtA,
        heapBeforePaletteBytes,
        heapAfterPaletteBytes: heapAfterBytes,
        backingBeforePaletteBytes,
        backingAfterPaletteBytes: backingAfterBytes,
        heapDeltaAfterPaletteBytes: heapBeforePaletteBytes === null || heapAfterBytes === null
          ? null
          : heapAfterBytes - heapBeforePaletteBytes,
        backingStorageDeltaAfterPaletteBytes: backingBeforePaletteBytes === null || backingAfterBytes === null
          ? null
          : backingAfterBytes - backingBeforePaletteBytes,
        rankingByScope,
        timingByScopeAndQuery,
      }
      if (errors.length) row.pageErrors = errors
      rows.push(row)
      await page.close()
  }

  const baselineRow = rows.find(({ context, signals, candidateScope, scopeCounts: countStrategy }) => (
    context === 'baseline' && signals === 'dynamic' && candidateScope === 'scan' && countStrategy === 'live'
  ))
  if (!baselineRow) throw new Error('Scoring matrix did not include the current product baseline.')
  const baselineByKey = flattenRanking(baselineRow.rankingByScope, baselineRow.scopeSwitchAtA)
  for (const row of rows) {
    const actualByKey = flattenRanking(row.rankingByScope, row.scopeSwitchAtA)
    row.parityMismatches = []
    for (const [key, ids] of Object.entries(baselineByKey)) {
      if (JSON.stringify(ids) !== JSON.stringify(actualByKey[key])) {
        row.parityMismatches.push({ key, baseline: ids, actual: actualByKey[key] })
      }
    }
  }
  const mismatchCount = rows.reduce((total, row) => total + row.parityMismatches.length, 0)
  return {
    scenario: `${dataset.siteCount} sites x ${dataset.artifactsPerSite}`,
    totalArtifacts: dataset.siteCount * dataset.artifactsPerSite,
    activeArtifacts: dataset.artifactsPerSite,
    recentReads: dataset.recentReadCountPerSite,
    pinnedArtifacts: dataset.pinnedArtifactIdsBySite[dataset.currentSiteId]?.length ?? 0,
    targetArtifactId: targetArtifact.id,
    loadIteration,
    strategies: rows,
    strategyCount: rows.length,
    parityMismatchCount: mismatchCount,
    allStrategiesMatchBaseline: mismatchCount === 0,
    ...(dataset.profileProjectionBytes ? {
      indexProfileProjection: {
        addedJsonBytes: dataset.profileProjectionBytes,
        addedGzipBytes: dataset.profileProjectionGzipBytes,
        fullIndexJsonBytes: dataset.currentIndexBytes,
        fullIndexGzipBytes: dataset.currentIndexGzipBytes,
        activeIndexGenerationMs: roundHundredths(dataset.activeProfileProjectionBuildMs),
        allIndexesGenerationMs: roundHundredths(dataset.profileProjectionBuildMs),
      },
    } : {}),
  }
}

async function measurePaletteQuery(search, value) {
  return search.evaluate(async (input, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Could not access the native input value setter.')
    const started = performance.now()
    if (input.value !== nextValue) {
      setter.call(input, nextValue)
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }))
    }
    const jsMs = performance.now() - started
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const ids = [...document.querySelectorAll('[role="option"][data-palette-entry-id^="artifact:"]')]
      .map((entry) => entry.getAttribute('data-palette-entry-id'))
    return { jsMs, inputToPaintMs: performance.now() - started, ids }
  }, value)
}

function flattenRanking(rankingByScope, scopeSwitchAtA) {
  const flattened = Object.create(null)
  for (const [scope, queries] of Object.entries(rankingByScope)) {
    for (const [query, ids] of Object.entries(queries)) flattened[`${scope}:${query}`] = ids
  }
  for (const { scope, ids } of scopeSwitchAtA) flattened[`switch:${scope}`] = ids
  return flattened
}

async function benchmarkTyping(search, iterations, sequence) {
  const result = await search.evaluate(async (input, { iterations, sequence }) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Could not access the native input value setter.')
    const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const samples = []

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      setter.call(input, '')
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
      await nextPaint()

      for (const [position, character] of Array.from(sequence).entries()) {
        const started = performance.now()
        setter.call(input, input.value + character)
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: character }))
        const processingMilliseconds = performance.now() - started
        await nextPaint()
        samples.push({
          position,
          character,
          processingMilliseconds,
          inputToPaintMilliseconds: performance.now() - started,
          optionCount: document.querySelectorAll('[role="dialog"] [role="option"]').length,
        })
      }
    }

    return { samples, inputValue: input.value }
  }, { iterations, sequence })

  if (result.inputValue !== sequence) throw new Error(`Sequential typing did not leave the expected search query: ${sequence}.`)
  const first = result.samples[0]
  const warm = result.samples.slice(1)
  const perCharacter = Array.from(sequence, (character, position) => {
    const characterSamples = result.samples.filter((sample) => sample.position === position)
    const jsSamples = characterSamples.map((sample) => sample.processingMilliseconds)
    const paintSamples = characterSamples.map((sample) => sample.inputToPaintMilliseconds)
    return {
      position: position + 1,
      character,
      jsP50Ms: round(percentile(jsSamples, 0.50)),
      jsP95Ms: round(percentile(jsSamples, 0.95)),
      inputToPaintP50Ms: round(percentile(paintSamples, 0.50)),
      inputToPaintP95Ms: round(percentile(paintSamples, 0.95)),
    }
  })
  return {
    sequence,
    iterations,
    firstCharacter: first.character,
    firstCharacterResults: first.optionCount,
    firstCharacterJsMs: round(first.processingMilliseconds),
    firstCharacterInputToPaintMs: round(first.inputToPaintMilliseconds),
    warmCharacterJsP50Ms: round(percentile(warm.map((sample) => sample.processingMilliseconds), 0.50)),
    warmCharacterJsP95Ms: round(percentile(warm.map((sample) => sample.processingMilliseconds), 0.95)),
    warmCharacterInputToPaintP50Ms: round(percentile(warm.map((sample) => sample.inputToPaintMilliseconds), 0.50)),
    warmCharacterInputToPaintP95Ms: round(percentile(warm.map((sample) => sample.inputToPaintMilliseconds), 0.95)),
    perCharacter,
  }
}

function generateSiteIndex(count, seed, siteId, siteTitle) {
  const random = createRandom(`${seed}:${siteId}:${count}`)
  const baseTime = Date.parse('2026-09-24T12:00:00.000Z')
  const artifacts = Array.from({ length: count }, (_, offset) => {
    const ordinal = offset + 1
    const adjective = choose(adjectives, random)
    const topic = topics[offset % topics.length]
    const firstNoun = choose(nouns, random)
    const secondNoun = choose(nouns, random)
    const area = choose(areas, random)
    const year = 2020 + Math.floor(random() * 7)
    const extension = ordinal % 10 === 0 ? 'md' : 'html'
    const pathParts = [
      area,
      String(year),
      choose(areas, random),
      adjective,
      `${adjective}-${topic}-${firstNoun}-${secondNoun}-${ordinal.toString(36)}.${extension}`,
    ]
    const artifactPath = pathParts.join('/')
    const title = `${capitalize(adjective)} ${capitalize(topic)} ${capitalize(firstNoun)} ${capitalize(secondNoun)}`

    return {
      id: artifactPath,
      title,
      path: artifactPath,
      format: extension === 'md' ? 'markdown' : 'html',
      filename: pathParts.at(-1),
      artifactUrl: `/_artifacts/${siteId}/${artifactPath}`,
      updatedAt: new Date(baseTime - Math.floor(random() * 1_825) * 86_400_000).toISOString(),
      lastCommitter: { name: `${capitalize(choose(adjectives, random))} ${capitalize(choose(nouns, random))}` },
      source: { repository: `benchmark/${siteId}`, ref: `seed-${seed}` },
    }
  })

  return {
    schemaVersion: 1,
    site: { id: siteId, title: siteTitle },
    generatedAt: '2026-09-24T12:00:00.000Z',
    artifacts,
  }
}

function generateSerializedPaletteProfiles(artifacts) {
  const ignoredWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'index', 'html', 'md',
    'incidents', 'architecture', 'reports', 'guides', 'runbooks', 'diagrams', 'docs',
  ])
  const wordDictionary = new Map()
  const folderDictionary = new Map()
  const wordOffsets = [0]
  const wordIds = []
  const folderOffsets = [0]
  const folderIds = []
  const intern = (dictionary, value) => {
    let id = dictionary.get(value)
    if (id === undefined) {
      id = dictionary.size
      dictionary.set(value, id)
    }
    return id
  }
  const words = (value) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && !ignoredWords.has(word))

  for (const artifact of artifacts) {
    const uniqueWords = new Set([...words(artifact.title), ...words(artifact.path)])
    for (const word of uniqueWords) wordIds.push(intern(wordDictionary, word))
    wordOffsets.push(wordIds.length)
    const folders = artifact.path.split('/').filter(Boolean).slice(0, -1)
    for (const folder of folders) folderIds.push(intern(folderDictionary, folder))
    folderOffsets.push(folderIds.length)
  }

  return {
    version: 1,
    wordOffsets,
    wordIds,
    wordIdWidth: wordDictionary.size <= 65_536 ? 16 : 32,
    folderOffsets,
    folderIds,
    folderIdWidth: folderDictionary.size <= 65_536 ? 16 : 32,
  }
}

function createRandom(seed) {
  let state = 2_166_136_261
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16_777_619) >>> 0
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function choose(items, random) {
  return items[Math.floor(random() * items.length)]
}

function capitalize(value) {
  return value[0].toUpperCase() + value.slice(1)
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]
}

function round(value) {
  return Number(value.toFixed(1))
}

function roundHundredths(value) {
  return Number(value.toFixed(2))
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/gu, '-')
}

function parseArguments(args) {
  const values = {
    counts: [1_000, 5_000, 10_000, 20_000],
    countsSpecified: false,
    siteCount: undefined,
    artifactsPerSite: undefined,
    chunkSizes: [],
    iterations: 20,
    loads: 1,
    recentReadsPerSite: 0,
    seed: '20260924',
    generateOnly: false,
    paletteScoreMatrix: false,
    paletteScopeMatrix: false,
    paletteIndexMatrix: false,
    paletteBaselineMatrix: false,
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') {
      console.log('Usage: npm run benchmark:palette -- [--counts 1000,5000,10000,20000] [--sites 20 --artifacts-per-site 1000] [--recent-reads 0-20] [--chunk-sizes 250,1000,5000] [--iterations 20] [--loads 3] [--seed text] [--palette-score-matrix]')
      console.log('       npm run benchmark:palette -- [--counts 20000,100000] [--sites 20 --artifacts-per-site 1000] [--recent-reads 20] [--iterations 5] [--loads 3] [--seed text] [--palette-scope-matrix]')
      console.log('       npm run benchmark:palette -- [--counts 20000,100000] [--sites 20 --artifacts-per-site 1000] [--recent-reads 20] [--iterations 5] [--loads 3] [--seed text] [--palette-index-matrix]')
      console.log('       npm run benchmark:palette -- [--counts 100000] [--recent-reads 20] [--iterations 5] [--loads 3] [--seed text] [--palette-baseline-matrix]')
      console.log('       npm run fixtures:palette -- [--counts 1000,5000,10000,20000] [--sites 20 --artifacts-per-site 1000] [--recent-reads 0-20] [--seed text]')
      process.exit(0)
    }
    if (argument === '--generate-only') {
      values.generateOnly = true
      continue
    }
    if (argument === '--palette-score-matrix') {
      values.paletteScoreMatrix = true
      continue
    }
    if (argument === '--palette-scope-matrix') {
      values.paletteScopeMatrix = true
      continue
    }
    if (argument === '--palette-index-matrix') {
      values.paletteIndexMatrix = true
      continue
    }
    if (argument === '--palette-baseline-matrix') {
      values.paletteBaselineMatrix = true
      continue
    }
    if (argument === '--counts' || argument === '--sites' || argument === '--artifacts-per-site' || argument === '--recent-reads' || argument === '--chunk-sizes' || argument === '--iterations' || argument === '--loads' || argument === '--seed') {
      const value = args[++index]
      if (!value) throw new Error(`Missing value for ${argument}.`)
      if (argument === '--counts') {
        values.counts = value.split(',').map(Number)
        values.countsSpecified = true
      }
      else if (argument === '--chunk-sizes') values.chunkSizes = value.split(',').map(Number)
      else if (argument === '--sites') values.siteCount = Number(value)
      else if (argument === '--artifacts-per-site') values.artifactsPerSite = Number(value)
      else if (argument === '--recent-reads') values.recentReadsPerSite = Number(value)
      else if (argument === '--iterations') values.iterations = Number(value)
      else if (argument === '--loads') values.loads = Number(value)
      else values.seed = value
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  const matrixModes = [values.paletteScoreMatrix, values.paletteScopeMatrix, values.paletteIndexMatrix, values.paletteBaselineMatrix]
  if (matrixModes.filter(Boolean).length > 1) throw new Error('Choose only one palette benchmark matrix mode at a time.')

  if (values.siteCount !== undefined && values.artifactsPerSite === undefined
    || values.siteCount === undefined && values.artifactsPerSite !== undefined) {
    throw new Error('--sites and --artifacts-per-site must be provided together.')
  }
  if (values.siteCount !== undefined && (!Number.isSafeInteger(values.siteCount) || values.siteCount < 1 || values.siteCount > 1_000)) {
    throw new Error('Sites must be a whole number between 1 and 1000.')
  }
  if (values.artifactsPerSite !== undefined && (!Number.isSafeInteger(values.artifactsPerSite) || values.artifactsPerSite < 1 || values.artifactsPerSite > 100_000)) {
    throw new Error('Artifacts per site must be a whole number between 1 and 100000.')
  }
  if (!Number.isSafeInteger(values.recentReadsPerSite) || values.recentReadsPerSite < 0 || values.recentReadsPerSite > 20) {
    throw new Error('Recent reads per site must be a whole number between 0 and 20.')
  }
  if (values.siteCount !== undefined && values.siteCount * values.artifactsPerSite > 1_000_000) {
    throw new Error('A multi-site fixture may contain at most one million artifacts.')
  }
  if (values.siteCount !== undefined && !values.countsSpecified) values.counts = []
  if (values.counts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 100_000)) {
    throw new Error('Counts must be whole numbers between 1 and 100000.')
  }
  if (values.chunkSizes.some((size) => !Number.isSafeInteger(size) || size < 1 || size > 100_000)) {
    throw new Error('Chunk sizes must be whole numbers between 1 and 100000.')
  }
  if (new Set(values.chunkSizes).size !== values.chunkSizes.length) throw new Error('Chunk sizes must not contain duplicates.')
  if (new Set(values.counts).size !== values.counts.length) throw new Error('Counts must not contain duplicates.')
  if (values.counts.length === 0 && values.siteCount === undefined) throw new Error('At least one single-site count or multi-site scenario is required.')
  if (!Number.isSafeInteger(values.iterations) || values.iterations < 5 || values.iterations > 100) {
    throw new Error('Iterations must be a whole number between 5 and 100.')
  }
  if (!Number.isSafeInteger(values.loads) || values.loads < 1 || values.loads > 10) {
    throw new Error('Loads must be a whole number between 1 and 10.')
  }
  if (previewPort < 1 || previewPort > 65_535) throw new Error('PALETTE_BENCH_PORT must be a valid TCP port.')
  return values
}

function startPreview() {
  return spawn(process.execPath, [viteCli, 'preview', '--config', path.join(repositoryRoot, 'web/vite.config.ts'), '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'], {
    cwd: repositoryRoot,
    stdio: 'ignore',
  })
}

async function startFixtureServer() {
  let dataset
  const server = createServer((incoming, outgoing) => {
    const pathname = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/_indexes/') {
      const body = `<!doctype html>${dataset.sites.map(({ site }) => `<a href="${site.id}/">${site.id}/</a>`).join('')}`
      sendResponse(outgoing, 200, 'text/html; charset=utf-8', body)
      return
    }

    const metadataMatch = pathname.match(/^\/_indexes\/([a-z0-9-]+)\/meta\.json$/u)
    if (metadataMatch) {
      const payload = dataset.metadataPayloads.get(metadataMatch[1])
      sendResponse(outgoing, payload ? 200 : 404, 'application/json; charset=utf-8', payload ?? 'Not found')
      return
    }

    const artifactPayload = dataset.currentArtifactPayloads.get(pathname)
    if (artifactPayload !== undefined) {
      sendResponse(outgoing, 200, 'application/json; charset=utf-8', artifactPayload)
      return
    }

    if (/^\/_indexes\/[a-z0-9-]+\//u.test(pathname)) {
      sendResponse(outgoing, 404, 'application/json; charset=utf-8', 'Not found')
      return
    }

    const headers = { ...incoming.headers, host: `127.0.0.1:${previewPort}` }
    delete headers.connection
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: previewPort,
      path: incoming.url,
      method: incoming.method,
      headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(outgoing)
    })
    upstream.on('error', () => {
      if (!outgoing.headersSent) sendResponse(outgoing, 502, 'text/plain; charset=utf-8', 'Preview server unavailable')
      else outgoing.destroy()
    })
    incoming.pipe(upstream)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(fixturePort, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${fixturePort}`,
    setDataset: (nextDataset) => { dataset = nextDataset },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

function sendResponse(response, status, contentType, body) {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function waitForPreview(child) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite preview exited with status ${child.exitCode}; check port ${previewPort}.`)
    try {
      const response = await fetch(previewUrl)
      if (response.ok) return
    } catch {
      // Wait for Vite preview to bind its local port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Vite preview did not start at ${previewUrl}.`)
}
