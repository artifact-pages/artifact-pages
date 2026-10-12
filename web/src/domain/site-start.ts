// Site order on the landing page (ISSUE-078, TD19), from data the reader already has; nothing is authored per site.

import { compareNames } from './listing-order.ts'

/**
 * Orders site cards by site title (lower-cased code points, then exact), with the site ID as the
 * tie-breaker. No locale is used, so every browser shows the same order. Operators control the
 * order through site titles (or IDs when titles are equal).
 */
export function compareSites(left: { site: { id: string; title: string } }, right: { site: { id: string; title: string } }) {
  return compareNames(left.site.title, right.site.title) || compareNames(left.site.id, right.site.id)
}

/** Reads a site-ID-keyed record without inheriting from Object.prototype (`constructor` is a valid site ID). */
export function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}
