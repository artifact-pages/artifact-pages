// Checks how the preview reader derives identity, the verified PR and the superseded state from the catalog.
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findPreviewGroup,
  identityFromGroupId,
  isSupersededRevision,
  previewGroupLabel,
  previewTagLabel,
  splitPreviewDocuments,
  verifiedPullRequest,
} from './preview-reader.ts'

const head = 'a'.repeat(40)
const newer = 'b'.repeat(40)
const pr = { id: 'pr:42', kind: 'pull-request', headSha: head, prUrl: 'https://github.com/acme/docs/pull/42', updatedAt: '2026-10-01T00:00:00Z', documents: [] }
const manual = { id: `head:${head}`, kind: 'manual', headSha: head, updatedAt: '2026-10-01T00:00:00Z', documents: [] }
const catalog = { schemaVersion: 1, site: 'guide', groups: [pr, manual] }

test('identity comes only from a well-formed group id', () => {
  assert.deepEqual(identityFromGroupId('pr:42'), { kind: 'pull-request', groupId: 'pr:42', number: '42' })
  assert.deepEqual(identityFromGroupId(`head:${head}`), { kind: 'manual', groupId: `head:${head}` })
  assert.deepEqual(identityFromGroupId('pr:0'), { kind: 'unknown' })
  assert.deepEqual(identityFromGroupId('pr:abc'), { kind: 'unknown' })
  assert.deepEqual(identityFromGroupId(undefined), { kind: 'unknown' })
})

test('a link without a group resolves to the revision manual group, never to a PR', () => {
  assert.equal(findPreviewGroup(catalog, head), manual)
  assert.equal(findPreviewGroup(catalog, head, 'pr:42'), pr)
  assert.equal(findPreviewGroup(catalog, newer), undefined)
  assert.equal(findPreviewGroup({ ...catalog, groups: [pr] }, head), undefined)
})

test('the PR is verified only for the group head and superseded is the opposite', () => {
  assert.deepEqual(verifiedPullRequest(pr, head), { number: '42', url: pr.prUrl })
  assert.equal(verifiedPullRequest(pr, newer), undefined)
  assert.equal(verifiedPullRequest(manual, head), undefined)
  assert.equal(verifiedPullRequest(undefined, head), undefined)
  assert.equal(isSupersededRevision(pr, head), false)
  assert.equal(isSupersededRevision({ ...pr, headSha: newer }, head), true)
  assert.equal(isSupersededRevision(undefined, head), false)
})

test('tag and group labels', () => {
  assert.equal(previewTagLabel(identityFromGroupId('pr:7')), 'Preview · PR #7')
  assert.equal(previewTagLabel(identityFromGroupId(`head:${head}`)), 'Preview · manual')
  assert.equal(previewTagLabel({ kind: 'unknown' }), 'Preview')
  assert.equal(previewGroupLabel(identityFromGroupId('pr:7'), head), 'PR #7')
  assert.equal(previewGroupLabel({ kind: 'unknown' }, head), `Revision ${head.slice(0, 8)}`)
})

test('documents split into changed pages and resource dependents', () => {
  const documents = [
    { path: 'a.md', title: 'A', format: 'markdown' },
    { path: 'b.html', title: 'B', format: 'html', reason: 'dependency' },
    { path: 'c.md', title: 'C', format: 'markdown', reason: 'changed' },
  ]
  const { changed, affected } = splitPreviewDocuments(documents)
  assert.deepEqual(changed.map(({ path }) => path), ['a.md', 'c.md'])
  assert.deepEqual(affected.map(({ path }) => path), ['b.html'])
})
