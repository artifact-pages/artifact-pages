import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

const routeFunctionPath = fileURLToPath(new URL('./routes.js', import.meta.url))
const routeFunctionSource = await readFile(routeFunctionPath, 'utf8')
const handler = vm.runInNewContext(`${routeFunctionSource}\n; handler`)
const distributionSource = await readFile(fileURLToPath(new URL('./main.tf', import.meta.url)), 'utf8')

test('unmatched control paths fall back to the app shell', () => {
  for (const uri of ['/_control', '/_control/locks/registry.json']) {
    const request = { uri, method: 'GET' }
    const result = handler({ request })

    assert.equal(result, request)
    assert.equal(result.uri, '/index.html', `${uri} should use the app shell rather than reach its object key`)
  }
})

test('CloudFront route function passes application, notice, and data-plane objects through', () => {
  const paths = [
    '/index.html',
    '/preview-bridge.js',
    '/LICENSE',
    '/THIRD_PARTY_NOTICES.txt',
    '/assets/app-AbC123xY.js',
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

test('reserved raw prefixes pass empty, nested, missing-name, and encoded segments unchanged for GET and HEAD', () => {
  const prefixes = ['/_indexes', '/_artifacts', '/_previews', '/assets/', '/_errors']
  const suffixes = ['', '/nested/item.html', '/missing-name', '/nested/name%2Fpart.html']

  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      for (const method of ['GET', 'HEAD']) {
        const uri = `${prefix}${suffix}`
        const request = {
          uri,
          method,
          headers: { accept: { value: 'text/html' }, 'x-test': { value: 'preserve-me' } },
          querystring: { revision: { value: 'latest' } },
        }
        const originalRequest = structuredClone(request)
        const result = handler({ request })

        assert.equal(result, request, `${method} ${uri} should be passed through unchanged`)
        assert.deepEqual(result, originalRequest, `${method} ${uri} must preserve the full request`)
      }
    }
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

test('fixed application files and route exceptions retain their established behavior', () => {
  for (const uri of ['/_indexes', '/_artifacts', '/_previews', '/_errors', '/index.html', '/preview-bridge.js', '/LICENSE', '/THIRD_PARTY_NOTICES.txt']) {
    const request = { uri, method: 'GET' }
    assert.equal(handler({ request }).uri, uri, `${uri} must pass through`)
  }

  assert.equal(handler({ request: { uri: '/assets', method: 'GET' } }).uri, '/index.html')
  assert.equal(handler({ request: { uri: '/preview', method: 'GET' } }).uri, '/index.html')
  assert.equal(handler({ request: { uri: '/sre/_previews', method: 'GET' } }).uri, '/index.html')
  assert.equal(handler({ request: { uri: '/_control/locks/registry.json', method: 'GET' } }).uri, '/index.html')
})

test('CloudFront preview behavior respects the origin Cache-Control and maps private-origin misses to 404', () => {
  const behaviorStart = distributionSource.indexOf('    previews = {')
  const behaviorEnd = distributionSource.indexOf('    assets = {', behaviorStart)
  assert.notEqual(behaviorStart, -1, 'CloudFront ordered behaviors must include previews')
  const previewBehavior = distributionSource.slice(behaviorStart, behaviorEnd)
  assert.match(previewBehavior, /path_pattern\s*=\s*"\/_previews\/\*"/u)
  assert.match(previewBehavior, /cache_policy_id\s*=\s*aws_cloudfront_cache_policy\.origin_respecting\.id/u)

  const noStorePolicy = distributionSource.match(/resource "aws_cloudfront_cache_policy" "no_store"\s*\{([\s\S]*?)\n\}/u)?.[1]
  assert.ok(noStorePolicy, 'CloudFront no-store policy must exist')
  for (const ttl of ['min_ttl', 'default_ttl', 'max_ttl']) {
    assert.match(noStorePolicy, new RegExp(`${ttl}\\s*=\\s*0(?:\\s|$)`, 'u'), `${ttl} must be zero for error responses`)
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

test('route function does not normalize dot segments before its logical-route fallback', () => {
  const request = { uri: '/x/../_artifacts/a', method: 'GET' }
  const result = handler({ request })

  assert.equal(result, request)
  assert.equal(result.uri, '/index.html', 'the function itself does not normalize the dot-segment path')
})
