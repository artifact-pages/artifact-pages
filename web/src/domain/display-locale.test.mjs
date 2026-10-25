import assert from 'node:assert/strict'
import test from 'node:test'
import { displayLocale, formatCount, formatDate, formatLongDate, formatNumber } from './display-locale.ts'
import { pageCountLabel } from './directory.ts'
import { artifactCountLabel, siteCountLabel } from './site-count-label.ts'
import { matchPositionLabel } from './match-navigator.ts'
import { formatPreviewTime } from './preview-time.ts'

test('Japanese and English date/count displays keep their locale and grammar', () => {
  assert.equal(formatDate('2026-10-24T12:00:00Z', 'ja-JP'), '10月24日')
  assert.equal(formatLongDate('2026-10-24T12:00:00Z', 'ja-JP'), '2026年10月24日')
  assert.equal(formatLongDate('2026-10-24T12:00:00Z', 'en-US'), 'Oct 24, 2026')
  assert.equal(pageCountLabel(40, 'ja-JP'), '40ページ')
  assert.equal(pageCountLabel(0, 'en-US'), '0 pages')
  assert.equal(pageCountLabel(1, 'en-US'), '1 page')
  assert.equal(pageCountLabel(1234, 'ja-JP'), '1,234ページ')
  assert.equal(artifactCountLabel(1, 'ja-JP'), '1アーティファクト')
  assert.equal(siteCountLabel(3, 'en-US'), '3 sites available')
  assert.equal(formatCount(3, 'folder', 'ja-JP'), '3フォルダー')
})

test('other languages retain localized numbers and dates with English count nouns', () => {
  assert.equal(formatNumber(1234, 'de-DE'), '1.234')
  assert.equal(matchPositionLabel(1233, 2000, 'de-DE'), '1.234 / 2.000')
  assert.equal(pageCountLabel(1234, 'de-DE'), '1.234 pages')
  assert.equal(pageCountLabel(1, 'fr-FR'), '1 page')
  assert.equal(displayLocale(['ja-JP', 'en-US']), 'ja-JP')
  assert.equal(formatDate('not a date', 'ja-JP'), 'not a date')
  assert.equal(formatNumber(1234, 'invalid_locale'), '1,234')
  assert.equal(pageCountLabel(1, 'invalid_locale'), '1 page')
})

test('Japanese preview time names its zone while UTC metadata is invariant', () => {
  const ja = formatPreviewTime('2026-10-11T15:03:09Z', 'Asia/Tokyo', 'ja-JP')
  assert.match(ja.label, /2026年10月12日/)
  assert.match(ja.label, /(?:JST|GMT\+9)/)
  assert.equal(ja.dateTime, '2026-10-11T15:03:09.000Z')
  assert.equal(ja.title, '2026-10-11 15:03:09 UTC')
  assert.deepEqual(formatPreviewTime('invalid', 'UTC', 'ja-JP'), { label: 'invalid' })
})
