import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { binaryName, plan, record, sourceKey } from './build-once.mjs'

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'build-once-'))
  const source = path.join(root, 'source')
  const temp = path.join(root, 'temp')
  mkdirSync(path.join(source, 'cli', 'cmd'), { recursive: true })
  mkdirSync(temp)
  writeFileSync(path.join(source, 'go.mod'), 'module x\n')
  writeFileSync(path.join(source, 'go.sum'), '')
  writeFileSync(path.join(source, 'cli', 'cmd', 'main.go'), 'package main\n')
  return { root, source, temp, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('the first Action builds, later Actions from the same source reuse the binary', (t) => {
  const f = fixture()
  t.after(f.cleanup)
  assert.equal(plan({ sourceRoot: f.source, tempDir: f.temp, prebuiltUsed: false }).build, true)
  writeFileSync(path.join(f.temp, binaryName), 'binary')
  assert.equal(plan({ sourceRoot: f.source, tempDir: f.temp, prebuiltUsed: false }).build, true, 'a binary without a marker is not trusted')
  record({ sourceRoot: f.source, tempDir: f.temp })
  const again = plan({ sourceRoot: f.source, tempDir: f.temp, prebuiltUsed: false })
  assert.equal(again.build, false)
  assert.match(again.reason, /reusing/)
})

test('a different source, a changed binary or a corrupt marker forces a rebuild', (t) => {
  const f = fixture()
  t.after(f.cleanup)
  writeFileSync(path.join(f.temp, binaryName), 'binary')
  record({ sourceRoot: f.source, tempDir: f.temp })
  writeFileSync(path.join(f.source, 'cli', 'cmd', 'main.go'), 'package main\n// changed\n')
  assert.match(plan({ sourceRoot: f.source, tempDir: f.temp, prebuiltUsed: false }).reason, /source differs/)
  record({ sourceRoot: f.source, tempDir: f.temp })
  writeFileSync(path.join(f.temp, binaryName), 'released binary')
  assert.match(plan({ sourceRoot: f.source, tempDir: f.temp, prebuiltUsed: false }).reason, /binary changed/)
  writeFileSync(path.join(f.temp, 'artifact-pages.build-marker'), '{')
  assert.equal(plan({ sourceRoot: f.source, tempDir: f.temp, prebuiltUsed: false }).build, true)
})

test('the released-binary path never builds and the source key is stable and content-sensitive', (t) => {
  const f = fixture()
  t.after(f.cleanup)
  assert.equal(plan({ sourceRoot: f.source, tempDir: f.temp, prebuiltUsed: true }).build, false)
  const key = sourceKey(f.source)
  assert.equal(sourceKey(f.source), key)
  writeFileSync(path.join(f.source, 'go.sum'), 'x\n')
  assert.notEqual(sourceKey(f.source), key)
})
