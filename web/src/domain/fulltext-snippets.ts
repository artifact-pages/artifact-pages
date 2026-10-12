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

export function foldWithSourceRanges(text: string): { normalized: string; sourceStart: number[]; sourceEnd: number[] } {
  let normalized = ''
  const sourceStart: number[] = [], sourceEnd: number[] = []
  for (const { segment, index } of segmenter.segment(text)) {
    let n = segment.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ')
    if (n.startsWith(' ') && (normalized === '' || normalized.endsWith(' '))) n = n.slice(1)
    normalized += n
    for (let i = 0; i < n.length; i++) { sourceStart.push(index); sourceEnd.push(index + segment.length) }
  }
  return { normalized, sourceStart, sourceEnd }
}

type Range = [number, number]

export function excerptFor(sections: readonly DecodedSection[], terms: readonly string[]): SearchExcerpt | null {
  if (terms.length === 0) return null
  let best: { section: DecodedSection; ranges: Range[]; distinct: number } | null = null
  for (const section of sections) {
    const { normalized, sourceStart, sourceEnd } = foldWithSourceRanges(section.text)
    const ranges: Range[] = []
    let distinct = 0
    for (const term of terms) {
      let found = false
      for (let position = normalized.indexOf(term); position !== -1; position = normalized.indexOf(term, position + term.length)) {
        found = true
        ranges.push([sourceStart[position], sourceEnd[position + term.length - 1]])
      }
      if (found) distinct++
    }
    if (distinct > 0 && (!best || distinct > best.distinct)) best = { section, ranges, distinct }
  }
  if (!best) return null
  const { section, ranges } = best
  const first = Math.min(...ranges.map((range) => range[0]))
  const clusters = [...segmenter.segment(section.text)]
  let f = clusters.findIndex((cluster) => first < cluster.index + cluster.segment.length)
  if (f < 0) f = clusters.length - 1
  const start = Math.max(0, f - EXCERPT_CLUSTERS_BEFORE), end = Math.min(clusters.length, start + EXCERPT_CLUSTERS)
  const from = clusters[start].index, last = clusters[end - 1], to = last.index + last.segment.length
  const clipped = ranges
    .map(([a, b]): Range => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => a < b)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1])
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
