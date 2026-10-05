import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assetName, checksumsName, installPrebuilt, parseChecksums, platforms, readRelease, selectPrebuilt, sha256 } from './prebuilt-cli.mjs'

const release0 = { version: '0.2.0', repository: 'artifact-pages/artifact-pages' }
const base = { release: release0, runnerOs: 'Linux', runnerArch: 'X64' }

test('the release record alone selects the asset, independent of any Action ref', () => {
  const selected = selectPrebuilt(base)
  assert.equal(selected.tag, 'v0.2.0')
  assert.equal(selected.asset, 'artifact-pages_v0.2.0_linux_amd64')
  assert.equal(selected.assetUrl, 'https://github.com/artifact-pages/artifact-pages/releases/download/v0.2.0/artifact-pages_v0.2.0_linux_amd64')
  assert.equal(selected.checksumsUrl, 'https://github.com/artifact-pages/artifact-pages/releases/download/v0.2.0/artifact-pages_v0.2.0_checksums.txt')
})

test('runner platforms map to release assets and unsupported ones are an error', () => {
  assert.equal(selectPrebuilt({ ...base, runnerArch: 'ARM64' }).asset, 'artifact-pages_v0.2.0_linux_arm64')
  assert.equal(selectPrebuilt({ ...base, runnerOs: 'macOS', runnerArch: 'ARM64' }).asset, 'artifact-pages_v0.2.0_darwin_arm64')
  assert.throws(() => selectPrebuilt({ ...base, runnerOs: 'Windows' }), /no released CLI for runner Windows/)
  assert.throws(() => selectPrebuilt({ ...base, runnerArch: 'X86' }), /no released CLI/)
  for (const platform of platforms) {
    const asset = assetName('0.2.0', platform.os, platform.arch)
    const runnerOs = platform.os === 'linux' ? 'Linux' : 'macOS'
    const arch = platform.arch === 'amd64' ? 'X64' : 'ARM64'
    assert.equal(selectPrebuilt({ ...base, runnerOs, runnerArch: arch }).asset, asset)
  }
})

test('release.json is read strictly and its absence means unreleased source', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'release-json-'))
  try {
    assert.equal(readRelease(scratch), undefined)
    writeFileSync(path.join(scratch, 'release.json'), JSON.stringify({ schemaVersion: 1, version: '0.1.0', repository: 'artifact-pages/artifact-pages' }))
    assert.deepEqual(readRelease(scratch), { version: '0.1.0', repository: 'artifact-pages/artifact-pages' })
    for (const bad of [{ schemaVersion: 2, version: '0.1.0', repository: 'a/b' }, { schemaVersion: 1, version: 'main', repository: 'a/b' }, { schemaVersion: 1, version: '0.1.0', repository: '../x' }]) {
      writeFileSync(path.join(scratch, 'release.json'), JSON.stringify(bad))
      assert.throws(() => readRelease(scratch))
    }
    writeFileSync(path.join(scratch, 'release.json'), '{')
    assert.throws(() => readRelease(scratch))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
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
    assert.equal(result.version, '0.2.0')
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

test('missing assets and missing checksum entries are errors with no fallback', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'prebuilt-'))
  try {
    const destination = path.join(scratch, 'artifact-pages')
    const asset = assetName('0.2.0', 'linux', 'amd64')
    await assert.rejects(installPrebuilt({ ...base, destination, fetchImpl: release(Buffer.from('x'), { missing: [asset] }).fetchImpl }), /release v0\.2\.0 of artifact-pages\/artifact-pages is unavailable/)
    await assert.rejects(installPrebuilt({ ...base, destination, fetchImpl: release(Buffer.from('x'), { missing: [checksumsName('0.2.0')] }).fetchImpl }), /unavailable/)
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
    assert.equal(result.version, '0.2.0')
    assert.ok(calls.filter((call) => call.url.startsWith('https://github.com/')).every((call) => call.auth === undefined))
    assert.ok(calls.filter((call) => call.url.startsWith('https://api.github.com/')).every((call) => call.auth === 'Bearer secret-token'))
    await assert.rejects(installPrebuilt({ ...base, destination: path.join(scratch, 'other'), fetchImpl: async () => ({ status: 403 }), token: 'secret-token' }), (error) => !/secret-token/.test(error.message))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('unreleased source installs only the CLI the workflow built, and a published Action ignores it', async () => {
  const { spawnSync } = await import('node:child_process')
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
  const script = path.join(root, 'actions', 'shared', 'prebuilt-cli.mjs')
  const scratch = mkdtempSync(path.join(tmpdir(), 'prebuilt-step-'))
  try {
    const actionRoot = path.join(scratch, 'action')
    const temp = path.join(scratch, 'temp')
    await import('node:fs').then((fs) => { fs.mkdirSync(actionRoot); fs.mkdirSync(temp) })
    const testCli = path.join(scratch, 'built-cli')
    writeFileSync(testCli, '#!/bin/sh\necho built\n')
    const env = { ...process.env, RUNNER_TEMP: temp, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ARTIFACT_PAGES_TOKEN: 'secret-token' }
    const run = (extra) => spawnSync('node', [script, '--action-root', actionRoot], { encoding: 'utf8', env: { ...env, ...extra } })

    const missing = run({ ARTIFACT_PAGES_TEST_CLI: '' })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /needs ARTIFACT_PAGES_TEST_CLI/)

    const used = run({ ARTIFACT_PAGES_TEST_CLI: testCli })
    assert.equal(used.status, 0, used.stderr)
    assert.match(used.stdout, /unreleased source; using the CLI built by this workflow/)
    assert.equal(readFileSync(path.join(temp, 'artifact-pages'), 'utf8'), '#!/bin/sh\necho built\n')
    assert.equal(statSync(path.join(temp, 'artifact-pages')).mode & 0o111, 0o111)

    // With release.json present the override is ignored; the (unreachable) release is required.
    writeFileSync(path.join(actionRoot, 'release.json'), JSON.stringify({ schemaVersion: 1, version: '0.0.0', repository: 'artifact-pages/artifact-pages' }))
    rmSync(path.join(temp, 'artifact-pages'))
    const published = run({ ARTIFACT_PAGES_TEST_CLI: testCli, HTTPS_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1' })
    assert.match(published.stdout, /ARTIFACT_PAGES_TEST_CLI is ignored by a published Action/)
    assert.equal(existsSync(path.join(temp, 'artifact-pages')), false)
    assert.doesNotMatch(published.stdout + published.stderr, /secret-token/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
