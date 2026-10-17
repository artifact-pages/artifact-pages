import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalPathname, parseRoute, searchRouteHref } from '../routing.ts'

test('_search with q and in parses to a search route', () => {
  assert.deepEqual(parseRoute('/guide/_search', '?q=latency&in=incidents'), { kind: 'search', siteId: 'guide', query: 'latency', folder: 'incidents' })
})

test('the query is decoded and trimmed, and a missing q is an empty query', () => {
  assert.deepEqual(parseRoute('/guide/_search', '?q=%20request+path%20'), { kind: 'search', siteId: 'guide', query: 'request path', folder: undefined })
  assert.deepEqual(parseRoute('/guide/_search', ''), { kind: 'search', siteId: 'guide', query: '', folder: undefined })
})

test('the folder loses surrounding slashes and an empty folder means no folder', () => {
  assert.equal(parseRoute('/guide/_search', '?q=a&in=%2Fa%2Fb%2F').folder, 'a/b')
  assert.equal(parseRoute('/guide/_search', '?q=a&in=').folder, undefined)
})

test('a longer path under _search is still a page of the site', () => {
  assert.deepEqual(parseRoute('/guide/_search/notes.md'), { kind: 'site', siteId: 'guide', artifactPath: '_search/notes.md' })
})

test('searchRouteHref round-trips through parseRoute', () => {
  for (const [query, folder] of [['latency', undefined], ['日本語 検索', 'ja/guide'], ['a&b=c', 'x y']]) {
    const href = searchRouteHref('my site', query, folder)
    const url = new URL(href, 'https://example.test')
    assert.deepEqual(parseRoute(url.pathname, url.search), { kind: 'search', siteId: 'my site', query, folder })
  }
})

test('searchRouteHref omits empty parts', () => {
  assert.equal(searchRouteHref('guide', ''), '/guide/_search')
  assert.equal(searchRouteHref('guide', 'a b'), '/guide/_search?q=a+b')
  assert.equal(searchRouteHref('guide', 'a', 'x'), '/guide/_search?q=a&in=x')
})

test('canonicalPathname keeps the search route', () => {
  assert.equal(canonicalPathname('/guide//_search'), '/guide/_search')
})

test('?section=files selects Files on the site root only; other values and paths ignore it', () => {
  assert.deepEqual(parseRoute('/guide', '?section=files'), { kind: 'site', siteId: 'guide', artifactPath: undefined, section: 'files' })
  assert.deepEqual(parseRoute('/guide', '?section=bogus'), { kind: 'site', siteId: 'guide', artifactPath: undefined, section: undefined })
  assert.deepEqual(parseRoute('/guide', ''), { kind: 'site', siteId: 'guide', artifactPath: undefined, section: undefined })
  assert.deepEqual(parseRoute('/guide/a.md', '?section=files'), { kind: 'site', siteId: 'guide', artifactPath: 'a.md' })
  // A published `_files` path is an ordinary page route, never shadowed.
  assert.deepEqual(parseRoute('/guide/_files', ''), { kind: 'site', siteId: 'guide', artifactPath: '_files' })
})
