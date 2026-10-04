import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import {
  assertRequiredPublishStateRoots,
  checkVersion,
  classifyFormats,
  collectFormatVersions,
  compatibilityPolicy,
  compareFormats,
  formatOf,
} from './compat-gate.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function candidateTree(t, version) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'compat-candidate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'cli/internal/version/version.go')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `package version\n\nconst Product = "${version}"\n`)
  return root
}

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
    validState({ committed: { ...validState().committed, generation: 'not-a-hash' } }),
    validState({
      committed: {
        ...validState().committed,
        objects: [{
          key: '_indexes/docs/index.json',
          sha256: 'not-a-hash',
          size: 1,
          contentType: 'application/json; charset=utf-8',
          contentEncoding: '',
          contentDisposition: 'inline',
          cacheControl: 'no-cache',
        }],
      },
    }),
    validState({
      committed: {
        ...validState().committed,
        objects: [{
          key: '_artifacts/notes/page.html',
          sha256: 'c'.repeat(64),
          size: 1,
          contentType: 'text/html',
          contentEncoding: '',
          contentDisposition: 'inline',
          cacheControl: 'no-cache',
        }],
      },
    }),
  ]
  for (const state of malformed) {
    const root = storageWithState(t, gzipSync(Buffer.from(JSON.stringify(state))))
    assert.throws(() => collectFormatVersions(root), /recognized control publish state/)
  }
})

test('requires a valid publish-state root for every site', (t) => {
  const root = storageWithState(t, gzipSync(Buffer.from(JSON.stringify(validState()))))
  assert.throws(() => assertRequiredPublishStateRoots(root, ['docs', 'notes']), /missing required control publish state for site notes/)
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

  const removedState = classifyFormats(compareFormats({ 'control-publish-state': [2] }, {}))
  assert.equal(removedState.verdict, 'breaking')
  assert.equal(removedState.mode, 'control-breaking')
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

test('skips cross-version checks for a 0.x candidate but keeps the source version authoritative', () => {
  assert.deepEqual(compatibilityPolicy({ productVersion: '0.2.0', tag: 'v0.2.0' }), {
    action: 'skip',
    reasonCode: 'pre-1.0-compatibility-not-guaranteed',
    reason: 'cross-version compatibility is not guaranteed before 1.0.0',
  })
  assert.equal(compatibilityPolicy({ productVersion: '1.0.0', tag: 'v1.0.0' }).action, 'run')
  assert.equal(compatibilityPolicy({ productVersion: '0.2.0', tag: 'v1.0.0' }).action, 'fail')
  assert.equal(compatibilityPolicy({ productVersion: '1.0.0', tag: 'v1.0.0' }).reasonCode, undefined)
})

test('the CLI writes an explicit 0.x skip report without building baseline or candidate', (t) => {
  const candidate = candidateTree(t, '0.2.1')
  const output = path.join(candidate, 'verdict.json')
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, 'scripts/compat-gate.mjs'),
    '--candidate', candidate,
    '--baseline', 'HEAD',
    '--tag', 'v0.2.1',
    '--out', output,
  ], { cwd: projectRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stderr, /building baseline CLI|building candidate CLI/)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(report.verdict, 'skipped')
  assert.equal(report.result, 'skipped')
  assert.equal(report.reasonCode, 'pre-1.0-compatibility-not-guaranteed')
  assert.equal(report.candidate.version, '0.2.1')
  assert.equal(report.baseline.ref, 'HEAD')
  assert.equal(report.versionCheck.status, 'passed')
})

test('the CLI still rejects a repeated 0.x tag even though format compatibility is skipped', (t) => {
  const candidate = candidateTree(t, '0.2.0')
  const output = path.join(candidate, 'verdict.json')
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, 'scripts/compat-gate.mjs'),
    '--candidate', candidate,
    '--baseline', 'HEAD',
    '--tag', 'v0.2.0',
    '--out', output,
  ], { cwd: projectRoot, encoding: 'utf8' })
  assert.equal(result.status, 1)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(report.verdict, 'skipped')
  assert.equal(report.result, 'failed')
  assert.equal(report.versionCheck.status, 'failed')
  assert.match(report.versionCheck.reason, /does not increase the version/)
})

test('the CLI does not let a mismatched 1.x tag bypass candidate version detection', (t) => {
  const candidate = candidateTree(t, '0.2.1')
  const output = path.join(candidate, 'verdict.json')
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, 'scripts/compat-gate.mjs'),
    '--candidate', candidate,
    '--tag', 'v1.0.0',
    '--out', output,
  ], { cwd: projectRoot, encoding: 'utf8' })
  assert.equal(result.status, 1)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(report.verdict, 'failed')
  assert.equal(report.reasonCode, 'candidate-tag-version-mismatch')
})

test('0.x skip keeps version tags strictly increasing without requiring a compatibility-position bump', () => {
  assert.deepEqual(checkVersion({ tag: 'v0.2.1', baselineVersion: '0.2.0', verdict: 'skipped' }), {
    status: 'passed',
    tag: 'v0.2.1',
    baseline: '0.2.0',
    reason: 'version increases; compatibility checks are skipped for 0.x',
  })
  assert.equal(checkVersion({ tag: 'v0.2.0', baselineVersion: '0.2.0', verdict: 'skipped' }).status, 'failed')
  assert.equal(checkVersion({ tag: 'v1.1.0', baselineVersion: '1.0.0', verdict: 'breaking' }).status, 'failed')
  assert.equal(checkVersion({ tag: 'v2.0.0', baselineVersion: '1.0.0', verdict: 'breaking' }).status, 'passed')
})
