// Ranks page text search hits with what the client already has: page titles and
// headings from the site index. The search contract returns hits in path order
// and stores no term frequencies or positions, so body-only matches cannot be
// ordered further. Tiers: title match, then heading match, then body-only
// (path order within a tier). Matching follows the core: NFKC, lowercase,
// every whitespace-separated term must be a substring.

import type { TocEntry } from './index'

export type MatchTier = 'title' | 'heading' | 'text'
export type MatchReason = { tier: MatchTier; heading?: string }
export type RankableArtifact = { title: string; toc?: TocEntry[] }
export type RankableHit = { id: string; path: string }

/** Above this many matching pages the list stays in path order and is paged. */
export const RANKING_MAX_HITS = 500

const TIER_ORDER: Record<MatchTier, number> = { title: 0, heading: 1, text: 2 }

function fold(text: string) {
  return text.normalize('NFKC').toLowerCase()
}

export function foldedTerms(query: string): string[] {
  return [...new Set(fold(query).split(/\s+/).filter(Boolean))]
}

function containsAll(text: string, terms: string[]) {
  const folded = fold(text)
  return terms.length > 0 && terms.every((term) => folded.includes(term))
}

/** Why a page matched, judged from its title and headings only. */
export function matchReason(query: string, artifact: RankableArtifact | undefined): MatchReason {
  const terms = foldedTerms(query)
  if (!artifact) return { tier: 'text' }
  if (containsAll(artifact.title, terms)) return { tier: 'title' }
  const heading = artifact.toc?.find((entry) => containsAll(entry.text, terms))
  return heading ? { tier: 'heading', heading: heading.text } : { tier: 'text' }
}

/** Orders hits by tier; hits keep their given (path) order within a tier. */
export function rankHits<T extends RankableHit>(hits: T[], query: string, artifacts: ReadonlyMap<string, RankableArtifact>): T[] {
  const tiers = new Map(hits.map((hit) => [hit.id, TIER_ORDER[matchReason(query, artifacts.get(hit.id)).tier]]))
  return hits
    .map((hit, index) => ({ hit, index }))
    .sort((left, right) => (tiers.get(left.hit.id)! - tiers.get(right.hit.id)!) || left.index - right.index)
    .map(({ hit }) => hit)
}

/** The folder of a path, '' at the top level. */
export function folderOfPath(path: string) {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/** Whether a path lies inside a folder (subfolders included). */
export function isInFolder(path: string, folder: string) {
  return folder === '' || path.startsWith(`${folder}/`)
}
