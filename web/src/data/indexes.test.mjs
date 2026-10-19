// Row validation of the artifact index and bounded site discovery (ISSUE-091, ISSUE-092).
// Run with: node --experimental-transform-types --no-warnings --test web/src/data/indexes.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test, { mock } from 'node:test'

// The web sources use extensionless relative imports (bundler resolution); map them to .ts.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) {
    try { return await next(specifier + '.ts', context) } catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error }
  }
  return next(specifier, context)
}`))

const {
  IndexLoadError, REGISTRY_TIMEOUT_MS, SITE_INDEX_CACHE_MAX_ENTRIES, SITE_INDEX_CACHE_TTL_MS, SITE_INDEX_TIMEOUT_MS,
  SITE_METADATA_CONCURRENCY, clearSiteIndexCache, discoverSites, loadSiteIndex, siteIndexCacheSize,
} = await import('./indexes.ts')

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/storage/_indexes/sre/index.json', import.meta.url), 'utf8'))
const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
const load = (body) => loadSiteIndex('sre', async () => json(body))

const row = (overrides = {}) => ({
  id: 'a.html',
  title: 'A',
  path: 'a.html',
  format: 'html',
  artifactUrl: '/_artifacts/sre/a.html',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
})
const indexWith = (artifacts) => ({ ...fixture, artifacts })

test.beforeEach(() => clearSiteIndexCache())

async function assertInvalid(body) {
  await assert.rejects(load(body), (error) => {
    assert.ok(error instanceof IndexLoadError)
    assert.equal(error.invalidData, true)
    return true
  })
}

test('a row missing required fields rejects the whole index', async () => {
  await assertInvalid({ ...fixture, artifacts: [{ id: 'broken' }] })
})

test('duplicate ids are rejected', async () => {
  await assertInvalid(indexWith([row(), row({ path: 'b.html' })]))
})

test('duplicate paths are rejected', async () => {
  await assertInvalid(indexWith([row(), row({ id: 'b.html' })]))
})

test('a protocol-relative artifactUrl is rejected', async () => {
  await assertInvalid(indexWith([row({ artifactUrl: '//evil.example/x' })]))
})

test('a path with a dot-dot segment is rejected', async () => {
  await assertInvalid(indexWith([row({ path: '../x' })]))
})

test('a valid row with an unknown extra field loads', async () => {
  const index = await load(indexWith([row({ futureField: { x: 1 } })]))
  assert.equal(index.artifacts.length, 1)
})

test('the published sre fixture loads', async () => {
  const index = await load(fixture)
  assert.equal(index.artifacts.length, fixture.artifacts.length)
})

test('an HTTP failure is not marked as invalid data', async () => {
  await assert.rejects(
    loadSiteIndex('sre', async () => ({ ok: false, status: 503, json: async () => ({}) })),
    (error) => error instanceof IndexLoadError && error.invalidData === undefined && error.status === 503,
  )
})

test('a path with a literal backslash loads', async () => {
  const index = await load(indexWith([row({ id: 'notes/a\\b.md', path: 'notes/a\\b.md', format: 'markdown', artifactUrl: '/_artifacts/sre/notes/a%5Cb.md' })]))
  assert.equal(index.artifacts.length, 1)
})

test('artifactUrl must be under this site\'s /_artifacts/ prefix', async () => {
  for (const artifactUrl of ['/', '/_indexes/sites.json', '/_artifacts/other/x.html', '/_artifacts/sre/', '/_artifacts/sre/x.html?a=1', '/_artifacts/sre/x.html#h']) {
    await assertInvalid(indexWith([row({ artifactUrl })]))
  }
})

// --- bounded site discovery (ISSUE-092) ---

const registryOf = (ids) => ({
  schemaVersion: 1,
  sites: ids.map((id) => ({ id, name: id.toUpperCase(), repository: 'o/r', sourcePath: id })),
})
const metaOf = (id) => ({
  schemaVersion: 1,
  site: { id, title: id.toUpperCase() },
  generatedAt: '2026-01-01T00:00:00Z',
  artifactCount: 1,
  artifactIndexUrl: `/_indexes/${id}/index.json`,
})

test('a metadata request that never completes ends as metadata-unavailable after the timeout', async () => {
  const ids = ['alpha', 'beta', 'slow']
  const fetcher = (url, init) => {
    if (url.endsWith('sites.json')) return Promise.resolve(json(registryOf(ids)))
    const id = url.split('/')[2]
    if (id !== 'slow') return Promise.resolve(json(metaOf(id)))
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
  const sites = await discoverSites(fetcher, { metadataTimeoutMs: 50 })
  assert.equal(sites.length, 3)
  const byId = Object.fromEntries(sites.map((entry) => [entry.site.id, entry.status]))
  assert.deepEqual(byId, { alpha: 'available', beta: 'available', slow: 'metadata-unavailable' })
})

test('at most SITE_METADATA_CONCURRENCY metadata requests are in flight', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `site-${String(i).padStart(2, '0')}`)
  let inFlight = 0
  let maxInFlight = 0
  const fetcher = async (url) => {
    if (url.endsWith('sites.json')) return json(registryOf(ids))
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 10))
    inFlight -= 1
    return json(metaOf(url.split('/')[2]))
  }
  const sites = await discoverSites(fetcher)
  assert.equal(sites.length, 10)
  assert.ok(sites.every((entry) => entry.status === 'available'))
  assert.ok(maxInFlight <= SITE_METADATA_CONCURRENCY, `max in flight ${maxInFlight}`)
  assert.ok(maxInFlight > 1)
})

test('the timeout is an overall deadline, not per batch', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `site-${String(i).padStart(2, '0')}`)
  const fetcher = (url, init) => {
    if (url.endsWith('sites.json')) return Promise.resolve(json(registryOf(ids)))
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
  const started = Date.now()
  const sites = await discoverSites(fetcher, { metadataTimeoutMs: 50 })
  assert.ok(Date.now() - started < 500)
  assert.equal(sites.length, 10)
  assert.ok(sites.every((entry) => entry.status === 'metadata-unavailable'))
})

// --- shared index cache eviction, deadlines and cancellation (ISSUE-094, ISSUE-101) ---

const settle = () => new Promise((resolve) => setImmediate(resolve))
const indexFor = (id) => ({ ...fixture, site: { ...fixture.site, id }, artifacts: [] })
const idOf = (url) => url.split('/')[2]

/** Runs `body` with a synthetic clock and a stubbed global fetch (the shared cache path). */
async function withClock(fetchImpl, body) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  try {
    await body()
  } finally {
    clearSiteIndexCache()
    mock.timers.reset()
    globalThis.fetch = originalFetch
  }
}

const respondWithIndex = (calls) => async (url) => {
  calls.push(url)
  return json(indexFor(idOf(url)))
}
const abortable = (init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(new Error('aborted')))
})

test('expired entries are evicted without reading the same key again', async () => {
  const calls = []
  await withClock(respondWithIndex(calls), async () => {
    mock.timers.tick(1_000)
    await loadSiteIndex('alpha')
    assert.equal(siteIndexCacheSize(), 1)
    mock.timers.tick(SITE_INDEX_CACHE_TTL_MS + 2_000)
    assert.equal(siteIndexCacheSize(), 0, 'alpha is evicted by its timer')
    await loadSiteIndex('beta')
    mock.timers.tick(SITE_INDEX_CACHE_TTL_MS + 1_000)
    await loadSiteIndex('gamma')
    assert.equal(siteIndexCacheSize(), 1)
    await loadSiteIndex('gamma')
    assert.equal(calls.length, 3, 'gamma is still shared')
  })
})

test('the TTL sweep on the next read removes expired entries even if their timers have not run', async () => {
  await withClock(respondWithIndex([]), async () => {
    await loadSiteIndex('alpha')
    await loadSiteIndex('beta')
    assert.equal(siteIndexCacheSize(), 2)
    // Move only the Date forward; the eviction timers stay pending.
    mock.timers.reset()
    mock.timers.enable({ apis: ['Date'], now: SITE_INDEX_CACHE_TTL_MS + 5_000 })
    await loadSiteIndex('gamma')
    assert.equal(siteIndexCacheSize(), 1)
  })
})

test('the cache keeps at most SITE_INDEX_CACHE_MAX_ENTRIES entries, evicting the oldest first', async () => {
  const calls = []
  await withClock(respondWithIndex(calls), async () => {
    const ids = ['site-a', 'site-b', 'site-c', 'site-d', 'site-e', 'site-f']
    for (const id of ids) await loadSiteIndex(id)
    assert.equal(siteIndexCacheSize(), SITE_INDEX_CACHE_MAX_ENTRIES)
    await loadSiteIndex('site-f')
    assert.equal(calls.length, 6, 'the newest entry is still cached')
    await loadSiteIndex('site-c')
    assert.equal(calls.length, 6, 'the oldest survivor is still cached')
    await loadSiteIndex('site-a')
    assert.equal(calls.length, 7, 'the oldest entry was evicted')
  })
})

test('entries that callers are still waiting for are never evicted for the cap', async () => {
  const pending = []
  await withClock((url, init) => new Promise((resolve, reject) => {
    pending.push(() => resolve(json(indexFor(idOf(url)))))
    init.signal.addEventListener('abort', () => reject(new Error('aborted')))
  }), async () => {
    const ids = ['site-a', 'site-b', 'site-c', 'site-d', 'site-e', 'site-f']
    const loads = ids.map((id) => loadSiteIndex(id))
    await settle()
    assert.equal(siteIndexCacheSize(), ids.length)
    pending.forEach((answer) => answer())
    await Promise.all(loads)
    mock.timers.tick(SITE_INDEX_CACHE_TTL_MS)
    assert.equal(siteIndexCacheSize(), 0)
  })
})

test('a shared request is aborted only when every waiting caller has aborted', async () => {
  let started = 0
  let requestSignal
  await withClock((url, init) => {
    started += 1
    requestSignal = init.signal
    return abortable(init)
  }, async () => {
    const first = new AbortController()
    const second = new AbortController()
    const a = loadSiteIndex('alpha', fetch, undefined, { signal: first.signal })
    const b = loadSiteIndex('alpha', fetch, undefined, { signal: second.signal })
    await settle()
    assert.equal(started, 1)
    first.abort()
    await assert.rejects(a, /Aborted/)
    assert.equal(requestSignal.aborted, false)
    assert.equal(siteIndexCacheSize(), 1)
    second.abort()
    await assert.rejects(b, /Aborted/)
    assert.equal(requestSignal.aborted, true)
    assert.equal(siteIndexCacheSize(), 0)
  })
})

test('aborting after the request fulfilled keeps the shared entry', async () => {
  const calls = []
  await withClock(respondWithIndex(calls), async () => {
    const controller = new AbortController()
    await loadSiteIndex('alpha', fetch, undefined, { signal: controller.signal })
    controller.abort()
    await loadSiteIndex('alpha')
    assert.equal(calls.length, 1)
  })
})

test('a site index whose headers never arrive times out and the next call starts a new request', async () => {
  let started = 0
  await withClock((url, init) => {
    started += 1
    return started === 1 ? abortable(init) : Promise.resolve(json(indexFor(idOf(url))))
  }, async () => {
    const first = loadSiteIndex('alpha')
    const outcome = assert.rejects(first, (error) => error instanceof IndexLoadError && error.timedOut === true)
    await settle()
    mock.timers.tick(SITE_INDEX_TIMEOUT_MS)
    await outcome
    assert.equal(siteIndexCacheSize(), 0)
    await loadSiteIndex('alpha')
    assert.equal(started, 2)
  })
})

test('a site index whose body never arrives times out', async () => {
  await withClock((url, init) => Promise.resolve({ ok: true, status: 200, json: () => abortable(init) }), async () => {
    const outcome = assert.rejects(loadSiteIndex('alpha'), (error) => error instanceof IndexLoadError && error.timedOut === true)
    await settle()
    mock.timers.tick(SITE_INDEX_TIMEOUT_MS)
    await outcome
  })
})

test('a registry whose headers never arrive times out at the registry deadline', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  try {
    const outcome = assert.rejects(
      discoverSites((url, init) => abortable(init)),
      (error) => error instanceof IndexLoadError && error.timedOut === true && error.url === '/_indexes/sites.json',
    )
    await settle()
    mock.timers.tick(REGISTRY_TIMEOUT_MS)
    await outcome
  } finally {
    mock.timers.reset()
  }
})

test('a registry whose body never arrives times out at the registry deadline', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  try {
    const outcome = assert.rejects(
      discoverSites((url, init) => Promise.resolve({ ok: true, status: 200, text: () => abortable(init) })),
      (error) => error instanceof IndexLoadError && error.timedOut === true,
    )
    await settle()
    mock.timers.tick(REGISTRY_TIMEOUT_MS)
    await outcome
  } finally {
    mock.timers.reset()
  }
})

test('aborting discovery rejects as aborted and cancels the registry request', async () => {
  const controller = new AbortController()
  let requestSignal
  const outcome = assert.rejects(
    discoverSites((url, init) => { requestSignal = init.signal; return abortable(init) }, { signal: controller.signal }),
    (error) => error instanceof IndexLoadError && /^Aborted/.test(error.message) && !error.timedOut,
  )
  await settle()
  controller.abort()
  await outcome
  assert.equal(requestSignal.aborted, true)
})

test('a registry that is not JSON is invalid data, not a transport error', async () => {
  await assert.rejects(
    discoverSites(async () => ({ ok: true, status: 200, text: async () => '{not json' })),
    (error) => error instanceof IndexLoadError && error.invalidData === true && error.message === 'Invalid site registry: /_indexes/sites.json.',
  )
  await assert.rejects(
    discoverSites(async () => json({ schemaVersion: 1, sites: 'nope' })),
    (error) => error instanceof IndexLoadError && error.invalidData === true,
  )
})

test('a registry body read that fails in transport is retryable, not invalid data', async () => {
  await assert.rejects(
    discoverSites(async () => ({ ok: true, status: 200, text: async () => { throw new TypeError('network error') } })),
    (error) => error instanceof IndexLoadError && !error.invalidData && !error.timedOut
      && error.message === 'Could not fetch /_indexes/sites.json.' && error.cause instanceof TypeError,
  )
})

test('one of two callers sharing a request aborts; the request resolves for the other', async () => {
  const calls = []
  let answer
  await withClock((url, init) => {
    calls.push(init.signal)
    return new Promise((resolve) => { answer = () => resolve(json(indexFor(idOf(url)))) })
  }, async () => {
    const leaving = new AbortController()
    const staying = new AbortController()
    const a = loadSiteIndex('alpha', fetch, undefined, { signal: leaving.signal })
    const b = loadSiteIndex('alpha', fetch, undefined, { signal: staying.signal })
    await settle()
    leaving.abort()
    await assert.rejects(a, /Aborted/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].aborted, false)
    answer()
    assert.equal((await b).site.id, 'alpha')
    // Both waiters have left; the fulfilled entry is still shared.
    await loadSiteIndex('alpha')
    assert.equal(calls.length, 1)
  })
})

// --- optional discovery fields (ISSUE-095, ISSUE-105) ---

const discoverOne = async (extra) => {
  const meta = { ...metaOf('alpha'), ...extra }
  const fetcher = async (url) => json(url.endsWith('sites.json') ? registryOf(['alpha']) : meta)
  const [entry] = await discoverSites(fetcher)
  return entry
}

test('valid optional discovery fields are kept', async () => {
  const extra = {
    artifactCount: 6,
    contentUpdatedAt: '2026-01-02T00:00:00.5Z',
    rootArtifactCount: 1,
    topLevelFolderCount: 2,
    topLevelFolders: [{ name: 'en', artifactCount: 3 }, { name: 'ja', artifactCount: 2 }],
  }
  const entry = await discoverOne(extra)
  assert.equal(entry.status, 'available')
  for (const [key, value] of Object.entries(extra)) assert.deepEqual(entry[key], value)
})

const base = {
  artifactCount: 5,
  contentUpdatedAt: '2026-01-02T00:00:00Z',
  rootArtifactCount: 1,
  topLevelFolderCount: 2,
  topLevelFolders: [{ name: 'en', artifactCount: 3 }, { name: 'ja', artifactCount: 1 }],
}
const FIELDS = ['contentUpdatedAt', 'rootArtifactCount', 'topLevelFolderCount', 'topLevelFolders']

// [name, overrides, fields that must be dropped]
for (const [name, extra, dropped] of [
  ['non-string contentUpdatedAt', { contentUpdatedAt: 5 }, ['contentUpdatedAt']],
  ['date-only contentUpdatedAt', { contentUpdatedAt: '2026-10-01' }, ['contentUpdatedAt']],
  ['contentUpdatedAt with an offset', { contentUpdatedAt: '2026-10-01T00:00:00+09:00' }, ['contentUpdatedAt']],
  ['contentUpdatedAt that is not a date', { contentUpdatedAt: '2026-13-45T00:00:00Z' }, ['contentUpdatedAt']],
  ['contentUpdatedAt on an impossible calendar date', { contentUpdatedAt: '2026-02-30T00:00:00Z' }, ['contentUpdatedAt']],
  ['contentUpdatedAt with hour 24', { contentUpdatedAt: '2026-02-03T24:00:00Z' }, ['contentUpdatedAt']],
  ['contentUpdatedAt on an empty site', { artifactCount: 0, rootArtifactCount: 0, topLevelFolderCount: 0, topLevelFolders: undefined }, ['contentUpdatedAt']],
  ['negative rootArtifactCount', { rootArtifactCount: -1 }, ['rootArtifactCount']],
  ['fractional rootArtifactCount', { rootArtifactCount: 1.5 }, ['rootArtifactCount']],
  ['rootArtifactCount above artifactCount', { rootArtifactCount: 9 }, ['rootArtifactCount']],
  ['string topLevelFolderCount', { topLevelFolderCount: '2' }, ['topLevelFolderCount', 'topLevelFolders']],
  ['unsafe topLevelFolderCount', { topLevelFolderCount: 2 ** 60 }, ['topLevelFolderCount', 'topLevelFolders']],
  ['topLevelFolderCount above the foldered artifacts', { topLevelFolderCount: 5 }, ['topLevelFolderCount', 'topLevelFolders']],
  ['topLevelFolderCount 0 although artifacts are in folders', { topLevelFolderCount: 0 }, ['topLevelFolderCount', 'topLevelFolders']],
  ['non-array topLevelFolders', { topLevelFolders: {} }, ['topLevelFolders']],
  ['folder with an empty name', { topLevelFolders: [{ name: '', artifactCount: 1 }, { name: 'ja', artifactCount: 3 }] }, ['topLevelFolders']],
  ['folder with a zero count', { topLevelFolders: [{ name: 'en', artifactCount: 4 }, { name: 'ja', artifactCount: 0 }] }, ['topLevelFolders']],
  ['folder that is not an object', { topLevelFolders: ['en', 'ja'] }, ['topLevelFolders']],
  ['list length differing from topLevelFolderCount', { topLevelFolderCount: 3 }, ['topLevelFolders']],
  ['duplicate folder names', { topLevelFolders: [{ name: 'en', artifactCount: 2 }, { name: 'en', artifactCount: 2 }] }, ['topLevelFolders']],
  ['unsorted folders', { topLevelFolders: [{ name: 'ja', artifactCount: 1 }, { name: 'en', artifactCount: 3 }] }, ['topLevelFolders']],
  ['folder counts not adding up with the root count', { topLevelFolders: [{ name: 'en', artifactCount: 2 }, { name: 'ja', artifactCount: 1 }] }, ['topLevelFolders']],
]) {
  test(`a field that breaks the specification is dropped without rejecting the metadata: ${name}`, async () => {
    const entry = await discoverOne({ ...base, ...extra })
    assert.equal(entry.status, 'available')
    assert.equal(entry.site.id, 'alpha')
    for (const key of FIELDS) {
      if (dropped.includes(key)) assert.equal(entry[key], undefined, key)
    }
  })
}

test('contradictory counts leave only the folder count (5 with a 2-entry list)', async () => {
  const entry = await discoverOne({ artifactCount: 9, rootArtifactCount: 0, topLevelFolderCount: 5, topLevelFolders: base.topLevelFolders })
  assert.equal(entry.topLevelFolders, undefined)
  assert.equal(entry.topLevelFolderCount, 5)
})

test('lastAuthor: a full author with a GitHub avatar is kept as given (ISSUE-117)', async () => {
  const lastAuthor = { name: 'Octocat', commitSha: 'a'.repeat(40), github: { login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4' } }
  const index = await load(indexWith([row({ lastAuthor, lastCommitter: { name: 'GitHub' } })]))
  assert.deepEqual(index.artifacts[0].lastAuthor, lastAuthor)
  assert.deepEqual(index.artifacts[0].lastCommitter, { name: 'GitHub' })
})

test('lastAuthor: name-only, legacy committer-only and absent rows parse unchanged', async () => {
  const nameOnly = { name: 'Alice', commitSha: 'b'.repeat(64) }
  const index = await load(indexWith([
    row({ id: 'a', path: 'a.html', artifactUrl: '/_artifacts/sre/a.html', lastAuthor: nameOnly }),
    row({ id: 'b', path: 'b.html', artifactUrl: '/_artifacts/sre/b.html', lastCommitter: { name: 'Maya' } }),
    row({ id: 'c', path: 'c.html', artifactUrl: '/_artifacts/sre/c.html' }),
  ]))
  assert.deepEqual(index.artifacts[0].lastAuthor, nameOnly)
  assert.equal(index.artifacts[1].lastAuthor, undefined)
  assert.deepEqual(index.artifacts[1].lastCommitter, { name: 'Maya' })
  assert.equal('lastAuthor' in index.artifacts[2], false)
})

test('lastAuthor: a malformed value is dropped without rejecting the row', async () => {
  const sha = 'a'.repeat(40)
  for (const bad of ['Alice', null, [], { name: 7, commitSha: sha }, { name: 'A' }, { name: 'A', commitSha: 3 }, { name: '  ', commitSha: sha }]) {
    const index = await load(indexWith([row({ lastAuthor: bad, lastCommitter: { name: 'Maya' } })]))
    assert.equal(index.artifacts.length, 1)
    assert.equal(index.artifacts[0].lastAuthor, undefined, JSON.stringify(bad))
    assert.deepEqual(index.artifacts[0].lastCommitter, { name: 'Maya' })
  }
})

test('lastAuthor: a malformed github is dropped alone and a bad avatarUrl is dropped alone', async () => {
  const sha = 'a'.repeat(40)
  for (const github of ['octocat', null, {}, { login: '' }, { login: 4, avatarUrl: 'https://avatars.githubusercontent.com/u/1' }]) {
    const index = await load(indexWith([row({ lastAuthor: { name: 'A', commitSha: sha, github } })]))
    assert.deepEqual(index.artifacts[0].lastAuthor, { name: 'A', commitSha: sha }, JSON.stringify(github))
  }
  for (const avatarUrl of ['http://avatars.githubusercontent.com/u/1', 'https://example.com/u/1', 'https://avatars.githubusercontent.com/', 7, '']) {
    const index = await load(indexWith([row({ lastAuthor: { name: 'A', commitSha: sha, github: { login: 'octocat', avatarUrl } } })]))
    assert.deepEqual(index.artifacts[0].lastAuthor, { name: 'A', commitSha: sha, github: { login: 'octocat' } }, String(avatarUrl))
  }
})

test('lastAuthor: the committed fixtures keep their resolved avatar, bot and name-only authors', async () => {
  const index = await load(fixture)
  const withAvatar = index.artifacts.find((a) => a.lastAuthor?.github?.avatarUrl)
  assert.equal(withAvatar.lastAuthor.github.login, 'octocat')
})
