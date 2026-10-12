import assert from 'node:assert/strict'
import test from 'node:test'
import { compareSites, ownValue } from './site-start.ts'

const site = (id, title) => ({ site: { id, title } })
const order = (sites) => [...sites].sort(compareSites).map((entry) => entry.site.id)

test('sites are ordered by title, ignoring case, with the site ID as tie-breaker', () => {
  assert.deepEqual(order([site('guide', 'Guide'), site('arch', 'architecture'), site('z', 'Alpha'), site('b', 'Alpha')]), ['b', 'z', 'arch', 'guide'])
})

test('site order uses code points, not locale: uppercase and lowercase titles interleave, non-Latin follows Latin', () => {
  assert.deepEqual(order([site('j', 'ガイド'), site('b', 'beta'), site('a', 'Alpha'), site('c', 'Zeta')]), ['a', 'b', 'c', 'j'])
  assert.deepEqual(order([site('x', 'Éclair'), site('y', 'Zed')]), ['y', 'x'])
})

test('record lookups by site ID ignore inherited properties', () => {
  const startPaths = { guide: 'README.md' }
  assert.equal(ownValue(startPaths, 'guide'), 'README.md')
  for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(ownValue(startPaths, id), undefined)
  assert.equal(ownValue({ constructor: 'README.md' }, 'constructor'), 'README.md')
})
