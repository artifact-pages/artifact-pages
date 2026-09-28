import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

const routeFunctionPath = fileURLToPath(new URL('./routes.js', import.meta.url))
const routeFunctionSource = await readFile(routeFunctionPath, 'utf8')
const handler = vm.runInNewContext(`${routeFunctionSource}\n; handler`)
const distributionSource = await readFile(fileURLToPath(new URL('./main.tf', import.meta.url)), 'utf8')

test('CloudFront route function blocks control paths with no-store responses', () => {
  for (const uri of ['/_control', '/_control/locks/registry.json']) {
    const response = handler({ request: { uri, method: 'GET' } })

    assert.equal(response.statusCode, 404, `${uri} should be hidden from viewers`)
    assert.equal(response.statusDescription, 'Not Found')
    assert.equal(response.headers['cache-control'].value, 'no-store')
  }
})

test('CloudFront route function passes application, notice, and data-plane objects through', () => {
  const paths = [
    '/index.html',
    '/preview-bridge.js',
    '/LICENSE',
    '/THIRD_PARTY_NOTICES.txt',
    '/assets/app-123.js',
    '/_indexes/sites.json',
    '/_artifacts/sre/report.html',
    '/_previews/sre/catalog.json',
    '/_previews/sre/revisions/missing/manifest.json',
    '/_errors/not-found.html',
  ]

  for (const uri of paths) {
    const request = {
      uri,
      method: 'GET',
      headers: { accept: { value: 'text/html' } },
      querystring: { revision: { value: 'latest' } },
    }
    const result = handler({ request })

    assert.equal(result, request, `${uri} should be passed through unchanged`)
    assert.equal(result.uri, uri)
  }
})

test('missing notice files stay on the origin path and return the configured non-cached 404', () => {
  for (const uri of ['/LICENSE', '/THIRD_PARTY_NOTICES.txt']) {
    const request = { uri, method: 'GET' }
    const result = handler({ request })

    assert.equal(result, request, `${uri} must reach S3 so a missing object does not become the SPA shell`)
    assert.equal(result.uri, uri)
  }

  for (const errorCode of [403, 404]) {
    assert.match(
      distributionSource,
      new RegExp(`error_code\\s*=\\s*${errorCode}\\s+response_code\\s*=\\s*404[\\s\\S]*?response_page_path\\s*=\\s*"/_errors/not-found\\.html"[\\s\\S]*?error_caching_min_ttl\\s*=\\s*0`, 'u'),
      `a private-origin ${errorCode} miss must become a non-cached 404`,
    )
  }
})

test('CloudFront route function keeps reserved namespace roots out of the SPA fallback', () => {
  for (const uri of ['/_indexes', '/_artifacts', '/_previews', '/_errors']) {
    const request = { uri, method: 'GET' }
    const result = handler({ request })

    assert.equal(result.uri, uri, `${uri} should be looked up as an origin path`)
  }
})

test('CloudFront preview behavior disables shared caching and maps private-origin misses to 404', () => {
  const behaviorStart = distributionSource.indexOf('    previews = {')
  const behaviorEnd = distributionSource.indexOf('    assets = {', behaviorStart)
  assert.notEqual(behaviorStart, -1, 'CloudFront ordered behaviors must include previews')
  const previewBehavior = distributionSource.slice(behaviorStart, behaviorEnd)
  assert.match(previewBehavior, /path_pattern\s*=\s*"\/_previews\/\*"/u)
  assert.match(previewBehavior, /cache_policy_id\s*=\s*aws_cloudfront_cache_policy\.no_store\.id/u)

  const noStorePolicy = distributionSource.match(/resource "aws_cloudfront_cache_policy" "no_store"\s*\{([\s\S]*?)\n\}/u)?.[1]
  assert.ok(noStorePolicy, 'CloudFront no-store policy must exist')
  for (const ttl of ['min_ttl', 'default_ttl', 'max_ttl']) {
    assert.match(noStorePolicy, new RegExp(`${ttl}\\s*=\\s*0(?:\\s|$)`, 'u'), `${ttl} must be zero for preview responses`)
  }

  for (const errorCode of [403, 404]) {
    assert.match(distributionSource, new RegExp(`error_code\\s*=\\s*${errorCode}\\s+response_code\\s*=\\s*404[\\s\\S]*?response_page_path\\s*=\\s*"/_errors/not-found\\.html"[\\s\\S]*?error_caching_min_ttl\\s*=\\s*0`, 'u'), `origin ${errorCode} misses must return a non-cached 404`)
  }
})

test('CloudFront route function rewrites logical user routes to the SPA shell', () => {
  for (const uri of ['/', '/sre', '/sre/incidents/checkout-latency/index.html']) {
    const request = { uri, method: 'GET' }
    const result = handler({ request })

    assert.equal(result, request)
    assert.equal(result.uri, '/index.html', `${uri} should load the SPA shell`)
    assert.equal(result.method, 'GET')
  }
})
