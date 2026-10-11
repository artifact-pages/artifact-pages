import type { ArtifactIndexEntry } from './index'
import { comparePaths } from './listing-order.ts'

// Pages worth reading after the current one (ISSUE-086), built from the site index alone
// (`title`, `path`, `toc`). Same-folder siblings and pages with a similar title or
// headings are merged into one ranking. No index, CLI or authoring change is needed.
//
// Score of a candidate (higher is better), the sum of:
//   +4  it sits in the same folder as the current page (a sibling)
//   +2  it is not a sibling but shares the current page's top-level folder
//   +similarity: for every token the two pages share, 3 if both titles contain it,
//        2 if it is in one title and in the other page's headings, 1 if only in both headings
// A page that is not a sibling must reach similarity 2 to be listed at all, so one shared
// heading word does not pull in an unrelated page. Ties are broken by the shared listing
// order (`comparePaths`), so the result is deterministic.
//
// Tokens: text is NFKC-normalised and lower-cased. Runs of Han, Hiragana, Katakana and
// Hangul become character bigrams (a single-character run stays one token), which works
// without a word dictionary; other text becomes words of two or more characters, minus a few
// English filler words.
//
// Translations kept in parallel top-level folders (`en/x.html`, `ja/x.html`) are not
// recommended for each other: a page with the same path below a different top-level folder
// is dropped. No language detection is involved.

export type RelatedReason = 'sibling' | 'similar'

export type RelatedPage = {
  entry: ArtifactIndexEntry
  reason: RelatedReason
  /** The entry's folder, set only when it differs from the current page's folder ('/' = site root). */
  folderLabel?: string
}

export const DEFAULT_RELATED_LIMIT = 5

const SIBLING_BONUS = 4
const SAME_TOP_BONUS = 2
const MIN_SIMILARITY = 2
const FILLER = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'your', 'are', 'how', 'what', 'is', 'to', 'of', 'in', 'on', 'an', 'or', 'by', 'it', 'as', 'at', 'be', 'index', 'readme'])
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]+/gu

/** Splits text into comparison tokens (see the header comment). */
export function relatedTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalised = text.normalize('NFKC').toLowerCase()
  for (const run of normalised.match(CJK) ?? []) {
    const chars = Array.from(run)
    if (chars.length === 1) tokens.add(chars[0])
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.add(chars[i] + chars[i + 1])
  }
  for (const word of normalised.replace(CJK, ' ').split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 2 && !FILLER.has(word)) tokens.add(word)
  }
  return tokens
}

type Profile = { title: Set<string>; headings: Set<string> }

function profileOf(entry: ArtifactIndexEntry): Profile {
  const title = relatedTokens(entry.title)
  const headings = new Set<string>()
  for (const heading of entry.toc ?? []) for (const token of relatedTokens(heading.text)) headings.add(token)
  return { title, headings }
}

function similarity(current: Profile, other: Profile) {
  let score = 0
  const seen = new Set<string>([...current.title, ...current.headings, ...other.title, ...other.headings])
  for (const token of seen) {
    const inCurrentTitle = current.title.has(token)
    const inOtherTitle = other.title.has(token)
    const inCurrent = inCurrentTitle || current.headings.has(token)
    const inOther = inOtherTitle || other.headings.has(token)
    if (!inCurrent || !inOther) continue
    score += inCurrentTitle && inOtherTitle ? 3 : inCurrentTitle || inOtherTitle ? 2 : 1
  }
  return score
}

function segmentsOf(path: string) {
  return path.split('/').filter(Boolean)
}

/**
 * Related pages for `currentPath`, best first, at most `limit` (default 5).
 * Never includes the current page; returns [] when nothing qualifies.
 */
export function relatedPages(
  artifacts: readonly ArtifactIndexEntry[],
  currentPath: string,
  limit = DEFAULT_RELATED_LIMIT,
): RelatedPage[] {
  const current = artifacts.find((entry) => entry.path === currentPath)
  if (!current || limit <= 0) return []
  const currentSegments = segmentsOf(current.path)
  const currentFolder = currentSegments.slice(0, -1).join('/')
  const currentTop = currentSegments.length > 1 ? currentSegments[0] : ''
  const currentRest = currentSegments.slice(1).join('/')
  const currentProfile = profileOf(current)

  const ranked: Array<{ entry: ArtifactIndexEntry; score: number; reason: RelatedReason; folder: string }> = []
  for (const entry of artifacts) {
    if (entry.path === current.path || entry.id === current.id) continue
    const segments = segmentsOf(entry.path)
    const folder = segments.slice(0, -1).join('/')
    const top = segments.length > 1 ? segments[0] : ''
    // The same page in a parallel top-level folder (en/x.html and ja/x.html) is a translation.
    if (currentTop && top && top !== currentTop && segments.length > 1 && segments.slice(1).join('/') === currentRest) continue

    const sibling = folder === currentFolder
    const sameTop = !sibling && top === currentTop && top !== ''
    const similar = similarity(currentProfile, profileOf(entry))
    if (!sibling && similar < MIN_SIMILARITY) continue
    ranked.push({
      entry,
      score: (sibling ? SIBLING_BONUS : sameTop ? SAME_TOP_BONUS : 0) + similar,
      reason: sibling ? 'sibling' : 'similar',
      folder,
    })
  }

  ranked.sort((a, b) => b.score - a.score || comparePaths(a.entry.path, b.entry.path))
  return ranked.slice(0, limit).map(({ entry, reason, folder }) => ({
    entry,
    reason,
    ...(folder !== currentFolder ? { folderLabel: folder || '/' } : {}),
  }))
}
