// Page counts per top-level folder for the site picker (ISSUE-078).
// Paths only: the first path segment names the folder. No language or translation
// notion is inferred; a folder is just a folder.

export type FolderCount = { folder: string; count: number }

/** Label for pages that sit directly at the site root. */
export const ROOT_FOLDER_LABEL = 'root'

/** More than this many groups reads as noise on a card; show a total instead. */
export const MAX_FOLDER_CHIPS = 4

export function topLevelFolderCounts(artifacts: ReadonlyArray<{ path: string }>): FolderCount[] {
  const counts = new Map<string, number>()
  let rootCount = 0
  for (const { path } of artifacts) {
    const slash = path.indexOf('/')
    if (slash <= 0) {
      rootCount += 1
      continue
    }
    const folder = path.slice(0, slash)
    counts.set(folder, (counts.get(folder) ?? 0) + 1)
  }
  const result = [...counts].map(([folder, count]) => ({ folder, count }))
    .sort((left, right) => left.folder.localeCompare(right.folder))
  if (rootCount > 0) result.push({ folder: ROOT_FOLDER_LABEL, count: rootCount })
  return result
}

export type SiteCountSummary =
  | { kind: 'folders'; folders: FolderCount[] }
  | { kind: 'total'; total: number; folderCount?: number }

/**
 * Rule: two to four groups show one count per group ("en 7 · ja 7"); a single group
 * or no folder information shows the plain total; more than four groups show the total
 * and the number of folders. `total` is the discovery metadata count and is used
 * whenever the per-folder breakdown is missing or has fewer than two groups.
 */
export function summarizeSiteCounts(total: number, folders: FolderCount[] | undefined): SiteCountSummary {
  if (!folders || folders.length < 2) return { kind: 'total', total }
  if (folders.length > MAX_FOLDER_CHIPS) {
    return { kind: 'total', total: folders.reduce((sum, entry) => sum + entry.count, 0), folderCount: folders.length }
  }
  return { kind: 'folders', folders }
}
