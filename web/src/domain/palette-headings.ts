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

type PreparedHeading = { heading: TocEntry; text: string; mask: number }
type PreparedToc = { headings: PreparedHeading[]; mask: number }
type HeadingSearchCache = { terms: string[]; ordinals: number[] }

const preparedTocs = new WeakMap<ArtifactIndexEntry, PreparedToc>()
const searchCache = new WeakMap<SiteIndex, HeadingSearchCache>()

// A 32-bit character bag: bit (code point mod 32) is set for every character. A text can match a
// query only if it has every bit of the query, which rejects most headings (and, through the
// union over a page's headings, most pages) before any fuzzy scoring.
function characterMask(text: string): number {
  let mask = 0
  for (const character of text) mask |= 1 << (character.codePointAt(0)! & 31)
  return mask
}

function preparedToc(artifact: ArtifactIndexEntry): PreparedToc {
  let prepared = preparedTocs.get(artifact)
  if (!prepared) {
    let union = 0
    const headings = (artifact.toc ?? []).map((heading) => {
      const text = prepareFuzzyScoreText(heading.text)
      const mask = characterMask(text)
      union |= mask
      return { heading, text, mask }
    })
    prepared = { headings, mask: union }
    preparedTocs.set(artifact, prepared)
  }
  return prepared
}

/**
 * Prepares every page's heading text in small time slices (idle-friendly) so the first keystroke
 * does not pay for it. Returns a cancel function. Safe to skip: searching prepares on demand.
 */
export function warmHeadingSearch(index: SiteIndex): () => void {
  let next = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const slice = () => {
    const deadline = performance.now() + 8
    while (next < index.artifacts.length && performance.now() < deadline) preparedToc(index.artifacts[next++])
    timer = next < index.artifacts.length ? setTimeout(slice, 0) : undefined
  }
  timer = setTimeout(slice, 0)
  return () => { if (timer !== undefined) clearTimeout(timer) }
}

/**
 * Ranking: the heading's fuzzy score (the same scoring pages use), shallower headings
 * slightly ahead of deeper ones, and pages near the open page (shared folders) ahead of
 * distant ones as a tiebreak. A page that also matched by title is not excluded, but its
 * title-level headings are (see shownPaths). The same text twice on one page (for example two
 * "Examples" sections) is listed once, at the first anchor. Each page contributes its best
 * `perPage` headings before the global top `limit` is taken, so the caps never starve the list.
 *
 * Cost: per-heading and per-page character masks reject most candidates cheaply, and a query
 * that extends the previous one (same site index) only revisits the pages that matched it.
 */
export function findHeadingHits(
  index: SiteIndex,
  query: FuzzyQuery,
  { currentArtifact, excludeCurrent = false, shownPaths, limit, perPage }: HeadingSearchOptions,
): HeadingHit[] {
  if (query.terms.length === 0) return []
  const queryMask = query.terms.reduce((mask, term) => mask | characterMask(term.normalized), 0)
  const previous = searchCache.get(index)
  const extendsPrevious = previous !== undefined
    && query.terms.length >= previous.terms.length
    && previous.terms.every((term, position) => query.terms[position].normalized.startsWith(term))
  const candidateCount = extendsPrevious ? previous.ordinals.length : index.artifacts.length
  const matchedOrdinals: number[] = []
  const top: HeadingHit[] = []

  for (let candidate = 0; candidate < candidateCount; candidate += 1) {
    const ordinal = extendsPrevious ? previous.ordinals[candidate] : candidate
    const artifact = index.artifacts[ordinal]
    const prepared = preparedToc(artifact)
    if (prepared.headings.length === 0 || (prepared.mask & queryMask) !== queryMask) continue
    const own: HeadingHit[] = []
    const seenText = new Set<string>()
    let affinity: number | undefined
    let matched = false
    for (const { heading, text, mask } of prepared.headings) {
      if ((mask & queryMask) !== queryMask) continue
      const fit = fuzzyScoreNormalizedText(text, query)
      if (fit === undefined) continue
      matched = true
      if (excludeCurrent && artifact.id === currentArtifact?.id) break
      if (shownPaths?.has(artifact.path) && (heading.level === 1 || text === prepareFuzzyScoreText(artifact.title))) continue
      if (seenText.has(text)) continue
      seenText.add(text)
      affinity ??= getPalettePathAffinity(artifact.path, currentArtifact?.path) * 0.1
      own.push({ artifact, heading, score: fit - heading.level * 0.05 + affinity })
    }
    if (matched) matchedOrdinals.push(ordinal)
    own.sort((left, right) => right.score - left.score)
    for (const hit of own.slice(0, perPage)) {
      let position = top.length
      while (position > 0 && top[position - 1].score < hit.score) position -= 1
      if (position >= limit) continue
      top.splice(position, 0, hit)
      if (top.length > limit) top.pop()
    }
  }
  searchCache.set(index, { terms: query.terms.map((term) => term.normalized), ordinals: matchedOrdinals })
  return top
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
