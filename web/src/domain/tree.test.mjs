// Checks the sidebar tree labels and which index rows fold into their folder row.
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildArtifactTree, foldedIndexArtifact } from './tree.ts'

const page = (path, title) => ({ id: path, path, title, updatedAt: '2026-10-01T00:00:00Z', format: 'markdown' })

test('tree nodes carry the folder label and the root has none', () => {
  const tree = buildArtifactTree([page('docs/README.md', 'Docs home'), page('docs/a.md', 'A'), page('plain/x.md', 'X')])
  assert.equal(tree.label, '')
  assert.deepEqual([...tree.directories.values()].map(({ name, label }) => [name, label]), [['docs', 'Docs home'], ['plain', 'plain']])
})

test('an index row folds into its folder only when the folder has other children', () => {
  const tree = buildArtifactTree([
    page('both/README.md', 'Both'), page('both/a.md', 'A'),
    page('alone/index.html', 'Alone'),
    page('nested/README.md', 'Nested'), page('nested/sub/b.md', 'B'),
    page('none/a.md', 'A'),
    page('README.md', 'Root'), page('top.md', 'Top'),
  ])
  const folded = (name) => foldedIndexArtifact(tree.directories.get(name))?.path
  assert.equal(folded('both'), 'both/README.md')
  assert.equal(folded('alone'), undefined)
  assert.equal(folded('nested'), 'nested/README.md')
  assert.equal(folded('none'), undefined)
  // The root README is the site introduction, folded too (see below).
  assert.equal(foldedIndexArtifact(tree)?.path, 'README.md')
})

test('the site root folds its introduction: README.md, index.md, index.html, index.htm', () => {
  const rootFolded = (pages) => foldedIndexArtifact(buildArtifactTree(pages))?.path
  assert.equal(rootFolded([page('README.md', 'Home'), page('index.md', 'Index'), page('a.md', 'A')]), 'README.md')
  assert.equal(rootFolded([page('index.md', 'Index'), page('a.md', 'A')]), 'index.md')
  assert.equal(rootFolded([page('index.html', 'Index'), page('a.md', 'A')]), 'index.html')
  assert.equal(rootFolded([page('index.htm', 'Index'), page('a.md', 'A')]), 'index.htm')
  // Markdown wins over HTML; the index.html that was not chosen keeps its own row.
  assert.equal(rootFolded([page('index.html', 'Index'), page('README.md', 'Home'), page('a.md', 'A')]), 'README.md')
  assert.equal(rootFolded([page('README.md', 'Home'), page('docs/a.md', 'A')]), 'README.md')
  // A site whose only page is its introduction keeps that row.
  assert.equal(rootFolded([page('README.md', 'Home')]), undefined)
})
