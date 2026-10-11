// Folder facets of the full-text results page: how many of the current
// query's hits lie in each top-level folder. Facets narrow the list with the
// `in` URL parameter (a folder path; subfolders included), so counting uses the
// same containment rule as `isInFolder` in search-ranking.

export type FolderFacet = { folder: string; count: number }

function topLevelFolder(path: string) {
  const slash = path.indexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/**
 * Top-level folders with at least one hit, most hits first (name order within a
 * count). Pages at the top level have no folder and appear only in the total.
 * A nested `selected` folder is listed as well, so the active choice is always
 * visible; its count is the hits inside it.
 */
export function folderFacets(hits: ReadonlyArray<{ path: string }>, selected?: string): FolderFacet[] {
  const counts = new Map<string, number>()
  for (const { path } of hits) {
    const folder = topLevelFolder(path)
    if (folder) counts.set(folder, (counts.get(folder) ?? 0) + 1)
  }
  const facets = [...counts].map(([folder, count]) => ({ folder, count }))
    .sort((left, right) => (right.count - left.count) || (left.folder < right.folder ? -1 : left.folder > right.folder ? 1 : 0))
  if (selected && !counts.has(selected)) {
    facets.push({ folder: selected, count: hits.filter(({ path }) => path.startsWith(`${selected}/`)).length })
  }
  return facets
}
