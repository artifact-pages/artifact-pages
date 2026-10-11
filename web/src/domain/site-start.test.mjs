import assert from 'node:assert/strict'
import test from 'node:test'
import { compareSites, siteStartPath } from './site-start.ts'

const site = (id, title) => ({ site: { id, title } })
const order = (sites) => [...sites].sort(compareSites).map((entry) => entry.site.id)

test('sites are ordered by title, ignoring case, with the site ID as tie-breaker', () => {
  assert.deepEqual(order([site('guide', 'Guide'), site('arch', 'architecture'), site('z', 'Alpha'), site('b', 'Alpha')]), ['b', 'z', 'arch', 'guide'])
})

test('site order uses code points, not locale: uppercase and lowercase titles interleave, non-Latin follows Latin', () => {
  assert.deepEqual(order([site('j', 'ガイド'), site('b', 'beta'), site('a', 'Alpha'), site('c', 'Zeta')]), ['a', 'b', 'c', 'j'])
  assert.deepEqual(order([site('x', 'Éclair'), site('y', 'Zed')]), ['y', 'x'])
})

test('the start path is the root README, with the directory-page preference', () => {
  assert.equal(siteStartPath([{ path: 'en/README.md' }, { path: 'README.md' }, { path: 'a.md' }]), 'README.md')
  assert.equal(siteStartPath([{ path: 'index.html' }, { path: 'Readme.MD' }]), 'Readme.MD')
  assert.equal(siteStartPath([{ path: 'index.html' }, { path: 'index.md' }]), 'index.md')
})

test('a site without a root README has no start path, even when a folder has one', () => {
  assert.equal(siteStartPath([{ path: 'en/README.md' }, { path: 'guide.md' }]), undefined)
  assert.equal(siteStartPath([]), undefined)
})
