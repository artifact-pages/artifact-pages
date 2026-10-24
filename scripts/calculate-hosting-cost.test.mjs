import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transferCostGB, classifyResponses, originReads, sessionVector, lWeighted, invalidationCost, objectSizes, compressedResponseBytes, calculate, cloudFrontViewerRequestCost, r2AfterFreeAllowance, conditionalHeaderEvidence, sanitizedRequestHeaders, parseLegacyModel } from './calculate-hosting-cost.mjs'

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
