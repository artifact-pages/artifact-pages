import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { linkedModules, renderNotices } from './package-cli-release.mjs'

function moduleDir(root, name, files) {
  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(dir, file), text)
  return dir
}

test('notices include the first-party license and every module license, sorted and deduplicated', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'notices-'))
  try {
    const a = moduleDir(root, 'a', { LICENSE: 'A license text' })
    const b = moduleDir(root, 'b', { 'LICENSE.md': 'B license', NOTICE: 'B notice', 'main.go': 'package b' })
    const text = renderNotices([
      { path: 'example.com/b', version: 'v2.0.0', dir: b },
      { path: 'example.com/a', version: 'v1.0.0', dir: a },
      { path: 'example.com/a', version: 'v1.0.0', dir: a },
    ], 'MIT License\n')
    assert.match(text, /^This file lists the licenses/)
    assert.match(text, /MIT License/)
    assert.ok(text.indexOf('example.com/a@v1.0.0') < text.indexOf('example.com/b@v2.0.0'))
    assert.equal(text.split('example.com/a@v1.0.0').length - 1, 1)
    assert.match(text, /B license\n\nB notice/)
    assert.doesNotMatch(text, /package b/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a module without a license file fails the packaging', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'notices-'))
  try {
    const dir = moduleDir(root, 'c', { 'main.go': 'package c' })
    assert.throws(() => renderNotices([{ path: 'example.com/c', version: 'v1.0.0', dir }], 'MIT'), /no license file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the linked module list covers the real CLI dependencies for every platform', () => {
  for (const platform of [{ os: 'linux', arch: 'amd64' }, { os: 'darwin', arch: 'arm64' }]) {
    const paths = linkedModules(platform).map((module) => module.path)
    assert.ok(paths.includes('github.com/aws/aws-sdk-go-v2/service/s3'), `${platform.os}/${platform.arch}`)
    assert.ok(!paths.includes('github.com/artifact-pages/artifact-pages'), 'the main module is not a third-party notice')
  }
})
