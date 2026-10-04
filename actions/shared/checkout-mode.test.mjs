import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { decideCheckout, isGitCheckoutRoot } from './checkout-mode.mjs'

const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'checkout-mode.mjs')

test('true and false are unconditional', () => {
  assert.equal(decideCheckout({ env: { ARTIFACT_PAGES_INPUT_CHECKOUT: 'true', GITHUB_WORKSPACE: '/x' }, isCheckout: () => true }).checkout, true)
  assert.equal(decideCheckout({ env: { ARTIFACT_PAGES_INPUT_CHECKOUT: 'false', GITHUB_WORKSPACE: '/x' }, isCheckout: () => false }).checkout, false)
})

test('auto (and empty) checks out only when the workspace is not a Git checkout', () => {
  for (const mode of ['auto', '', 'AUTO']) {
    assert.equal(decideCheckout({ env: { ARTIFACT_PAGES_INPUT_CHECKOUT: mode }, isCheckout: () => false }).checkout, true, mode)
    assert.equal(decideCheckout({ env: { ARTIFACT_PAGES_INPUT_CHECKOUT: mode }, isCheckout: () => true }).checkout, false, mode)
  }
})

test('invalid checkout and fetch-depth values are errors', () => {
  assert.throws(() => decideCheckout({ env: { ARTIFACT_PAGES_INPUT_CHECKOUT: 'yes' } }), /auto, true or false/)
  for (const depth of ['-1', '1.5', 'all', '0; rm']) {
    assert.throws(() => decideCheckout({ env: { ARTIFACT_PAGES_INPUT_FETCH_DEPTH: depth }, isCheckout: () => true }), /fetch-depth/, depth)
  }
  assert.doesNotThrow(() => decideCheckout({ env: { ARTIFACT_PAGES_INPUT_FETCH_DEPTH: '1' }, isCheckout: () => true }))
})

test('isGitCheckoutRoot recognizes a repository root, not a plain or nested directory', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'checkout-mode-'))
  try {
    const plain = path.join(scratch, 'plain')
    const repo = path.join(scratch, 'repo')
    mkdirSync(plain)
    mkdirSync(path.join(repo, 'nested'), { recursive: true })
    assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
    assert.equal(isGitCheckoutRoot(plain), false)
    assert.equal(isGitCheckoutRoot(repo), true)
    assert.equal(isGitCheckoutRoot(path.join(repo, 'nested')), false)
    assert.equal(isGitCheckoutRoot(path.join(scratch, 'missing')), false)
    assert.equal(isGitCheckoutRoot(''), false)

    const output = path.join(scratch, 'out.txt')
    writeFileSync(output, '')
    const run = (workspace, extra = {}) => spawnSync('node', [script], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_WORKSPACE: workspace, ARTIFACT_PAGES_INPUT_CHECKOUT: 'auto', ...extra } })
    assert.equal(run(plain).status, 0)
    assert.equal(run(repo).status, 0)
    assert.equal(readFileSync(output, 'utf8'), 'checkout=true\ncheckout=false\n')
    const bad = run(repo, { ARTIFACT_PAGES_INPUT_CHECKOUT: 'maybe' })
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /::error/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
