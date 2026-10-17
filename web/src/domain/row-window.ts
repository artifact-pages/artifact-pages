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
