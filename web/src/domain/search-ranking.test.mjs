// Checks the page text search ranking tiers and folder helpers.
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import { folderOfPath, isInFolder, matchReason, rankHits, RANKING_MAX_HITS, scopeHits, shouldRank } from './search-ranking.ts'

const artifacts = new Map([
  ['a.md', { title: 'Alpha notes', toc: [] }],
  ['b.md', { title: 'Beta', toc: [{ level: 2, text: 'Start with Cloudflare', id: 'x' }] }],
  ['c.md', { title: 'Cloudflare overview', toc: [] }],
  ['d.md', { title: 'Delta', toc: [] }],
  ['e.md', { title: 'ＥＰＳＩＬＯＮ', toc: [{ level: 2, text: 'CLOUDFLARE R2', id: 'y' }] }],
])
const hit = (id) => ({ id, path: id })

test('reasons: title beats heading beats text, with the heading text', () => {
  assert.deepEqual(matchReason('cloudflare', artifacts.get('c.md')), { tier: 'title' })
  assert.deepEqual(matchReason('cloudflare', artifacts.get('b.md')), { tier: 'heading', heading: 'Start with Cloudflare' })
  assert.deepEqual(matchReason('cloudflare', artifacts.get('d.md')), { tier: 'text' })
  assert.deepEqual(matchReason('cloudflare', undefined), { tier: 'text' })
})

test('matching folds compatibility forms and needs every term', () => {
  assert.equal(matchReason('epsilon', artifacts.get('e.md')).tier, 'title')
  assert.equal(matchReason('ｃｌｏｕｄｆｌａｒｅ r2', { title: 'x', toc: artifacts.get('e.md').toc }).tier, 'heading')
  assert.equal(matchReason('cloudflare zzz', artifacts.get('c.md')).tier, 'text')
  assert.equal(matchReason('   ', artifacts.get('c.md')).tier, 'text')
})

test('ranking orders by tier and keeps path order within a tier', () => {
  const hits = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map(hit)
  assert.deepEqual(rankHits(hits, 'cloudflare', artifacts).map(({ id }) => id), ['c.md', 'b.md', 'e.md', 'a.md', 'd.md'])
})

test('ranking does not mutate its input and tolerates unknown pages', () => {
  const hits = [hit('z.md'), hit('c.md')]
  assert.deepEqual(rankHits(hits, 'cloudflare', artifacts).map(({ id }) => id), ['c.md', 'z.md'])
  assert.deepEqual(hits.map(({ id }) => id), ['z.md', 'c.md'])
})

test('folder helpers', () => {
  assert.equal(folderOfPath('en/a.html'), 'en')
  assert.equal(folderOfPath('a.html'), '')
  assert.equal(folderOfPath('a/b/c.html'), 'a/b')
  assert.equal(isInFolder('en/a.html', 'en'), true)
  assert.equal(isInFolder('en/x/a.html', 'en'), true)
  assert.equal(isInFolder('english/a.html', 'en'), false)
})

test('CJK queries match titles and headings by substring', () => {
  const ja = new Map([
    ['t.md', { title: 'プレビューの使い方', toc: [] }],
    ['h.md', { title: '公開', toc: [{ level: 2, text: 'プレビュー環境の設定', id: 'a' }] }],
    ['x.md', { title: '設定', toc: [] }],
  ])
  assert.deepEqual(rankHits(['x.md', 'h.md', 't.md'].map(hit), 'プレビュー', ja).map(({ id }) => id), ['t.md', 'h.md', 'x.md'])
  assert.deepEqual(matchReason('プレビュー', ja.get('h.md')), { tier: 'heading', heading: 'プレビュー環境の設定' })
})

test('the heading tier needs every term inside a single heading', () => {
  const split = { title: 'Guide', toc: [{ level: 2, text: 'Cloudflare', id: 'a' }, { level: 2, text: 'Preview', id: 'b' }] }
  assert.equal(matchReason('cloudflare preview', split).tier, 'text')
  assert.equal(matchReason('cloudflare', split).tier, 'heading')
})

test('rank only up to the threshold; scope filters by folder', () => {
  assert.equal(shouldRank(RANKING_MAX_HITS), true)
  assert.equal(shouldRank(RANKING_MAX_HITS + 1), false)
  assert.equal(shouldRank(24, 20), false)
  assert.equal(shouldRank(0, 0), true)
  const hits = ['en/a.md', 'ja/a.md', 'top.md'].map(hit)
  assert.deepEqual(scopeHits(hits, 'en').map(({ id }) => id), ['en/a.md'])
  assert.equal(scopeHits(hits, null), hits)
  assert.deepEqual(scopeHits(hits, ''), hits)
})
