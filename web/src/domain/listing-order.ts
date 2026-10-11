// The one order for every page and folder listing (ISSUE-076, TD19): follow GitHub's
// repository file browser. Folders come before files, and each group is sorted by
// filename (the path segment), never by title.
//
// Collation: a segment is compared by its lower-cased code points, then by the exact
// code points as a tie-break. It uses no locale, so the result is the same in every
// browser. Numbers are not compared naturally: `10-x` sorts before `2-x`, so authors
// number files with a fixed width (`01-intro.html`). Non-Latin names (Japanese) sort
// by code point, which is deterministic but not a dictionary order.

function compareCodePoints(left: string, right: string) {
  const a = Array.from(left, (char) => char.codePointAt(0)!)
  const b = Array.from(right, (char) => char.codePointAt(0)!)
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/** Compares two names (one path segment each): case-insensitive, then exact. */
export function compareNames(left: string, right: string) {
  return compareCodePoints(left.toLowerCase(), right.toLowerCase()) || compareCodePoints(left, right)
}

/**
 * Compares two slash-joined paths segment by segment. At the first differing
 * position a folder (the path continues) sorts before a file (the path ends).
 */
export function comparePaths(left: string, right: string) {
  const a = left.split('/').filter(Boolean)
  const b = right.split('/').filter(Boolean)
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i += 1) {
    const leftIsFolder = i < a.length - 1
    const rightIsFolder = i < b.length - 1
    if (leftIsFolder !== rightIsFolder) return leftIsFolder ? -1 : 1
    const byName = compareNames(a[i], b[i])
    if (byName) return byName
  }
  return a.length - b.length
}

/** Orders artifacts (or any object with a path) by `comparePaths`, then by id. */
export function compareArtifactsByPath(left: { path: string; id?: string }, right: { path: string; id?: string }) {
  return comparePaths(left.path, right.path) || compareCodePoints(left.id ?? '', right.id ?? '')
}
