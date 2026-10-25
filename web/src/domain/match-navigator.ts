import { formatNumber, type DisplayLocales } from './display-locale.ts'

// Position arithmetic of the match navigator ("q  2 / 5  ↑ ↓ ×") shown on a
// page opened from a search: steps wrap around, and a changing match count
// (diagrams and scripts render late) never leaves the position out of range.

/** The match `delta` steps from `index`, wrapping at both ends; 0 when nothing matches. */
export function stepMatch(index: number, total: number, delta: number) {
  if (total <= 0) return 0
  return (((index + delta) % total) + total) % total
}

/** Keeps a position inside 0..total-1. */
export function clampMatch(index: number, total: number) {
  return total <= 0 ? 0 : Math.max(0, Math.min(index, total - 1))
}

/** "2 / 5" for a zero-based position. */
export function matchPositionLabel(index: number, total: number, locales?: DisplayLocales) {
  return `${formatNumber(clampMatch(index, total) + 1, locales)} / ${formatNumber(total, locales)}`
}
