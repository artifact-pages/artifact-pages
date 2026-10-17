// Page counts per top-level folder for the site picker (ISSUE-078, ISSUE-095).
// Read from discovery metadata; no language or translation notion is inferred, a folder is just a folder.

import { compareNames } from './listing-order.ts'

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

/**
 * Summary for a site card from discovery metadata alone (no index read). With the folder list the
 * usual rule applies; without it, only a large folder count is known and the card says so.
 */
export function folderSummaryFromMetadata(meta: {
  rootArtifactCount?: number
  topLevelFolderCount?: number
  topLevelFolders?: { name: string; artifactCount: number }[]
}): FolderSummary {
  if (meta.topLevelFolders) {
    const groups: FolderCount[] = meta.topLevelFolders
      .map(({ name, artifactCount }) => ({ folder: name, count: artifactCount }))
      .sort((left, right) => compareNames(left.folder, right.folder))
    if ((meta.rootArtifactCount ?? 0) > 0) groups.push({ folder: ROOT_FOLDER_LABEL, count: meta.rootArtifactCount as number, isRoot: true })
    if (groups.length < 2) return { kind: 'none' }
    if (groups.length > MAX_FOLDER_CHIPS) return { kind: 'many', folderCount: meta.topLevelFolderCount ?? meta.topLevelFolders.length }
    return { kind: 'folders', folders: groups }
  }
  if (meta.topLevelFolderCount !== undefined && meta.topLevelFolderCount > MAX_FOLDER_CHIPS) {
    return { kind: 'many', folderCount: meta.topLevelFolderCount }
  }
  return { kind: 'none' }
}

/** Plain-text equivalent of the chips for assistive technology: "en: 7 pages, ja: 7 pages". */
export function folderSummaryText(summary: FolderSummary) {
  if (summary.kind === 'many') return `${summary.folderCount} top-level folders`
  if (summary.kind === 'none') return ''
  return summary.folders.map((entry) => `${folderChipLabel(entry)}: ${entry.count} ${entry.count === 1 ? 'page' : 'pages'}`).join(', ')
}
