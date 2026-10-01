// Research: storage and cold committed-query payloads, with lossless AND substring semantics.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { brotliCompressSync, constants, gzipSync, gunzipSync } from 'node:zlib'
import { createServer } from 'node:http'
import { chromium } from '@playwright/test'
import * as codec from './fulltext-packed.mjs'

const output = '.local/fulltext-cost'
mkdirSync(output, { recursive: true })
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const gzip = (bytes) => gzipSync(bytes, { level: 9 })
const brotli = (bytes, quality = 5) => brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } })
const stats = (bytes) => ({ raw: bytes.length, gzip: gzip(bytes).length, brotli5: brotli(bytes).length })
const extract = (roots) => JSON.parse(execFileSync('go', ['run', './scripts/fulltext-corpus', ...roots], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
const real = extract(['fixtures/storage/_artifacts', 'docs/public/sites/guide'])
const editorial = extract(['docs'])
const queries = ['cache', 'retry', 'timeout', '検索', '再試行', 'ＡＰＩ', 'API cache', '本', 'no-such-body-token', 'unique-7', 'foo.bar', '🧪試験', '']
const expected = (records, query) => {
  const terms = codec.normalize(query).split(' ').filter(Boolean)
  return terms.length ? records.flatMap(({ text }, i) => terms.every((term) => codec.normalize(text).includes(term)) ? [i] : []) : []
}
// Codec and search checks include all container modes and troublesome substrings.
for (const n of [1, 127, 128, 1000, 10000]) {
  for (const ids of [[], [0], Array.from({ length: n }, (_, i) => i), Array.from({ length: Math.floor(n / 2) }, (_, i) => i * 2), Array.from({ length: Math.max(0, n - 1) }, (_, i) => i)]) {
    for (const ef of [false, true]) assert.deepEqual(codec.decodePosting(codec.encodePosting(ids, n, true, ef), n), ids)
  }
}
for (let seed = 1; seed <= 100; seed++) {
  let state = seed
  const ids = Array.from({ length: 1000 }, (_, i) => i).filter(() => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % 5 === 0 })
  for (const ef of [false, true]) assert.deepEqual(codec.decodePosting(codec.encodePosting(ids, 1000, true, ef), 1000), ids)
}
const probes = [{ text: 'ab zz bc zz cd foo.bar 🧪試験 再試行 ＡＰＩ' }, { text: 'abcdef api cache' }, { text: '前半検索後半' }]
const probe = codec.build(probes)
const probeLex = codec.decodeLexicon(codec.encodeLexicon(probe))
const probeLists = codec.decodeLists(codec.encodeLists(probe))
for (const q of [...queries, 'abcd', 'cde', 'foo.', 'bc', '検索', '半検']) assert.deepEqual(codec.execute(probeLex, codec.queryPlan(probeLex, q), probeLists), expected(probes, q))

const repeated = Array.from({ length: 10000 }, (_, i) => ({ id: `site/report-${i}.html`, text: `${real[i % real.length].text} unique-${i.toString(36)} ${i % 100 === 0 ? '再試行 retry timeout' : ''}` }))
const vocabulary = [...new Set(real.flatMap(({ text }) => codec.normalize(text).split(' ')))].filter((word) => word.length > 1 && word.length < 32)
let state = 0x1a0f6bb
const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0 }
const diverse = Array.from({ length: 10000 }, (_, i) => ({
  id: `varied/report-${i}.html`,
  text: `${Array.from({ length: 180 }, () => vocabulary[random() % vocabulary.length]).join(' ')} unique-${i.toString(36)} ${i % 100 === 0 ? '再試行 retry timeout' : ''} 障害調査ではログと応答時間を確認する。`,
}))
const clauses = ['監視データを確認する。', '障害の原因を調査する。', '応答時間を測定する。', '再試行の上限を設定する。', '変更履歴を参照する。', '検索結果を共有する。', 'キャッシュの状態を確認する。', '接続先の負荷を調べる。', '復旧手順を実行する。', '担当者に調査を引き継ぐ。', '利用状況を記録する。', '設定値を比較する。']
const japanese = Array.from({ length: 10000 }, (_, i) => ({ id: `japanese/report-${i}.html`, text: Array.from({ length: 24 }, () => clauses[random() % clauses.length]).join('') }))
const corpora = [
  ['real-published', real], ['repository-editorial', editorial],
  ['repeated-10000', repeated], ['varied-10000', diverse], ['japanese-unsegmented-10000', japanese],
]
const report = { date: '2026-10-01', runtime: process.version, queries, corpora: [] }
const assets = new Map()
let browserCorpus
function packaging(index, shards, prefix) {
  const lex = gzip(codec.encodeLexicon(index)), files = new Map([[`${prefix}/lex.gz`, lex]])
  const parts = []
  for (let shard = 0; shard < shards; shard++) {
    const bytes = gzip(codec.encodeLists(index, shard, shards))
    const url = `${prefix}/p${shard}.gz`
    files.set(url, bytes); parts.push({ url, hash: sha(bytes), bytes: bytes.length })
  }
  const manifest = Buffer.from(JSON.stringify({ version: 1, generation: 'experiment', documents: index.documents, lexicon: { url: `${prefix}/lex.gz`, hash: sha(lex), bytes: lex.length }, parts }))
  files.set(`${prefix}/manifest.json`, manifest)
  const lexicon = codec.decodeLexicon(codec.encodeLexicon(index))
  const queryStats = queries.map((query) => {
    const plan = codec.queryPlan(lexicon, query)
    const selected = (!plan.length || plan.some((ids) => !ids.length)) ? [] : [...new Set(plan.flat().map((id) => id % shards))]
    const selectedLists = new Map()
    for (const shard of selected) for (const [id, bytes] of codec.decodeLists(gunzipSync(files.get(parts[shard].url)))) selectedLists.set(id, bytes)
    return {
      query, ids: codec.execute(lexicon, plan, selectedLists),
      bytes: manifest.length + lex.length + selected.reduce((sum, shard) => sum + parts[shard].bytes, 0),
      requests: 2 + selected.length, shards: selected.length,
    }
  })
  return { files, summary: { shards, storageBytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0), manifestBytes: manifest.length, lexiconBytes: lex.length, queries: queryStats } }
}
function packagingStable(index, shards, prefix) {
  const stable = codec.buildStable(index, shards)
  const rootRaw = codec.encodeLexicon(stable.root), root = gzip(rootRaw), rootHash = sha(root)
  const files = new Map()
  const parts = stable.leaves.map((leaf, i) => {
    if (!leaf.tokens.length) return null
    const bytes = gzip(codec.encodeBundle(leaf)), hash = sha(bytes), url = `${prefix}/p${i}-${hash}.gz`
    files.set(url, bytes); return { url, bytes: bytes.length }
  })
  const metadata = { version: 2, generation: sha(JSON.stringify([rootHash, parts])), documents: index.documents, parts }
  const envelope = gzip(codec.encodeRoot(metadata, stable.root))
  files.set(`${prefix}/root.gz`, envelope)
  const decodedRoot = codec.decodeLexicon(rootRaw)
  const queryStats = queries.map((query) => {
    const plan = codec.stablePlan(decodedRoot, query, shards), bundles = new Map()
    for (const shard of plan.needed) bundles.set(shard, codec.decodeBundle(gunzipSync(files.get(parts[shard].url))))
    return { query, ids: codec.executeStable(decodedRoot, plan, bundles), bytes: envelope.length + plan.needed.reduce((sum, shard) => sum + parts[shard].bytes, 0), requests: 1 + plan.needed.length, shards: plan.needed.length }
  })
  return { files, summary: { shards, storageBytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0), rootBytes: envelope.length, standaloneLexiconBytes: root.length, inlineTokens: stable.root.listIDs.filter(Boolean).length, queries: queryStats } }
}
for (const [name, records] of corpora) {
  const start = performance.now(), normalized = records.map(({ id, text }) => ({ id, text: codec.normalize(text) }))
  writeFileSync(`${output}/${name}-corpus.json`, JSON.stringify(records))
  const grams = codec.build(records, { kind: 'bigrams', adaptive: false, intern: false })
  const baseline = Buffer.from(JSON.stringify({ version: 1, docs: normalized, postings: Object.fromEntries(grams.tokens.map((token, i) => [token, codec.decodePosting(grams.lists[i], records.length)])) }))
  const tokenJSON = codec.build(records, { adaptive: false, intern: false })
  const textlessJSON = Buffer.from(JSON.stringify(Object.fromEntries(tokenJSON.tokens.map((token, i) => [token, codec.decodePosting(tokenJSON.lists[i], records.length)]))))
  const result = { name, documents: records.length, corpusHash: sha(JSON.stringify(records)), textBytes: Buffer.byteLength(normalized.map(({ text }) => text).join('')), baseline: stats(baseline), textOnly: stats(Buffer.from(JSON.stringify({ version: 1, docs: normalized }))), textlessTokenJSON: stats(textlessJSON), variants: [], layouts: [] }
  let selectedIndex, selectedBytes = Infinity, selectedOptions
  for (const [variant, options] of [['delta', { adaptive: false, intern: false }], ['adaptive', { intern: false }], ['adaptive-interned', {}], ['adaptive-interned-ef', { eliasFano: true }]]) {
    const index = codec.build(records, options)
    const lex = codec.encodeLexicon(index), lists = codec.encodeLists(index)
    const bytes = Buffer.concat([Buffer.from(lex), Buffer.from(lists)])
    const sizes = stats(bytes)
    result.variants.push({ variant, vocabulary: index.tokens.length, uniqueLists: index.lists.length, modes: index.modes, lexiconRaw: lex.length, postingsRaw: lists.length, ...sizes })
    const restoredLex = codec.decodeLexicon(lex), restoredLists = codec.decodeLists(lists)
    for (const query of queries) assert.deepEqual(codec.execute(restoredLex, codec.queryPlan(restoredLex, query), restoredLists), expected(records, query), `${name}: ${variant}: ${query}`)
    if (sizes.gzip < selectedBytes) { selectedIndex = index; selectedBytes = sizes.gzip; selectedOptions = options; result.selectedVariant = variant }
  }
  for (const shards of [1, 8, 32, 128]) {
    const packaged = packaging(selectedIndex, shards, `/${name}/${shards}`)
    for (const q of packaged.summary.queries) assert.deepEqual(q.ids, expected(records, q.query))
    result.layouts.push({ ...packaged.summary, queries: packaged.summary.queries.map(({ ids, ...q }) => ({ ...q, hits: ids.length })) })
  }
  result.stableLayouts = []
  for (const shards of [1, 8, 32, 128]) {
    const packaged = packagingStable(selectedIndex, shards, `/${name}/${shards}`)
    for (const q of packaged.summary.queries) assert.deepEqual(q.ids, expected(records, q.query))
    result.stableLayouts.push({ ...packaged.summary, queries: packaged.summary.queries.map(({ ids, ...q }) => ({ ...q, hits: ids.length })) })
    if (name === 'varied-10000' && shards === 32) {
      for (const [url, bytes] of packaged.files) assets.set(url, bytes)
      browserCorpus = { records, prefix: `/${name}/${shards}` }
      const dir = `${output}/browser-bundle`; mkdirSync(dir, { recursive: true })
      for (const [url, bytes] of packaged.files) writeFileSync(`${dir}/${url.split('/').at(-1)}`, bytes)
    }
  }
  // Estimate generation upload amplification after a one-document body edit.
  const edited = records.map((record, i) => i === 0 ? { ...record, text: `${record.text} novelupdateidentifier` } : record)
  const a = packaging(selectedIndex, 32, '/update'), b = packaging(codec.build(edited, selectedOptions), 32, '/update')
  const changed = [...b.files].filter(([url, bytes]) => sha(bytes) !== sha(a.files.get(url)))
  result.oneDocumentEdit = { changedFiles: changed.length, uploadBytes: changed.reduce((sum, [, bytes]) => sum + bytes.length, 0), totalBytes: b.summary.storageBytes }
  const stableA = packagingStable(selectedIndex, 32, '/stable-update')
  const common = selectedIndex.tokens.find((token, i) => { const docs = codec.decodePosting(selectedIndex.lists[selectedIndex.listIDs[i]], records.length); return docs.length > 1 && !docs.includes(0) })
  const stableEdited = records.map((record, i) => i === 0 ? { ...record, text: `${record.text} novelupdateidentifier ${common ?? ''}` } : record)
  const stableB = packagingStable(codec.build(stableEdited, selectedOptions), 32, '/stable-update')
  const stableChanged = [...stableB.files].filter(([url, bytes]) => !stableA.files.has(url) || sha(bytes) !== sha(stableA.files.get(url)))
  result.stableOneDocumentEdit = { changedFiles: stableChanged.length, uploadBytes: stableChanged.reduce((sum, [, bytes]) => sum + bytes.length, 0), totalBytes: stableB.summary.storageBytes, addedExistingToken: common }
  result.elapsedMs = performance.now() - start
  report.corpora.push(result)
  writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2))
  console.log(`${name}: ${result.documents} docs, gzip baseline ${result.baseline.gzip}, packed ${selectedBytes} (${result.selectedVariant})`)
}

// Real HTTP/browser evidence: idle + typing make zero data requests; Enter commits search.
const module = readFileSync('scripts/fulltext-packed.mjs')
const client = `const box = document.querySelector('input'), form = document.querySelector('form');
let manifest, lexicon; const cache = new Map();
async function unpack(url) {
 const response = await fetch(url); if (!response.ok) throw new Error('fetch failed');
 const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
 return new Uint8Array(await new Response(stream).arrayBuffer());
}
form.onsubmit = async (event) => {
 event.preventDefault(); const started = performance.now();
 if (!box.value.trim()) { window.answer = {ids: [], elapsedMs: 0}; return; }
 try {
 const {decodeRoot,decodeBundle,stablePlan,executeStable} = await import('/codec.mjs');
 if (!manifest) { const root = decodeRoot(await unpack('${browserCorpus.prefix}/root.gz')); manifest = root.metadata; lexicon = root.lexicon; }
 const plan = stablePlan(lexicon, box.value, manifest.parts.length);
 await Promise.all(plan.needed.map(async shard => { if (!cache.has(shard)) cache.set(shard, decodeBundle(await unpack(manifest.parts[shard].url))); }));
 window.answer = {ids: executeStable(lexicon, plan, cache), elapsedMs: performance.now() - started};
 document.querySelector('output').textContent = window.answer.ids.length + ' results';
 } catch (error) {window.answer = {error: String(error)};}
};`
const requests = []
const server = createServer((req, res) => {
  if (assets.has(req.url)) { const body = assets.get(req.url); requests.push({ url: req.url, bytes: body.length }); res.writeHead(200, { 'Content-Type': req.url.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'Content-Length': body.length }); res.end(body) }
  else if (req.url === '/codec.mjs') { const body = gzip(module); requests.push({ url: req.url, bytes: body.length }); res.writeHead(200, { 'Content-Type': 'text/javascript', 'Content-Encoding': 'gzip', 'Content-Length': body.length }); res.end(body) }
  else if (req.url === '/client.mjs') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(client) }
  else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<form><input aria-label="Search"><button>Search</button></form><output></output><script type="module" src="/client.mjs"></script>') }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true })
try {
  report.browserVersion = browser.version(); report.browser = []
  for (const query of ['API cache', '再試行', 'unique-7', 'no-such-body-token']) {
    const page = await browser.newPage(); requests.length = 0
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('textbox').fill(query)
    assert.equal(requests.length, 0, 'No search data fetch before submit')
    await page.getByRole('textbox').press('Enter')
    await page.waitForFunction(() => window.answer)
    const answer = await page.evaluate(() => window.answer)
    assert(!answer.error, answer.error)
    assert.deepEqual(answer.ids, expected(browserCorpus.records, query))
    report.browser.push({ query, hits: answer.ids.length, elapsedMs: answer.elapsedMs, requests: requests.length, bytes: requests.reduce((sum, req) => sum + req.bytes, 0), assets: [...requests] })
    requests.length = 0
    await page.evaluate(() => { window.answer = undefined })
    await page.getByRole('textbox').press('Enter'); await page.waitForFunction(() => window.answer)
    assert.equal(requests.length, 0, 'Same submitted query reuses memory cache')
    requests.length = 0
    await page.evaluate(() => { window.answer = undefined })
    await page.getByRole('textbox').fill('再試行')
    assert.equal(requests.length, 0, 'Editing the next query does not fetch')
    await page.getByRole('textbox').press('Enter'); await page.waitForFunction(() => window.answer)
    const changedAnswer = await page.evaluate(() => window.answer)
    assert.deepEqual(changedAnswer.ids, expected(browserCorpus.records, '再試行'))
    report.browser.at(-1).nextSubmittedQuery = { query: '再試行', requests: requests.length, bytes: requests.reduce((sum, req) => sum + req.bytes, 0) }
    await page.close()
  }
  report.decoder = { raw: module.length, gzip: gzip(module).length, note: 'Whole research codec, including build functions; excludes React/app shell and client adapter.' }
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)) }
writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2))
console.log(`Browser parity passed; results: ${output}/results.json`)
