import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluatePublishOn, parsePublishOn } from './publish-on.mjs'

const run = (publishOn, eventName, ref, dryRun = false) => evaluatePublishOn({ publishOn, eventName, ref, dryRun, env: {} })

test('an empty condition keeps the current behavior', () => {
  assert.equal(run('', 'pull_request', 'refs/pull/1/merge').dryRun, false)
  assert.equal(run('  \n\n', 'push', 'refs/heads/x').dryRun, false)
})

test('explicit dry-run always wins, even when the condition matches', () => {
  const result = run('push:refs/heads/main', 'push', 'refs/heads/main', true)
  assert.equal(result.dryRun, true)
  assert.match(result.reason, /dry-run input/)
})

test('event and event:ref entries match exactly', () => {
  const condition = 'push:refs/heads/main\nworkflow_dispatch'
  assert.equal(run(condition, 'push', 'refs/heads/main').dryRun, false)
  assert.equal(run(condition, 'workflow_dispatch', 'refs/heads/anything').dryRun, false)
  const miss = run(condition, 'push', 'refs/heads/topic')
  assert.equal(miss.dryRun, true)
  assert.match(miss.reason, /push at refs\/heads\/topic/)
  assert.equal(run(condition, 'pull_request', 'refs/pull/3/merge').dryRun, true)
  assert.equal(run('push:refs/heads/main', 'push', 'refs/heads/main-2').dryRun, true)
})

test('an event-only entry matches every ref and wildcards cover tags and branches', () => {
  assert.equal(run('push', 'push', 'refs/tags/v1').dryRun, false)
  assert.equal(run('push:refs/tags/v*', 'push', 'refs/tags/v1.2.3').dryRun, false)
  assert.equal(run('push:refs/tags/v*', 'push', 'refs/heads/v1').dryRun, true)
  assert.equal(run('push:refs/heads/release/*', 'push', 'refs/heads/release/1.x').dryRun, false)
  assert.equal(run('push:refs/heads/a.b', 'push', 'refs/heads/aXb').dryRun, true, 'regex metacharacters are literal')
})

test('malformed entries are errors rather than silent dry-runs', () => {
  for (const bad of ['push:main', 'refs/heads/main', 'push:', 'push refs/heads/main', 'push:refs/heads/main:x']) {
    assert.throws(() => parsePublishOn(bad), /publish-on entry/, bad)
  }
})
