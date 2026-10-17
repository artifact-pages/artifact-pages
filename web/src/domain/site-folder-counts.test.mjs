// Checks the per-top-level-folder summary shown on site picker cards, derived from discovery metadata.
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import { folderChipKey, folderChipLabel, folderSummaryFromMetadata, folderSummaryText } from './site-folder-counts.ts'

const folders = (...pairs) => pairs.map(([name, artifactCount]) => ({ name, artifactCount }))

test('folders are sorted by name and the root bucket is listed last', () => {
  const summary = folderSummaryFromMetadata({
    rootArtifactCount: 2,
    topLevelFolderCount: 2,
    topLevelFolders: folders(['ja', 1], ['en', 3]),
  })
  assert.deepEqual(summary, {
    kind: 'folders',
    folders: [{ folder: 'en', count: 3 }, { folder: 'ja', count: 1 }, { folder: '(root)', count: 2, isRoot: true }],
  })
})

test('two folders and no root pages show per-folder counts', () => {
  const summary = folderSummaryFromMetadata({ rootArtifactCount: 0, topLevelFolderCount: 2, topLevelFolders: folders(['en', 7], ['ja', 7]) })
  assert.equal(summary.kind, 'folders')
  assert.equal(folderSummaryText(summary), 'en: 7 pages, ja: 7 pages')
})

test('a real folder named root does not collide with the root bucket', () => {
  const summary = folderSummaryFromMetadata({ rootArtifactCount: 1, topLevelFolderCount: 1, topLevelFolders: folders(['root', 1]) })
  assert.equal(summary.kind, 'folders')
  assert.notEqual(folderChipKey(summary.folders[0]), folderChipKey(summary.folders[1]))
  assert.deepEqual(summary.folders.map(folderChipLabel), ['root', '(root)'])
})

test('a single group adds nothing', () => {
  assert.deepEqual(folderSummaryFromMetadata({ rootArtifactCount: 0, topLevelFolderCount: 1, topLevelFolders: folders(['en', 7]) }), { kind: 'none' })
  assert.deepEqual(folderSummaryFromMetadata({ rootArtifactCount: 5, topLevelFolderCount: 0, topLevelFolders: [] }), { kind: 'none' })
})

test('five folders show the folder count from topLevelFolderCount', () => {
  const summary = folderSummaryFromMetadata({
    rootArtifactCount: 0,
    topLevelFolderCount: 5,
    topLevelFolders: folders(['a', 1], ['b', 1], ['c', 1], ['d', 1], ['e', 2]),
  })
  assert.deepEqual(summary, { kind: 'many', folderCount: 5 })
})

test('seventeen folders without a list still show the folder count', () => {
  assert.deepEqual(folderSummaryFromMetadata({ rootArtifactCount: 0, topLevelFolderCount: 17 }), { kind: 'many', folderCount: 17 })
})

test('a small folder count without a list adds nothing', () => {
  assert.deepEqual(folderSummaryFromMetadata({ topLevelFolderCount: 3 }), { kind: 'none' })
})

test('old metadata without the new fields adds nothing', () => {
  assert.deepEqual(folderSummaryFromMetadata({}), { kind: 'none' })
})
