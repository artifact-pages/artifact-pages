import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assetName, checksumsName, installPrebuilt, parseChecksums, platforms, selectPrebuilt, sha256 } from './prebuilt-cli.mjs'

const base = { actionRef: 'v0.2.0', product: '0.2.0', repository: 'tasuku43/git-artifact-pages', runnerOs: 'Linux', runnerArch: 'X64' }

test('only a release tag that matches the source version selects a binary', () => {
  const selected = selectPrebuilt(base)
  assert.equal(selected.use, true)
  assert.equal(selected.asset, 'artifact-pages_v0.2.0_linux_amd64')
  assert.equal(selected.assetUrl, 'https://github.com/tasuku43/git-artifact-pages/releases/download/v0.2.0/artifact-pages_v0.2.0_linux_amd64')
  assert.equal(selected.checksumsUrl, 'https://github.com/tasuku43/git-artifact-pages/releases/download/v0.2.0/artifact-pages_v0.2.0_checksums.txt')
  for (const actionRef of ['main', '0123456789abcdef0123456789abcdef01234567', 'v0.2.0-rc1', 'v0.2', '', undefined]) {
    assert.equal(selectPrebuilt({ ...base, actionRef }).use, false, String(actionRef))
  }
  const mismatch = selectPrebuilt({ ...base, actionRef: 'v0.2.1' })
  assert.equal(mismatch.use, false)
  assert.match(mismatch.reason, /does not match the source version v0\.2\.0/)
})

test('runner platforms map to release assets and unsupported ones fall back', () => {
  assert.equal(selectPrebuilt({ ...base, runnerArch: 'ARM64' }).asset, 'artifact-pages_v0.2.0_linux_arm64')
  assert.equal(selectPrebuilt({ ...base, runnerOs: 'macOS', runnerArch: 'ARM64' }).asset, 'artifact-pages_v0.2.0_darwin_arm64')
  assert.equal(selectPrebuilt({ ...base, runnerOs: 'Windows' }).use, false)
  assert.equal(selectPrebuilt({ ...base, runnerArch: 'X86' }).use, false)
  assert.equal(selectPrebuilt({ ...base, repository: '../x' }).use, false)
  for (const platform of platforms) {
    const asset = assetName('0.2.0', platform.os, platform.arch)
    const runnerOs = platform.os === 'linux' ? 'Linux' : 'macOS'
    const arch = platform.arch === 'amd64' ? 'X64' : 'ARM64'
    assert.equal(selectPrebuilt({ ...base, runnerOs, runnerArch: arch }).asset, asset)
  }
})

test('checksum files parse in sha256sum format', () => {
  const hash = 'a'.repeat(64)
  const map = parseChecksums(`${hash}  artifact-pages_v0.2.0_linux_amd64\n${'B'.repeat(64)} *other\nnot a line\n${hash}  ../escape\n`)
  assert.equal(map.get('artifact-pages_v0.2.0_linux_amd64'), hash)
  assert.equal(map.get('other'), 'b'.repeat(64))
  assert.equal(map.size, 2)
})

function release(binary, { checksumOverride, missing = [], status = {} } = {}) {
  const asset = assetName('0.2.0', 'linux', 'amd64')
  const files = new Map([
    [asset, binary],
    [checksumsName('0.2.0'), Buffer.from(`${checksumOverride ?? sha256(binary)}  ${asset}\n`)],
  ])
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization })
    const name = String(url).split('/').pop()
    if (status[name]) return { status: status[name], arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) }
    if (missing.includes(name) || !files.has(name)) return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    const bytes = files.get(name)
    return { status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  }
  return { fetchImpl, calls }
}

test('a verified download is installed executable and never sends the token unauthenticated', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'prebuilt-'))
  try {
    const binary = Buffer.from('#!/bin/sh\necho hi\n')
    const destination = path.join(scratch, 'artifact-pages')
    const { fetchImpl, calls } = release(binary)
    const result = await installPrebuilt({ ...base, destination, fetchImpl, token: 'secret-token' })
    assert.equal(result.used, true)
    assert.deepEqual(readFileSync(destination), binary)
    assert.equal(statSync(destination).mode & 0o111, 0o111)
    assert.ok(calls.every((call) => call.auth === undefined), 'unauthenticated by default')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a checksum mismatch fails and installs nothing', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'prebuilt-'))
  try {
    const destination = path.join(scratch, 'artifact-pages')
    const { fetchImpl } = release(Buffer.from('binary'), { checksumOverride: 'c'.repeat(64) })
    await assert.rejects(installPrebuilt({ ...base, destination, fetchImpl }), /checksum mismatch/)
    assert.equal(existsSync(destination), false)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('missing assets, missing checksum entries and non-tag refs fall back to a source build', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'prebuilt-'))
  try {
    const destination = path.join(scratch, 'artifact-pages')
    const asset = assetName('0.2.0', 'linux', 'amd64')
    const missingAsset = await installPrebuilt({ ...base, destination, fetchImpl: release(Buffer.from('x'), { missing: [asset] }).fetchImpl })
    assert.equal(missingAsset.used, false)
    assert.match(missingAsset.reason, /unavailable/)
    const missingChecksums = await installPrebuilt({ ...base, destination, fetchImpl: release(Buffer.from('x'), { missing: [checksumsName('0.2.0')] }).fetchImpl })
    assert.equal(missingChecksums.used, false)
    const notTag = await installPrebuilt({ ...base, actionRef: 'main', destination, fetchImpl: async () => assert.fail('must not download') })
    assert.equal(notTag.used, false)
    assert.equal(existsSync(destination), false)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('rate limiting retries through the API with the token, which never appears in a reason', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'prebuilt-'))
  try {
    const binary = Buffer.from('payload')
    const asset = assetName('0.2.0', 'linux', 'amd64')
    const checksumText = Buffer.from(`${sha256(binary)}  ${asset}\n`)
    const calls = []
    const body = (bytes) => ({ status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), auth: init.headers?.Authorization })
      const text = String(url)
      if (text.startsWith('https://github.com/')) return { status: 429 }
      if (text.endsWith('/releases/tags/v0.2.0')) return { status: 200, json: async () => ({ assets: [{ name: asset, url: 'https://api.github.com/assets/1' }, { name: checksumsName('0.2.0'), url: 'https://api.github.com/assets/2' }] }) }
      return body(text.endsWith('/1') ? binary : checksumText)
    }
    const destination = path.join(scratch, 'artifact-pages')
    const result = await installPrebuilt({ ...base, destination, fetchImpl, token: 'secret-token' })
    assert.equal(result.used, true)
    assert.ok(calls.filter((call) => call.url.startsWith('https://github.com/')).every((call) => call.auth === undefined))
    assert.ok(calls.filter((call) => call.url.startsWith('https://api.github.com/')).every((call) => call.auth === 'Bearer secret-token'))
    const denied = await installPrebuilt({ ...base, destination: path.join(scratch, 'other'), fetchImpl: async () => ({ status: 403 }), token: 'secret-token' })
    assert.equal(denied.used, false)
    assert.doesNotMatch(denied.reason, /secret-token/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('the step script reads the source version and reports a source build for non-release refs', async () => {
  const { spawnSync } = await import('node:child_process')
  const { readProductVersion } = await import('./prebuilt-cli.mjs')
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
  assert.match(readProductVersion(root), /^\d+\.\d+\.\d+$/)
  const scratch = mkdtempSync(path.join(tmpdir(), 'prebuilt-step-'))
  try {
    const output = path.join(scratch, 'out.txt')
    const run = spawnSync('node', [path.join(root, 'actions', 'shared', 'prebuilt-cli.mjs'), '--source-root', root], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output, RUNNER_TEMP: scratch, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ARTIFACT_PAGES_ACTION_REF: 'main', ARTIFACT_PAGES_ACTION_REPOSITORY: 'tasuku43/git-artifact-pages', ARTIFACT_PAGES_TOKEN: 'secret-token' },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /building from source \(the Action ref "main" is not a release tag\)/)
    assert.equal(readFileSync(output, 'utf8'), 'used=false\n')
    assert.doesNotMatch(run.stdout + run.stderr, /secret-token/)
    assert.equal(existsSync(path.join(scratch, 'artifact-pages')), false)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
