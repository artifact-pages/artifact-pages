// Checks the per-top-level-folder counts shown on site picker cards.
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeSiteCounts, topLevelFolderCounts } from './site-folder-counts.ts'

const at = (...paths) => paths.map((path) => ({ path }))

test('counts pages per first path segment, sorted by folder name', () => {
  assert.deepEqual(
    topLevelFolderCounts(at('ja/a.html', 'en/a.html', 'en/b.html', 'en/deep/c.html')),
    [{ folder: 'en', count: 3 }, { folder: 'ja', count: 1 }],
  )
})

test('root pages are a separate group listed last', () => {
  assert.deepEqual(
    topLevelFolderCounts(at('index.html', 'en/a.html', 'about.md')),
    [{ folder: 'en', count: 1 }, { folder: 'root', count: 2 }],
  )
})

test('no pages gives no groups', () => {
  assert.deepEqual(topLevelFolderCounts([]), [])
})

test('two to four groups show per-folder counts', () => {
  const folders = topLevelFolderCounts(at('en/a.html', 'ja/a.html'))
  assert.deepEqual(summarizeSiteCounts(2, folders), { kind: 'folders', folders })
})

test('a single group or missing breakdown shows the metadata total', () => {
  assert.deepEqual(summarizeSiteCounts(5, topLevelFolderCounts(at('en/a.html'))), { kind: 'total', total: 5 })
  assert.deepEqual(summarizeSiteCounts(5, []), { kind: 'total', total: 5 })
  assert.deepEqual(summarizeSiteCounts(5, undefined), { kind: 'total', total: 5 })
})

test('more than four groups show the total and the folder count', () => {
  const folders = topLevelFolderCounts(at('a/1', 'b/1', 'c/1', 'd/1', 'e/1', 'e/2'))
  assert.deepEqual(summarizeSiteCounts(6, folders), { kind: 'total', total: 6, folderCount: 5 })
})
