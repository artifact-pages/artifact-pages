import assert from 'node:assert/strict'
import test from 'node:test'
import { searchAvailability } from './search-availability.ts'

const withMeta = { site: { id: 's', title: 's' }, schemaVersion: 1, generatedAt: 'x', artifactCount: 1, artifactIndexUrl: '/i' }

test('while discovery loads the page is loading, never unavailable', () => {
  assert.equal(searchAvailability('loading', undefined, false), 'loading')
  assert.equal(searchAvailability('loading', withMeta, false), 'loading')
})

test('a failed discovery is a load failure, not "published without page text search"', () => {
  assert.equal(searchAvailability('error', undefined, false), 'discovery-error')
})

test('a site whose own metadata is unavailable is a load failure', () => {
  assert.equal(searchAvailability('success', { site: withMeta.site, status: 'metadata-unavailable' }, false), 'discovery-error')
})

test('loaded discovery without a full-text client says search is unavailable', () => {
  assert.equal(searchAvailability('success', withMeta, false), 'unavailable')
  assert.equal(searchAvailability('success', undefined, false), 'unavailable')
})

test('loaded discovery with a client is available', () => {
  assert.equal(searchAvailability('success', { ...withMeta, fullTextUrl: '/_indexes/s/search/manifest.json' }, true), 'available')
})
