// Checks the row windows of the directory page and the sidebar tree (ISSUE-093).
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DIRECTORY_PAGE_SIZE,
  TREE_BRANCH_ROW_LIMIT,
  TREE_FLAT_ROW_LIMIT,
  TREE_TOTAL_ROW_LIMIT,
  boundRows,
  clampPage,
  createRowBudget,
  pageRange,
  pageTotal,
  splitRange,
  visitBranch,
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

// A depth-first walk like the sidebar tree: folders first, each folder row followed by its children.
function walk(budget, node, activePath) {
  const rows = [...node.folders.map((folder) => ({ folder })), ...node.files.map((file) => ({ file }))]
  const out = { rows: 0, overflow: 0, pinned: 0 }
  const isActiveFolder = (folder) => activePath?.startsWith(`${folder.name}/`)
  const result = visitBranch(
    budget,
    rows,
    { limit: 100, isPinned: (row) => row.folder ? isActiveFolder(row.folder) : row.file === activePath },
    (row) => {
      out.rows += 1
      if (row.folder ? isActiveFolder(row.folder) : row.file === activePath) out.pinned += 1
      if (row.folder) {
        const inner = walk(budget, row.folder, activePath)
        out.rows += inner.rows
        out.overflow += inner.overflow
        out.pinned += inner.pinned
      }
    },
  )
  if (result.showOverflow) out.overflow += 1
  return out
}

test('the tree-wide budget bounds 100 expanded folders of 50 pages and keeps the active page', () => {
  const folders = Array.from({ length: 100 }, (_, f) => ({
    name: `f${f}`,
    folders: [],
    files: Array.from({ length: 50 }, (_, p) => `f${f}/p${p}`),
  }))
  const budget = createRowBudget()
  const result = walk(budget, { folders, files: [] }, 'f99/p49')
  assert.equal(TREE_TOTAL_ROW_LIMIT, 400)
  // Budgeted rows plus pinned rows (the last folder and its page) plus overflow rows.
  assert.ok(result.rows <= 400 + result.pinned, `${result.rows} rows`)
  assert.ok(result.overflow <= 100)
  assert.equal(result.pinned, 2)
  assert.equal(budget.withheld, true)
})

test('a small tree is not withheld', () => {
  const budget = createRowBudget()
  const result = walk(budget, { folders: [{ name: 'a', folders: [], files: ['a/1', 'a/2'] }], files: ['x'] }, undefined)
  assert.equal(result.rows, 4)
  assert.equal(result.overflow, 0)
  assert.equal(budget.withheld, false)
})
