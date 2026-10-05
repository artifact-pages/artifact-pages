import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNotes } from './release-notes.mjs'

test('release notes explain that a 0.x compatibility skip is policy, not a missing baseline', () => {
  const notes = buildNotes({
    version: '0.2.1',
    bundle: { unchanged: true, added: [], modified: [], removed: [] },
    previousTag: 'v0.2.0',
    verdict: {
      verdict: 'skipped',
      result: 'skipped',
      reasonCode: 'pre-1.0-compatibility-not-guaranteed',
      reason: 'cross-version compatibility is not guaranteed before 1.0.0',
    },
  })
  assert.match(notes, /Cross-version compatibility is not guaranteed before 1\.0\.0/)
  assert.match(notes, /normal release verification suite/)
  assert.doesNotMatch(notes, /No earlier release exists/)
})

test('release notes keep the no-baseline skip distinct', () => {
  const notes = buildNotes({
    version: '1.0.0',
    bundle: undefined,
    verdict: { verdict: 'skipped', result: 'skipped', reasonCode: 'no-baseline' },
  })
  assert.match(notes, /No earlier release exists/)
  assert.doesNotMatch(notes, /compatibility is not guaranteed before 1\.0\.0/i)
})

test('the first 0.x release of a series has no previous web bundle and no baseline', () => {
  const notes = buildNotes({
    version: '0.1.0',
    bundle: undefined,
    verdict: { verdict: 'skipped', result: 'skipped', reasonCode: 'pre-1.0', reason: 'cross-version compatibility is not guaranteed before 1.0.0' },
  })
  assert.match(notes, /First release: there is no previous web bundle/)
  assert.doesNotMatch(notes, /undefined/)
})
