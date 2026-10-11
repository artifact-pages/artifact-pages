// Checks the per-top-level-folder counts shown on site picker cards.
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import { folderChipKey, folderChipLabel, folderSummaryText, summarizeFolders, topLevelFolderCounts } from './site-folder-counts.ts'

const at = (...paths) => paths.map((path) => ({ path }))

test('counts pages per first path segment, sorted by folder name', () => {
  assert.deepEqual(
    topLevelFolderCounts(at('ja/a.html', 'en/a.html', 'en/b.html', 'en/deep/c.html')),
    [{ folder: 'en', count: 3 }, { folder: 'ja', count: 1 }],
  )
})

test('root pages are a separate synthetic group listed last', () => {
  assert.deepEqual(
    topLevelFolderCounts(at('index.html', 'en/a.html', 'about.md')),
    [{ folder: 'en', count: 1 }, { folder: '(root)', count: 2, isRoot: true }],
  )
})

test('a real folder named root does not collide with the root bucket', () => {
  const folders = topLevelFolderCounts(at('root/a.html', 'index.html'))
  assert.equal(folders.length, 2)
  assert.notEqual(folderChipKey(folders[0]), folderChipKey(folders[1]))
  assert.deepEqual(folders.map(folderChipLabel), ['root', '(root)'])
})

test('no pages gives no groups', () => {
  assert.deepEqual(topLevelFolderCounts([]), [])
})

test('two to four groups show per-folder counts', () => {
  const folders = topLevelFolderCounts(at('en/a.html', 'ja/a.html'))
  assert.deepEqual(summarizeFolders(folders), { kind: 'folders', folders })
})

test('a single group or missing breakdown adds nothing', () => {
  assert.deepEqual(summarizeFolders(topLevelFolderCounts(at('en/a.html'))), { kind: 'none' })
  assert.deepEqual(summarizeFolders([]), { kind: 'none' })
  assert.deepEqual(summarizeFolders(undefined), { kind: 'none' })
})

test('more than four groups show the folder count', () => {
  const folders = topLevelFolderCounts(at('a/1', 'b/1', 'c/1', 'd/1', 'e/1', 'e/2'))
  assert.deepEqual(summarizeFolders(folders), { kind: 'many', folderCount: 5 })
})

test('the accessible text spells out each group', () => {
  const folders = topLevelFolderCounts(at('en/a.html', 'en/b.html', 'ja/a.html'))
  assert.equal(folderSummaryText(summarizeFolders(folders)), 'en: 2 pages, ja: 1 page')
})
