import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const outputRoot = path.join(repositoryRoot, '.local', 'palette-load-fixtures')
const previewPort = Number(process.env.PALETTE_BENCH_PORT ?? 4185)
const previewUrl = `http://127.0.0.1:${previewPort}`
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

try {
  await mkdir(outputRoot, { recursive: true })
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/gu, '')}-${randomUUID().slice(0, 8)}-seed-${slugify(options.seed)}`
  const runRoot = path.join(outputRoot, runId)
  await mkdir(runRoot)

  const datasets = []
  for (const count of options.counts) {
    const generationStarted = performance.now()
    const index = generateSiteIndex(count, options.seed)
    const payload = `${JSON.stringify(index)}\n`
    const storageIndexPath = path.join(runRoot, String(count), 'storage', '_indexes', 'search-lab.json')
    await mkdir(path.dirname(storageIndexPath), { recursive: true })
    await writeFile(storageIndexPath, payload, { flag: 'wx' })
    datasets.push({
      count,
      index,
      payload,
      bytes: Buffer.byteLength(payload),
      generationMs: performance.now() - generationStarted,
      outputPath: path.relative(repositoryRoot, storageIndexPath),
    })
  }

  console.log(`Generated index-only fixtures: ${path.relative(repositoryRoot, runRoot)}`)
  console.log(`Seed: ${options.seed}`)

  if (!options.generateOnly) {
    preview = startPreview()
    await waitForPreview(preview)
    browser = await chromium.launch({ headless: true })

    for (const dataset of datasets) {
      const result = await benchmarkDataset(browser, dataset, options.iterations)
      console.log(JSON.stringify(result))
    }

    console.log(`Iterations per query and size: ${options.iterations}`)
  }
} finally {
  await browser?.close()
  if (preview && preview.exitCode === null) {
    preview.kill('SIGTERM')
    await new Promise((resolve) => preview.once('exit', resolve))
  }
}

async function benchmarkDataset(browserInstance, dataset, iterations) {
  const page = await browserInstance.newPage({ viewport: { width: 1440, height: 960 } })
  let indexRequests = 0
  let pageError
  page.on('pageerror', (error) => { pageError = error.message })
  await page.route('**/_indexes/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/_indexes/') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><a href="search-lab.json">search-lab.json</a>',
      })
    } else if (pathname === '/_indexes/search-lab.json') {
      indexRequests += 1
      await route.fulfill({ status: 200, contentType: 'application/json', body: dataset.payload })
    } else {
      await route.fulfill({ status: 404, body: 'Not found' })
    }
  })

  const loadStarted = performance.now()
  await page.goto(`${previewUrl}/search-lab`, { waitUntil: 'domcontentloaded' })
  await page.locator('.site-home h1').waitFor({ state: 'visible', timeout: 60_000 })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const pageReadyMs = performance.now() - loadStarted

  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.waitFor({ state: 'visible' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  const typingResult = await benchmarkTyping(search, iterations)
  const queryResults = []

  for (const query of queries) {
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

  await page.close()
  if (pageError) throw new Error(`Browser error at ${dataset.count} artifacts: ${pageError}`)
  return {
    artifacts: dataset.count,
    indexBytes: dataset.bytes,
    generatedMs: round(dataset.generationMs),
    pageReadyMs: round(pageReadyMs),
    indexRequests,
    typingResult,
    queryResults,
    fixture: dataset.outputPath,
  }
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

function generateSiteIndex(count, seed) {
  const random = createRandom(`${seed}:${count}`)
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
      artifactUrl: `/_artifacts/search-lab/${artifactPath}`,
      updatedAt: new Date(baseTime - Math.floor(random() * 1_825) * 86_400_000).toISOString(),
      lastCommitter: { name: `${capitalize(choose(adjectives, random))} ${capitalize(choose(nouns, random))}` },
      source: { repository: 'benchmark/search-fixtures', ref: `seed-${seed}` },
    }
  })

  return {
    schemaVersion: 1,
    site: { id: 'search-lab', title: `Search Load Lab (${count})` },
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
  const values = { counts: [1_000, 5_000, 10_000, 20_000], iterations: 20, seed: '20260924', generateOnly: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') {
      console.log('Usage: npm run benchmark:palette -- [--counts 1000,5000,10000,20000] [--iterations 20] [--seed text]')
      console.log('       npm run fixtures:palette -- [--counts 1000,5000,10000,20000] [--seed text]')
      process.exit(0)
    }
    if (argument === '--generate-only') {
      values.generateOnly = true
      continue
    }
    if (argument === '--counts' || argument === '--iterations' || argument === '--seed') {
      const value = args[++index]
      if (!value) throw new Error(`Missing value for ${argument}.`)
      if (argument === '--counts') values.counts = value.split(',').map(Number)
      else if (argument === '--iterations') values.iterations = Number(value)
      else values.seed = value
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  if (values.counts.length === 0 || values.counts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 100_000)) {
    throw new Error('Counts must be whole numbers between 1 and 100000.')
  }
  if (new Set(values.counts).size !== values.counts.length) throw new Error('Counts must not contain duplicates.')
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
