// Checks the similar-page suggestions shown for a path that matches no page.
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import { nearbyArtifacts } from './nearby-pages.ts'

const artifacts = [
  ['guide/en/publishing.html', 'Publishing'],
  ['guide/en/previews.html', 'Previews'],
  ['guide/ja/publishing.html', '公開する'],
  ['reference/cli.html', 'CLI reference'],
  ['index.html', 'Home'],
].map(([path, title]) => ({ id: path, path, title }))

test('a missing page is matched to pages in its folder first', () => {
  const paths = nearbyArtifacts(artifacts, 'guide/en/nope.html').map(({ path }) => path)
  assert.deepEqual(paths.slice(0, 2), ['guide/en/previews.html', 'guide/en/publishing.html'])
  assert.ok(!paths.includes('reference/cli.html'))
})

test('a misspelled page name finds the page by shared words', () => {
  assert.equal(nearbyArtifacts(artifacts, 'reference/cli-reference')[0].path, 'reference/cli.html')
  assert.equal(nearbyArtifacts(artifacts, 'publishing')[0].path.endsWith('publishing.html'), true)
})

test('a folder path offers the pages under it, and unrelated paths offer nothing', () => {
  assert.deepEqual(nearbyArtifacts(artifacts, 'guide/ja').map(({ path }) => path)[0], 'guide/ja/publishing.html')
  assert.deepEqual(nearbyArtifacts(artifacts, 'zzz/qqq'), [])
  assert.deepEqual(nearbyArtifacts(artifacts, ''), [])
})

test('suggestions are capped', () => {
  assert.equal(nearbyArtifacts(artifacts, 'guide/en/nope.html', 1).length, 1)
})

test('non-ASCII path segments match decoded paths and titles', () => {
  const pages = [
    { id: 'a', path: 'guide/ja/公開手順.html', title: '公開手順' },
    { id: 'b', path: 'guide/ja/概要.html', title: '概要' },
  ]
  assert.equal(nearbyArtifacts(pages, 'guide/ja/公開手順-旧')[0].id, 'a')
})
