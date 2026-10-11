// Page counts per top-level folder for the site picker (ISSUE-078).
// Paths only: the first path segment names the folder. No language or translation
// notion is inferred; a folder is just a folder.

export type FolderCount = {
  folder: string
  count: number
  /** The synthetic bucket for pages directly at the site root (a real folder may also be called "root"). */
  isRoot?: boolean
}

/** Label for the synthetic root bucket. */
export const ROOT_FOLDER_LABEL = '(root)'

/** More than this many groups reads as noise on a card; show the folder count instead. */
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
  const result: FolderCount[] = [...counts].map(([folder, count]) => ({ folder, count }))
    .sort((left, right) => left.folder.localeCompare(right.folder))
  if (rootCount > 0) result.push({ folder: ROOT_FOLDER_LABEL, count: rootCount, isRoot: true })
  return result
}

export function folderChipLabel(entry: FolderCount) {
  return entry.isRoot ? ROOT_FOLDER_LABEL : entry.folder
}

export function folderChipKey(entry: FolderCount) {
  return entry.isRoot ? '\0root' : `d:${entry.folder}`
}

export type FolderSummary =
  | { kind: 'folders'; folders: FolderCount[] }
  | { kind: 'many'; folderCount: number }
  | { kind: 'none' }

/**
 * Rule: two to four groups show one count per group ("en 7 · ja 7"); more than four show only the
 * number of folders; a single group or no data shows nothing extra. The page total is always the
 * `artifactCount` of the discovery metadata, shown separately.
 */
export function summarizeFolders(folders: FolderCount[] | undefined): FolderSummary {
  if (!folders || folders.length < 2) return { kind: 'none' }
  if (folders.length > MAX_FOLDER_CHIPS) return { kind: 'many', folderCount: folders.length }
  return { kind: 'folders', folders }
}

/** Plain-text equivalent of the chips for assistive technology: "en: 7 pages, ja: 7 pages". */
export function folderSummaryText(summary: FolderSummary) {
  if (summary.kind === 'many') return `${summary.folderCount} top-level folders`
  if (summary.kind === 'none') return ''
  return summary.folders.map((entry) => `${folderChipLabel(entry)}: ${entry.count} ${entry.count === 1 ? 'page' : 'pages'}`).join(', ')
}
