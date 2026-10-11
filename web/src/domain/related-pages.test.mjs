// Checks the related-pages selector (ISSUE-086). Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import { relatedPages, relatedTokens } from './related-pages.ts'

const page = (path, title, headings = []) => ({
  id: path,
  path,
  title,
  toc: headings.map((text, i) => ({ level: 2, text, id: `h${i}` })),
})
const paths = (list) => list.map(({ entry }) => entry.path)

test('the current page is never included, and an unknown path gives nothing', () => {
  const pages = [page('a/one.html', 'One'), page('a/two.html', 'Two')]
  assert.deepEqual(paths(relatedPages(pages, 'a/one.html')), ['a/two.html'])
  assert.deepEqual(relatedPages(pages, 'a/missing.html'), [])
})

test('siblings alone are listed in listing order, with reason sibling and no folder label', () => {
  const pages = [page('docs/b.html', 'B'), page('docs/a.html', 'A'), page('docs/c.html', 'C'), page('other/x.html', 'Unrelated')]
  const list = relatedPages(pages, 'docs/c.html')
  assert.deepEqual(paths(list), ['docs/a.html', 'docs/b.html'])
  assert.ok(list.every((item) => item.reason === 'sibling' && item.folderLabel === undefined))
})

test('similarity alone fills the list for a root page, with the folder shown', () => {
  const pages = [
    page('index.html', 'Publishing guide', ['Publish on push']),
    page('guide/publishing.html', 'Publishing', ['Publish on push', 'Rolling back']),
    page('guide/cli.html', 'CLI reference', ['Flags']),
  ]
  const list = relatedPages(pages, 'index.html')
  assert.deepEqual(paths(list), ['guide/publishing.html'])
  assert.equal(list[0].reason, 'similar')
  assert.equal(list[0].folderLabel, 'guide')
})

test('a weak match (one shared heading word) is not enough for a non-sibling', () => {
  const pages = [page('a/x.html', 'Alpha', ['Flags']), page('b/y.html', 'Beta', ['Flags'])]
  assert.deepEqual(relatedPages(pages, 'a/x.html'), [])
})

test('siblings and similar pages are merged into one ranking', () => {
  const pages = [
    page('guide/en/previews.html', 'Previews', ['Preview URLs', 'Retention']),
    page('guide/en/versions.html', 'Versions'),
    page('guide/en/zeta.html', 'Zeta'),
    page('guide/ref/preview-links.html', 'Preview URLs', ['Retention']),
    page('guide/ref/unrelated.html', 'Unrelated'),
  ]
  const list = relatedPages(pages, 'guide/en/previews.html')
  // the similar page outranks plain siblings; plain siblings follow in path order
  assert.deepEqual(paths(list), ['guide/ref/preview-links.html', 'guide/en/versions.html', 'guide/en/zeta.html'])
  assert.deepEqual(list.map((item) => item.reason), ['similar', 'sibling', 'sibling'])
  assert.equal(list[0].folderLabel, 'guide/ref')
})

test('no candidates gives an empty list', () => {
  assert.deepEqual(relatedPages([page('only.html', 'Only')], 'only.html'), [])
  assert.deepEqual(relatedPages([page('a/only.html', 'Only'), page('b/other.html', 'Different')], 'a/only.html'), [])
})

test('the list is capped (default 5) and the cap is configurable', () => {
  const pages = Array.from({ length: 9 }, (_, i) => page(`docs/p${i}.html`, `P${i}`))
  assert.equal(relatedPages(pages, 'docs/p0.html').length, 5)
  assert.equal(relatedPages(pages, 'docs/p0.html', 2).length, 2)
  assert.deepEqual(relatedPages(pages, 'docs/p0.html', 0), [])
})

test('ties are broken by path, whatever the input order', () => {
  const forward = [page('d/a.html', 'A'), page('d/b.html', 'B'), page('d/c.html', 'C'), page('d/z.html', 'Z')]
  const shuffled = [forward[3], forward[1], forward[0], forward[2]]
  assert.deepEqual(paths(relatedPages(forward, 'd/z.html')), ['d/a.html', 'd/b.html', 'd/c.html'])
  assert.deepEqual(paths(relatedPages(shuffled, 'd/z.html')), ['d/a.html', 'd/b.html', 'd/c.html'])
})

test('parallel en/ and ja/ folders: the counterpart is dropped and the same top-level folder is preferred', () => {
  const pages = [
    page('en/publishing.html', 'Publishing', ['Publish on push']),
    page('en/previews.html', 'Previews'),
    page('ja/publishing.html', 'Publishing', ['Publish on push']),
    page('ja/previews.html', 'Previews'),
    page('ja/versions.html', 'Versions'),
  ]
  const list = relatedPages(pages, 'en/publishing.html')
  assert.deepEqual(paths(list), ['en/previews.html'])
  assert.ok(!paths(relatedPages(pages, 'ja/publishing.html')).includes('en/publishing.html'))
})

test('same-top-level pages outrank equally similar pages in another top-level folder', () => {
  const pages = [
    page('en/a/cloud.html', 'Cloud setup', ['Cloud setup']),
    page('en/b/cloud-more.html', 'Cloud setup notes'),
    page('ja/b/cloud-more.html', 'Cloud setup notes'),
  ]
  assert.deepEqual(paths(relatedPages(pages, 'en/a/cloud.html')), ['en/b/cloud-more.html', 'ja/b/cloud-more.html'])
})

test('Japanese titles and headings match by character bigrams', () => {
  assert.deepEqual([...relatedTokens('公開手順')].sort(), ['公開', '手順', '開手'].sort())
  const pages = [
    page('ja/a.html', '公開の手順', ['プレビューの公開']),
    page('x/b.html', '手順を公開する', ['公開']),
    page('x/c.html', 'バージョン', ['固定']),
  ]
  assert.deepEqual(paths(relatedPages(pages, 'ja/a.html')), ['x/b.html'])
})

test('the root folder is labelled "/" for a page in a folder', () => {
  const pages = [page('guide/a.html', 'Cloud storage setup'), page('storage.html', 'Cloud storage setup')]
  assert.equal(relatedPages(pages, 'guide/a.html')[0].folderLabel, '/')
})
