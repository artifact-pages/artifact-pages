import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
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
    })),
    ...(options.siteCount === undefined ? [] : [{
      label: `multi-${options.siteCount}-by-${options.artifactsPerSite}`,
      siteCount: options.siteCount,
      artifactsPerSite: options.artifactsPerSite,
    }]),
  ]
  const datasets = []
  for (const scenario of scenarios) datasets.push(await generateDataset(runRoot, scenario, options.seed))

  console.log(`Generated index-only fixtures: ${path.relative(repositoryRoot, runRoot)}`)
  console.log(`Seed: ${options.seed}`)

  if (!options.generateOnly) {
    preview = startPreview()
    await waitForPreview(preview)
    fixtureServer = await startFixtureServer()
    browser = await chromium.launch({ headless: true })

    for (const dataset of datasets) {
      fixtureServer.setDataset(dataset)
      const result = await benchmarkDataset(browser, dataset, options.iterations, fixtureServer.url)
      console.log(JSON.stringify(result))
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

async function generateDataset(runRoot, scenario, seed) {
  const generationStarted = performance.now()
  const scenarioRoot = path.join(runRoot, scenario.label, 'storage', '_indexes')
  const sites = []
  const metadataPayloads = new Map()
  let currentIndexPayload
  let currentIndexBytes = 0
  let totalIndexBytes = 0

  for (let offset = 0; offset < scenario.siteCount; offset += 1) {
    const ordinal = offset + 1
    const siteId = scenario.siteCount === 1 ? 'search-lab' : `site-${String(ordinal).padStart(4, '0')}`
    const title = scenario.siteCount === 1
      ? `Search Load Lab (${scenario.artifactsPerSite})`
      : `Search Lab ${String(ordinal).padStart(4, '0')}`
    const index = generateSiteIndex(scenario.artifactsPerSite, seed, siteId, title)
    const indexPayload = `${JSON.stringify(index)}\n`
    const indexPath = path.join(scenarioRoot, siteId, 'index.json')
    await mkdir(path.dirname(indexPath), { recursive: true })
    await writeFile(indexPath, indexPayload, { flag: 'wx' })
    const indexBytes = Buffer.byteLength(indexPayload)
    totalIndexBytes += indexBytes
    if (offset === 0) {
      currentIndexPayload = indexPayload
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
    const metadataPath = path.join(scenarioRoot, `${siteId}.json`)
    await writeFile(metadataPath, metadataPayload, { flag: 'wx' })
    metadataPayloads.set(siteId, metadataPayload)
    sites.push(metadata)
  }

  if (currentIndexPayload === undefined) throw new Error('A benchmark scenario must contain at least one site.')
  return {
    ...scenario,
    sites,
    metadataPayloads,
    currentIndexPayload,
    currentSiteId: sites[0].site.id,
    currentIndexBytes,
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
    if (/^\/_indexes\/[^/]+\.json$/u.test(pathname)) metadataRequests.push(pathname)
    if (pathname.endsWith('/index.json')) artifactIndexRequests.push(pathname)
  })
  page.on('pageerror', (error) => { pageError = error.message })
  await page.addInitScript((maxResourceEntries) => {
    performance.setResourceTimingBufferSize(maxResourceEntries)
    const metrics = { jsonLoads: [], fetches: [], initialHeapBytes: performance.memory?.usedJSHeapSize ?? null }
    Object.defineProperty(window, '__paletteBenchMetrics', { value: metrics })
    const nativeFetch = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const started = performance.now()
      const response = await nativeFetch(...args)
      const pathname = new URL(response.url).pathname
      if (pathname.startsWith('/_indexes/')) {
        metrics.fetches.push({ pathname, elapsedMs: performance.now() - started })
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
  }, Math.max(250, dataset.siteCount + 100))
  const loadStarted = performance.now()
  await page.goto(`${fixtureUrl}/${dataset.currentSiteId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.site-home h1').waitFor({ state: 'visible', timeout: 60_000 })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const pageReadyMs = performance.now() - loadStarted
  await page.waitForFunction((siteCount) => {
    const metadataLoads = window.__paletteBenchMetrics.jsonLoads.filter(({ pathname }) => (
      pathname.endsWith('.json') && !pathname.endsWith('/index.json')
    ))
    return metadataLoads.length === siteCount
  }, dataset.siteCount)
  const discoveryCompleteMs = performance.now() - loadStarted
  const heapAfterSiteLoadBytes = await readJsHeapBytes(cdp)

  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.waitFor({ state: 'visible' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  const typingResult = await benchmarkTyping(search, iterations)
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

  if (metadataRequests.length !== dataset.siteCount) {
    throw new Error(`Expected ${dataset.siteCount} discovery metadata requests, received ${metadataRequests.length}.`)
  }
  if (artifactIndexRequests.length !== 1 || artifactIndexRequests[0] !== `/_indexes/${dataset.currentSiteId}/index.json`) {
    throw new Error(`Expected only the current site's detailed index, received: ${artifactIndexRequests.join(', ') || '(none)'}.`)
  }

  const loadMetrics = await page.evaluate(() => {
    const metrics = window.__paletteBenchMetrics
    const jsonLoads = metrics.jsonLoads
    const detailed = jsonLoads.filter(({ pathname }) => pathname.endsWith('/index.json'))
    const metadata = jsonLoads.filter(({ pathname }) => pathname.endsWith('.json') && !pathname.endsWith('/index.json'))
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

  await cdp.detach()
  await page.close()
  if (pageError) throw new Error(`Browser error in ${dataset.siteCount} sites × ${dataset.artifactsPerSite} artifacts: ${pageError}`)
  return {
    sites: dataset.siteCount,
    artifactsPerSite: dataset.artifactsPerSite,
    totalArtifacts: dataset.siteCount * dataset.artifactsPerSite,
    generatedIndexBytesAcrossAllSites: dataset.totalIndexBytes,
    currentSiteIndexBytes: dataset.currentIndexBytes,
    discoveryMetadataBytes: dataset.metadataBytes,
    generatedMs: round(dataset.generationMs),
    pageReadyMs: round(pageReadyMs),
    discoveryCompleteMs: round(discoveryCompleteMs),
    discoveryMetadataRequests: metadataRequests.length,
    artifactIndexRequests: artifactIndexRequests.length,
    siteIndexRequestsAfterLookup,
    loadMetrics: {
      ...loadMetrics,
      metadataParseMs: round(loadMetrics.metadataParseMs),
      detailParseMs: round(loadMetrics.detailParseMs),
      totalParseMs: round(loadMetrics.totalParseMs),
      totalBodyReadMs: round(loadMetrics.totalBodyReadMs),
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
    typingResult,
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

async function benchmarkTyping(search, iterations) {
  const result = await search.evaluate(async (input, { iterations, sequence }) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Could not access the native input value setter.')
    const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const samples = []

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      setter.call(input, '')
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
      await nextPaint()

      for (const character of sequence) {
        const started = performance.now()
        setter.call(input, input.value + character)
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: character }))
        const processingMilliseconds = performance.now() - started
        await nextPaint()
        samples.push({
          character,
          processingMilliseconds,
          inputToPaintMilliseconds: performance.now() - started,
          optionCount: document.querySelectorAll('[role="dialog"] [role="option"]').length,
        })
      }
    }

    return { samples, inputValue: input.value }
  }, { iterations, sequence: 'atlas' })

  if (result.inputValue !== 'atlas') throw new Error('Sequential typing did not leave the expected search query.')
  const first = result.samples[0]
  const warm = result.samples.slice(1)
  return {
    sequence: 'atlas',
    iterations,
    firstCharacter: first.character,
    firstCharacterResults: first.optionCount,
    firstCharacterJsMs: round(first.processingMilliseconds),
    firstCharacterInputToPaintMs: round(first.inputToPaintMilliseconds),
    warmCharacterJsP50Ms: round(percentile(warm.map((sample) => sample.processingMilliseconds), 0.50)),
    warmCharacterJsP95Ms: round(percentile(warm.map((sample) => sample.processingMilliseconds), 0.95)),
    warmCharacterInputToPaintP50Ms: round(percentile(warm.map((sample) => sample.inputToPaintMilliseconds), 0.50)),
    warmCharacterInputToPaintP95Ms: round(percentile(warm.map((sample) => sample.inputToPaintMilliseconds), 0.95)),
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
      id: `document-${ordinal.toString(36).padStart(5, '0')}`,
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

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/gu, '-')
}

function parseArguments(args) {
  const values = {
    counts: [1_000, 5_000, 10_000, 20_000],
    countsSpecified: false,
    siteCount: undefined,
    artifactsPerSite: undefined,
    iterations: 20,
    seed: '20260924',
    generateOnly: false,
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') {
      console.log('Usage: npm run benchmark:palette -- [--counts 1000,5000,10000,20000] [--sites 20 --artifacts-per-site 1000] [--iterations 20] [--seed text]')
      console.log('       npm run fixtures:palette -- [--counts 1000,5000,10000,20000] [--sites 20 --artifacts-per-site 1000] [--seed text]')
      process.exit(0)
    }
    if (argument === '--generate-only') {
      values.generateOnly = true
      continue
    }
    if (argument === '--counts' || argument === '--sites' || argument === '--artifacts-per-site' || argument === '--iterations' || argument === '--seed') {
      const value = args[++index]
      if (!value) throw new Error(`Missing value for ${argument}.`)
      if (argument === '--counts') {
        values.counts = value.split(',').map(Number)
        values.countsSpecified = true
      }
      else if (argument === '--sites') values.siteCount = Number(value)
      else if (argument === '--artifacts-per-site') values.artifactsPerSite = Number(value)
      else if (argument === '--iterations') values.iterations = Number(value)
      else values.seed = value
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

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
  if (values.siteCount !== undefined && values.siteCount * values.artifactsPerSite > 1_000_000) {
    throw new Error('A multi-site fixture may contain at most one million artifacts.')
  }
  if (values.siteCount !== undefined && !values.countsSpecified) values.counts = []
  if (values.counts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 100_000)) {
    throw new Error('Counts must be whole numbers between 1 and 100000.')
  }
  if (new Set(values.counts).size !== values.counts.length) throw new Error('Counts must not contain duplicates.')
  if (values.counts.length === 0 && values.siteCount === undefined) throw new Error('At least one single-site count or multi-site scenario is required.')
  if (!Number.isSafeInteger(values.iterations) || values.iterations < 5 || values.iterations > 100) {
    throw new Error('Iterations must be a whole number between 5 and 100.')
  }
  if (previewPort < 1 || previewPort > 65_535) throw new Error('PALETTE_BENCH_PORT must be a valid TCP port.')
  return values
}

function startPreview() {
  return spawn(process.execPath, [viteCli, 'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'], {
    cwd: repositoryRoot,
    stdio: 'ignore',
  })
}

async function startFixtureServer() {
  let dataset
  const server = createServer((incoming, outgoing) => {
    const pathname = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/_indexes/') {
      const body = `<!doctype html>${dataset.sites.map(({ site }) => `<a href="${site.id}.json">${site.id}.json</a>`).join('')}`
      sendResponse(outgoing, 200, 'text/html; charset=utf-8', body)
      return
    }

    const metadataMatch = pathname.match(/^\/_indexes\/([a-z0-9-]+)\.json$/u)
    if (metadataMatch) {
      const payload = dataset.metadataPayloads.get(metadataMatch[1])
      sendResponse(outgoing, payload ? 200 : 404, 'application/json; charset=utf-8', payload ?? 'Not found')
      return
    }

    const indexMatch = pathname.match(/^\/_indexes\/([a-z0-9-]+)\/index\.json$/u)
    if (indexMatch) {
      const payload = indexMatch[1] === dataset.currentSiteId ? dataset.currentIndexPayload : undefined
      sendResponse(outgoing, payload ? 200 : 404, 'application/json; charset=utf-8', payload ?? 'Not found')
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
