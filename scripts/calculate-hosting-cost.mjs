#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

export const pricing = Object.freeze({
  date: '2026-10-18', monthDays: 30, headerBytes: 1024,
  r2: { storageGBMonth: 0.015, classA: 4.5 / 1e6, classB: 0.36 / 1e6, freeGB: 10, freeA: 1e6, freeB: 10e6 },
  aws: { storageGiBMonth: 0.023, classA: 0.005 / 1000, classB: 0.0004 / 1000,
    viewerRequestFree: 10e6, viewerRequestUS: 0.010 / 10000, viewerRequestPC100: 0.012 / 10000,
    functionFree: 2e6, functionPerMillion: 0.10 / 1e6, invalidationFree: 1000, invalidationPath: 0.005,
    transferFreeGB: 1000, transferTiers: [{ limitGB: 9000, rate: 0.085 }, { limitGB: 40000, rate: 0.08 }, { limitGB: 100000, rate: 0.06 }] },
})
const cli06Pricing = Object.freeze({
  ...pricing,
  aws: Object.freeze(Object.fromEntries(Object.entries(pricing.aws).filter(([key]) => key !== 'invalidationFree' && key !== 'invalidationPath'))),
})
export const cloudFrontCompressionConditions = Object.freeze({
  minimumBytes: 1000, maximumBytes: 10000000, eligibleContentTypes: [
    'application/javascript', 'application/json', 'application/xml', 'image/svg+xml',
    'text/css', 'text/html', 'text/javascript', 'text/plain', 'text/xml',
  ], source: 'https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html',
})

export function sanitizedRequestHeaders(headers = {}) {
  const secretHeader = /(authorization|cookie|token|api[-_]key|secret)/i
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, secretHeader.test(name) ? '[REDACTED]' : String(value)]))
}

export function conditionalHeaderEvidence(headers = {}, source = 'absent') {
  const get = (wanted) => {
    const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === wanted.toLowerCase())
    return entry ? { present: true, value: String(entry[1]) } : { present: false, value: null }
  }
  return { source, ifNoneMatch: get('if-none-match'), ifModifiedSince: get('if-modified-since') }
}

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
export function cloudFrontFunctionCost(invocations) {
  return Math.max(0, invocations - pricing.aws.functionFree) * pricing.aws.functionPerMillion
}
export function r2AfterFreeAllowance({ storageGB, classA, classB }) {
  const storage = Math.max(0, storageGB - pricing.r2.freeGB) * pricing.r2.storageGBMonth
  const requestsA = Math.max(0, classA - pricing.r2.freeA) * pricing.r2.classA
  const requestsB = Math.max(0, classB - pricing.r2.freeB) * pricing.r2.classB
  return { storage, classA: requestsA, classB: requestsB, total: storage + requestsA + requestsB }
}
export function r2RoundedAfterFreeAllowance({ storageGB, classA, classB }) {
  const rounded = {
    storageGB: Math.ceil(Math.max(0, storageGB - pricing.r2.freeGB)),
    classA: Math.ceil(Math.max(0, classA - pricing.r2.freeA) / 1e6) * 1e6,
    classB: Math.ceil(Math.max(0, classB - pricing.r2.freeB) / 1e6) * 1e6,
  }
  const storage = rounded.storageGB * pricing.r2.storageGBMonth
  const requestsA = rounded.classA * pricing.r2.classA
  const requestsB = rounded.classB * pricing.r2.classB
  return { ...rounded, total: storage + requestsA + requestsB }
}

function legacyNumber(value) { return Number(String(value).replace(/[$,]/g, '').trim()) }
function rowsInTable(markdown, header) {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => line.includes(header))
  if (start < 0) throw new Error(`legacy report is missing table header: ${header}`)
  const rows = []
  for (let i = start + 1; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    if (/^\|\s*:?-+/.test(lines[i])) continue
    rows.push(lines[i].split('|').slice(1, -1).map((cell) => cell.trim()))
  }
  return rows
}

export function parseLegacyModel(markdown) {
  const subtotalRows = rowsInTable(markdown, '| Scenario | CDN miss rate | R2 gross')
  const totals = new Map(subtotalRows.map(([scenario, miss, r2, awsUS, awsPC]) => {
    const [gross, net] = r2.match(/\$([\d,.]+)\s*\(\$([\d,.]+)\)/)?.slice(1).map(legacyNumber) ?? []
    if (![gross, net].every(Number.isFinite)) throw new Error(`cannot parse legacy R2 subtotal: ${r2}`)
    return [`${scenario}:${Number(miss.replace('%', '')) / 100}`, { r2Gross: gross, r2Net: net, awsUS: legacyNumber(awsUS), awsPC: legacyNumber(awsPC) }]
  }))
  if (totals.size !== 9) throw new Error(`legacy report must contain nine subtotal rows; found ${totals.size}`)

  const workloadRows = rowsInTable(markdown, '| Scenario | Sites and modeled pages | Publishes | Previews/week | Page views/day | Searches/day |')
  const workload = Object.fromEntries(workloadRows.map(([scenario, , , , views, searches]) => [scenario, { viewsPerDay: legacyNumber(views), searchesPerDay: legacyNumber(searches) }]))
  const storageLine = markdown.match(/monthly storage inputs include[^\n]*: S ([\d,.]+) MB, M ([\d,.]+) MB, L ([\d,.]+) MB/i)
  if (!storageLine) throw new Error('legacy report is missing monthly storage inputs')
  const storageMB = Object.fromEntries(['S', 'M', 'L'].map((name, i) => [name, legacyNumber(storageLine[i + 1])]))

  const documentRow = rowsInTable(markdown, '| Reader action | Requests | Transferred bytes | Boundary |')
    .find((row) => row[0].startsWith('Cold document view'))
  const documentBytes = documentRow?.[2].match(/[\d,]+/g)?.map(legacyNumber)
  if (!documentBytes || documentBytes.length < 4) throw new Error('legacy report is missing cold document byte measurements')
  const broad = rowsInTable(markdown, '| Reader action | Requests | Transferred bytes | Boundary |').find((row) => row[0].includes('Full-text broad'))
  const short = rowsInTable(markdown, '| Reader action | Requests | Transferred bytes | Boundary |').find((row) => row[0].includes('Full-text short'))
  const queryInputs = [broad, short].map((row) => {
    const requests = Number(row?.[1].match(/(\d+) total/)?.[1])
    const bytes = Number(row?.[2].match(/([\d,]+) total/)?.[1]?.replace(/,/g, ''))
    if (!Number.isFinite(requests) || !Number.isFinite(bytes)) throw new Error('legacy report is missing full-text query counts or bytes')
    return { requests, bytes }
  })

  const publishingStart = markdown.indexOf('## Measured publishing units')
  const publishingEnd = markdown.indexOf('\n## ', publishingStart + 4)
  const publishingText = markdown.slice(publishingStart, publishingEnd < 0 ? undefined : publishingEnd)
  const publisherRows = new Map()
  for (const line of publishingText.split(/\r?\n/)) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (!/^(1,000|5,000|50,000)$/.test(cells[0] ?? '')) continue
    const parseCalls = (cell) => cell.split(';')[0].split('/').map(legacyNumber)
    const first = parseCalls(cells[1]), changed = parseCalls(cells[3])
    if (first.length !== 6 || changed.length !== 6) throw new Error(`cannot parse publisher calls for ${cells[0]}`)
    const firstPaths = cells[1].split(';')[2]?.split('/').map(legacyNumber) ?? []
    const changedPaths = cells[3].split(';')[2]?.split('/').map(legacyNumber) ?? []
    publisherRows.set(Number(cells[0].replace(/,/g, '')), { first, changed, initialAwsPaths: firstPaths[0], changedAwsPaths: changedPaths[0] })
  }
  if (publisherRows.size !== 3) throw new Error(`legacy report must contain three publisher rows; found ${publisherRows.size}`)
  return { totals, workload, storageMB, documentBytes: { 1000: documentBytes[0], 5000: documentBytes[1], 50000: documentBytes[3] }, queryInputs, publisherRows }
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
  if (response.indexChanged) {
    const url = response.url ?? ''
    const kind = `${url.endsWith('/index.json') ? 'site-index' : 'search-manifest'}-${url.match(/scale-(\d+)/)?.[1] ?? ''}`
    const row = objectSizeAudit.find((x) => x.objectType === kind)
    if (!row?.decodedBytes) return 0
    const size = provider === 'aws' ? row.gzip6Bytes : mode === 'brotli5' ? row.recompressedBrotli5Bytes : row.recompressedGzip6Bytes
    return size
  }
  if (status === 304 || response.fromCache || isInferredMemoryCacheHit(response)) return 0
  if (status !== 200) return Number(response.encodedBytes || 0)
  const url = response.url ?? ''
  const contentType = String(response.contentType ?? '').toLowerCase()
  if (url.endsWith('/index.html') || (!url.startsWith('/_artifacts/') && !url.startsWith('/_indexes/')) && !url.startsWith('/assets/')) return Number(response.decodedBytes || 0)
  if (url.endsWith('.gz')) return Number(response.encodedBytes || 0)
  const baseIndexKind = url.endsWith('/index.json') ? 'site-index' : url.endsWith('/manifest.json') ? 'search-manifest' : ''
  const indexKind = baseIndexKind ? `${baseIndexKind}-${url.match(/scale-(\d+)/)?.[1] ?? ''}` : ''
  if (response.contentEncoding && (provider === 'aws' || !indexKind)) return Number(response.encodedBytes || 0)
  const decoded = Number(response.decodedBytes || 0)
  const contentLength = Number(response.httpMetadata?.['content-length'] || decoded)
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
function isInferredMemoryCacheHit(response) {
  return Number(response.status) === 200 && response.encodedBytes != null && Number(response.encodedBytes) === 0 && !response.fromCache
}
export function projectCompression(vector, mode, audit, provider) {
  const responses = vector.responses ?? []
  const bodyBytes = responses.reduce((n, response) => n + compressedResponseBytes(response, mode, audit, { provider }), 0)
  const metrics = numericMetrics(vector)
  const inferredMemoryCacheHits = responses.filter(isInferredMemoryCacheHit).length
  if (inferredMemoryCacheHits) {
    metrics.requests = Math.max(0, metrics.requests - inferredMemoryCacheHits)
    metrics.network200 = Math.max(0, metrics.network200 - inferredMemoryCacheHits)
    metrics.browserCacheRequests += inferredMemoryCacheHits
    metrics.cacheableRequests = Math.max(0, metrics.cacheableRequests - inferredMemoryCacheHits)
  }
  return { ...metrics, bodyBytes }
}
const numericMetrics = (vector) => Object.fromEntries(['requests', 'alwaysOriginRequests', 'cacheableRequests', 'browserCacheRequests', 'network200', 'network304'].map((key) => [key, Number(vector?.[key] ?? 0)]))
export function calculate(reader, publishers, { q = 3, reloads = 0, headerBytes = pricing.headerBytes, missRate = 0.1, compression = 'gzip6', legacyMarkdown = null } = {}) {
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
    const assumptions = { q: qValue, reloads: reloadCount, reloadIndexChanged, headerBytes: header, compression, missRate: rate }
    return { scenario: scenario.name, missRate: rate, assumptions, reader: readerUse, aws, r2: { gross: r2Gross, afterDedicatedFreeAllowance: r2Net, readerTransferGB: r2ReaderUse.viewerBytes / 1e9 } }
  }
  const rows = scenarios.flatMap((scenario) => [0.1, 0.5, 1].map((rate) => oneScenario(scenario, rate, q, reloads, headerBytes, compression)))
  const sensitivities = []
  for (const scenario of scenarios) for (const dimension of [
    ...[1, 3, 5].map((value) => ({ q: value })),
    ...['gzip6', 'brotli5'].map((value) => ({ compression: value })),
    ...[0, 1].map((value) => ({ reloads: value })),
    ...[false, true].map((value) => ({ reloads: 1, reloadIndexChanged: value })),
    ...[512, 1024, 2048].map((value) => ({ headerBytes: value })),
  ]) {
    const assumptions = { q: dimension.q ?? q, reloads: dimension.reloads ?? reloads,
      reloadIndexChanged: dimension.reloadIndexChanged ?? false, headerBytes: dimension.headerBytes ?? headerBytes,
      compression: dimension.compression ?? compression }
    sensitivities.push({ scenario: scenario.name, ...dimension, rows: [0.1, 0.5, 1].map((rate) => {
      const row = oneScenario(scenario, rate, assumptions.q, assumptions.reloads, assumptions.headerBytes,
        assumptions.compression, assumptions.reloadIndexChanged)
      return { ...row, sensitivity: { ...assumptions, missRate: rate } }
    }) })
  }
  const decomposition = legacyMarkdown ? makeDecomposition(legacyMarkdown) : null
  function makeDecomposition(markdown) {
    const legacy = parseLegacyModel(markdown)
    const awsTraces = getTraces(compression, 'aws', false)
    const r2Traces = getTraces(compression, 'r2', false)
    const sumNewUsage = (scenario, tracesBySize, rate, headers) => {
      const use = (partial, size) => monthlyReader(partial, size, tracesBySize[size], tracesBySize, q, 0, rate, headers)
      if (scenario.name !== 'L') return use(scenario, scenario.name === 'S' ? 1000 : 5000)
      const regular = use({ ...scenario, viewsPerDay: scenario.viewsPerDay * 30 / 31, searchesPerDay: scenario.searchesPerDay * 30 / 31 }, 5000)
      const large = use({ ...scenario, viewsPerDay: scenario.viewsPerDay / 31, searchesPerDay: scenario.searchesPerDay / 31 }, 50000)
      return addVectors(regular, large)
    }
    const oldInputs = (scenario, rate) => {
      const source = legacy.workload[scenario.name]
      if (!source) throw new Error(`legacy workload inputs missing for ${scenario.name}`)
      const views = source.viewsPerDay * pricing.monthDays
      const fullTextQueries = source.searchesPerDay * pricing.monthDays / 2
      const oldDocBytes = scenario.name === 'S' ? legacy.documentBytes[1000]
        : scenario.name === 'M' ? legacy.documentBytes[5000]
          : (legacy.documentBytes[5000] * 30 + legacy.documentBytes[50000]) / 31
      const oldSearchBytesPerQuery = legacy.queryInputs.reduce((sum, x) => sum + x.bytes, 0) / 2
      const oldSearchRequestsPerQuery = legacy.queryInputs.reduce((sum, x) => sum + x.requests, 0) / 2
      const oldReaderBytes = views * oldDocBytes + fullTextQueries * oldSearchBytesPerQuery
      const oldViewerRequests = views * 35 + fullTextQueries * oldSearchRequestsPerQuery
      const oldOriginRequests = views * (1 + 34 * rate) + fullTextQueries * oldSearchRequestsPerQuery * rate
      const groups = scenario.name === 'L' ? [{ size: 5000, sites: 30 }, { size: 50000, sites: 1 }]
        : [{ size: scenario.name === 'S' ? 1000 : 5000, sites: scenario.sites }]
      const calls = { classA: 0, classB: 0, invalidationPaths: 0 }
      for (const group of groups) {
        const row = legacy.publisherRows.get(group.size)
        const changes = scenario.publishesPerSiteDay * pricing.monthDays * group.sites
        calls.classA += group.sites * (row.first[2] + row.first[3]) + changes * (row.changed[2] + row.changed[3])
        calls.classB += group.sites * (row.first[0] + row.first[1]) + changes * (row.changed[0] + row.changed[1])
        calls.invalidationPaths += group.sites * row.initialAwsPaths + changes * row.changedAwsPaths
      }
      return { views, fullTextQueries, oldDocBytes, oldSearchBytes: fullTextQueries * oldSearchBytesPerQuery,
        oldSearchRequestsPerQuery, oldReaderBytes, oldViewerRequests, oldOriginRequests, publisher: calls }
    }
    const rounded = (n) => Number(n.toFixed(2))
    const stages = []
    for (const scenario of scenarios) for (const rate of [0.1, 0.5, 1]) {
      const key = `${scenario.name}:${rate}`
      const target = rows.find((row) => row.scenario === scenario.name && row.missRate === rate)
      const old = legacy.totals.get(key)
      if (!old || !target) throw new Error(`decomposition endpoint missing for ${key}`)
      const oldInput = oldInputs(scenario, rate)
      const oldStorageGB = legacy.storageMB[scenario.name] / 1000
      const oldStorageGiB = legacy.storageMB[scenario.name] / 1024
      const oldStorageAWS = oldStorageGiB * pricing.aws.storageGiBMonth
      const oldStorageR2 = oldStorageGB * pricing.r2.storageGBMonth
      const oldPubAWS = oldInput.publisher.classA * pricing.aws.classA + oldInput.publisher.classB * pricing.aws.classB
      const oldPubR2 = oldInput.publisher.classA * pricing.r2.classA + oldInput.publisher.classB * pricing.r2.classB
      const oldOriginAWS = oldInput.oldOriginRequests * pricing.aws.classB
      const oldOriginR2 = oldInput.oldOriginRequests * pricing.r2.classB
      const oldR2Request = oldPubR2 + oldOriginR2
      const oldViewerUS = cloudFrontViewerRequestCost(oldInput.oldViewerRequests, pricing.aws.viewerRequestUS)
      const oldViewerPC = cloudFrontViewerRequestCost(oldInput.oldViewerRequests, pricing.aws.viewerRequestPC100)
      const oldTransfer = transferCostGB(oldInput.oldReaderBytes / 1e9)
      const oldInvalidation = invalidationCost(oldInput.publisher.invalidationPaths)
      const legacyR2Free = r2AfterFreeAllowance({ storageGB: oldStorageGB, classA: oldInput.publisher.classA, classB: oldInput.publisher.classB + oldInput.oldOriginRequests }).total
      const oldComponents = { awsUS: oldStorageAWS + oldPubAWS + oldOriginAWS + oldViewerUS + oldTransfer + oldInvalidation,
        awsPC100: oldStorageAWS + oldPubAWS + oldOriginAWS + oldViewerPC + oldTransfer + oldInvalidation,
        r2Gross: oldStorageR2 + oldR2Request, r2AfterDedicatedFree: legacyR2Free }
      const oldArchived = { awsUS: old.awsUS, awsPC100: old.awsPC, r2Gross: old.r2Gross, r2AfterDedicatedFree: old.r2Net }
      for (const series of Object.keys(oldComponents)) if (rounded(oldComponents[series]) !== oldArchived[series]) {
        throw new Error(`legacy input components do not match archived total ${key} ${series}: ${rounded(oldComponents[series])} vs ${oldArchived[series]}`)
      }

      const selected = scenario.name === 'S' ? 1000 : 5000
      const viewsPerMonth = scenario.viewsPerDay * pricing.monthDays
      const fullTextQueries = oldInput.fullTextQueries
      const sizeMix = scenario.name === 'L' ? [[5000, 30 / 31], [50000, 1 / 31]] : [[selected, 1]]
      const bodyFor = (vectors, keyName) => sizeMix.reduce((total, [size, weight]) => {
        const vector = vectors[size][keyName]
        return total + weight * Number(vector.bodyBytes || 0)
      }, 0)
      const coldBody = bodyFor(awsTraces, 'C') * viewsPerMonth
      const sessionBody = sizeMix.reduce((total, [size, weight]) => {
        const v = awsTraces[size]
        return total + weight * viewsPerMonth / 3 * (v.C.bodyBytes + 2 * v.W.bodyBytes)
      }, 0)
      const oldSearchBody = oldInput.oldSearchBytes
      const newSearchPerQuery = sizeMix.reduce((total, [size, weight]) => {
        const queryVectors = awsTraces[size].search
        return total + weight * queryVectors.reduce((sum, x) => sum + Number(x.vector.bodyBytes || 0), 0) / queryVectors.length
      }, 0)
      const newSearchBody = fullTextQueries * newSearchPerQuery
      const phase1Transfer = transferCostGB((coldBody + oldSearchBody) / 1e9)
      const phase2Transfer = transferCostGB((sessionBody + oldSearchBody) / 1e9)
      const phase3Transfer = transferCostGB((sessionBody + newSearchBody) / 1e9)
      const newAwsUsage = sumNewUsage(scenario, awsTraces, rate, headerBytes)
      const newR2Usage = sumNewUsage(scenario, r2Traces, rate, headerBytes)
      const newPublisher = monthlyPublish(scenario)
      const newAwsRequestUS = target.aws.publisherRequests + target.aws.readerOriginRequests + target.aws.viewerRequestsUS
      const newAwsRequestPC = target.aws.publisherRequests + target.aws.readerOriginRequests + target.aws.viewerRequestsPC100
      const oldAwsRequestUS = oldPubAWS + oldOriginAWS + oldViewerUS
      const oldAwsRequestPC = oldPubAWS + oldOriginAWS + oldViewerPC
      const newR2Request = newPublisher.r2ClassA * pricing.r2.classA + (newPublisher.r2ClassB + newR2Usage.originRequests) * pricing.r2.classB
      const newR2BeforeStorageNet = r2AfterFreeAllowance({ storageGB: oldStorageGB, classA: newPublisher.r2ClassA,
        classB: newPublisher.r2ClassB + newR2Usage.originRequests }).total
      const newR2FinalNet = r2AfterFreeAllowance({ storageGB: newPublisher.r2StorageBytes / 1e9, classA: newPublisher.r2ClassA,
        classB: newPublisher.r2ClassB + newR2Usage.originRequests }).total
      const legacyR2BeforeStorageNet = r2AfterFreeAllowance({ storageGB: oldStorageGB, classA: oldInput.publisher.classA,
        classB: oldInput.publisher.classB + oldInput.oldOriginRequests }).total
      const newStorageAWS = target.aws.storage
      const newStorageR2 = newPublisher.r2StorageBytes / 1e9 * pricing.r2.storageGBMonth
      const newAwsBodyTransfer = target.aws.transfer
      const newR2BodyGB = newR2Usage.viewerBytes / 1e9
      const steps = []
      let awsUS = oldComponents.awsUS, awsPC = oldComponents.awsPC100,
        r2Gross = oldComponents.r2Gross, r2Net = oldComponents.r2AfterDedicatedFree
      const add = (name, delta, heldInputs) => {
        awsUS += delta.awsUS; awsPC += delta.awsPC; r2Gross += delta.r2Gross; r2Net += delta.r2Net
        steps.push({ name, delta: { awsUS: delta.awsUS, awsPC100: delta.awsPC, r2Gross: delta.r2Gross, r2AfterDedicatedFree: delta.r2Net },
          subtotal: { awsUS, awsPC100: awsPC, r2Gross, r2AfterDedicatedFree: r2Net }, inputsHeld: heldInputs })
      }
      add('compression', { awsUS: phase1Transfer - oldTransfer, awsPC: phase1Transfer - oldTransfer, r2Gross: 0, r2Net: 0 },
        { documentViews: 'cold every page view', searchBodyBytes: oldSearchBody, billableRequests: 'legacy', storage: 'legacy' })
      add('sessionReuse', { awsUS: phase2Transfer - phase1Transfer, awsPC: phase2Transfer - phase1Transfer, r2Gross: 0, r2Net: 0 },
        { reloads: 0, searchBodyBytes: oldSearchBody, billableRequests: 'legacy', storage: 'legacy' })
      add('searchTreatment', { awsUS: phase3Transfer - phase2Transfer, awsPC: phase3Transfer - phase2Transfer, r2Gross: 0, r2Net: 0 },
        { documentSessionBodyBytes: sessionBody, queryCountAndMix: 'legacy', billableRequests: 'legacy', storage: 'legacy' })
      const requestAndHeaderTransferDelta = newAwsBodyTransfer - phase3Transfer
      add('requestCount', {
        awsUS: requestAndHeaderTransferDelta + newAwsRequestUS - oldAwsRequestUS,
        awsPC: requestAndHeaderTransferDelta + newAwsRequestPC - oldAwsRequestPC,
        r2Gross: newR2Request - oldR2Request,
        r2Net: newR2BeforeStorageNet - legacyR2BeforeStorageNet,
      }, { documentAndSearchBodyBytes: sessionBody + newSearchBody, storage: 'legacy', headers: headerBytes,
        requests: { oldViewer: oldInput.oldViewerRequests, newViewer: newAwsUsage.requests }, publisherRequests: 'legacy -> measured' })
      add('storage', { awsUS: newStorageAWS - oldStorageAWS, awsPC: newStorageAWS - oldStorageAWS,
        r2Gross: newStorageR2 - oldStorageR2,
        r2Net: newR2FinalNet - newR2BeforeStorageNet },
      { requests: 'measured', storage: 'legacy -> measured' })
      const endpoint = { awsUS: target.aws.usCanada, awsPC100: target.aws.pc100Upper,
        r2Gross: target.r2.gross, r2AfterDedicatedFree: target.r2.afterDedicatedFreeAllowance }
      const actual = steps.at(-1).subtotal
      for (const series of Object.keys(endpoint)) if (Math.abs(actual[series] - endpoint[series]) > 1e-8) {
        throw new Error(`legacy waterfall does not reconcile ${key} ${series}: ${actual[series]} vs ${endpoint[series]}`)
      }
      stages.push({ scenario: scenario.name, missRate: rate, legacy: oldComponents,
        legacyTable: { awsUS: old.awsUS, awsPC100: old.awsPC, r2Gross: old.r2Gross, r2AfterDedicatedFree: old.r2Net },
        steps, new: endpoint,
        verification: { oldR2FreeModelRounded: rounded(legacyR2Free), oldR2GrossComponentsRounded: rounded(oldStorageR2 + oldR2Request),
          oldAWSComponentsRounded: { us: rounded(oldStorageAWS + oldPubAWS + oldOriginAWS + oldViewerUS + oldTransfer + oldInvalidation),
            pc100: rounded(oldStorageAWS + oldPubAWS + oldOriginAWS + oldViewerPC + oldTransfer + oldInvalidation) },
          newReaderBodyBytes: { aws: newAwsUsage.bodyBytes, r2: newR2Usage.bodyBytes }, newR2ReaderGB: newR2BodyGB } })
    }
    return { method: 'fixed-order sequential model substitutions; deltas include interactions in the stated order and are not independent causal effects',
      order: ['compression', 'sessionReuse', 'searchTreatment', 'requestCount', 'storage'],
      note: 'The compression step keeps document views cold for every page view; it also includes the cold-body re-measurement difference and is not a pure compression effect.',
      legacySource: 'docs/research/hosting-cost-model-legacy-2026-10-18.md', stages }
  }
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
      publisher: publisherEvidence }, scenarios: rows, sensitivities, decomposition }
}

// CLI 0.6 models origin work by the URL class owned by the publisher cache policy.
export const cli06OriginRates = Object.freeze({
  siteRoot: 1, mutableContent: 1, appShell: 1, hashedAppAsset: 0.1,
  hashedSearchBlob: 0.5, notFound: 1,
})
const cli06Classes = Object.keys(cli06OriginRates)
const appHashName = /^.+-[A-Za-z0-9_-]{8}\.[^/]+$/
export function classifyCLI06URL(url, status = 200) {
  if (status === 404) return 'notFound'
  const clean = String(url ?? '').split('?')[0]
  if (!clean.startsWith('/')) throw new Error(`unrecognized response URL: ${url}`)
  if (clean === '/' || clean === '/index.html' || (!clean.startsWith('/_') && !clean.startsWith('/assets/'))) return 'appShell'
  if (clean.startsWith('/assets/')) return appHashName.test(path.posix.basename(clean)) ? 'hashedAppAsset' : 'appShell'
  if (/^\/_indexes\/[^/]+\/search\/.+\.gz$/.test(clean)) return 'hashedSearchBlob'
  if (/^\/_indexes\/[^/]+\/search\/manifest\.json$/.test(clean)) return 'mutableContent'
  if (clean === '/_indexes/sites.json') return 'siteRoot'
  if (/^\/_indexes\/[^/]+\/.+$/.test(clean)) return 'siteRoot'
  if (/^\/_artifacts\/[^/]+\/.+$/.test(clean) || /^\/_previews\/[^/]+\/.+$/.test(clean)) return 'mutableContent'
  throw new Error(`unrecognized response URL: ${url}`)
}

export function projectCLI06Vector(vector, mode = 'gzip6', audit = [], provider = 'aws', { reloadIndexChanged = false } = {}) {
  const totals = Object.fromEntries(cli06Classes.map((name) => [name, { networkRequests: 0, bodyBytes: 0, originRequests: 0 }]))
  const responses = vector?.responses ?? []
  for (const response of responses) {
    const changed = reloadIndexChanged && response.url?.endsWith('/index.json') && Number(response.status) === 304
    const effective = changed ? { ...response, status: 200, indexChanged: true } : response
    const status = Number(effective.status)
    if (response.failed || !(status === 200 || status === 304 || status === 404)) throw new Error(`failed or unsupported response status ${status} for ${response.url}`)
    const klass = classifyCLI06URL(response.url, status)
    const target = totals[klass]
    if (response.fromCache) continue
    target.networkRequests++
    if (status === 200 || status === 404) target.bodyBytes += compressedResponseBytes(effective, mode, audit, { provider })
    // A 304 still requires validation at the edge. Its modeled origin work follows the same class rate.
    target.originRequests += cli06OriginRates[klass]
  }
  return totals
}

function compactPublisherProbe(probe) {
  if (probe.headerCheckSummary && probe.perClassObjectCounts && !probe.objects) return probe
  const headers = probe.cachePolicyHeaders ?? {}
  const counts = Object.fromEntries(Object.keys(headers).map((name) => [name, 0]))
  for (const object of probe.objects ?? []) {
    let klass
    if (object.key.startsWith(`_artifacts/${probe.site}/`)) klass = 'artifact'
    else if (object.key.startsWith(`_indexes/${probe.site}/`)) {
      const relative = object.key.slice(`_indexes/${probe.site}/`.length)
      if (relative === 'search/manifest.json') klass = 'search-manifest'
      else if (relative.startsWith('search/') && relative.endsWith('.gz')) klass = 'hashed-asset'
      else klass = 'site-root'
    } else throw new Error(`publisher probe object is outside the measured site projection: ${object.key}`)
    if (!(klass in headers)) throw new Error(`publisher probe cache class ${klass} has no policy header`)
    if (object.cacheControl !== headers[klass]) throw new Error(`publisher probe header mismatch for ${object.key}: ${object.cacheControl}`)
    counts[klass] = (counts[klass] ?? 0) + 1
  }
  const headerCheckSummary = Object.fromEntries(Object.entries(headers).map(([klass, expectedHeader]) => [klass, {
    objectCount: counts[klass] ?? 0, expectedHeader, verified: (counts[klass] ?? 0) > 0,
  }]))
  return {
    cachePolicyRevision: probe.cachePolicyRevision, cachePolicyHeaders: headers, measuredAt: probe.measuredAt,
    provider: probe.provider, sourceRevision: probe.sourceRevision, site: probe.site, pages: probe.pages,
    sourceFiles: probe.sourceFiles, sourceBytes: probe.sourceBytes, counterBoundary: probe.counterBoundary,
    phases: (probe.phases ?? []).map(({ name, outcome, buildSkipped, callCounts, getBodyBytes, listJSONBytes, putBodyBytes, wallMs }) =>
      ({ name, outcome, buildSkipped, callCounts, getBodyBytes, listJSONBytes, putBodyBytes, wallMs })),
    storedProjectionObjects: probe.storedProjectionObjects, storedProjectionBytes: probe.storedProjectionBytes,
    storedSearchObjects: probe.storedSearchObjects, storedSearchBytes: probe.storedSearchBytes,
    publishStateRawBytes: probe.publishStateRawBytes, publishStateGzipBytes: probe.publishStateGzipBytes,
    generatedJSONValidation: probe.generatedJSONValidation, perClassObjectCounts: counts, headerCheckSummary,
  }
}

export function calculateCLI06(reader, publishers, { q = 3, reloads = 0, headerBytes = pricing.headerBytes, compression = 'gzip6', originRates = cli06OriginRates } = {}) {
  const scenarios = [
    { name: 'S', sites: 5, pages: 200, publishesPerSiteDay: 2, viewsPerDay: 1000, searchesPerDay: 100 },
    { name: 'M', sites: 30, pages: 2000, publishesPerSiteDay: 5, viewsPerDay: 20000, searchesPerDay: 2000 },
    { name: 'L', sites: 31, pages: 2000, publishesPerSiteDay: 5, viewsPerDay: 100000, searchesPerDay: 10000 },
  ]
  for (const [name, rate] of Object.entries(originRates)) if (!cli06Classes.includes(name) || rate < 0 || rate > 1) throw new Error(`invalid CLI 0.6 origin rate ${name}=${rate}`)
  const profiles = reader.profiles?.unthrottled ?? reader.profiles ?? {}
  const audit = reader.data?.objectSizeAudit ?? []
  const sizes = [1000, 5000, 50000]
  const traceSet = (size, mode = compression, reloadIndexChanged = false) => {
    const records = profiles[`scale-${size}`]?.hostingCost ?? []
    if (!records.length) throw new Error(`reader measurements missing for scale-${size}`)
    const vectors = { C: [], W: [], R: [], search: [] }
    for (const record of records) {
      const actions = record.reader?.sessionActions ?? []
      if (actions.length !== 3) throw new Error(`scale-${size} iteration must contain three document actions`)
      vectors.C.push(actions[0].vector); vectors.W.push(...actions.slice(1).map((x) => x.vector)); vectors.R.push(record.reader.reload)
      if ((record.searches ?? []).length !== 2) throw new Error(`scale-${size} iteration must contain two search vectors`)
      vectors.search.push(...record.searches.map((x) => x.vector))
    }
    const avg = (items) => {
      const projected = items.map((v) => projectCLI06Vector(v, mode, audit, 'aws', { reloadIndexChanged: reloadIndexChanged && items === vectors.R }))
      return Object.fromEntries(cli06Classes.map((c) => [c, Object.fromEntries(['networkRequests', 'bodyBytes', 'originRequests'].map((k) => [k, projected.reduce((n, x) => n + x[c][k], 0) / projected.length]))]))
    }
    return { C: avg(vectors.C), W: avg(vectors.W), R: avg(vectors.R), search: avg(vectors.search) }
  }
  const traceByMode = Object.fromEntries(['gzip6', 'brotli5'].map((mode) => [mode, Object.fromEntries(sizes.map((size) => [size, traceSet(size, mode)]))]))
  const changedReloadTraces = Object.fromEntries(sizes.map((size) => [size, traceSet(size, compression, true)]))
  const publisherMonth = (scenario) => {
    const groups = scenario.name === 'L' ? [{ size: 5000, sites: 30 }, { size: 50000, sites: 1 }] : [{ size: scenario.name === 'S' ? 1000 : 5000, sites: scenario.sites }]
    const out = { aws: { classA: 0, classB: 0, storageBytes: 0 }, r2: { classA: 0, classB: 0, storageBytes: 0 } }
    for (const group of groups) for (const [name, provider] of [['aws', 'aws'], ['r2', 'plain']]) {
      const evidence = publishers[provider]?.[group.size]
      const phases = evidence?.phases
      const first = phases?.find((x) => x.name === 'first publish'), changed = phases?.find((x) => x.name === 'one-document change')
      if (!evidence || !first || !changed) throw new Error(`missing ${provider} publisher evidence for ${group.size}`)
      const changes = scenario.publishesPerSiteDay * pricing.monthDays * group.sites
      const count = (p, method) => Number(p.callCounts?.[method] || 0)
      out[name].classA += group.sites * (count(first, 'PUT') + count(first, 'LIST')) + changes * (count(changed, 'PUT') + count(changed, 'LIST'))
      out[name].classB += group.sites * (count(first, 'GET') + count(first, 'HEAD')) + changes * (count(changed, 'GET') + count(changed, 'HEAD'))
      out[name].storageBytes += group.sites * (Number(evidence.storedProjectionBytes) + Number(evidence.publishStateGzipBytes))
    }
    return out
  }
  const compute = (scenario, rates, sensitivity = {}) => {
    const qValue = sensitivity.q ?? q, reloadCount = sensitivity.reloads ?? reloads
    const headers = sensitivity.headerBytes ?? headerBytes, mode = sensitivity.compression ?? compression
    const traceBySize = sensitivity.reloadIndexChanged ? changedReloadTraces : traceByMode[mode]
    const breakdown = Object.fromEntries(cli06Classes.map((c) => [c, { requests: 0, bodyBytes: 0, originRequests: 0 }]))
    const weightSets = scenario.name === 'L' ? [[5000, 30 / 31], [50000, 1 / 31]] : [[scenario.name === 'S' ? 1000 : 5000, 1]]
    for (const [size, weight] of weightSets) {
      const t = traceBySize[size], views = scenario.viewsPerDay * pricing.monthDays * weight, sessions = views / qValue
      for (const c of cli06Classes) {
        const sessionActions = (t.C[c].networkRequests + (qValue - 1) * t.W[c].networkRequests + reloadCount * t.R[c].networkRequests) * sessions
        const sessionBytes = (t.C[c].bodyBytes + (qValue - 1) * t.W[c].bodyBytes + reloadCount * t.R[c].bodyBytes) * sessions
        const queryCount = scenario.searchesPerDay * pricing.monthDays / 2 * weight
        breakdown[c].requests += sessionActions + t.search[c].networkRequests * queryCount
        breakdown[c].bodyBytes += sessionBytes + t.search[c].bodyBytes * queryCount
        breakdown[c].originRequests += (t.C[c].networkRequests * sessions + (qValue - 1) * t.W[c].networkRequests * sessions + reloadCount * t.R[c].networkRequests * sessions + t.search[c].networkRequests * queryCount) * rates[c]
      }
    }
    const viewerRequests = Object.values(breakdown).reduce((n, x) => n + x.requests, 0)
    const viewerBytes = Object.values(breakdown).reduce((n, x) => n + x.bodyBytes + x.requests * headers, 0)
    const originRequests = Object.values(breakdown).reduce((n, x) => n + x.originRequests, 0)
    const pub = publisherMonth(scenario)
    const awsStorage = pub.aws.storageBytes / 1024 ** 3 * pricing.aws.storageGiBMonth
    const awsPublisher = pub.aws.classA * pricing.aws.classA + pub.aws.classB * pricing.aws.classB
    const awsOrigin = originRequests * pricing.aws.classB
    const awsViewerUS = cloudFrontViewerRequestCost(viewerRequests, pricing.aws.viewerRequestUS)
    const awsViewerPC = cloudFrontViewerRequestCost(viewerRequests, pricing.aws.viewerRequestPC100)
    const sessions = scenario.viewsPerDay * pricing.monthDays / qValue
    const functionInvocations = 4 * sessions + scenario.searchesPerDay * pricing.monthDays / 2
    const awsFunctions = cloudFrontFunctionCost(functionInvocations)
    const preChangeFunctionInvocations = viewerRequests
    const preChangeFunctions = cloudFrontFunctionCost(preChangeFunctionInvocations)
    const awsTransfer = transferCostGB(viewerBytes / 1e9)
    const aws = { storage: awsStorage, publisherRequests: awsPublisher, readerOriginRequests: awsOrigin, viewerRequestsUS: awsViewerUS, viewerRequestsPC100: awsViewerPC,
      functionInvocations, functions: awsFunctions, preChangeFunctionInvocations, preChangeFunctions, transfer: awsTransfer,
      usCanada: awsStorage + awsPublisher + awsOrigin + awsViewerUS + awsFunctions + awsTransfer,
      pc100Upper: awsStorage + awsPublisher + awsOrigin + awsViewerPC + awsFunctions + awsTransfer }
    const r2StorageGB = pub.r2.storageBytes / 1e9
    const r2Storage = r2StorageGB * pricing.r2.storageGBMonth
    const r2PublisherClassA = pub.r2.classA * pricing.r2.classA
    const r2PublisherClassB = pub.r2.classB * pricing.r2.classB
    const r2ReaderOrigin = originRequests * pricing.r2.classB
    const r2ClassB = pub.r2.classB + originRequests
    const r2Gross = r2Storage + r2PublisherClassA + r2PublisherClassB + r2ReaderOrigin
    const r2Net = r2AfterFreeAllowance({ storageGB: r2StorageGB, classA: pub.r2.classA, classB: r2ClassB })
    return { scenario: scenario.name, assumptions: { q: qValue, reloads: reloadCount, headerBytes: headers, compression: mode, originRates: rates, ...sensitivity }, reader: { breakdown, viewerRequests, viewerBytes, originRequests }, publisher: pub,
      aws, r2: { storage: r2Storage, publisherClassA: r2PublisherClassA, publisherClassB: r2PublisherClassB, readerOriginRequests: r2ReaderOrigin,
        gross: r2Gross, afterDedicatedFreeAllowance: r2Net.total, roundedAfterDedicatedFreeAllowance: r2RoundedAfterFreeAllowance({ storageGB: r2StorageGB, classA: pub.r2.classA, classB: r2ClassB }).total, readerTransferGB: viewerBytes / 1e9 } }
  }
  const scenariosRows = scenarios.map((s) => compute(s, originRates))
  const sensitivities = scenarios.map((scenario) => ({ scenario: scenario.name, rows: [
    compute(scenario, { ...originRates, siteRoot: 0 }, { sensitivity: 'roots-0-percent' }),
    compute(scenario, Object.fromEntries(cli06Classes.map((c) => [c, 1])), { sensitivity: 'all-classes-100-percent' }),
  ] }))
  const oneFactor = []
  for (const scenario of scenarios) for (const dimension of [
    ...[1, 3, 5].map((value) => ({ q: value })), ...['gzip6', 'brotli5'].map((value) => ({ compression: value })),
    ...[0, 1].map((value) => ({ reloads: value })), ...[false, true].map((value) => ({ reloads: 1, reloadIndexChanged: value })),
    ...[512, 1024, 2048].map((value) => ({ headerBytes: value })),
  ]) oneFactor.push({ scenario: scenario.name, ...dimension, row: compute(scenario, originRates, dimension) })
  const publisherEvidence = Object.fromEntries(['plain', 'aws'].map((p) => [p, Object.fromEntries(sizes.map((size) => [size, compactPublisherProbe(publishers[p][size])]))]))
  return { schemaVersion: 1, policy: 'cli06', pricing: cli06Pricing, calculation: { q, reloads, headerBytes, compression, originRates,
    moduleAssumptions: { cloudflare: '0.2.0', aws: 'monorepo compatibility module; max TTL caps 0/0/31536000; AWS not live-verified' },
    excludedScope: ['preview frequency and bytes', '404 frequency (each explicitly supplied Cloudflare 404 includes its body bytes and one origin read)', 'registry sync', 'app deploy', 'account-wide shared allowances', 'domain, GitHub, runner, support, tax, WAF, logging'] },
    evidence: { readerMeasuredAt: reader.measuredAt, readerSourceRevision: reader.sourceRevision ?? reader.environment?.commit ?? null, readerInputSHA256: reader.inputSHA256 ?? null,
      readerVectors: traceByMode[compression], publisherProbeSourceContext: 'base 116521ef plus the hosting cost probe changes in this PR', publisher: publisherEvidence }, scenarios: scenariosRows, sensitivities: { originRates: sensitivities, oneFactor } }
}

function args(argv) {
  const out = {}; for (let i = 0; i < argv.length; i++) { const k = argv[i].replace(/^--/, ''), v = argv[++i]; if (!['policy', 'reader', 'publisher-log-dir', 'publisher-results', 'legacy', 'output'].includes(k) || v === undefined) throw new Error(`invalid argument ${k}`); out[k] = v }
  for (const k of ['policy', 'reader', 'output']) if (!out[k]) throw new Error(`--${k} is required`)
  if (!['t29', 'cli06'].includes(out.policy)) throw new Error(`invalid --policy ${out.policy}; want t29 or cli06`)
  if (out.policy === 't29' && (!out.legacy || !out['publisher-log-dir'])) throw new Error('T29 policy requires --legacy and --publisher-log-dir')
  if (out.policy === 'cli06' && (!!out['publisher-log-dir'] === !!out['publisher-results'])) throw new Error('CLI 0.6 requires exactly one of --publisher-log-dir or --publisher-results')
  return out
}
function main() {
  const options = args(process.argv.slice(2)), readerRaw = readFileSync(options.reader, 'utf8'), reader = JSON.parse(readerRaw)
  let publishers
  if (options['publisher-results']) publishers = JSON.parse(readFileSync(options['publisher-results'], 'utf8')).evidence?.publisher
  else {
    publishers = {}
    for (const [size, count] of [[1000, '1000'], [5000, '5000'], [50000, '50000']]) for (const provider of ['plain', 'aws']) {
      const filename = path.join(options['publisher-log-dir'], `${provider}-${count}.log`)
      const raw = readFileSync(filename, 'utf8').match(/HOSTING_COST_JSON=(\{.*\})/)
      if (!raw) throw new Error(`missing HOSTING_COST_JSON in ${filename}`)
      const probe = JSON.parse(raw[1])
      if (probe.provider !== provider || probe.pages !== size) throw new Error(`probe identity mismatch in ${filename}: provider=${probe.provider}, pages=${probe.pages}`)
      publishers[provider] ??= {}; publishers[provider][size] = probe
    }
  }
  if (!publishers) throw new Error('--publisher-results is missing evidence.publisher')
  const output = options.policy === 't29'
    ? calculate(reader, publishers, { legacyMarkdown: readFileSync(options.legacy, 'utf8') })
    : calculateCLI06(reader, publishers)
  if (options.policy === 'cli06') output.evidence.readerInputSHA256 = createHash('sha256').update(readerRaw).digest('hex')
  mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true }); writeFileSync(options.output, `${JSON.stringify(output, null, 2)}\n`)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
