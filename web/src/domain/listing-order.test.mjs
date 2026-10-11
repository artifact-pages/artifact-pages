// Checks the shared listing comparator (ISSUE-076, TD19): folders first, filename order, locale independent.
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import { compareArtifactsByPath, compareNames, comparePaths } from './listing-order.ts'
import { buildArtifactTree } from './tree.ts'

const sortNames = (names) => [...names].sort(compareNames)
const sortPaths = (paths) => [...paths].sort(comparePaths)

test('names compare case-insensitively with the exact name as tie-break', () => {
  assert.deepEqual(sortNames(['banana', 'Apple', 'cherry', 'apple']), ['Apple', 'apple', 'banana', 'cherry'])
  assert.equal(compareNames('README.md', 'readme.md') < 0, true)
  assert.equal(compareNames('a', 'a'), 0)
})

test('numeric prefixes keep author order and numbers are not compared naturally', () => {
  assert.deepEqual(sortNames(['03-config.html', '01-intro.html', '02-start.html']), ['01-intro.html', '02-start.html', '03-config.html'])
  assert.deepEqual(sortNames(['2-x.html', '10-x.html', '1-x.html']), ['1-x.html', '10-x.html', '2-x.html'])
})

test('Japanese and mixed names sort by code point regardless of locale', () => {
  const names = ['はじめる.html', 'Zeta.html', 'サイトの公開.html', 'alpha.html', '01-概要.html', '設定ファイル.html']
  const expected = ['01-概要.html', 'alpha.html', 'Zeta.html', 'はじめる.html', 'サイトの公開.html', '設定ファイル.html']
  assert.deepEqual(sortNames(names), expected)
  assert.deepEqual(sortNames([...names].reverse()), expected)
  assert.deepEqual(sortNames(names), expected)
})

test('astral code points compare as code points, not UTF-16 units', () => {
  // U+FF5E (BMP, above surrogates in UTF-16) must sort before U+1F600.
  assert.equal(compareNames('～', '\u{1F600}') < 0, true)
})

test('folders come before files at every level', () => {
  assert.deepEqual(
    sortPaths(['zeta.html', 'en/b.html', 'a.html', 'en/sub/c.html', 'en/a.html', 'ja/x.html']),
    ['en/sub/c.html', 'en/a.html', 'en/b.html', 'ja/x.html', 'a.html', 'zeta.html'],
  )
  assert.equal(comparePaths('docs/z.html', 'docs.html') < 0, true)
})

test('paths tie-break by id when equal', () => {
  const a = { id: 'a', path: 'x.html' }
  const b = { id: 'b', path: 'x.html' }
  assert.equal(compareArtifactsByPath(a, b) < 0, true)
  assert.equal(compareArtifactsByPath(a, a), 0)
})

test('the title does not affect the order', () => {
  const entries = [
    { id: '1', path: '02-start.html', title: 'Aardvark' },
    { id: '2', path: '01-intro.html', title: 'Zebra' },
  ]
  assert.deepEqual([...entries].sort(compareArtifactsByPath).map((entry) => entry.id), ['2', '1'])
})

test('the tree lists folders first and each group by filename', () => {
  const entry = (path) => ({ id: path, path, title: path })
  const tree = buildArtifactTree(['b.html', 'zz/01.html', 'a.html', '10-x/1.html', 'Aa/1.html', '2-x/1.html', 'zz/00.html'].map(entry))
  assert.deepEqual([...tree.directories.keys()], ['10-x', '2-x', 'Aa', 'zz'])
  assert.deepEqual(tree.artifacts.map((artifact) => artifact.path), ['a.html', 'b.html'])
  assert.deepEqual(tree.directories.get('zz').artifacts.map((artifact) => artifact.path), ['zz/00.html', 'zz/01.html'])
})

test('a file and a folder sharing a prefix still put the folder first', () => {
  assert.deepEqual(sortPaths(['a', 'a.html', 'a/b.html', 'ab/c.html']), ['a/b.html', 'ab/c.html', 'a', 'a.html'])
  assert.equal(comparePaths('a/z.html', 'a.html') < 0, true)
})

test('surrogate-pair names order by code point', () => {
  assert.deepEqual(sortNames(['\u{1F600}.html', '\uFF5E.html', 'a.html', '\u{20BB7}.html']), ['a.html', '\uFF5E.html', '\u{1F600}.html', '\u{20BB7}.html'])
})

test('NFC and NFD spellings are distinct and sort deterministically', () => {
  const nfc = '\u00E9.html'
  const nfd = 'e\u0301.html'
  assert.notEqual(compareNames(nfc, nfd), 0)
  assert.deepEqual(sortNames([nfd, nfc]), sortNames([nfc, nfd]))
})
