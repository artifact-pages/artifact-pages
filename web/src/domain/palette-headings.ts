// Headings of every page in the site index, ranked for the command palette. Pure and
// allocation-light: normalized heading text is cached per TocEntry, and only the few
// winning hits are turned into rows (with highlight positions) by the caller.
import type { ArtifactIndexEntry, SiteIndex, TocEntry } from './index'
import { fuzzyScoreNormalizedText, prepareFuzzyScoreText, type FuzzyQuery } from './fuzzy-search'
import { getPalettePathAffinity } from './palette-scoring'

export type HeadingHit = {
  artifact: ArtifactIndexEntry
  heading: TocEntry
  score: number
}

export type HeadingSearchOptions = {
  /** The open page: used for the path-affinity tiebreak, and left out when excludeCurrent is set. */
  currentArtifact?: ArtifactIndexEntry
  excludeCurrent?: boolean
  /**
   * Paths of pages already listed as page matches. Their own title-level headings (an H1,
   * or any heading whose text is the page title) are skipped as redundant; deeper headings
   * of those pages are still listed, since they are different destinations.
   */
  shownPaths?: ReadonlySet<string>
  /** Rows returned in total. */
  limit: number
  /** Rows any one page may contribute, so a single long page cannot fill the group. */
  perPage: number
}

// Hits kept while scanning; the per-page cap is applied to this shortlist.
const SHORTLIST = 64

const preparedHeadingText = new WeakMap<TocEntry, string>()

/**
 * Ranking: the heading's fuzzy score (the same scoring pages use), shallower headings
 * slightly ahead of deeper ones, and pages near the open page (shared folders) ahead of
 * distant ones as a tiebreak. A page that also matched by title is not excluded: its
 * headings are different targets. The same text twice on one page (for example two
 * "Examples" sections) is listed once, at the first anchor.
 */
export function findHeadingHits(
  index: SiteIndex,
  query: FuzzyQuery,
  { currentArtifact, excludeCurrent = false, shownPaths, limit, perPage }: HeadingSearchOptions,
): HeadingHit[] {
  if (query.terms.length === 0) return []
  const shortlist: HeadingHit[] = []
  for (const artifact of index.artifacts) {
    const toc = artifact.toc
    if (!toc?.length) continue
    if (excludeCurrent && artifact.id === currentArtifact?.id) continue
    const titleShown = shownPaths?.has(artifact.path) === true
    const folded = titleShown ? prepareFuzzyScoreText(artifact.title) : ''
    const affinity = getPalettePathAffinity(artifact.path, currentArtifact?.path) * 0.1
    for (const heading of toc) {
      let prepared = preparedHeadingText.get(heading)
      if (prepared === undefined) {
        prepared = prepareFuzzyScoreText(heading.text)
        preparedHeadingText.set(heading, prepared)
      }
      if (titleShown && (heading.level === 1 || prepared === folded)) continue
      const fit = fuzzyScoreNormalizedText(prepared, query)
      if (fit === undefined) continue
      const score = fit - heading.level * 0.05 + affinity
      let position = shortlist.length
      while (position > 0 && shortlist[position - 1].score < score) position -= 1
      if (position >= SHORTLIST) continue
      shortlist.splice(position, 0, { artifact, heading, score })
      if (shortlist.length > SHORTLIST) shortlist.pop()
    }
  }

  const hits: HeadingHit[] = []
  const perPageCount = new Map<string, number>()
  const seen = new Set<string>()
  for (const hit of shortlist) {
    const key = `${hit.artifact.id}\0${preparedHeadingText.get(hit.heading)}`
    if (seen.has(key)) continue
    seen.add(key)
    const count = perPageCount.get(hit.artifact.id) ?? 0
    if (count >= perPage) continue
    perPageCount.set(hit.artifact.id, count + 1)
    hits.push(hit)
    if (hits.length >= limit) break
  }
  return hits
}

/** "Page title · folder", the folder omitted for pages at the site root. */
export function headingLocation(artifact: ArtifactIndexEntry): string {
  const folder = artifact.path.split('/').filter(Boolean).slice(0, -1).join('/')
  return folder ? `${artifact.title} · ${folder}` : artifact.title
}

/** The fragment of a heading link (the same form the heading jump uses). */
export function headingFragment(headingId: string): string {
  return `#${encodeURIComponent(headingId)}`
}
