// Bounds on the rows the directory page and the sidebar tree mount at once (ISSUE-093).

/** Rows per page of a directory listing. */
export const DIRECTORY_PAGE_SIZE = 100
/** Rows rendered per expanded branch of the sidebar tree. */
export const TREE_BRANCH_ROW_LIMIT = 100
/** Rows rendered by the flat sidebar views (recent, path lists). */
export const TREE_FLAT_ROW_LIMIT = 100

/** The number of pages needed for `total` rows (at least 1). */
export function pageTotal(total: number, size = DIRECTORY_PAGE_SIZE) {
  return Math.max(1, Math.ceil(total / size))
}

/** Keeps a zero-based page index inside `[0, pageTotal - 1]`. */
export function clampPage(page: number, total: number, size = DIRECTORY_PAGE_SIZE) {
  return Math.min(Math.max(0, Math.floor(page) || 0), pageTotal(total, size) - 1)
}

/** The half-open row range `[start, end)` of a zero-based page. */
export function pageRange(page: number, total: number, size = DIRECTORY_PAGE_SIZE) {
  const start = clampPage(page, total, size) * size
  return { start, end: Math.min(total, start + size) }
}

/**
 * Maps a window `[start, end)` over the sequence "all folders, then all pages" to the
 * slice of each list, as half-open ranges.
 */
export function splitRange(folderCount: number, pageCount: number, start: number, end: number) {
  const folderEnd = Math.min(end, folderCount)
  const pageStart = Math.max(0, start - folderCount)
  const pageEnd = Math.max(0, end - folderCount)
  return {
    folders: [Math.min(start, folderEnd), folderEnd] as const,
    pages: [Math.min(pageStart, pageCount), Math.min(pageEnd, pageCount)] as const,
  }
}

/**
 * The first `limit` rows, plus the one active row when it lies beyond the limit.
 * `hidden` is the number of rows left out.
 */
export function boundRows<T>(rows: readonly T[], limit: number, isActive: (row: T) => boolean = () => false) {
  if (rows.length <= limit) return { shown: rows.slice(), hidden: 0 }
  const shown = rows.slice(0, limit)
  const active = rows.slice(limit).find(isActive)
  if (active !== undefined) shown.push(active)
  return { shown, hidden: rows.length - shown.length }
}

/** Rows the tree view mounts in total, across all expanded branches (directory rows and artifact rows). */
export const TREE_TOTAL_ROW_LIMIT = 400

export type RowBudget = { limit: number; used: number; withheld: boolean }

export function createRowBudget(limit = TREE_TOTAL_ROW_LIMIT): RowBudget {
  return { limit, used: 0, withheld: false }
}

/**
 * Visits the rows of one tree branch in render order, within the per-branch limit and the
 * tree-wide budget. Pinned rows (the active page or folder and its ancestors) are always
 * visited and do not use the budget. `visit` may recurse into child branches, which then
 * spend the same budget. A branch reached after the budget ran out shows no overflow row.
 */
export function visitBranch<T, R>(
  budget: RowBudget,
  rows: readonly T[],
  options: { limit: number; isPinned: (row: T) => boolean },
  visit: (row: T) => R,
) {
  const exhaustedOnEntry = budget.used >= budget.limit
  const { shown } = boundRows(rows, options.limit, options.isPinned)
  const items: R[] = []
  for (const row of shown) {
    const pinned = options.isPinned(row)
    if (pinned || budget.used < budget.limit) {
      if (!pinned) budget.used += 1
      items.push(visit(row))
    } else {
      budget.withheld = true
    }
  }
  const hidden = rows.length - items.length
  if (hidden > 0 && exhaustedOnEntry) budget.withheld = true
  return { items, hidden, showOverflow: hidden > 0 && !exhaustedOnEntry }
}
