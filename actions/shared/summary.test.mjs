import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { renderSummary, summaryEnabled, writeSummary } from './summary.mjs'

test('site publish reports outcome, change breakdown and pruned previews', () => {
  const text = renderSummary({
    result: {
      operation: 'site publish', outcome: 'published', site: 'sre',
      changes: [{ action: 'create', path: 'a' }, { action: 'update', path: 'b' }, { action: 'create', path: 'c' }],
      previewChanges: [{ action: 'remove', groupId: 'pr:1', headSha: 'x', reason: 'manifest-missing' }, { action: 'keep' }],
    },
  })
  assert.match(text, /^### Artifact Pages: site publish \(published\)\n/)
  assert.match(text, /- \*\*Site:\*\* `sre`/)
  assert.match(text, /- \*\*Changes:\*\* 3 \(create 2, update 1\)/)
  assert.match(text, /- \*\*Pruned previews:\*\* 1/)
  assert.match(text, /<details><summary>Changes \(3\)<\/summary>[\s\S]*create a\nupdate b/)
  assert.doesNotMatch(text, /Error/)
})

test('dry-run mode and its reason are shown', () => {
  const text = renderSummary({ result: { operation: 'site publish', outcome: 'planned', site: 's', changes: [] }, dryRun: true, dryRunReason: 'publish-on does not match event pull_request at refs/pull/1/merge' })
  assert.match(text, /- \*\*Mode:\*\* dry-run \(publish-on does not match event pull_request/)
  assert.match(text, /- \*\*Changes:\*\* 0\n/)
  assert.doesNotMatch(renderSummary({ result: { operation: 'site publish', outcome: 'planned', changes: [] }, dryRun: true, dryRunReason: 'dry-run input is true' }), /\(dry-run input/)
})

test('registry register lists registered and removed sites', () => {
  const text = renderSummary({
    result: {
      operation: 'registry register', outcome: 'registered', registryUpdated: true,
      changes: [
        { action: 'create', path: '_indexes/sites.json#sites/docs' }, { action: 'update', path: '_indexes/sites.json#sites/sre' },
        { action: 'remove', path: '_indexes/sites.json#sites/legacy' }, { action: 'update', path: '_indexes/sites.json' },
      ],
    },
  })
  assert.match(text, /- \*\*Registered:\*\* `docs`, `sre`/)
  assert.match(text, /- \*\*Removed:\*\* `legacy`/)
  assert.match(text, /- \*\*Registry updated:\*\* true/)
  assert.match(renderSummary({ result: { operation: 'registry register', outcome: 'no-op', registryUpdated: false, changes: [] } }), /- \*\*Registered:\*\* none\n- \*\*Removed:\*\* none/)
})

test('registry unregister and app deploy', () => {
  assert.match(renderSummary({ result: { operation: 'registry unregister', outcome: 'unregistered', site: 'old', registryUpdated: true, changes: [] } }), /- \*\*Removed:\*\* `old`/)
  const deploy = renderSummary({ result: { operation: 'app deploy', outcome: 'deployed', version: '0.2.0', changes: [{ action: 'create', path: 'index.html' }] } })
  assert.match(deploy, /- \*\*Object changes:\*\* 1/)
  assert.match(deploy, /- \*\*Version:\*\* `0\.2\.0`/)
})

test('preview lists the group URL and a document table, capped', () => {
  const documents = Array.from({ length: 52 }, (_, index) => ({ path: `d${index}.md`, title: index === 0 ? 'A | B' : `Doc ${index}`, url: `https://x.test/${index}`, reason: index === 1 ? 'dependency' : '' }))
  const text = renderSummary({ result: { operation: 'preview publish', outcome: 'published', site: 'sre', groupListUrl: 'https://x.test/sre/_previews?group=pr%3A1', documents } })
  assert.match(text, /- \*\*Preview list:\*\* https:\/\/x\.test\/sre\/_previews\?group=pr%3A1/)
  assert.match(text, /- \*\*Documents:\*\* 52/)
  assert.match(text, /\| \[A \\\| B\]\(https:\/\/x\.test\/0\) \| `d0\.md` \| changed \|/)
  assert.match(text, /\| `d1\.md` \| dependency \|/)
  assert.match(text, /\.\.\. and 2 more/)
  assert.equal(text.split('\n').filter((line) => line.startsWith('| [')).length, 50)
})

test('failures show the error on one line, including without a result', () => {
  const text = renderSummary({ result: { operation: 'site publish', outcome: 'failed', site: 's', changes: [], error: 'line one\nline two' }, exitCode: 1 })
  assert.match(text, /> \*\*Error \(exit 1\):\*\* line one line two/)
  assert.match(renderSummary({ operation: 'registry register', result: { outcome: 'failed', error: 'boom' }, exitCode: 2 }), /### Artifact Pages: registry register \(failed\)[\s\S]*Error \(exit 2\):\*\* boom/)
})

test('summary input validation and file writing', async () => {
  assert.equal(summaryEnabled(''), true)
  assert.equal(summaryEnabled('TRUE'), true)
  assert.equal(summaryEnabled('false'), false)
  assert.throws(() => summaryEnabled('yes'), /true or false/)
  const scratch = mkdtempSync(path.join(tmpdir(), 'summary-'))
  try {
    const file = path.join(scratch, 'summary.md')
    const context = { result: { operation: 'app deploy', outcome: 'no-op', changes: [] } }
    assert.equal(await writeSummary(context, { ARTIFACT_PAGES_INPUT_SUMMARY: 'false', GITHUB_STEP_SUMMARY: file }), false)
    assert.equal(existsSync(file), false)
    assert.equal(await writeSummary(context, { GITHUB_STEP_SUMMARY: file }), true)
    assert.equal(await writeSummary(context, { GITHUB_STEP_SUMMARY: file }), true)
    assert.equal(readFileSync(file, 'utf8').split('### Artifact Pages').length - 1, 2, 'summaries append')
    assert.equal(await writeSummary(context, {}), false, 'no summary file is not an error')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
