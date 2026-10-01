// Research only: normalized substring AND search, not the palette fuzzy matcher.
// Run from the repository root. Outputs stay beneath ignored .local/.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { gzipSync } from 'node:zlib'
import { chromium } from '@playwright/test'

const output = '.local/fulltext-experiment'
mkdirSync(output, { recursive: true })
const normalize = (text) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
const grams = (text) => {
  const chars = Array.from(text)
  return [...new Set(chars.slice(0, -1).map((char, i) => char + chars[i + 1]))]
}
function build(records) {
  const docs = records.map(({ id, text }) => ({ id, text: normalize(text) }))
  const postings = Object.create(null)
  docs.forEach(({ text }, ordinal) => {
    for (const gram of grams(text)) (postings[gram] ??= []).push(ordinal)
  })
  return { version: 1, docs, postings }
}
const termsFor = (query) => normalize(query).split(' ').filter(Boolean)
const matches = (text, terms) => terms.every((term) => text.includes(term))
function scan(index, query) {
  const terms = termsFor(query)
  if (!terms.length) return []
  const ids = []
  index.docs.forEach((doc, ordinal) => { if (matches(doc.text, terms)) ids.push(ordinal) })
  return ids
}
function search(index, query) {
  const terms = termsFor(query)
  if (!terms.length) return { ids: [], candidates: 0 }
  const keys = [...new Set(terms.flatMap(grams))]
  const lists = keys.map((key) => index.postings[key] ?? []).sort((a, b) => a.length - b.length)
  let candidates = lists.length ? lists[0] : index.docs.map((_, i) => i)
  // Sorted document ordinals permit intersection without browser-side Sets.
  for (const list of lists.slice(1)) {
    const intersection = []
    let a = 0, b = 0
    while (a < candidates.length && b < list.length) {
      if (candidates[a] === list[b]) { intersection.push(candidates[a]); a++; b++ }
      else if (candidates[a] < list[b]) a++
      else b++
    }
    candidates = intersection
  }
  return { ids: candidates.filter((i) => matches(index.docs[i].text, terms)), candidates: candidates.length }
}
function timings(fn, repetitions = 30) {
  for (let i = 0; i < 5; i++) fn()
  const values = []
  for (let i = 0; i < repetitions; i++) {
    const start = performance.now(); fn(); values.push(performance.now() - start)
  }
  values.sort((a, b) => a - b)
  return { p50: values[Math.floor(values.length / 2)], p95: values[Math.floor(values.length * .95)] }
}

// Exercise extraction semantics using adversarial HTML/Markdown fixtures.
const extractionFixture = `${output}/extraction`
mkdirSync(extractionFixture, { recursive: true })
writeFileSync(`${extractionFixture}/probe.html`, '<title>secret-head</title><style>secret-style</style><script>secret-script</script><p>再<span>試行</span>と ＡＰＩ &amp; cache</p><p hidden>secret-hidden</p><p aria-hidden="true">secret-aria</p><template>secret-template</template><p data-search-ignore>secret-ignore</p><p>block</p><p>boundary</p>')
writeFileSync(`${extractionFixture}/probe.md`, '# Markdown\n\n本文のみの識別語\n\n```js\nretryBudget = 3\n```\n\n<script>secret-md-script</script>\n\n| key | value |\n| --- | --- |\n| timeout | 30 |')
const extract = (roots) => JSON.parse(execFileSync('go', ['run', './scripts/fulltext-corpus', ...roots], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
const probes = extract([extractionFixture])
assert(probes.every(({ text }) => !text.includes('secret-')))
assert(probes.find(({ id }) => id.endsWith('.html')).text.includes('再試行と ＡＰＩ & cache block boundary'))
assert(probes.find(({ id }) => id.endsWith('.md')).text.includes('retryBudget = 3'))
assert(probes.find(({ id }) => id.endsWith('.md')).text.includes('timeout 30'))
const extractionStart = performance.now()
const real = extract(['fixtures/storage/_artifacts', 'docs/public/sites/guide'])
const extractionMs = performance.now() - extractionStart
const realIndex = build(real)
const queries = ['cache', 'retry', 'timeout', '検索', '再試行', 'ＡＰＩ', 'API cache', '本', 'no-such-body-token', '']
for (const query of queries) assert.deepEqual(search(realIndex, query).ids, scan(realIndex, query))
const probeIndex = build(probes)
assert.equal(search(probeIndex, 'api cache').ids.length, 1)
assert.equal(search(probeIndex, '再試行').ids.length, 1)
assert.equal(search(probeIndex, '本文のみの識別語').ids.length, 1)
// Same grams at separate positions are NOT a phrase match.
assert.equal(search(build([{ id: 'false-positive', text: 'ab zz bc zz cd' }]), 'abcd').ids.length, 0)
assert.equal(search(build([{ id: 'astral', text: 'prefix 🧪試験 suffix' }]), '🧪試験').ids.length, 1)
const report = { runtime: process.version, extraction: { documents: real.length, elapsedIncludingGoStartupMs: extractionMs }, real: {}, synthetic: [] }
const browser = await chromium.launch({ headless: true })
async function browserMeasure(fullJSON) {
  const page = await browser.newPage()
  await page.addScriptTag({ content: `const normalize = ${normalize}; const grams = ${grams}; const termsFor = ${termsFor}; const matches = ${matches}; ${scan} ${search} ${timings}` })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  const before = await cdp.send('Runtime.getHeapUsage')
  const parseMs = await page.evaluate((json) => {
    const start = performance.now()
    globalThis.fulltextIndex = JSON.parse(json)
    return performance.now() - start
  }, fullJSON)
  const queryResults = await page.evaluate((queries) => queries.map((query) => {
    const index = globalThis.fulltextIndex
    const a = search(index, query).ids, b = scan(index, query)
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`Browser parity: ${query}`)
    return { query, scan: timings(() => scan(index, query)), indexed: timings(() => search(index, query)) }
  }), queries)
  await cdp.send('HeapProfiler.collectGarbage')
  const after = await cdp.send('Runtime.getHeapUsage')
  await page.close()
  return { parseMs, retainedHeapDeltaBytes: after.usedSize - before.usedSize, queries: queryResults }
}
async function measure(name, records) {
  const start = performance.now()
  const index = build(records)
  const buildMs = performance.now() - start
  const textJSON = JSON.stringify({ version: 1, docs: index.docs })
  const fullJSON = JSON.stringify(index)
  const result = {
    name, documents: records.length, normalizedTextBytes: Buffer.byteLength(index.docs.map(({ text }) => text).join('')),
    textRawBytes: Buffer.byteLength(textJSON), textGzipBytes: gzipSync(textJSON).length,
    indexedRawBytes: Buffer.byteLength(fullJSON), indexedGzipBytes: gzipSync(fullJSON).length,
    buildMs, parse: timings(() => JSON.parse(fullJSON), 10), queries: [],
  }
  for (const query of queries) {
    const indexed = search(index, query)
    assert.deepEqual(indexed.ids, scan(index, query), `${name}: ${query}`)
    result.queries.push({ query, hits: indexed.ids.length, candidates: indexed.candidates, scan: timings(() => scan(index, query)), indexed: timings(() => search(index, query)) })
  }
  result.browser = await browserMeasure(fullJSON)
  return result
}
report.browserVersion = browser.version()
report.real = await measure('repository HTML/Markdown', real)
// Repeat real bodies, with varied body-only identifiers and selectively injected terms.
// This is a repetitive stress corpus, not a realistic vocabulary/entropy model.
for (const count of [1000, 5000, 10000]) {
  const records = Array.from({ length: count }, (_, i) => ({
    id: `site/report-${i}.html`,
    text: `${real[i % real.length].text} unique-${i.toString(36)} ${i % 100 === 0 ? '再試行 retry timeout' : ''}`,
  }))
  report.synthetic.push(await measure(`${count} repeated real bodies`, records))
}
await browser.close()
writeFileSync(`${output}/corpus.json`, JSON.stringify(real, null, 2))
writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
