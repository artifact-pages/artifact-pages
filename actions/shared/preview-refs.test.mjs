import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertPreviewRefsReachable, resolvePreviewRefs, resolvePullRequestReference } from './preview-refs.mjs'

const sha = 'a'.repeat(40)
const prEvent = { pull_request: { head: { sha }, base: { ref: 'release/1' } } }

test('explicit inputs always win, even on pull_request', () => {
  const refs = resolvePreviewRefs({
    env: { ARTIFACT_PAGES_INPUT_HEAD: ' topic ', ARTIFACT_PAGES_INPUT_DEFAULT_REF: 'main', GITHUB_EVENT_NAME: 'pull_request' },
    event: prEvent,
  })
  assert.deepEqual([refs.head, refs.defaultRef, refs.headSource, refs.defaultRefSource], ['topic', 'main', 'input', 'input'])
})

test('pull_request defaults to the event head SHA and origin/<base ref>', () => {
  const refs = resolvePreviewRefs({ env: { GITHUB_EVENT_NAME: 'pull_request' }, event: prEvent })
  assert.deepEqual([refs.head, refs.defaultRef, refs.headSource, refs.defaultRefSource], [sha, 'origin/release/1', 'event', 'event'])
})

test('each side falls back independently', () => {
  const refs = resolvePreviewRefs({ env: { GITHUB_EVENT_NAME: 'pull_request', ARTIFACT_PAGES_INPUT_HEAD: 'topic' }, event: prEvent })
  assert.deepEqual([refs.head, refs.defaultRef], ['topic', 'origin/release/1'])
})

test('other events keep HEAD and origin/HEAD, including pull_request_target', () => {
  for (const eventName of ['push', 'workflow_dispatch', 'pull_request_target', '']) {
    const refs = resolvePreviewRefs({ env: { GITHUB_EVENT_NAME: eventName }, event: prEvent })
    assert.deepEqual([refs.head, refs.defaultRef], ['HEAD', 'origin/HEAD'], eventName)
  }
})

test('a malformed pull_request event is an error', () => {
  assert.throws(() => resolvePreviewRefs({ env: { GITHUB_EVENT_NAME: 'pull_request' }, event: { pull_request: { base: { ref: 'main' } } } }), /valid head commit SHA/)
  assert.throws(() => resolvePreviewRefs({ env: { GITHUB_EVENT_NAME: 'pull_request' }, event: { pull_request: { head: { sha } } } }), /base ref/)
})

const prNumberEvent = { pull_request: { number: 42, head: { sha }, base: { ref: 'main' } } }

test('pull-request defaults to the pull_request event number only', () => {
  assert.deepEqual(resolvePullRequestReference({ env: { GITHUB_EVENT_NAME: 'pull_request' }, event: prNumberEvent }), { reference: '42', source: 'event' })
  for (const eventName of ['push', 'workflow_dispatch', 'pull_request_target', 'issue_comment', '']) {
    assert.deepEqual(resolvePullRequestReference({ env: { GITHUB_EVENT_NAME: eventName }, event: prNumberEvent }), { reference: '', source: 'default' }, eventName)
  }
})

test('an explicit pull-request wins and none forces a manual preview', () => {
  const env = { GITHUB_EVENT_NAME: 'pull_request' }
  assert.deepEqual(resolvePullRequestReference({ env: { ...env, ARTIFACT_PAGES_INPUT_PULL_REQUEST: ' 7 ' }, event: prNumberEvent }), { reference: '7', source: 'input' })
  assert.deepEqual(resolvePullRequestReference({ env: { ...env, ARTIFACT_PAGES_INPUT_PULL_REQUEST: 'None' }, event: prNumberEvent }), { reference: '', source: 'none' })
  assert.deepEqual(resolvePullRequestReference({ env: { GITHUB_EVENT_NAME: 'push', ARTIFACT_PAGES_INPUT_PULL_REQUEST: 'none' } }), { reference: '', source: 'none' })
})

test('a pull_request event without a valid number is an error', () => {
  for (const event of [{ pull_request: {} }, { pull_request: { number: 0 } }, { pull_request: { number: '42' } }, {}]) {
    assert.throws(() => resolvePullRequestReference({ env: { GITHUB_EVENT_NAME: 'pull_request' }, event }), /valid pull request number/)
  }
})

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function repository(root) {
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(root, 'a.txt'), 'a')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'one')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(root, 'switch', '-qc', 'topic')
  writeFileSync(path.join(root, 'b.txt'), 'b')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'two')
  return root
}

test('reachable refs report their commits and merge base', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'preview-refs-'))
  try {
    const root = repository(path.join(scratch, 'repo'))
    const result = assertPreviewRefsReachable(root, { head: 'topic', defaultRef: 'origin/main', headSource: 'input' })
    assert.equal(result.headSHA, git(root, 'rev-parse', 'topic'))
    assert.equal(result.mergeBaseSHA, git(root, 'rev-parse', 'origin/main'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('unreachable refs fail with fetch-depth guidance and never fetch', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'preview-refs-'))
  try {
    const root = repository(path.join(scratch, 'repo'))
    assert.throws(
      () => assertPreviewRefsReachable(root, { head: sha, defaultRef: 'origin/main', headSource: 'event' }),
      (error) => /head SHA must be fetched/.test(error.message) && /fetch-depth: 0/.test(error.message),
    )
    assert.throws(() => assertPreviewRefsReachable(root, { head: 'topic', defaultRef: 'origin/missing', headSource: 'input' }), /default ref "origin\/missing".*fetch-depth: 0/)

    git(root, 'switch', '-q', '--orphan', 'unrelated')
    writeFileSync(path.join(root, 'c.txt'), 'c')
    git(root, 'add', 'c.txt')
    git(root, 'commit', '-qm', 'orphan')
    assert.throws(() => assertPreviewRefsReachable(root, { head: 'unrelated', defaultRef: 'origin/main', headSource: 'input' }), /no merge base.*fetch-depth: 0/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
