// Folders derived from artifact paths, for the palette's "Folders" group. The index has no
// folder records, so a folder exists wherever a page path passes through it. Counts are
// pages anywhere below the folder. Cached per SiteIndex object.
import type { SiteIndex } from './index'
import { fuzzyScoreNormalizedText, prepareFuzzyScoreText, type FuzzyQuery } from './fuzzy-search'
import { artifactRouteHref } from '../routing'

export type PaletteFolder = {
  path: string
  name: string
  pageCount: number
  preparedName: string
  preparedPath: string
}

const folderCache = new WeakMap<SiteIndex, PaletteFolder[]>()

export function siteFolders(index: SiteIndex): PaletteFolder[] {
  const cached = folderCache.get(index)
  if (cached) return cached
  const counts = new Map<string, number>()
  for (const artifact of index.artifacts) {
    const segments = artifact.path.split('/').filter(Boolean).slice(0, -1)
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const path = segments.slice(0, depth).join('/')
      counts.set(path, (counts.get(path) ?? 0) + 1)
    }
  }
  const folders = [...counts].map(([path, pageCount]) => {
    const name = path.slice(path.lastIndexOf('/') + 1)
    return { path, name, pageCount, preparedName: prepareFuzzyScoreText(name), preparedPath: prepareFuzzyScoreText(path) }
  })
  folderCache.set(index, folders)
  return folders
}

/** Folders matching the query by name or path, best first (name matches lead, then larger folders). */
export function findFolders(index: SiteIndex, query: FuzzyQuery, limit: number): PaletteFolder[] {
  if (query.terms.length === 0) return []
  const hits: Array<{ folder: PaletteFolder; score: number }> = []
  for (const folder of siteFolders(index)) {
    const nameScore = fuzzyScoreNormalizedText(folder.preparedName, query)
    const pathScore = fuzzyScoreNormalizedText(folder.preparedPath, query)
    if (nameScore === undefined && pathScore === undefined) continue
    hits.push({ folder, score: (nameScore ?? 0) * 1.12 + (pathScore ?? 0) })
  }
  return hits
    .sort((left, right) => right.score - left.score
      || right.folder.pageCount - left.folder.pageCount
      || left.folder.path.localeCompare(right.folder.path))
    .slice(0, limit)
    .map(({ folder }) => folder)
}

/** True when the folder's own name (not just its path) matches the query. */
export function folderNameMatches(folder: PaletteFolder, query: FuzzyQuery): boolean {
  return fuzzyScoreNormalizedText(folder.preparedName, query) !== undefined
}

/**
 * Folder route `/<site>/<folder path>` (no trailing slash). Same segment encoding as
 * artifactRouteHref; kept here so the palette does not depend on routing.ts changes made
 * for the directory page (ISSUE-075). Consolidate with its route helper once that lands.
 */
export function folderRouteHref(siteId: string, folderPath: string): string {
  return artifactRouteHref(siteId, folderPath)
}

export function folderPageCountLabel(count: number): string {
  return count === 1 ? '1 page' : `${count} pages`
}
