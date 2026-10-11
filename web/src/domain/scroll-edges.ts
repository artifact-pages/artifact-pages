/** The horizontal scroll geometry of an element. */
export type ScrollMetrics = {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
}

/** Which edges of a horizontally scrollable region hide more content. */
export type ScrollEdges = {
  /** The content is wider than the region. */
  overflows: boolean
  /** Content is clipped on the left (the region was scrolled right). */
  left: boolean
  /** Content is clipped on the right. */
  right: boolean
}

/** Sub-pixel rounding and zoom leave fractions of a pixel that are not real overflow. */
const TOLERANCE = 1

export function scrollEdges({ scrollLeft, clientWidth, scrollWidth }: ScrollMetrics): ScrollEdges {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
  if (maxScrollLeft <= TOLERANCE) return { overflows: false, left: false, right: false }
  // Right-to-left regions report a negative scrollLeft; the distance from the start is what counts.
  const offset = Math.abs(scrollLeft)
  return {
    overflows: true,
    left: offset > TOLERANCE,
    right: offset < maxScrollLeft - TOLERANCE,
  }
}

export function sameScrollEdges(a: ScrollEdges, b: ScrollEdges): boolean {
  return a.overflows === b.overflows && a.left === b.left && a.right === b.right
}
