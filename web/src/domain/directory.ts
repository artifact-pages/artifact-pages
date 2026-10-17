import type { ArtifactIndexEntry, TocEntry } from './index'
import { compareArtifactsByPath, compareNames } from './listing-order.ts'

export type DirectoryFolder = {
  /** The path segment. */
  name: string
  /** What is displayed: the index page's title when it has one, else `name`. */
  label: string
  path: string
  /** Every page under the folder, at any depth. */
  pageCount: number
  latestUpdatedAt?: string
}

export type DirectoryListing = {
  /** Slash-joined folder path without leading or trailing slash. */
  path: string
  /** The last path segment. `label` is what is displayed. */
  name: string
  /** The index page's title when it has one, else `name` (TD19). Empty for the root. */
  label: string
  /** Every page under the folder, at any depth, including the index page. */
  pageCount: number
  latestUpdatedAt?: string
  /** Direct subfolders in filename order (listing-order.ts). */
  folders: DirectoryFolder[]
  /** Direct pages in filename order (listing-order.ts), without the index page. */
  pages: ArtifactIndexEntry[]
  /** The folder's README or index page, rendered as the directory page body. */
  indexArtifact?: ArtifactIndexEntry
}

// First match wins. Markdown is preferred over HTML, README over index.
const INDEX_FILE_NAMES = ['readme.md', 'index.md', 'index.html', 'index.htm']
// The site root's introduction is Markdown only (ISSUE-107): index.html and index.htm stay ordinary documents there.
const ROOT_INTRODUCTION_FILE_NAMES = ['readme.md', 'index.md']

export function directoryPathOf(path: string) {
  return path.split('/').filter(Boolean).join('/')
}

function latest(left: string | undefined, right: string | undefined) {
  if (!right || Number.isNaN(Date.parse(right))) return left
  if (!left) return right
  return Date.parse(right) > Date.parse(left) ? right : left
}

/** The folder's README or index page, if it has one among its direct pages. */
export function findIndexArtifact(pages: readonly ArtifactIndexEntry[], names: readonly string[] = INDEX_FILE_NAMES) {
  for (const name of names) {
    // Several files can match once case is ignored; the code-point order of the path decides, so the choice never depends on index order.
    const found = pages
      .filter((page) => (page.path.split('/').at(-1) ?? '').toLowerCase() === name)
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))[0]
    if (found) return found
  }
  return undefined
}

/**
 * What a folder is called: the title of its index page, unless that page has no
 * real title (empty, or the CLI's filename-stem fallback such as README), in
 * which case the folder name.
 */
export function folderLabel(name: string, indexArtifact?: ArtifactIndexEntry): string {
  if (!indexArtifact) return name
  const title = (indexArtifact.title ?? '').trim()
  if (!title) return name
  const fileName = (indexArtifact.path.split('/').at(-1) ?? '').toLowerCase()
  const stem = fileName.includes('.') ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName
  const lowered = title.toLowerCase()
  if (lowered === fileName || lowered === stem) return name
  return title
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
  return buildListing(artifacts, path)
}

/**
 * The listing of the site root: the same shape as a folder's, with an empty path
 * and name. Undefined when the site has no pages. Its `indexArtifact` is the
 * site's introduction: README.md, else index.md (never an HTML index page).
 */
export function resolveRootDirectory(artifacts: readonly ArtifactIndexEntry[]): DirectoryListing | undefined {
  return buildListing(artifacts, '')
}

function buildListing(artifacts: readonly ArtifactIndexEntry[], path: string): DirectoryListing | undefined {
  const indexNames = path ? INDEX_FILE_NAMES : ROOT_INTRODUCTION_FILE_NAMES
  const prefix = path ? `${path}/` : ''
  const depth = path ? path.split('/').length : 0

  const pages: ArtifactIndexEntry[] = []
  const folders = new Map<string, DirectoryFolder>()
  const folderPages = new Map<string, ArtifactIndexEntry[]>()
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
    const folder = folders.get(name) ?? { name, label: name, path: path ? `${path}/${name}` : name, pageCount: 0 }
    if (segments.length === depth + 2) {
      const direct = folderPages.get(name) ?? []
      direct.push(artifact)
      folderPages.set(name, direct)
    }
    folder.pageCount += 1
    folder.latestUpdatedAt = latest(folder.latestUpdatedAt, artifact.updatedAt)
    folders.set(name, folder)
  }

  if (pageCount === 0) return undefined

  for (const folder of folders.values()) {
    folder.label = folderLabel(folder.name, findIndexArtifact(folderPages.get(folder.name) ?? []))
  }

  const indexArtifact = findIndexArtifact(pages, indexNames)
  const name = path.split('/').at(-1) ?? path
  return {
    path,
    name,
    label: path ? folderLabel(name, indexArtifact) : '',
    pageCount,
    latestUpdatedAt,
    folders: [...folders.values()].sort((left, right) => compareNames(left.name, right.name)),
    pages: pages.filter((page) => page !== indexArtifact).sort(compareArtifactsByPath),
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
