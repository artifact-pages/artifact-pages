#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

export const pricing = Object.freeze({
  date: '2026-10-18', monthDays: 30, headerBytes: 1024,
  r2: { storageGBMonth: 0.015, classA: 4.5 / 1e6, classB: 0.36 / 1e6, freeGB: 10, freeA: 1e6, freeB: 10e6 },
  aws: { storageGiBMonth: 0.023, classA: 0.005 / 1000, classB: 0.0004 / 1000,
    viewerRequestFree: 10e6, viewerRequestUS: 0.010 / 10000, viewerRequestPC100: 0.012 / 10000, invalidationFree: 1000, invalidationPath: 0.005,
    transferFreeGB: 1000, transferTiers: [{ limitGB: 9000, rate: 0.085 }, { limitGB: 40000, rate: 0.08 }, { limitGB: 100000, rate: 0.06 }] },
})
export const cloudFrontCompressionConditions = Object.freeze({
  minimumBytes: 1000, maximumBytes: 10000000, eligibleContentTypes: [
    'application/javascript', 'application/json', 'application/xml', 'image/svg+xml',
    'text/css', 'text/html', 'text/javascript', 'text/plain', 'text/xml',
  ], source: 'https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html',
})

export function transferCostGB(gb, { freeGB = pricing.aws.transferFreeGB, tiers = pricing.aws.transferTiers } = {}) {
  let remaining = Math.max(0, gb - freeGB), cost = 0
  for (const tier of tiers) { const n = Math.min(remaining, tier.limitGB); cost += n * tier.rate; remaining -= n; if (!remaining) break }
  return cost
}
export function classifyResponses(responses) {
  return responses.reduce((out, r) => {
    if (r.fromCache) { out.browserCache += 1; return out }
    const status = Number(r.status)
    if (status === 200) { out.network200 += 1; out.viewerBytes += Number(r.encodedBytes || 0); out.originBytes += Number(r.originBytes || 0) }
    else if (status === 304) { out.network304 += 1; out.origin304 += r.originValidated ? 1 : 0 }
    else if (status > 0) out.otherNetwork += 1
    if (status === 200 || status === 304) out.networkRequests += 1
    return out
  }, { network200: 0, network304: 0, browserCache: 0, otherNetwork: 0, networkRequests: 0, viewerBytes: 0, originBytes: 0, origin304: 0 })
}
export function originReads(alwaysOrigin, cacheable, missRate) { return alwaysOrigin + cacheable * missRate }
export function sessionVector(C, W, R, views, q, reloads = 0) {
  return scaleVector(addVectors(C, scaleVector(W, q - 1), scaleVector(R, reloads)), views / q)
}
const addVectors = (...xs) => Object.fromEntries([...new Set(xs.flatMap((x) => Object.keys(x)))].map((k) => [k, xs.reduce((n, x) => n + Number(x[k] || 0), 0)]))
const scaleVector = (x, factor) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Number(v) * factor]))
export function lWeighted(regular, large) { return (regular * 30 + large) / 31 }
export function invalidationCost(paths) { return Math.max(0, paths - pricing.aws.invalidationFree) * pricing.aws.invalidationPath }
export function cloudFrontViewerRequestCost(requests, price = pricing.aws.viewerRequestUS) {
  return Math.max(0, requests - pricing.aws.viewerRequestFree) * price
}
export function r2AfterFreeAllowance({ storageGB, classA, classB }) {
  const storage = Math.max(0, storageGB - pricing.r2.freeGB) * pricing.r2.storageGBMonth
  const requestsA = Math.max(0, classA - pricing.r2.freeA) * pricing.r2.classA
  const requestsB = Math.max(0, classB - pricing.r2.freeB) * pricing.r2.classB
  return { storage, classA: requestsA, classB: requestsB, total: storage + requestsA + requestsB }
}
export function objectSizes(decoded, { precompressed = false, opaqueGzip = false, storedBytes = null } = {}) {
  const bytes = Buffer.from(decoded)
  const identity = opaqueGzip ? Number(storedBytes ?? bytes.length) : bytes.length
  if (precompressed) return { decodedBytes: bytes.length, identityBytes: bytes.length, gzip6Bytes: Number(storedBytes ?? bytes.length), brotli5Bytes: Number(storedBytes ?? bytes.length),
    recompressedGzip6Bytes: gzipSync(bytes, { level: 6, mtime: 0 }).length,
    recompressedBrotli5Bytes: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length, representation: 'stored-gzip' }
  if (opaqueGzip) return { decodedBytes: bytes.length, identityBytes: Number(storedBytes ?? bytes.length), gzip6Bytes: Number(storedBytes ?? bytes.length), brotli5Bytes: Number(storedBytes ?? bytes.length),
    recompressedGzip6Bytes: Number(storedBytes ?? bytes.length), recompressedBrotli5Bytes: Number(storedBytes ?? bytes.length), representation: 'opaque-gzip' }
  return { decodedBytes: identity, identityBytes: identity, gzip6Bytes: gzipSync(bytes, { level: 6, mtime: 0 }).length,
    brotli5Bytes: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length,
    recompressedGzip6Bytes: gzipSync(bytes, { level: 6, mtime: 0 }).length,
    recompressedBrotli5Bytes: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length, representation: 'compressible-local-proxy' }
}
export function averageVectors(vectors) {
  if (!vectors.length) throw new Error('cannot average an empty vector list')
  return Object.fromEntries([...new Set(vectors.flatMap((v) => Object.keys(v)))].map((key) => [key, vectors.reduce((sum, v) => sum + Number(v[key] || 0), 0) / vectors.length]))
}
export function compressedResponseBytes(response, mode, objectSizeAudit = [], { provider = 'aws' } = {}) {
  const status = Number(response.status)
  if (status === 304 || response.fromCache) return 0
  if (status !== 200) return Number(response.encodedBytes || 0)
  const url = response.url ?? ''
  const contentType = String(response.contentType ?? '').toLowerCase()
  if (response.indexChanged) {
    const kind = `${url.endsWith('/index.json') ? 'site-index' : 'search-manifest'}-${url.match(/scale-(\d+)/)?.[1] ?? ''}`
    const row = objectSizeAudit.find((x) => x.objectType === kind)
    if (!row?.decodedBytes) return 0
    const size = provider === 'aws' ? row.gzip6Bytes : mode === 'brotli5' ? row.recompressedBrotli5Bytes : row.recompressedGzip6Bytes
    return size
  }
  if (url.endsWith('/index.html') || (!url.startsWith('/_artifacts/') && !url.startsWith('/_indexes/')) && !url.startsWith('/assets/')) return Number(response.decodedBytes || 0)
  if (url.endsWith('.gz')) return Number(response.encodedBytes || 0)
  const baseIndexKind = url.endsWith('/index.json') ? 'site-index' : url.endsWith('/manifest.json') ? 'search-manifest' : ''
  const indexKind = baseIndexKind ? `${baseIndexKind}-${url.match(/scale-(\d+)/)?.[1] ?? ''}` : ''
  if (response.contentEncoding && (provider === 'aws' || !indexKind)) return Number(response.encodedBytes || 0)
  const decoded = Number(response.decodedBytes || 0)
  const contentLength = Number(response.httpMetadata?.['content-length'] ?? 0)
  const eligibleType = cloudFrontCompressionConditions.eligibleContentTypes.includes(contentType)
  if (!eligibleType || !contentLength || decoded < cloudFrontCompressionConditions.minimumBytes || decoded > cloudFrontCompressionConditions.maximumBytes) return decoded
  const ext = indexKind || (url.startsWith('/assets/') ? `app-asset-${pathExt(url)}` : pathExt(url))
  const row = objectSizeAudit.find((x) => x.objectType === ext)
  if (!row || !row.decodedBytes) return decoded
  const size = provider === 'aws' ? (mode === 'brotli5' ? row.brotli5Bytes : row.gzip6Bytes)
    : (mode === 'brotli5' ? row.recompressedBrotli5Bytes : row.recompressedGzip6Bytes)
  return decoded * size / row.decodedBytes
}
const pathExt = (url) => url.split('?')[0].split('/').pop().split('.').pop().toLowerCase()
function projectCompression(vector, mode, audit, provider) {
  const responses = vector.responses ?? []
  const bodyBytes = responses.reduce((n, response) => n + compressedResponseBytes(response, mode, audit, { provider }), 0)
  return { ...numericMetrics(vector), bodyBytes }
}
const numericMetrics = (vector) => Object.fromEntries(['requests', 'alwaysOriginRequests', 'cacheableRequests', 'browserCacheRequests', 'network200', 'network304'].map((key) => [key, Number(vector?.[key] ?? 0)]))
export function calculate(reader, publishers, { q = 3, reloads = 0, headerBytes = pricing.headerBytes, missRate = 0.1, compression = 'gzip6' } = {}) {
  const scenarios = [
    { name: 'S', sites: 5, pages: 200, publishesPerSiteDay: 2, viewsPerDay: 1000, searchesPerDay: 100 },
    { name: 'M', sites: 30, pages: 2000, publishesPerSiteDay: 5, viewsPerDay: 20000, searchesPerDay: 2000 },
    { name: 'L', sites: 31, pages: 2000, publishesPerSiteDay: 5, viewsPerDay: 100000, searchesPerDay: 10000 },
  ]
  const profiles = reader.profiles?.unthrottled ?? reader.profiles ?? {}
  const traces = (count) => profiles[`scale-${count}`]?.hostingCost ?? []
  const sizeAudit = reader.data?.objectSizeAudit ?? []
  const numericVector = (v) => Object.fromEntries(['bodyBytes', 'requests', 'alwaysOriginRequests', 'cacheableRequests', 'browserCacheRequests', 'network200', 'network304'].map((key) => [key, Number(v?.[key] ?? 0)]))
  const indexReloadVariant = (vector, changed) => {
    if (!changed) return vector
    let changedCount = 0
    const responses = (vector.responses ?? []).map((response) => {
      if (response.url?.endsWith('/index.json') && Number(response.status) === 304) { changedCount++; return { ...response, status: 200, indexChanged: true } }
      return response
    })
    return { ...vector, responses, network304: Math.max(0, Number(vector.network304 || 0) - changedCount), network200: Number(vector.network200 || 0) + changedCount }
  }
  const meanVector = (items, mode, provider, indexChanged = false) => averageVectors(items.map((x) => projectCompression(x.vector ?? indexReloadVariant(x, indexChanged), mode, sizeAudit, provider)))
  const traceVectors = (count, mode, provider, indexChanged) => {
    const sessions = traces(count)
    if (!sessions.length) throw new Error(`reader measurements missing for scale-${count}`)
    const initial = [], later = [], reload = [], search = []
    for (const sample of sessions) {
      const actions = sample.reader?.sessionActions ?? []
      if (actions.length !== 3) throw new Error(`scale-${count} iteration must contain three document actions`)
      initial.push(actions[0]); later.push(actions[1], actions[2]); reload.push(sample.reader.reload)
      if ((sample.searches ?? []).length !== 2) throw new Error(`scale-${count} iteration must contain latency and quokkaflux searches`)
      search.push(...sample.searches)
    }
    return { C: meanVector(initial, mode, provider), W: meanVector(later, mode, provider), R: meanVector(reload, mode, provider, indexChanged), search: search.map((x) => ({ ...x, vector: projectCompression(x.vector, mode, sizeAudit, provider) })) }
  }
  const getTraces = (mode, provider, indexChanged) => ({ 1000: traceVectors(1000, mode, provider, indexChanged), 5000: traceVectors(5000, mode, provider, indexChanged), 50000: traceVectors(50000, mode, provider, indexChanged) })
  const publisherFor = (provider, size) => publishers[provider]?.[size]
  const phase = (probe, label) => probe?.phases?.find((x) => x.name === label)
  const requests = (p, type) => Number(p?.callCounts?.[type] ?? 0)
  const monthlyPublish = (scenario) => {
    const groups = scenario.name === 'L' ? [{ size: 5000, sites: 30 }, { size: 50000, sites: 1 }]
      : [{ size: scenario.name === 'S' ? 1000 : 5000, sites: scenario.sites }]
    const result = { classA: 0, classB: 0, storageBytes: 0, invalidationPaths: 0, r2StorageBytes: 0, r2ClassA: 0, r2ClassB: 0 }
    for (const group of groups) {
      const changes = scenario.publishesPerSiteDay * pricing.monthDays * group.sites
      for (const provider of ['aws', 'plain']) {
        const probe = publisherFor(provider, group.size)
        if (!probe) throw new Error(`missing ${provider} publisher probe for ${group.size}`)
        const initial = phase(probe, 'first publish'), changed = phase(probe, 'one-document change')
        if (!initial || !changed) throw new Error(`${provider} publisher probe ${group.size} lacks first/change phases`)
        const a = group.sites * (requests(initial, 'PUT') + requests(initial, 'LIST')) + changes * (requests(changed, 'PUT') + requests(changed, 'LIST'))
        const b = group.sites * (requests(initial, 'GET') + requests(initial, 'HEAD')) + changes * (requests(changed, 'GET') + requests(changed, 'HEAD'))
        if (provider === 'aws') {
          result.classA += a; result.classB += b
          result.storageBytes += group.sites * (Number(probe.storedProjectionBytes) + Number(probe.publishStateGzipBytes))
          result.invalidationPaths += group.sites * Number(initial.awsProviderPathCount) + changes * Number(changed.awsProviderPathCount)
        } else {
          result.r2ClassA += a; result.r2ClassB += b
          result.r2StorageBytes += group.sites * (Number(probe.storedProjectionBytes) + Number(probe.publishStateGzipBytes))
        }
      }
    }
    return result
  }
  function monthlyReader(scenario, size, trace, allTraces, qValue = q, reloadCount = reloads, rate = missRate, header = headerBytes) {
    const views = scenario.viewsPerDay * pricing.monthDays
    const session = sessionVector(trace.C, trace.W, trace.R, views, qValue, reloadCount)
    const searchTrace = allTraces[size].search
    const perQuery = searchTrace.reduce((acc, x) => addVectors(acc, numericVector(x.vector)), {})
    const queryCount = scenario.searchesPerDay * pricing.monthDays / 2 / searchTrace.length
    const searchIncrement = scaleVector(perQuery, queryCount)
    const total = addVectors(session, searchIncrement)
    const reqCount = Number(total.requests || 0), bodyBytes = Number(total.bodyBytes || 0)
    return { ...total, bodyBytes, viewerBytes: bodyBytes + reqCount * header, viewerRequests: reqCount, headerBytes: reqCount * header,
      originRequests: Number(total.alwaysOriginRequests || 0) + rate * Number(total.cacheableRequests || 0),
      sessions: views / qValue, pageViews: views, searchIncrement }
  }
  function oneScenario(scenario, rate = missRate, qValue = q, reloadCount = reloads, header = headerBytes, mode = compression, reloadIndexChanged = false) {
    const tracesBySize = getTraces(mode, 'aws', reloadIndexChanged)
    const r2TracesBySize = getTraces(mode, 'r2', reloadIndexChanged)
    const select = scenario.name === 'S' ? 1000 : 5000
    const trace = tracesBySize[select]
    const readerUse = monthlyReader(scenario, select, trace, tracesBySize, qValue, reloadCount, rate, header)
    let readerBytes = readerUse.viewerBytes, readerRequests = readerUse.viewerRequests, originReadsTotal = readerUse.originRequests
    if (scenario.name === 'L') {
      const largePart = monthlyReader({ ...scenario, viewsPerDay: scenario.viewsPerDay / 31, searchesPerDay: scenario.searchesPerDay / 31 }, 50000, tracesBySize[50000], tracesBySize, qValue, reloadCount, rate, header)
      const regularPart = monthlyReader({ ...scenario, viewsPerDay: scenario.viewsPerDay * 30 / 31, searchesPerDay: scenario.searchesPerDay * 30 / 31 }, 5000, tracesBySize[5000], tracesBySize, qValue, reloadCount, rate, header)
      readerBytes = regularPart.viewerBytes + largePart.viewerBytes
      readerRequests = regularPart.viewerRequests + largePart.viewerRequests
      originReadsTotal = regularPart.originRequests + largePart.originRequests
    }
    let r2ReaderUse = monthlyReader(scenario, select, r2TracesBySize[select], r2TracesBySize, qValue, reloadCount, rate, header)
    if (scenario.name === 'L') {
      const largePart = monthlyReader({ ...scenario, viewsPerDay: scenario.viewsPerDay / 31, searchesPerDay: scenario.searchesPerDay / 31 }, 50000, r2TracesBySize[50000], r2TracesBySize, qValue, reloadCount, rate, header)
      const regularPart = monthlyReader({ ...scenario, viewsPerDay: scenario.viewsPerDay * 30 / 31, searchesPerDay: scenario.searchesPerDay * 30 / 31 }, 5000, r2TracesBySize[5000], r2TracesBySize, qValue, reloadCount, rate, header)
      r2ReaderUse = { viewerBytes: regularPart.viewerBytes + largePart.viewerBytes, viewerRequests: regularPart.viewerRequests + largePart.viewerRequests,
        originRequests: regularPart.originRequests + largePart.originRequests }
    }
    const awsPub = monthlyPublish(scenario), r2Pub = awsPub
    const transferGB = readerBytes / 1e9
    const storageGiB = awsPub.storageBytes / (1024 ** 3)
    const aws = {
      storage: storageGiB * pricing.aws.storageGiBMonth,
      publisherRequests: awsPub.classA * pricing.aws.classA + awsPub.classB * pricing.aws.classB,
      readerOriginRequests: originReadsTotal * pricing.aws.classB,
      viewerRequestsUS: cloudFrontViewerRequestCost(readerRequests, pricing.aws.viewerRequestUS),
      viewerRequestsPC100: cloudFrontViewerRequestCost(readerRequests, pricing.aws.viewerRequestPC100),
      transfer: transferCostGB(transferGB),
      invalidation: invalidationCost(awsPub.invalidationPaths),
      transferGB, invalidationPaths: awsPub.invalidationPaths,
    }
    aws.usCanada = aws.storage + aws.publisherRequests + aws.readerOriginRequests + aws.viewerRequestsUS + aws.transfer + aws.invalidation
    aws.pc100Upper = aws.usCanada + aws.viewerRequestsPC100 - aws.viewerRequestsUS
    const r2StorageGB = r2Pub.r2StorageBytes / 1e9
    const r2ClassB = r2Pub.r2ClassB + r2ReaderUse.originRequests
    const r2Gross = r2StorageGB * pricing.r2.storageGBMonth + r2Pub.r2ClassA * pricing.r2.classA + r2ClassB * pricing.r2.classB
    const r2Net = r2AfterFreeAllowance({ storageGB: r2StorageGB, classA: r2Pub.r2ClassA, classB: r2ClassB }).total
    return { scenario: scenario.name, missRate: rate, assumptions: { q: qValue, reloads: reloadCount, reloadIndexChanged, headerBytes: header, compression }, reader: readerUse, aws, r2: { gross: r2Gross, afterDedicatedFreeAllowance: r2Net, readerTransferGB: r2ReaderUse.viewerBytes / 1e9 } }
  }
  const rows = scenarios.flatMap((scenario) => [0.1, 0.5, 1].map((rate) => oneScenario(scenario, rate, q, reloads, headerBytes, compression)))
  const sensitivities = []
  for (const scenario of scenarios) for (const dimension of [
    ...[1, 3, 5].map((value) => ({ q: value })),
    ...['gzip6', 'brotli5'].map((value) => ({ compression: value })),
    ...[0, 1].map((value) => ({ reloads: value })),
    ...[false, true].map((value) => ({ reloads: 1, reloadIndexChanged: value })),
    ...[512, 1024, 2048].map((value) => ({ headerBytes: value })),
  ]) sensitivities.push({ scenario: scenario.name, ...dimension, rows: [0.1, 0.5, 1].map((rate) => oneScenario(scenario, rate, dimension.q ?? q, dimension.reloads ?? reloads, dimension.headerBytes ?? headerBytes, dimension.compression ?? compression, dimension.reloadIndexChanged ?? false)) })
  const baselineVectors = getTraces(compression, 'aws', false)
  const publisherEvidence = {}
  for (const provider of ['plain', 'aws']) {
    publisherEvidence[provider] = {}
    for (const size of [1000, 5000, 50000]) {
      const probe = publisherFor(provider, size)
      publisherEvidence[provider][size] = { sourceRevision: probe?.sourceRevision, provider: probe?.provider, pages: probe?.pages,
        sourceBytes: probe?.sourceBytes, storedProjectionBytes: probe?.storedProjectionBytes, storedSearchBytes: probe?.storedSearchBytes,
        publishStateGzipBytes: probe?.publishStateGzipBytes, generatedJSONValidation: probe?.generatedJSONValidation,
        phaseSummaries: probe?.phases?.map(({ name, outcome, callCounts, invalidationPathCount, awsProviderPathCount, getBodyBytes, listJSONBytes, putBodyBytes }) =>
          ({ name, outcome, callCounts, invalidationPathCount, awsProviderPathCount, getBodyBytes, listJSONBytes, putBodyBytes })) }
    }
  }
  return { schemaVersion: 1, pricing, calculation: { q, reloads, headerBytes, compression, cloudFrontCompressionConditions,
    measurementBoundary: 'local compressed fixture proxy; no AWS billing or CloudFront delivery was measured' },
    evidence: { readerMeasuredAt: reader.measuredAt, readerConditions: reader.conditions, readerEnvironment: reader.environment,
      generator: reader.data?.generatorVersion, seed: reader.data?.seed, objectSizeAudit: sizeAudit,
      readerVectors: Object.fromEntries(Object.entries(baselineVectors).map(([size, values]) => [size, { C: values.C, W: values.W, R: values.R }])),
      publisher: publisherEvidence }, scenarios: rows, sensitivities }
}

function args(argv) {
  const out = {}; for (let i = 0; i < argv.length; i++) { const k = argv[i].replace(/^--/, ''), v = argv[++i]; if (!['reader', 'publisher-log-dir', 'output'].includes(k) || v === undefined) throw new Error(`invalid argument ${k}`); out[k] = v }
  for (const k of ['reader', 'publisher-log-dir', 'output']) if (!out[k]) throw new Error(`--${k} is required`)
  return out
}
function main() {
  const options = args(process.argv.slice(2)), reader = JSON.parse(readFileSync(options.reader, 'utf8'))
  const publishers = {}
  for (const [size, count] of [[1000, '1000'], [5000, '5000'], [50000, '50000']]) for (const provider of ['plain', 'aws']) {
    const filename = path.join(options['publisher-log-dir'], `${provider}-${count}.log`)
    const raw = readFileSync(filename, 'utf8').match(/HOSTING_COST_JSON=(\{.*\})/)
    if (!raw) throw new Error(`missing HOSTING_COST_JSON in ${filename}`)
    const probe = JSON.parse(raw[1])
    if (probe.provider !== provider || probe.pages !== size) throw new Error(`probe identity mismatch in ${filename}: provider=${probe.provider}, pages=${probe.pages}`)
    publishers[provider] ??= {}; publishers[provider][size] = probe
  }
  const output = calculate(reader, publishers)
  mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true }); writeFileSync(options.output, `${JSON.stringify(output, null, 2)}\n`)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
