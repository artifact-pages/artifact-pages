// Checks that preview times name their timezone.
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import { formatPreviewTime } from './preview-time.ts'

test('preview times name their timezone and keep the full instant', () => {
  const utc = formatPreviewTime('2026-10-11T15:03:09Z', 'UTC', 'en-US')
  assert.equal(utc.label, 'Oct 11, 2026, 3:03 PM UTC')
  assert.equal(utc.dateTime, '2026-10-11T15:03:09.000Z')
  assert.equal(utc.title, '2026-10-11 15:03:09 UTC')
  const tokyo = formatPreviewTime('2026-10-11T15:03:09Z', 'Asia/Tokyo', 'en-US')
  assert.match(tokyo.label, /^Oct 12, 2026, 12:03 AM (?:GMT\+9|JST)$/)
  assert.equal(tokyo.dateTime, utc.dateTime)
})

test('an unparseable preview time is shown as given', () => {
  assert.deepEqual(formatPreviewTime('yesterday'), { label: 'yesterday' })
})
