// Checks the row windows of the directory page and the sidebar tree (ISSUE-093).
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DIRECTORY_PAGE_SIZE,
  TREE_BRANCH_ROW_LIMIT,
  TREE_FLAT_ROW_LIMIT,
  boundRows,
  clampPage,
  pageRange,
  pageTotal,
  splitRange,
} from './row-window.ts'

test('the limits are 100 rows', () => {
  assert.equal(DIRECTORY_PAGE_SIZE, 100)
  assert.equal(TREE_BRANCH_ROW_LIMIT, 100)
  assert.equal(TREE_FLAT_ROW_LIMIT, 100)
})

test('5,000 rows make 50 pages with the right bounds', () => {
  assert.equal(pageTotal(5000), 50)
  assert.deepEqual(pageRange(0, 5000), { start: 0, end: 100 })
  assert.deepEqual(pageRange(24, 5000), { start: 2400, end: 2500 })
  // The last page holds rows 4,901-5,000 (one-based).
  assert.deepEqual(pageRange(49, 5000), { start: 4900, end: 5000 })
})

test('page indexes are clamped and an empty list has one page', () => {
  assert.equal(clampPage(-3, 5000), 0)
  assert.equal(clampPage(99, 5000), 49)
  assert.equal(pageTotal(0), 1)
  assert.deepEqual(pageRange(0, 0), { start: 0, end: 0 })
  assert.deepEqual(pageRange(0, 101), { start: 0, end: 100 })
  assert.deepEqual(pageRange(1, 101), { start: 100, end: 101 })
})

test('a window over folders then pages is split per list', () => {
  assert.deepEqual(splitRange(30, 5000, 0, 100), { folders: [0, 30], pages: [0, 70] })
  assert.deepEqual(splitRange(30, 5000, 100, 200), { folders: [30, 30], pages: [70, 170] })
  assert.deepEqual(splitRange(150, 10, 100, 160), { folders: [100, 150], pages: [0, 10] })
  assert.deepEqual(splitRange(0, 5000, 4900, 5000), { folders: [0, 0], pages: [4900, 5000] })
})

test('boundRows keeps the first 100 and counts the hidden rows', () => {
  const rows = Array.from({ length: 5000 }, (_, index) => index)
  const { shown, hidden } = boundRows(rows, 100)
  assert.equal(shown.length, 100)
  assert.equal(hidden, 4900)
  assert.deepEqual(boundRows(rows.slice(0, 100), 100), { shown: rows.slice(0, 100), hidden: 0 })
})

test('boundRows adds the active row once when it is beyond the limit', () => {
  const rows = Array.from({ length: 5000 }, (_, index) => index)
  const beyond = boundRows(rows, 100, (row) => row === 4320)
  assert.equal(beyond.shown.length, 101)
  assert.equal(beyond.shown.filter((row) => row === 4320).length, 1)
  assert.equal(beyond.shown.at(-1), 4320)
  assert.equal(beyond.hidden, 4899)
  const within = boundRows(rows, 100, (row) => row === 5)
  assert.equal(within.shown.length, 100)
  assert.equal(within.shown.filter((row) => row === 5).length, 1)
  assert.equal(within.hidden, 4900)
})
