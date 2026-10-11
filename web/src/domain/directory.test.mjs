// Checks directory resolution, counts and ordering for the directory page (ISSUE-075).
// Run with: npm run test:reader-shell
// Ordering is alphabetical (title) until ISSUE-076 / TD19 define an explicit order; update the order assertions then.
import assert from 'node:assert/strict'
import test from 'node:test'
import { findIndexArtifact, pageCountLabel, pageHeadings, resolveDirectory } from './directory.ts'

const page = (path, title, updatedAt = '2026-10-01T00:00:00Z', extra = {}) => ({ id: path, path, title, updatedAt, format: path.endsWith('.md') ? 'markdown' : 'html', ...extra })

const artifacts = [
  page('en/publishing.html', 'Publishing', '2026-10-03T00:00:00Z'),
  page('en/getting-started.html', 'Getting started', '2026-10-02T00:00:00Z'),
  page('en/reference/cli/publish.html', 'publish command', '2026-10-09T00:00:00Z'),
  page('en/reference/cli/preview.html', 'preview command', '2026-10-05T00:00:00Z'),
  page('en/reference/config.html', 'Configuration', '2026-10-04T00:00:00Z'),
  page('ja/publishing.html', '公開する'),
  page('solo/only.html', 'Only page'),
  page('docs/README.md', 'Docs home'),
  page('docs/a.md', 'A page'),
  page('with space/日本語/ページ.html', 'Encoded'),
  page('top.html', 'Top level'),
]

test('a path with no page below it is not a directory', () => {
  assert.equal(resolveDirectory(artifacts, 'nope'), undefined)
  assert.equal(resolveDirectory(artifacts, 'en/publishing.html'), undefined)
  assert.equal(resolveDirectory(artifacts, 'e'), undefined)
  assert.equal(resolveDirectory(artifacts, ''), undefined)
})

test('a directory lists subfolders and pages in alphabetical order with deep counts', () => {
  const listing = resolveDirectory(artifacts, 'en')
  assert.equal(listing.name, 'en')
  assert.equal(listing.pageCount, 5)
  assert.equal(listing.latestUpdatedAt, '2026-10-09T00:00:00Z')
  assert.deepEqual(listing.folders.map(({ name, pageCount }) => [name, pageCount]), [['reference', 3]])
  assert.equal(listing.folders[0].latestUpdatedAt, '2026-10-09T00:00:00Z')
  assert.deepEqual(listing.pages.map(({ title }) => title), ['Getting started', 'Publishing'])
  assert.equal(listing.indexArtifact, undefined)
})

test('trailing and duplicate slashes name the same directory', () => {
  assert.equal(resolveDirectory(artifacts, 'en/')?.path, 'en')
  assert.equal(resolveDirectory(artifacts, '/en//reference/')?.path, 'en/reference')
})

test('a directory whose only pages sit in nested folders has folders and no pages', () => {
  const listing = resolveDirectory(artifacts, 'en/reference')
  assert.deepEqual(listing.folders.map(({ name }) => name), ['cli'])
  assert.deepEqual(listing.pages.map(({ title }) => title), ['Configuration'])
  const cli = resolveDirectory(artifacts, 'en/reference/cli')
  assert.equal(cli.pageCount, 2)
  assert.deepEqual(cli.pages.map(({ title }) => title), ['preview command', 'publish command'])
  const top = resolveDirectory([page('a/b/c/d.html', 'D')], 'a')
  assert.deepEqual(top.pages, [])
  assert.deepEqual(top.folders.map(({ name, pageCount }) => [name, pageCount]), [['b', 1]])
})

test('a one-page directory is a directory', () => {
  const listing = resolveDirectory(artifacts, 'solo')
  assert.equal(listing.pageCount, 1)
  assert.deepEqual(listing.pages.map(({ title }) => title), ['Only page'])
})

test('README.md becomes the body and is not listed again', () => {
  const listing = resolveDirectory(artifacts, 'docs')
  assert.equal(listing.indexArtifact?.path, 'docs/README.md')
  assert.deepEqual(listing.pages.map(({ path }) => path), ['docs/a.md'])
  assert.equal(listing.pageCount, 2)
})

test('index file precedence prefers Markdown README, then index.md, then index.html', () => {
  const pick = (...names) => findIndexArtifact(names.map((name) => page(`x/${name}`, name)))?.path
  assert.equal(pick('index.html', 'index.md', 'README.md'), 'x/README.md')
  assert.equal(pick('index.html', 'index.md'), 'x/index.md')
  assert.equal(pick('other.html', 'index.html'), 'x/index.html')
  assert.equal(pick('Readme.MD'), 'x/Readme.MD')
  assert.equal(pick('other.html'), undefined)
})

test('percent-decoded paths with spaces and non-ASCII names resolve', () => {
  const listing = resolveDirectory(artifacts, 'with space/日本語')
  assert.equal(listing.name, '日本語')
  assert.equal(listing.pages.length, 1)
  assert.deepEqual(resolveDirectory(artifacts, 'with space').folders.map(({ name }) => name), ['日本語'])
})

test('pageHeadings keeps the first level-2 headings and counts the rest', () => {
  const toc = [1, 2, 2, 3, 2, 2, 2].map((level, i) => ({ level, text: `H${i}`, id: `h${i}` }))
  const { shown, hidden } = pageHeadings({ toc })
  assert.deepEqual(shown.map(({ id }) => id), ['h1', 'h2', 'h4'])
  assert.equal(hidden, 2)
  assert.deepEqual(pageHeadings({}), { shown: [], hidden: 0 })
})

test('page counts are pluralised', () => {
  assert.equal(pageCountLabel(1), '1 page')
  assert.equal(pageCountLabel(3), '3 pages')
})
