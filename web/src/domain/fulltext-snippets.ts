// Page text excerpts for full-text search results (Reader procedure steps 5-6 of
// docs/architecture/fulltext-search.md). Pure functions; kept behind a dynamic import.
import { normalize } from './fulltext-codec'

export const EXCERPT_CLUSTERS = 160
export const EXCERPT_CLUSTERS_BEFORE = 40
export type ExcerptPart = { text: string; mark: boolean }
export type SearchExcerpt = { heading: string; anchor: string; parts: ExcerptPart[] }
export type DecodedSection = { heading: string; anchor: string; text: string }

/** normalize(query) split on ' ', blanks removed, duplicates removed (first occurrence order). */
export function excerptTerms(query: string): string[] {
  return [...new Set(normalize(query).split(' ').filter((term) => term !== ''))]
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

type Folded = { normalized: string; sourceStart: number[]; sourceEnd: number[]; clusters: { segment: string; index: number }[] }

export function foldWithSourceRanges(text: string): Folded {
  let normalized = ''
  const sourceStart: number[] = [], sourceEnd: number[] = [], clusters: Folded['clusters'] = []
  for (const { segment, index } of segmenter.segment(text)) {
    clusters.push({ segment, index })
    // Printable ASCII (no space) is unchanged by NFKC and whitespace folding; only A-Z needs lowercasing.
    const code = segment.charCodeAt(0)
    let n = segment.length === 1 && code > 32 && code < 127
      ? (code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : segment)
      : segment.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ')
    if (n.startsWith(' ') && (normalized === '' || normalized.endsWith(' '))) n = n.slice(1)
    normalized += n
    for (let i = 0; i < n.length; i++) { sourceStart.push(index); sourceEnd.push(index + segment.length) }
  }
  return { normalized, sourceStart, sourceEnd, clusters }
}

type Range = [number, number]

export function excerptFor(sections: readonly DecodedSection[], terms: readonly string[]): SearchExcerpt | null {
  if (terms.length === 0) return null
  // Choosing the section needs only whether each term occurs: one indexOf per term.
  let best: { section: DecodedSection; folded: Folded; distinct: number; first: number } | null = null
  for (const section of sections) {
    const folded = foldWithSourceRanges(section.text)
    let distinct = 0, first = Infinity
    for (const term of terms) {
      const position = folded.normalized.indexOf(term)
      if (position === -1) continue
      distinct++
      first = Math.min(first, folded.sourceStart[position])
    }
    if (distinct > 0 && (!best || distinct > best.distinct)) best = { section, folded, distinct, first }
  }
  if (!best) return null
  const { section, folded } = best
  const { clusters } = folded
  let f = clusters.findIndex((cluster) => best.first < cluster.index + cluster.segment.length)
  if (f < 0) f = clusters.length - 1
  const start = Math.max(0, f - EXCERPT_CLUSTERS_BEFORE), end = Math.min(clusters.length, start + EXCERPT_CLUSTERS)
  const from = clusters[start].index, last = clusters[end - 1], to = last.index + last.segment.length
  // Occurrences (overlapping ones included) are collected only inside the window's normalized range.
  const { normalized, sourceStart, sourceEnd } = folded
  let lo = 0
  while (lo < normalized.length && sourceEnd[lo] <= from) lo++
  let hi = normalized.length
  while (hi > lo && sourceStart[hi - 1] >= to) hi--
  const clipped: Range[] = []
  for (const term of terms) {
    for (let position = normalized.indexOf(term, lo); position !== -1 && position < hi; position = normalized.indexOf(term, position + 1)) {
      const a = Math.max(sourceStart[position], from), b = Math.min(sourceEnd[position + term.length - 1], to)
      if (a < b) clipped.push([a, b])
    }
  }
  clipped.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const merged: Range[] = []
  for (const range of clipped) {
    const top = merged[merged.length - 1]
    if (top && range[0] <= top[1]) top[1] = Math.max(top[1], range[1])
    else merged.push([range[0], range[1]])
  }
  const parts: ExcerptPart[] = []
  if (start > 0) parts.push({ text: '…', mark: false })
  let cursor = from
  for (const [a, b] of merged) {
    if (a > cursor) parts.push({ text: section.text.slice(cursor, a), mark: false })
    parts.push({ text: section.text.slice(a, b), mark: true })
    cursor = b
  }
  if (cursor < to) parts.push({ text: section.text.slice(cursor, to), mark: false })
  if (end < clusters.length) parts.push({ text: '…', mark: false })
  return { heading: section.heading, anchor: section.anchor, parts }
}
