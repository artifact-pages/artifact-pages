import assert from 'node:assert/strict'
import test from 'node:test'
import { folderFacets } from './search-facets.ts'

const hits = ['a/1.md', 'a/b/2.md', 'a/b/3.md', 'c/4.md', 'top.md', 'd/5.md', 'd/6.md'].map((path) => ({ path }))

test('counts hits per top-level folder, most hits first then by name', () => {
  assert.deepEqual(folderFacets(hits), [
    { folder: 'a', count: 3 },
    { folder: 'd', count: 2 },
    { folder: 'c', count: 1 },
  ])
})

test('pages at the top level are not a facet', () => {
  assert.deepEqual(folderFacets([{ path: 'top.md' }]), [])
})

test('a nested selected folder is listed with its own count', () => {
  assert.deepEqual(folderFacets(hits, 'a/b').at(-1), { folder: 'a/b', count: 2 })
  assert.equal(folderFacets(hits, 'a/b').length, 4)
})

test('a selected top-level folder is not duplicated', () => {
  assert.equal(folderFacets(hits, 'a').length, 3)
})

test('a selected folder without hits still appears with zero', () => {
  assert.deepEqual(folderFacets(hits, 'zzz').at(-1), { folder: 'zzz', count: 0 })
})

test('no hits give no facets', () => {
  assert.deepEqual(folderFacets([]), [])
})
