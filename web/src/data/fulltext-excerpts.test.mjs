// Checks the excerpt loading of the full-text client against the Go writer fixtures.
// Run with: npm run test:fulltext-reader
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'

// The web sources use extensionless relative imports (bundler resolution); map them to .ts.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) {
    try { return await next(specifier + '.ts', context) } catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error }
  }
  return next(specifier, context)
}`))

const { createSiteFullTextSearch } = await import('./fulltext.ts')

const dir = new URL('../../../cli/internal/fulltext/testdata/', import.meta.url)
const read = (name) => readFileSync(new URL(name, dir))
const MANIFEST_URL = '/_indexes/sre/search/manifest.json'
const metadata = { site: { id: 'sre' }, fullTextUrl: MANIFEST_URL }

function fixture(file, edit = (manifest) => manifest) {
  const manifest = edit(JSON.parse(read(file).toString('utf8')))
  const log = []
  const overrides = new Map()
  const fetcher = async (url) => {
    log.push(url)
    if (url === MANIFEST_URL) return new Response(JSON.stringify(manifest))
    if (overrides.has(url)) return overrides.get(url)()
    const name = url.split('/').pop()
    try { return new Response(read(name)) } catch { return new Response('missing', { status: 404 }) }
  }
  const client = createSiteFullTextSearch(metadata, { fetcher })
  const count = (kind) => log.filter((url) => url.includes(`/${kind}-`)).length
  return { manifest, client, log, overrides, count, manifestRequests: () => log.filter((url) => url === MANIFEST_URL).length }
}

const text = (excerpt) => excerpt.parts.map((part) => part.text).join('')
const marked = (excerpt) => excerpt.parts.filter((part) => part.mark).map((part) => part.text)

test('excerpts read the section table and only the packs of the requested hits', async () => {
  const { client, manifest, count, log } = fixture('manifest-snippets.json')
  const result = await client.search('cache')
  const excerpts = await client.excerpts('cache', result.generation, ['guide.html'])
  assert.equal(count('sections'), 1)
  assert.equal(count('text'), 1)
  assert.ok(log.includes(manifest.texts[0].url))
  assert.ok(!log.includes(manifest.texts[1].url))
  const excerpt = excerpts.get('guide.html')
  assert.equal(excerpt.heading, '')
  assert.equal(excerpt.anchor, '')
  assert.equal(text(excerpt), 'cache')
  assert.deepEqual(marked(excerpt), ['cache'])
})

test('excerpts choose the section with the most terms and reuse the caches', async () => {
  const { client, count } = fixture('manifest-snippets.json')
  const { generation } = await client.search('cache')
  const first = await client.excerpts('retry cache', generation, ['guide.html'])
  const excerpt = first.get('guide.html')
  assert.equal(excerpt.heading, 'Retry')
  assert.equal(excerpt.anchor, 'md-retry')
  assert.deepEqual(marked(excerpt), ['Retry', 'cache'])
  const requests = count('sections') + count('text')
  const second = await client.excerpts('cache', generation, ['guide.html', 'docs/help.md'])
  assert.equal(count('sections') + count('text'), requests)
  assert.equal(second.get('guide.html').heading, '')
  assert.equal(second.get('docs/help.md'), null)
  assert.deepEqual([...second.keys()], ['guide.html', 'docs/help.md'])
})

test('title-only and omitted documents need no pack', async () => {
  const plain = fixture('manifest-snippets.json')
  const { generation } = await plain.client.search('cache')
  const titleOnly = await plain.client.excerpts('cache', generation, ['title-only.md', 'not-in-the-site.md'])
  assert.deepEqual([...titleOnly.values()], [null, null])
  assert.equal(plain.count('text'), 0)

  const omitted = fixture('manifest-snippets.json', (manifest) => {
    manifest.snippetLimits.omittedDocuments = ['guide.html']
    return manifest
  })
  const found = await omitted.client.search('cache')
  const result = await omitted.client.excerpts('cache', found.generation, ['guide.html'])
  assert.equal(result.get('guide.html'), null)
  assert.equal(omitted.count('text'), 0)
})

test('a v1 manifest has no excerpts and search is unchanged', async () => {
  const { client, count } = fixture('manifest-v1.json')
  const result = await client.search('cache')
  assert.ok(result.hits.length > 0)
  const excerpts = await client.excerpts('cache', result.generation, result.hits.map((hit) => hit.path))
  assert.ok([...excerpts.values()].every((value) => value === null))
  assert.equal(excerpts.size, result.hits.length)
  assert.equal(count('sections'), 0)
  assert.equal(count('text'), 0)
})

test('invalid snippet fields in the manifest disable excerpts only', async () => {
  for (const edit of [
    (manifest) => { delete manifest.texts },
    (manifest) => { manifest.texts = [] },
    (manifest) => { manifest.snippetLimits.maxSiteBytes = 1 },
    (manifest) => { manifest.snippetLimits.omittedDocuments = [1] },
    (manifest) => { delete manifest.snippetLimits },
    (manifest) => { manifest.texts[1].rawBytes = 262145 },
    (manifest) => { manifest.sections.url = '/_indexes/sre/search/text-' + manifest.sections.sha256 + '.gz' },
  ]) {
    const { client, count } = fixture('manifest-snippets.json', (manifest) => { edit(manifest); return manifest })
    const result = await client.search('cache')
    assert.ok(result.hits.length > 0)
    const excerpts = await client.excerpts('cache', result.generation, ['guide.html'])
    assert.equal(excerpts.get('guide.html'), null)
    assert.equal(count('sections'), 0)
  }
})

test('a corrupted pack or table only removes the affected excerpts', async () => {
  const pack = fixture('manifest-snippets.json')
  const { generation } = await pack.client.search('cache')
  pack.overrides.set(pack.manifest.texts[1].url, () => new Response(read(pack.manifest.texts[0].url.split('/').pop())))
  const mixed = await pack.client.excerpts('xxx cache', generation, ['guide.html', 'large.md'])
  assert.equal(mixed.get('large.md'), null)
  assert.ok(mixed.get('guide.html'))
  assert.equal((await pack.client.search('cache')).generation, generation)

  const broken = fixture('manifest-snippets.json')
  const found = await broken.client.search('cache')
  broken.overrides.set(broken.manifest.sections.url, () => new Response(read(broken.manifest.texts[0].url.split('/').pop())))
  const none = await broken.client.excerpts('cache', found.generation, ['guide.html', 'docs/help.md'])
  assert.deepEqual([...none.values()], [null, null])
  const again = await broken.client.excerpts('cache', found.generation, ['guide.html'])
  assert.equal(again.get('guide.html'), null)
  assert.equal(broken.count('sections'), 1, 'invalid table data stays cached')
})

test('a network failure of the table is retried by a later call', async () => {
  const { client, overrides, manifest, count } = fixture('manifest-snippets.json')
  const { generation } = await client.search('cache')
  overrides.set(manifest.sections.url, () => new Response('down', { status: 503 }))
  const failed = await client.excerpts('cache', generation, ['guide.html'])
  assert.equal(failed.get('guide.html'), null)
  overrides.clear()
  const retried = await client.excerpts('cache', generation, ['guide.html'])
  assert.ok(retried.get('guide.html'))
  assert.equal(count('sections'), 2)
})

test('a 404 on a pack reloads the manifest once', async () => {
  const { client, overrides, manifest, manifestRequests } = fixture('manifest-snippets.json')
  const { generation } = await client.search('cache')
  assert.equal(manifestRequests(), 1)
  overrides.set(manifest.texts[0].url, () => new Response('gone', { status: 404 }))
  const excerpts = await client.excerpts('cache', generation, ['guide.html'])
  assert.equal(excerpts.get('guide.html'), null)
  assert.equal(manifestRequests(), 2)
})

test('a generation that does not match gets no excerpts and fetches nothing', async () => {
  const { client, log } = fixture('manifest-snippets.json')
  const { generation } = await client.search('cache')
  const before = log.length
  const other = await client.excerpts('cache', 'f'.repeat(64), ['guide.html'])
  assert.equal(other.get('guide.html'), null)
  const blank = await client.excerpts('   ', generation, ['guide.html'])
  assert.equal(blank.get('guide.html'), null)
  assert.equal(log.length, before)
  const cold = fixture('manifest-snippets.json')
  assert.equal((await cold.client.excerpts('cache', generation, ['guide.html'])).get('guide.html'), null)
  assert.equal(cold.log.length, 0)
})

test('an aborted call rejects with the signal reason', async () => {
  const { client } = fixture('manifest-snippets.json')
  const { generation } = await client.search('cache')
  const controller = new AbortController()
  const pending = client.excerpts('cache', generation, ['guide.html'], { signal: controller.signal })
  controller.abort(new Error('stop'))
  await assert.rejects(pending, /stop/)
})

test('a cap record that contradicts the table disables excerpts for the page', async () => {
  for (const edit of [
    (manifest) => { manifest.snippetLimits.omittedDocuments = ['guide.html'] },
    (manifest) => { manifest.snippetLimits.truncatedDocuments = ['not-in-the-site.md'] },
    (manifest) => { manifest.snippetLimits.omittedDocuments = ['not-in-the-site.md'] },
  ]) {
    const { client, count } = fixture('manifest-snippets.json', (manifest) => { edit(manifest); return manifest })
    const { generation, hits } = await client.search('cache')
    assert.ok(hits.length > 0)
    const excerpts = await client.excerpts('cache', generation, ['guide.html', 'docs/help.md'])
    assert.deepEqual([...excerpts.values()], [null, null])
    assert.equal(count('text'), 0)
  }
})
