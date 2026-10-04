import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { checkVersion, classifyFormats, collectFormatVersions, compareFormats, formatOf } from './compat-gate.mjs'

function storageWithState(t, bytes) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'compat-gate-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const statePath = path.join(root, '_control', 'publish-state', 'docs.json.gz')
  mkdirSync(path.dirname(statePath), { recursive: true })
  writeFileSync(statePath, bytes)
  return root
}

function validState(overrides = {}) {
  return {
    schemaVersion: 2,
    site: 'docs',
    committed: {
      inputRoot: 'a'.repeat(64),
      generation: 'b'.repeat(64),
      objects: [],
    },
    ...overrides,
  }
}

test('recognizes the compressed per-site publish-state format and reads its schema', (t) => {
  assert.equal(formatOf('_control/publish-state/docs.json.gz'), 'control-publish-state')
  const root = storageWithState(t, gzipSync(Buffer.from(JSON.stringify(validState()))))
  assert.deepEqual(collectFormatVersions(root), { 'control-publish-state': [2] })
})

test('fails closed when a recognized publish-state body is not valid gzip JSON', (t) => {
  const root = storageWithState(t, Buffer.from('not gzip'))
  assert.throws(() => collectFormatVersions(root), /cannot read recognized control publish state/)
})

test('fails closed when a recognized publish-state envelope is malformed', (t) => {
  const malformed = [
    [],
    { schemaVersion: 2, site: 'docs', committed: {} },
    { schemaVersion: 2, site: 'docs', committed: { inputRoot: '', objects: [] } },
    { schemaVersion: 0, site: 'docs', committed: { objects: [] } },
    { schemaVersion: 2, site: 'another-site', committed: { objects: [] } },
  ]
  for (const state of malformed) {
    const root = storageWithState(t, gzipSync(Buffer.from(JSON.stringify(state))))
    assert.throws(() => collectFormatVersions(root), /recognized control publish state/)
  }
})

test('fails closed when a recognized publish-state body has duplicate JSON keys', (t) => {
  const duplicate = '{"schemaVersion":2,"schemaVersion":2,"site":"docs","committed":{"inputRoot":"","generation":"b","objects":[]}}'
  const root = storageWithState(t, gzipSync(Buffer.from(duplicate)))
  assert.throws(() => collectFormatVersions(root), /duplicate JSON object key/)
})

test('classifies required control-state additions and control schema changes as breaking', () => {
  const addition = compareFormats({}, { 'control-publish-state': [2] })
  assert.deepEqual(classifyFormats(addition), {
    verdict: 'breaking',
    breakingFormats: [addition[0]],
    publicBreakingFormats: [],
    controlBreakingFormats: [addition[0]],
    mode: 'control-breaking',
  })

  const schemaChange = classifyFormats(compareFormats({ 'control-site-cache': [1] }, { 'control-site-cache': [2] }))
  assert.equal(schemaChange.verdict, 'breaking')
  assert.equal(schemaChange.mode, 'control-breaking')

  const stateSchemaChange = classifyFormats(compareFormats({ 'control-publish-state': [1] }, { 'control-publish-state': [2] }))
  assert.equal(stateSchemaChange.verdict, 'breaking')
  assert.equal(stateSchemaChange.mode, 'control-breaking')
})

test('keeps optional public-only additions compatible and detects public schema breaks', () => {
  const addition = classifyFormats(compareFormats(
    { registry: [1] },
    { registry: [1], 'full-text-manifest': [1] },
  ))
  assert.equal(addition.verdict, 'compatible')
  assert.equal(addition.mode, 'compatible')

  const schemaChange = classifyFormats(compareFormats({ registry: [1] }, { registry: [2] }))
  assert.equal(schemaChange.verdict, 'breaking')
  assert.equal(schemaChange.mode, 'public-breaking')
})

test('accepts the control-format upgrade from 0.1.2 to 0.2.0', () => {
  assert.deepEqual(checkVersion({ tag: 'v0.2.0', baselineVersion: '0.1.2', verdict: 'breaking' }), {
    status: 'passed',
    tag: 'v0.2.0',
    baseline: '0.1.2',
    reason: 'breaking change with the required version increase',
  })
})
