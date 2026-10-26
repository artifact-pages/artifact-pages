import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { transferCostGB, classifyResponses, originReads, sessionVector, lWeighted, invalidationCost, objectSizes, compressedResponseBytes, projectCompression, calculate, calculateCLI06, classifyCLI06URL, projectCLI06Vector, cli06OriginRates, cloudFrontViewerRequestCost, cloudFrontFunctionCost, r2AfterFreeAllowance, r2RoundedAfterFreeAllowance, conditionalHeaderEvidence, sanitizedRequestHeaders, parseLegacyModel } from './calculate-hosting-cost.mjs'

const probeHeaders = {
  'site-root': 'public, max-age=0, s-maxage=5, must-revalidate, stale-if-error=0',
  'search-manifest': 'public, max-age=0, s-maxage=0, must-revalidate, stale-if-error=0',
  artifact: 'public, max-age=0, s-maxage=0, must-revalidate, stale-if-error=0',
  'hashed-asset': 'public, max-age=31536000, immutable',
  'app-shell': 'no-cache, max-age=0, must-revalidate, stale-if-error=0',
  'preview-catalog': 'public, max-age=0, s-maxage=0, must-revalidate, stale-if-error=0',
  'preview-file': 'public, max-age=0, s-maxage=0, must-revalidate, stale-if-error=0',
  'private-control': 'no-store',
}
function tinyReader({ empty = false } = {}) {
  const makeVector = (size, status = 200) => {
    if (empty) return { responses: [] }
    const body = size === 50000 ? 100 : size === 5000 ? 10 : 3
    const responses = status === 304
      ? [{ url: `/_indexes/scale-${size}/index.json`, status, encodedBytes: 0, decodedBytes: 1000, contentType: 'application/json' }]
      : [
        { url: `/_artifacts/scale-${size}/doc.bin`, status, encodedBytes: body, decodedBytes: body, contentType: 'application/octet-stream' },
        { url: '/assets/app-ABCDEFGH.js', status: 200, encodedBytes: 1, decodedBytes: 1, contentType: 'application/octet-stream' },
      ]
    return { responses }
  }
  return {
    measuredAt: { startedAt: '2026-10-25T00:00:00Z', finishedAt: '2026-10-25T00:00:01Z' },
    environment: { commit: 'tiny-reader-fixture' },
    data: { objectSizeAudit: [1000, 5000, 50000].map((size) => ({ objectType: `site-index-${size}`, decodedBytes: 1000, gzip6Bytes: 100, brotli5Bytes: 80, recompressedGzip6Bytes: 100, recompressedBrotli5Bytes: 80 })) },
    profiles: { unthrottled: Object.fromEntries([1000, 5000, 50000].map((size) => {
      const vector = makeVector(size)
      return [`scale-${size}`, { hostingCost: [{ reader: { sessionActions: [{ vector }, { vector }, { vector }], reload: makeVector(size, 304) }, searches: [{ vector }, { vector }] }] }]
    })) },
  }
}
function tinyPublishers() {
  const publishers = { plain: {}, aws: {} }
  for (const provider of ['plain', 'aws']) for (const size of [1000, 5000, 50000]) {
    const site = `scale-${size}`
    publishers[provider][size] = {
      provider, site, pages: size, sourceRevision: 'probe-source-fixture', measuredAt: '2026-10-25T00:00:00Z',
      cachePolicyRevision: 'd-lt-v1', cachePolicyHeaders: probeHeaders, sourceFiles: size, sourceBytes: size * 10,
      counterBoundary: 'tiny test fixture', storedProjectionObjects: 4, storedProjectionBytes: size * 100,
      storedSearchObjects: 1, storedSearchBytes: 20, publishStateRawBytes: 100, publishStateGzipBytes: 50,
      generatedJSONValidation: { index: true, manifest: true },
      objects: [
        { key: `_indexes/${site}/meta.json`, cacheControl: probeHeaders['site-root'] },
        { key: `_indexes/${site}/search/manifest.json`, cacheControl: probeHeaders['search-manifest'] },
        { key: `_indexes/${site}/search/shards/abc.gz`, cacheControl: probeHeaders['hashed-asset'] },
        { key: `_artifacts/${site}/doc.bin`, cacheControl: probeHeaders.artifact },
      ],
      phases: [
        { name: 'first publish', outcome: 'published', callCounts: { PUT: 2, LIST: 1, GET: 2, HEAD: 1 } },
        { name: 'no-op republish', outcome: 'no-op', callCounts: { PUT: 0, LIST: 0, GET: 1, HEAD: 1 } },
        { name: 'one-document change', outcome: 'published', callCounts: { PUT: 1, LIST: 0, GET: 2, HEAD: 1 } },
      ],
    }
  }
  return publishers
}

test('request header evidence records conditional values or explicit absence', () => {
  const headers = sanitizedRequestHeaders({ 'If-None-Match': '"abc"', 'If-Modified-Since': 'Tue, 01 Jan 2030 00:00:00 GMT', Cookie: 'secret' })
  assert.equal(headers.Cookie, '[REDACTED]')
  assert.deepEqual(conditionalHeaderEvidence(headers, 'requestWillBeSentExtraInfo'), {
    source: 'requestWillBeSentExtraInfo',
    ifNoneMatch: { present: true, value: '"abc"' },
    ifModifiedSince: { present: true, value: 'Tue, 01 Jan 2030 00:00:00 GMT' },
  })
  assert.deepEqual(conditionalHeaderEvidence({}, 'absent'), {
    source: 'absent', ifNoneMatch: { present: false, value: null }, ifModifiedSince: { present: false, value: null },
  })
})

test('CloudFront transfer free allowance and tier edges', () => {
  assert.equal(transferCostGB(1000), 0)
  assert.equal(transferCostGB(1001), 0.085)
  assert.equal(transferCostGB(10000), 9000 * 0.085)
  assert.equal(transferCostGB(50000), 9000 * 0.085 + 40000 * 0.08)
})

test('200, 304 and browser cache remain distinct', () => {
  const result = classifyResponses([
    { status: 200, encodedBytes: 90, originBytes: 90 },
    { status: 304, encodedBytes: 0, originValidated: true },
    { status: 200, encodedBytes: 100, fromCache: true },
  ])
  assert.deepEqual(result, { network200: 1, network304: 1, browserCache: 1, otherNetwork: 0, networkRequests: 2, viewerBytes: 90, originBytes: 90, origin304: 1 })
})

test('miss rate changes origin reads, not viewer transfer bytes', () => {
  const view = { alwaysOriginRequests: 1, cacheableRequests: 34, bytes: 1000 }
  assert.equal(originReads(view.alwaysOriginRequests, view.cacheableRequests, 0.1), 4.4)
  assert.equal(originReads(view.alwaysOriginRequests, view.cacheableRequests, 1), 35)
  assert.equal(view.bytes, 1000)
})
test('session q uses one cold C followed by q minus one SPA deltas', () => {
  const total = sessionVector({ bodyBytes: 100, requests: 1 }, { bodyBytes: 20, requests: 1 }, { bodyBytes: 0, requests: 1 }, 300, 3, 1)
  assert.equal(total.bodyBytes, 14000)
  assert.equal(total.requests, 400)
})

test('L site mix weights thirty regular sites and one large site', () => assert.equal(lWeighted(2, 32), 92 / 31))
test('CLI 0.6 classifies roots, mutable content, previews, app assets, search blobs, and 404s', () => {
  assert.equal(classifyCLI06URL('/_indexes/sites.json'), 'siteRoot')
  assert.equal(classifyCLI06URL('/_indexes/s/meta.json'), 'siteRoot')
  assert.equal(classifyCLI06URL('/_indexes/s/index.json'), 'siteRoot')
  assert.equal(classifyCLI06URL('/_indexes/s/fulltext/nested/catalog.json'), 'siteRoot')
  assert.equal(classifyCLI06URL('/_indexes/s/search/manifest.json'), 'mutableContent')
  assert.equal(classifyCLI06URL('/_indexes/s/search/text-deadbeef.gz'), 'hashedSearchBlob')
  assert.equal(classifyCLI06URL('/_indexes/s/search/shards/text/deadbeef.gz'), 'hashedSearchBlob')
  assert.equal(classifyCLI06URL('/_indexes/s/search/unknown.json'), 'siteRoot')
  assert.equal(classifyCLI06URL('/_artifacts/s/a.css'), 'mutableContent')
  assert.equal(classifyCLI06URL('/_previews/s/rev/a.html'), 'mutableContent')
  assert.equal(classifyCLI06URL('/assets/main-ABCDEFGH.js'), 'hashedAppAsset')
  assert.equal(classifyCLI06URL('/assets/main.js'), 'appShell')
  assert.equal(classifyCLI06URL('/reports/a.html'), 'appShell')
  assert.equal(classifyCLI06URL('/_artifacts/s/missing', 404), 'notFound')
})
test('CLI 0.6 fails closed for unknown URLs and failed responses', () => {
  assert.throws(() => classifyCLI06URL('/_mystery/data'), /unrecognized/)
  for (const url of ['/_indexes/', '/_indexes/s', '/_artifacts/', '/_artifacts/s', '/_previews/', '/_previews/s']) {
    assert.throws(() => classifyCLI06URL(url), /unrecognized/, url)
  }
  assert.throws(() => projectCLI06Vector({ responses: [{ url: '/_artifacts/s/a', status: 0, failed: true }] }), /failed or unsupported/)
})
test('CLI 0.6 separates network 200, 304, and browser cache by class', () => {
  const out = projectCLI06Vector({ responses: [
    { url: '/_indexes/s/meta.json', status: 200, encodedBytes: 40, decodedBytes: 40 },
    { url: '/_artifacts/s/a.html', status: 304, encodedBytes: 0 },
    { url: '/assets/main-ABCDEFGH.js', status: 200, fromCache: true, encodedBytes: 0 },
    { url: '/_artifacts/s/missing', status: 404, encodedBytes: 12 },
  ] })
  assert.deepEqual(out.siteRoot, { networkRequests: 1, bodyBytes: 40, originRequests: 1 })
  assert.deepEqual(out.mutableContent, { networkRequests: 1, bodyBytes: 0, originRequests: 1 })
  assert.deepEqual(out.hashedAppAsset, { networkRequests: 0, bodyBytes: 0, originRequests: 0 })
  assert.deepEqual(out.notFound, { networkRequests: 1, bodyBytes: 12, originRequests: 1 })
  assert.equal(Object.values(out).reduce((n, x) => n + x.networkRequests, 0), 3)
})
test('CLI 0.6 does not double-compress stored index or opaque search blob bytes', () => {
  const audit = [{ objectType: 'site-index-5000', decodedBytes: 1000, gzip6Bytes: 50, brotli5Bytes: 40,
    recompressedGzip6Bytes: 30, recompressedBrotli5Bytes: 20 }]
  const out = projectCLI06Vector({ responses: [
    { url: '/_indexes/scale-5000/index.json', status: 200, encodedBytes: 50, decodedBytes: 1000, contentType: 'application/json', contentEncoding: 'gzip' },
    { url: '/_indexes/scale-5000/search/shards/text.gz', status: 200, encodedBytes: 17, decodedBytes: 9, contentType: 'application/octet-stream' },
  ] }, 'brotli5', audit, 'aws')
  assert.equal(out.siteRoot.bodyBytes, 50)
  assert.equal(out.hashedSearchBlob.bodyBytes, 17)
})
test('invalidation includes only paths above the monthly free allowance', () => {
  assert.equal(invalidationCost(1000), 0)
  assert.equal(invalidationCost(1790), 3.95)
})
test('CloudFront request and R2 dedicated allowances apply only above their boundaries', () => {
  assert.equal(cloudFrontViewerRequestCost(10_000_000), 0)
  assert.equal(cloudFrontViewerRequestCost(10_000_001), 0.000001)
  assert.deepEqual(r2AfterFreeAllowance({ storageGB: 10, classA: 1_000_000, classB: 10_000_000 }), { storage: 0, classA: 0, classB: 0, total: 0 })
  const above = r2AfterFreeAllowance({ storageGB: 11, classA: 1_000_001, classB: 10_000_001 })
  assert.ok(Math.abs(above.total - (0.015 + 4.5 / 1e6 + 0.36 / 1e6)) < 1e-12)
})
test('CloudFront Functions have a separate 2 million monthly allowance', () => {
  assert.equal(cloudFrontFunctionCost(2_000_000), 0)
  assert.ok(Math.abs(cloudFrontFunctionCost(2_000_001) - 0.0000001) < 1e-20)
  assert.ok(Math.abs(cloudFrontFunctionCost(4_150_000) - 0.215) < 1e-12)
})
test('R2 reference subtotal rounds billable units after its dedicated free allowance', () => {
  assert.deepEqual(r2RoundedAfterFreeAllowance({ storageGB: 10, classA: 1_000_000, classB: 10_000_000 }), { storageGB: 0, classA: 0, classB: 0, total: 0 })
  const above = r2RoundedAfterFreeAllowance({ storageGB: 10.01, classA: 1_000_001, classB: 10_000_001 })
  assert.equal(above.total, 0.015 + 4.5 + 0.36)
})
test('precompressed and opaque gzip objects are never compressed twice', () => {
  const bytes = Buffer.from('repeated content '.repeat(100))
  const plain = objectSizes(bytes)
  assert.ok(plain.gzip6Bytes < plain.identityBytes)
  assert.equal(objectSizes(bytes, { precompressed: true }).gzip6Bytes, bytes.length)
  assert.equal(objectSizes(bytes, { opaqueGzip: true }).brotli5Bytes, bytes.length)
})

test('AWS keeps precompressed index bytes while R2 estimates edge compression from decoded JSON', () => {
  const response = { url: '/_indexes/scale-1000/index.json', status: 200, encodedBytes: 50, decodedBytes: 1000, contentType: 'application/json', contentEncoding: 'gzip', httpMetadata: { 'content-length': '1000' } }
  const audit = [{ objectType: 'site-index-1000', decodedBytes: 1000, gzip6Bytes: 50, brotli5Bytes: 50,
    recompressedGzip6Bytes: 30, recompressedBrotli5Bytes: 20 }]
  assert.equal(compressedResponseBytes(response, 'brotli5', audit, { provider: 'aws' }), 50)
  assert.equal(compressedResponseBytes(response, 'gzip6', audit, { provider: 'r2' }), 30)
  assert.equal(compressedResponseBytes(response, 'brotli5', audit, { provider: 'r2' }), 20)
  assert.equal(compressedResponseBytes({ ...response, url: '/_indexes/s/search/root-1.gz' }, 'brotli5', audit, { provider: 'r2' }), 50)
})

test('compressible responses without Content-Length use decoded size for eligibility', () => {
  const response = { url: '/assets/mermaid.core.js', status: 200, encodedBytes: 12_000,
    decodedBytes: 8_000, contentType: 'application/javascript', httpMetadata: { 'content-length': '' } }
  const audit = [{ objectType: 'app-asset-js', decodedBytes: 8_000, gzip6Bytes: 2_000, brotli5Bytes: 1_500,
    recompressedGzip6Bytes: 2_000, recompressedBrotli5Bytes: 1_500 }]
  assert.equal(compressedResponseBytes(response, 'gzip6', audit), 2_000)
})

test('zero-transfer 200 responses are treated as memory-cache hits', () => {
  const result = projectCompression({ requests: 1, alwaysOriginRequests: 0, cacheableRequests: 1,
    browserCacheRequests: 0, network200: 1, network304: 0, responses: [{ url: '/assets/index-hash.js', status: 200,
      encodedBytes: 0, decodedBytes: 0, contentType: 'application/javascript' }] }, 'gzip6', [])
  assert.deepEqual(result, { requests: 0, alwaysOriginRequests: 0, cacheableRequests: 0,
    browserCacheRequests: 1, network200: 0, network304: 0, bodyBytes: 0 })
})

test('calculator emits nine rows and uses the L 30:1 publisher mix', () => {
  const vector = { bodyBytes: 100, requests: 2, alwaysOriginRequests: 1, cacheableRequests: 1, responses: [
    { url: '/scale/overview.md', status: 200, encodedBytes: 100, decodedBytes: 100, contentType: 'text/markdown' },
    { url: '/_indexes/scale-1000/index.json', status: 200, encodedBytes: 20, decodedBytes: 40, contentType: 'application/json', contentEncoding: 'gzip', httpMetadata: { 'content-length': '20' } },
  ] }
  const reader = { profiles: { unthrottled: Object.fromEntries([1000, 5000, 50000].map((n) => [`scale-${n}`, { hostingCost: [{
    reader: { sessionActions: [{ vector }, { vector }, { vector }], reload: vector }, searches: [{ vector }, { vector }],
  }] }])) }, data: { objectSizeAudit: [{ objectType: 'site-index-1000', decodedBytes: 40, gzip6Bytes: 20, brotli5Bytes: 18,
    recompressedGzip6Bytes: 20, recompressedBrotli5Bytes: 18 }] } }
  const publishers = { plain: {}, aws: {} }
  for (const provider of ['plain', 'aws']) for (const size of [1000, 5000, 50000]) {
    const startPaths = size === 1000 ? 178 : size === 5000 ? 353 : 1481
    publishers[provider][size] = { storedProjectionBytes: size * 100, publishStateGzipBytes: 100,
      phases: [
        { name: 'first publish', callCounts: { PUT: 1, LIST: 2, GET: 15, HEAD: 1 }, awsProviderPathCount: startPaths },
        { name: 'one-document change', callCounts: { PUT: 7, LIST: 0, GET: 15, HEAD: 1 }, awsProviderPathCount: 3 },
      ] }
  }
  const result = calculate(reader, publishers)
  assert.equal(result.scenarios.length, 9)
  const l = result.scenarios.find((row) => row.scenario === 'L' && row.missRate === 0.1)
  assert.equal(l.aws.invalidationPaths, 26021)
  assert.ok(Number.isFinite(l.aws.transfer))
  assert.equal(result.sensitivities.length, 3 * 12)
  const brotli = result.sensitivities.find((x) => x.scenario === 'S' && x.compression === 'brotli5').rows[2]
  assert.deepEqual(brotli.sensitivity, { q: 3, reloads: 0, reloadIndexChanged: false, headerBytes: 1024, compression: 'brotli5', missRate: 1 })
  const changedReload = result.sensitivities.find((x) => x.scenario === 'S' && x.reloads === 1 && x.reloadIndexChanged === true).rows[1]
  assert.equal(changedReload.assumptions.reloadIndexChanged, true)
  assert.equal(changedReload.assumptions.reloads, 1)
  assert.equal(changedReload.assumptions.missRate, 0.5)
})

test('CLI 0.6 emits three class-based rows, origin sensitivities, and one-factor sensitivities without purge charges', () => {
  const reader = JSON.parse(readFileSync('docs/research/hosting-cost-reader-session-results.json', 'utf8'))
  const committed = JSON.parse(readFileSync('docs/research/hosting-cost-model-results.json', 'utf8'))
  const publishers = { plain: {}, aws: {} }
  for (const provider of ['plain', 'aws']) for (const size of [1000, 5000, 50000]) {
    const evidence = committed.evidence.publisher[provider][size]
    publishers[provider][size] = { ...evidence, phases: evidence.phaseSummaries.map((phase) => ({ ...phase,
      callCounts: phase.callCounts ?? {} })) }
  }
  const result = calculateCLI06(reader, publishers)
  assert.equal(result.scenarios.length, 3)
  assert.deepEqual(result.scenarios.map((row) => row.scenario), ['S', 'M', 'L'])
  assert.equal(result.scenarios[0].assumptions.originRates.siteRoot, 1)
  assert.equal(result.scenarios[0].assumptions.originRates.hashedAppAsset, 0.1)
  assert.equal(result.scenarios[0].assumptions.originRates.hashedSearchBlob, 0.5)
  assert.equal(result.scenarios[0].reader.breakdown.siteRoot.originRequests, result.scenarios[0].reader.breakdown.siteRoot.requests)
  assert.equal(result.scenarios[2].assumptions.q, 3)
  assert.equal(result.sensitivities.originRates.length, 3)
  assert.equal(result.sensitivities.oneFactor.length, 3 * 12)
  assert.ok(result.sensitivities.oneFactor.some((x) => x.reloadIndexChanged === true))
  assert.ok(result.scenarios.every((row) => !('invalidation' in row.aws) && !('invalidationPaths' in row.aws)))
  assert.equal('invalidationFree' in result.pricing.aws, false)
  assert.equal('invalidationPath' in result.pricing.aws, false)
  assert.equal(JSON.stringify(result).includes('invalidation'), false)
  const warmRoots = result.sensitivities.originRates[0].rows[0]
  assert.equal(warmRoots.reader.viewerBytes, result.scenarios[0].reader.viewerBytes)
  assert.equal(warmRoots.reader.viewerRequests, result.scenarios[0].reader.viewerRequests)
  assert.ok(cli06OriginRates.mutableContent === 1 && cli06OriginRates.notFound === 1)
})

test('CLI 0.6 L reader breakdown uses 30 regular sites plus one large site and reconciles unrounded costs', () => {
  const result = calculateCLI06(tinyReader(), tinyPublishers())
  const row = result.scenarios.find((item) => item.scenario === 'L')
  const sessions = 100_000 * 30 / 3
  const queries = 10_000 * 30 / 2
  const expectedBody = sessions * (30 / 31 * 30 + 1 / 31 * 300) + queries * (30 / 31 * 10 + 1 / 31 * 100)
  assert.ok(Math.abs(row.reader.breakdown.mutableContent.bodyBytes - expectedBody) < 1e-7)
  for (const item of result.scenarios) {
    const { aws, r2, reader, publisher } = item
    assert.ok(Math.abs(aws.usCanada - (aws.storage + aws.publisherRequests + aws.readerOriginRequests + aws.viewerRequestsUS + aws.functions + aws.transfer)) < 1e-10)
    assert.ok(Math.abs(aws.pc100Upper - (aws.storage + aws.publisherRequests + aws.readerOriginRequests + aws.viewerRequestsPC100 + aws.functions + aws.transfer)) < 1e-10)
    assert.ok(Math.abs(r2.gross - (r2.storage + r2.publisherClassA + r2.publisherClassB + r2.readerOriginRequests)) < 1e-10)
    const expectedNet = r2AfterFreeAllowance({ storageGB: publisher.r2.storageBytes / 1e9, classA: publisher.r2.classA,
      classB: publisher.r2.classB + reader.originRequests }).total
    assert.ok(Math.abs(r2.afterDedicatedFreeAllowance - expectedNet) < 1e-10)
  }
})

test('changing immutable origin rates does not change CLI 0.6 viewer requests or bytes', () => {
  const reader = tinyReader(), publishers = tinyPublishers()
  const baseline = calculateCLI06(reader, publishers)
  const warmer = calculateCLI06(reader, publishers, { originRates: { ...cli06OriginRates, hashedAppAsset: 1, hashedSearchBlob: 1 } })
  for (let i = 0; i < baseline.scenarios.length; i++) {
    assert.equal(warmer.scenarios[i].reader.viewerRequests, baseline.scenarios[i].reader.viewerRequests)
    assert.equal(warmer.scenarios[i].reader.viewerBytes, baseline.scenarios[i].reader.viewerBytes)
  }
  assert.notEqual(warmer.scenarios[0].reader.originRequests, baseline.scenarios[0].reader.originRequests)
})

test('CLI 0.6 reload changed and unchanged index cases count the changed 304 body', () => {
  const reload = { responses: [{ url: '/_indexes/scale-1000/index.json', status: 304, encodedBytes: 0, decodedBytes: 1000, contentType: 'application/json' }] }
  const audit = tinyReader().data.objectSizeAudit
  assert.equal(projectCLI06Vector(reload, 'gzip6', audit).siteRoot.bodyBytes, 0)
  assert.equal(projectCLI06Vector(reload, 'gzip6', audit, 'aws', { reloadIndexChanged: true }).siteRoot.bodyBytes, 100)
  const result = calculateCLI06(tinyReader(), tinyPublishers())
  const unchanged = result.sensitivities.oneFactor.find((item) => item.scenario === 'S' && item.reloads === 1 && item.reloadIndexChanged === false).row
  const changed = result.sensitivities.oneFactor.find((item) => item.scenario === 'S' && item.reloads === 1 && item.reloadIndexChanged === true).row
  assert.ok(changed.reader.viewerBytes > unchanged.reader.viewerBytes)
  assert.equal(changed.reader.viewerRequests, unchanged.reader.viewerRequests)
})

test('CLI 0.6 R2 subtotals apply free tiers at the exact boundary and just above it', () => {
  const reader = tinyReader({ empty: true }), publishers = tinyPublishers()
  const probe = publishers.plain[1000]
  probe.storedProjectionBytes = 2_000_000_000
  probe.publishStateGzipBytes = 0
  probe.phases[0].callCounts = { PUT: 200, LIST: 0, GET: 2_000_000, HEAD: 0 }
  probe.phases[2].callCounts = { PUT: 3330, LIST: 0, GET: 0, HEAD: 0 }
  let row = calculateCLI06(reader, publishers).scenarios.find((item) => item.scenario === 'S')
  assert.equal(row.publisher.r2.storageBytes, 10_000_000_000)
  assert.equal(row.publisher.r2.classA, 1_000_000)
  assert.equal(row.publisher.r2.classB + row.reader.originRequests, 10_000_000)
  assert.equal(row.r2.afterDedicatedFreeAllowance, 0)
  probe.phases[0].callCounts.GET++
  row = calculateCLI06(reader, publishers).scenarios.find((item) => item.scenario === 'S')
  assert.ok(Math.abs(row.r2.afterDedicatedFreeAllowance - 5 * 0.36 / 1e6) < 1e-12)
  assert.equal(row.r2.roundedAfterDedicatedFreeAllowance, 0.36)
})

test('CLI 0.6 --publisher-results re-input reproduces a small generated fixture exactly', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'hosting-cost-cli06-test-'))
  try {
    const readerPath = path.join(temp, 'reader.json')
    const inputRaw = JSON.stringify(tinyReader())
    writeFileSync(readerPath, inputRaw)
    const logDir = path.join(temp, 'logs')
    mkdirSync(logDir)
    const outputA = path.join(temp, 'result-a.json'), outputB = path.join(temp, 'result-b.json')
    const publishers = tinyPublishers()
    for (const provider of ['plain', 'aws']) for (const size of [1000, 5000, 50000]) {
      writeFileSync(path.join(logDir, `${provider}-${size}.log`), `HOSTING_COST_JSON=${JSON.stringify(publishers[provider][size])}\n`)
    }
    const calculator = path.resolve('scripts/calculate-hosting-cost.mjs')
    const run = (...args) => spawnSync(process.execPath, [calculator, ...args], { cwd: process.cwd(), encoding: 'utf8' })
    let result = run('--policy', 'cli06', '--reader', readerPath, '--publisher-log-dir', logDir, '--output', outputA)
    assert.equal(result.status, 0, result.stderr)
    result = run('--policy', 'cli06', '--reader', readerPath, '--publisher-results', outputA, '--output', outputB)
    assert.equal(result.status, 0, result.stderr)
    const generated = JSON.parse(readFileSync(outputA, 'utf8'))
    const replayed = JSON.parse(readFileSync(outputB, 'utf8'))
    assert.deepEqual(replayed.pricing, generated.pricing)
    assert.deepEqual(replayed.calculation, generated.calculation)
    assert.deepEqual(replayed.scenarios, generated.scenarios)
    assert.deepEqual(replayed.sensitivities, generated.sensitivities)
    assert.deepEqual(replayed.evidence, generated.evidence)
    assert.ok(Buffer.byteLength(JSON.stringify(generated)) < 100_000)
    assert.equal('objects' in generated.evidence.publisher.aws[50000], false)
    assert.equal(generated.evidence.publisher.aws[50000].perClassObjectCounts['site-root'], 1)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('CLI 0.6 prices ISSUE-127 default-behavior CloudFront Function invocations separately', () => {
  const reader = JSON.parse(readFileSync('docs/research/hosting-cost-reader-session-results.json', 'utf8'))
  const committed = JSON.parse(readFileSync('docs/research/hosting-cost-cli06-results.json', 'utf8'))
  const publishers = { plain: {}, aws: {} }
  for (const provider of ['plain', 'aws']) for (const size of [1000, 5000, 50000]) {
    const evidence = committed.evidence.publisher[provider][size]
    publishers[provider][size] = { ...evidence, phases: evidence.phases.map((phase) => ({ ...phase,
      invalidationPathCount: phase.invalidationPathCount, awsProviderPathCount: phase.awsProviderPathCount })) }
  }
  const rows = calculateCLI06(reader, publishers).scenarios
  assert.deepEqual(rows.map((row) => row.aws.functionInvocations), [41500, 830000, 4150000])
  assert.deepEqual(rows.map((row) => row.aws.preChangeFunctionInvocations), [413250, 8160000, 40790322.58064516])
  assert.deepEqual(rows.map((row) => Number(row.aws.functions.toFixed(2))), [0, 0, 0.22])
  assert.deepEqual(rows.map((row) => Number(row.aws.usCanada.toFixed(2))), [0.10, 2.11, 37.80])
  assert.deepEqual(rows.map((row) => Number(row.aws.pc100Upper.toFixed(2))), [0.10, 2.11, 43.96])
})

test('sequential legacy waterfall reconciles all scenarios, misses, and price series', () => {
  const reader = JSON.parse(readFileSync('docs/research/hosting-cost-reader-session-results.json', 'utf8'))
  const committed = JSON.parse(readFileSync('docs/research/hosting-cost-model-results.json', 'utf8'))
  const legacyMarkdown = readFileSync('docs/research/hosting-cost-model-legacy-2026-10-18.md', 'utf8')
  const publishers = { plain: {}, aws: {} }
  for (const provider of ['plain', 'aws']) for (const size of [1000, 5000, 50000]) {
    const evidence = committed.evidence.publisher[provider][size]
    publishers[provider][size] = { ...evidence, phases: evidence.phaseSummaries.map((phase) => ({ ...phase,
      invalidationPathCount: phase.invalidationPathCount, awsProviderPathCount: phase.awsProviderPathCount })) }
  }
  const result = calculate(reader, publishers, { legacyMarkdown })
  const legacy = parseLegacyModel(legacyMarkdown)
  assert.equal(result.decomposition.stages.length, 9)
  assert.deepEqual(result.decomposition.order, ['compression', 'sessionReuse', 'searchTreatment', 'requestCount', 'storage'])
  const expectedSeries = ['awsUS', 'awsPC100', 'r2Gross', 'r2AfterDedicatedFree']
  for (const row of result.decomposition.stages) {
    const old = legacy.totals.get(`${row.scenario}:${row.missRate}`)
    const next = result.scenarios.find((x) => x.scenario === row.scenario && x.missRate === row.missRate)
    const expectedOld = { awsUS: old.awsUS, awsPC100: old.awsPC, r2Gross: old.r2Gross, r2AfterDedicatedFree: old.r2Net }
    const expectedNew = { awsUS: next.aws.usCanada, awsPC100: next.aws.pc100Upper, r2Gross: next.r2.gross, r2AfterDedicatedFree: next.r2.afterDedicatedFreeAllowance }
    for (const series of expectedSeries) {
      assert.equal(Number(row.legacyTable[series].toFixed(2)), expectedOld[series])
      assert.equal(Number(row.legacy[series].toFixed(2)), expectedOld[series])
      assert.ok(Math.abs(row.new[series] - expectedNew[series]) < 1e-8, `${row.scenario} ${row.missRate} ${series} new endpoint`)
      const delta = row.steps.reduce((sum, step) => sum + step.delta[series], 0)
      assert.ok(Math.abs(delta - (row.new[series] - row.legacy[series])) < 1e-8, `${row.scenario} ${row.missRate} ${series} waterfall sum`)
    }
    assert.equal(row.steps.length, 5)
  }
  assert.equal(result.decomposition.stages.find((x) => x.scenario === 'L' && x.missRate === 0.1).steps[0].delta.awsUS < 0, true)
})
