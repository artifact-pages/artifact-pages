import type { ArtifactIndexEntry, TocEntry } from './index'

export type DirectoryFolder = {
  name: string
  path: string
  /** Every page under the folder, at any depth. */
  pageCount: number
  latestUpdatedAt?: string
}

export type DirectoryListing = {
  /** Slash-joined folder path without leading or trailing slash. */
  path: string
  /** The last path segment, shown as-is (TD19 may add a display title later). */
  name: string
  /** Every page under the folder, at any depth, including the index page. */
  pageCount: number
  latestUpdatedAt?: string
  /** Direct subfolders in alphabetical order. */
  folders: DirectoryFolder[]
  /** Direct pages in alphabetical title order, without the index page. */
  pages: ArtifactIndexEntry[]
  /** The folder's README or index page, rendered as the directory page body. */
  indexArtifact?: ArtifactIndexEntry
}

// First match wins. Markdown is preferred over HTML, README over index.
const INDEX_FILE_NAMES = ['readme.md', 'index.md', 'index.html', 'index.htm']

export function directoryPathOf(path: string) {
  return path.split('/').filter(Boolean).join('/')
}

function latest(left: string | undefined, right: string | undefined) {
  if (!right || Number.isNaN(Date.parse(right))) return left
  if (!left) return right
  return Date.parse(right) > Date.parse(left) ? right : left
}

function compareTitles(left: ArtifactIndexEntry, right: ArtifactIndexEntry) {
  // Alphabetical by title until ISSUE-076 / TD19 define an explicit order.
  return left.title.localeCompare(right.title) || left.path.localeCompare(right.path)
}

/** The folder's README or index page, if it has one among its direct pages. */
export function findIndexArtifact(pages: readonly ArtifactIndexEntry[]) {
  for (const name of INDEX_FILE_NAMES) {
    const found = pages.find((page) => (page.path.split('/').at(-1) ?? '').toLowerCase() === name)
    if (found) return found
  }
  return undefined
}

/**
 * The listing of a directory, or undefined when no page sits under the path (so
 * the path is not a directory). A path that is itself a page is the caller's to
 * resolve first: a page wins over a directory of the same name.
 */
export function resolveDirectory(
  artifacts: readonly ArtifactIndexEntry[],
  requestedPath: string,
): DirectoryListing | undefined {
  const path = directoryPathOf(requestedPath)
  if (!path) return undefined
  const prefix = `${path}/`
  const depth = path.split('/').length

  const pages: ArtifactIndexEntry[] = []
  const folders = new Map<string, DirectoryFolder>()
  let pageCount = 0
  let latestUpdatedAt: string | undefined

  for (const artifact of artifacts) {
    if (!artifact.path.startsWith(prefix)) continue
    pageCount += 1
    latestUpdatedAt = latest(latestUpdatedAt, artifact.updatedAt)
    const segments = artifact.path.split('/').filter(Boolean)
    if (segments.length === depth + 1) {
      pages.push(artifact)
      continue
    }
    const name = segments[depth]
    const folder = folders.get(name) ?? { name, path: `${path}/${name}`, pageCount: 0 }
    folder.pageCount += 1
    folder.latestUpdatedAt = latest(folder.latestUpdatedAt, artifact.updatedAt)
    folders.set(name, folder)
  }

  if (pageCount === 0) return undefined

  const indexArtifact = findIndexArtifact(pages)
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    pageCount,
    latestUpdatedAt,
    folders: [...folders.values()].sort((left, right) => left.name.localeCompare(right.name)),
    pages: pages.filter((page) => page !== indexArtifact).sort(compareTitles),
    indexArtifact,
  }
}

/** The level-2 headings of a page: the outline chips shown on a directory row. */
export function pageHeadings(artifact: Pick<ArtifactIndexEntry, 'toc'>, limit = 3) {
  const headings: TocEntry[] = (artifact.toc ?? []).filter((entry) => entry.level === 2)
  return { shown: headings.slice(0, limit), hidden: Math.max(0, headings.length - limit) }
}

export function pageCountLabel(count: number) {
  return `${count} ${count === 1 ? 'page' : 'pages'}`
}
