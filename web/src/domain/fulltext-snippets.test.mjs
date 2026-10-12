// Checks the section table decoder and the page text excerpts against the Go writer fixtures.
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'

// The web sources use extensionless relative imports (bundler resolution); map them to .ts.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) {
    try { return await next(specifier + '.ts', context) } catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error }
  }
  return next(specifier, context)
}`))

const { decodeSectionTable } = await import('./fulltext-codec.ts')
const { EXCERPT_CLUSTERS, EXCERPT_CLUSTERS_BEFORE, excerptFor, excerptTerms, foldWithSourceRanges } = await import('./fulltext-snippets.ts')

const dir = new URL('../../../cli/internal/fulltext/testdata/', import.meta.url)
const blob = (ref) => gunzipSync(readFileSync(new URL(ref.url.split('/').pop(), dir)))
const manifest = JSON.parse(readFileSync(new URL('manifest-snippets.json', dir), 'utf8'))
const vectors = JSON.parse(readFileSync(new URL('snippet-vectors.json', dir), 'utf8'))
const vector = (prefix) => {
  const found = vectors.find((item) => item.name.startsWith(prefix))
  return { paths: found.paths, table: blob(found.sections), packs: found.texts.map(blob) }
}
const sizes = (packs) => packs.map((pack) => pack.length)
const encode = (value) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))

/** Decodes every section of a path of a vector into excerpt input. */
function sectionsOf(item, path) {
  const rows = decodeSectionTable(item.table, item.paths, sizes(item.packs)).get(path)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  return rows.map((row) => ({ heading: row.heading, anchor: row.anchor, text: decoder.decode(item.packs[row.pack].subarray(row.offset, row.offset + row.length)) }))
}
const markedText = (excerpt) => excerpt.parts.filter((part) => part.mark).map((part) => part.text)
const clusters = (text) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length

const ROOT = ['docs/help.md', 'guide.html', 'large.md', 'title-only.md']
const snippetsTable = () => ({ bytes: blob(manifest.sections), packSizes: manifest.texts.map((ref) => ref.rawBytes) })
const table = (documents, version = 1) => ({ version, documents })

test('decodeSectionTable accepts the writer fixtures', () => {
  const { bytes, packSizes } = snippetsTable()
  const rows = decodeSectionTable(bytes, ROOT, packSizes)
  assert.deepEqual([...rows.keys()], ['docs/help.md', 'guide.html', 'large.md'])
  assert.equal(rows.get('guide.html')[1].anchor, 'md-retry')
  for (const prefix of ['F1', 'F2', 'F3', 'F4a', 'F5', 'F6', 'F7']) {
    const item = vector(prefix)
    assert.equal(decodeSectionTable(item.table, item.paths, sizes(item.packs)).size, item.paths.length, prefix)
  }
})

test('decodeSectionTable rejects tables that break the contract', () => {
  const doc = (path, sections) => ({ path, sections })
  const sec = (heading, anchor, pack, offset, length) => ({ heading, anchor, pack, offset, length })
  const ok = () => [doc('a', [sec('', '', 0, 0, 5), sec('H', 'h', 0, 5, 5)]), doc('b', [sec('', '', 0, 10, 5)])]
  const decode = (value, root = ['a', 'b', 'c'], packs = [15]) => decodeSectionTable(encode(value), root, packs)
  assert.equal(decode(table(ok())).size, 2)
  const bad = (name, value, root, packs) => assert.throws(() => decode(value, root, packs), undefined, name)
  const mutate = (change) => { const documents = ok(); change(documents); return table(documents) }
  bad('offset shifted', mutate((d) => { d[0].sections[1].offset = 6 }))
  bad('length past the pack', mutate((d) => { d[1].sections[0].length = 6 }))
  bad('lead section not first', mutate((d) => { d[0].sections.reverse() }))
  bad('out of order path', table([doc('b', [sec('', '', 0, 0, 5)]), doc('a', [sec('', '', 0, 5, 5)])]), ['a', 'b'], [10])
  bad('path not in root', table(ok()), ['a'])
  bad('pack out of range', mutate((d) => { d[1].sections[0].pack = 1 }))
  bad('pack moving backwards', table([doc('a', [sec('', '', 1, 0, 5)]), doc('b', [sec('', '', 0, 0, 5)])]), ['a', 'b'], [5, 5])
  bad('unreferenced pack', table(ok()), ['a', 'b'], [15, 4])
  bad('extra key', mutate((d) => { d[0].extra = 1 }))
  bad('missing key', mutate((d) => { delete d[0].sections[0].length }))
  bad('version 2', table(ok(), 2))
  bad('empty heading with anchor', mutate((d) => { d[0].sections[0].anchor = 'x' }))
  bad('empty sections', mutate((d) => { d[0].sections = [] }))
  bad('documents in a no-pack table', table(ok()), ['a', 'b'], [])
  assert.throws(() => decodeSectionTable(new Uint8Array([0xff, 0xfe]), ['a'], [1]), undefined, 'invalid UTF-8')
  assert.equal(decodeSectionTable(encode(table([])), [], []).size, 0)
})

test('F1 non-BMP matches highlight exactly the display character', () => {
  const sections = sectionsOf(vector('F1'), 'f1-non-bmp.md')
  for (const query of ['😀', '𠮷']) {
    const excerpt = excerptFor(sections, excerptTerms(query))
    assert.deepEqual(markedText(excerpt), [query])
    assert.equal(excerpt.parts.map((part) => part.text).join(''), sections[0].text)
  }
})

test('F2 highlights the display form, not the normalized one', () => {
  const sections = sectionsOf(vector('F2'), 'f2-display.md')
  assert.deepEqual(markedText(excerptFor(sections, excerptTerms('abc'))), ['ＡＢＣ'])
  assert.deepEqual(markedText(excerptFor(sections, excerptTerms('artifact'))), ['Artifact'])
})

test('F4a picks the section with the most distinct terms, earliest on ties', () => {
  const sections = sectionsOf(vector('F4a'), 'f4a-headings.md')
  const verify = excerptFor(sections, excerptTerms('detail notes'))
  assert.equal(verify.heading, 'Verify')
  assert.equal(verify.anchor, 'md-verify')
  assert.deepEqual(markedText(verify), ['notes', 'Detail', 'Detail', 'notes', 'notes'])
  const setup = excerptFor(sections, excerptTerms('setup'))
  assert.equal(setup.heading, 'Setup')
  assert.equal(excerptFor(sections, excerptTerms('overview setup')).heading, 'Overview')
})

test('F3 long single section: window arithmetic at the edges', () => {
  const item = vector('F3')
  const longText = new TextDecoder().decode(item.packs[0])
  assert.equal(longText.length, 262142)
  const withMatch = [{ heading: '', anchor: '', text: `${longText.slice(0, -1)}界` }]
  const tail = excerptFor(withMatch, excerptTerms('界'))
  assert.equal(tail.parts[0].text, '…')
  assert.equal(tail.parts.at(-1).mark, true)
  assert.deepEqual(markedText(tail), ['界'])
  assert.equal(clusters(tail.parts.slice(1).map((part) => part.text).join('')), EXCERPT_CLUSTERS_BEFORE + 1)
  const head = excerptFor([{ heading: '', anchor: '', text: longText }], excerptTerms('aaa'))
  assert.notEqual(head.parts[0].text, '…')
  assert.equal(head.parts.at(-1).text, '…')
  const shown = head.parts.slice(0, -1).map((part) => part.text).join('')
  assert.equal(clusters(shown), EXCERPT_CLUSTERS)
  assert.deepEqual(markedText(head), [shown])
})

test('the window never splits a grapheme cluster and starts 40 clusters before the match', () => {
  const family = '👨‍👩‍👧‍👦', flag = '🇯🇵'
  const unit = ['a', family, 'b', flag, 'é', 'c']
  const text = Array.from({ length: 400 }, (_, i) => unit[i % unit.length]).join('')
  assert.equal(clusters(text), 400)
  const sliced = [...text].length
  assert.ok(sliced > 400)
  for (const position of [100, 233, 250]) {
    const clustersList = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((c) => c.segment)
    clustersList[position] = 'Q'
    const excerpt = excerptFor([{ heading: 'H', anchor: 'h', text: clustersList.join('') }], ['q'])
    assert.deepEqual(markedText(excerpt), ['Q'])
    const body = excerpt.parts.filter((part) => part.text !== '…').map((part) => part.text).join('')
    const expected = clustersList.slice(position - EXCERPT_CLUSTERS_BEFORE, position - EXCERPT_CLUSTERS_BEFORE + EXCERPT_CLUSTERS).join('')
    assert.equal(body, expected)
    assert.equal(clusters(body), EXCERPT_CLUSTERS)
    assert.equal(excerpt.parts[0].text, '…')
    assert.equal(excerpt.parts.at(-1).text, '…')
  }
})

test('foldWithSourceRanges maps folded text back to source clusters', () => {
  const folded = foldWithSourceRanges('Ａ  B\n𠮷')
  assert.equal(folded.normalized, 'a b 𠮷')
  assert.deepEqual(folded.sourceStart, [0, 1, 3, 4, 5, 5])
  assert.deepEqual(folded.sourceEnd.slice(-2), [7, 7])
})

test('no excerpt without a match or without terms', () => {
  const title = [{ heading: '', anchor: '', text: '検索結果cacheRetry cache' }]
  assert.equal(excerptFor(title, excerptTerms('absent')), null)
  assert.equal(excerptFor(title, []), null)
  assert.equal(excerptFor(title, excerptTerms('   ')), null)
  assert.equal(excerptFor([], ['x']), null)
  assert.deepEqual(excerptTerms('Cache  cache RETRY'), ['cache', 'retry'])
})
