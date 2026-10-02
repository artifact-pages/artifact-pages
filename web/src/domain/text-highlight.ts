// Highlights committed page-text search terms with the CSS Custom Highlight API,
// so the artifact DOM is never mutated. Matching mirrors the full-text core:
// NFKC + lowercase, whitespace-separated terms, substring matches. Known
// differences: matches are found within single text nodes (the core sees the
// whole document text), and a highlight boundary that falls inside a character
// cluster (for example half of a ligature such as "ﬁ") extends to the whole
// cluster.

export const SEARCH_HIGHLIGHT_NAME = 'gap-page-text-search'
const MAX_RANGES = 1000
const SKIPPED_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA'])

type HighlightWindow = Window & typeof globalThis & {
  Highlight?: new (...ranges: Range[]) => unknown
}

export function searchTerms(query: string): string[] {
  return [...new Set(query.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean))]
}

/**
 * Replaces this document's search highlight with the query's matches inside
 * `root` and returns the first matching range. Returns undefined when nothing
 * matches or the browser cannot highlight.
 */
export function highlightSearchTerms(root: Node, query: string): Range | undefined {
  const document = root.ownerDocument ?? (root as Document)
  const view = document.defaultView as HighlightWindow | null
  const registry = view?.CSS && 'highlights' in view.CSS ? view.CSS.highlights : undefined
  if (!view || !registry || !view.Highlight) return undefined
  registry.delete(SEARCH_HIGHLIGHT_NAME)

  const terms = searchTerms(query)
  if (terms.length === 0) return undefined
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => isSearchableText(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  })
  for (let node = walker.nextNode(); node && ranges.length < MAX_RANGES; node = walker.nextNode()) {
    const text = node.nodeValue ?? ''
    if (!text.trim()) continue
    const { normalized, starts, ends } = normalizeWithOffsets(text)
    for (const term of terms) {
      for (let at = normalized.indexOf(term); at !== -1 && ranges.length < MAX_RANGES; at = normalized.indexOf(term, at + term.length)) {
        const range = document.createRange()
        range.setStart(node, starts[at])
        range.setEnd(node, ends[at + term.length - 1])
        ranges.push(range)
      }
    }
  }
  if (ranges.length === 0) return undefined
  ranges.sort((left, right) => left.compareBoundaryPoints(Range.START_TO_START, right))
  registry.set(SEARCH_HIGHLIGHT_NAME, new view.Highlight(...ranges) as never)
  return ranges[0]
}

/**
 * Keeps the highlight current while the document renders asynchronously
 * (tables, diagrams, hydrating scripts). Highlights never touch the DOM, so
 * re-applying them cannot retrigger the observer. `onFirstMatch` runs once.
 */
export function keepSearchHighlighted(root: Element, query: string, onFirstMatch?: (range: Range) => void): () => void {
  const view = root.ownerDocument.defaultView
  let reported = false
  let frame = 0
  const apply = () => {
    frame = 0
    const first = highlightSearchTerms(root, query)
    if (first && !reported) {
      reported = true
      onFirstMatch?.(first)
    }
  }
  apply()
  if (!view) return () => {}
  const observer = new view.MutationObserver(() => {
    if (!frame) frame = view.requestAnimationFrame(apply)
  })
  observer.observe(root, { childList: true, subtree: true, characterData: true })
  return () => {
    observer.disconnect()
    if (frame) view.cancelAnimationFrame(frame)
  }
}

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

/**
 * Notes whether the reader starts scrolling `target` (wheel, touch, pointer on
 * a scrollbar, or a scrolling key) from now on, so a match that is found late
 * (diagrams, hydrating scripts) does not pull the page away from where the
 * reader went. Programmatic scrolling, such as a fragment jump, does not count.
 */
export function watchReaderScroll(target: EventTarget) {
  let scrolled = false
  const mark = () => { scrolled = true }
  const markKey = (event: Event) => {
    if (SCROLL_KEYS.has((event as KeyboardEvent).key)) scrolled = true
  }
  const options = { capture: true, passive: true }
  for (const type of ['wheel', 'touchmove', 'pointerdown']) target.addEventListener(type, mark, options)
  target.addEventListener('keydown', markKey, options)
  return {
    get scrolled() { return scrolled },
    dispose() {
      for (const type of ['wheel', 'touchmove', 'pointerdown']) target.removeEventListener(type, mark, options)
      target.removeEventListener('keydown', markKey, options)
    },
  }
}

export function clearSearchHighlight(document: Document) {
  const view = document.defaultView
  if (view?.CSS && 'highlights' in view.CSS) view.CSS.highlights.delete(SEARCH_HIGHLIGHT_NAME)
}

const HIGHLIGHT_STYLE = `::highlight(${SEARCH_HIGHLIGHT_NAME}) { background-color: rgba(255, 196, 0, 0.42); color: inherit; }`
const adoptedHighlightSheets = new WeakSet<CSSStyleSheet>()

/**
 * Artifact documents carry their own styles, so the highlight style is added
 * once per document. It is adopted as a constructed style sheet, which leaves
 * the artifact's DOM untouched; only browsers without constructable style
 * sheets get a <style data-gap-search-highlight> element instead.
 */
export function ensureSearchHighlightStyle(document: Document) {
  const view = document.defaultView as (Window & typeof globalThis) | null
  const Sheet = view?.CSSStyleSheet
  if (Sheet && Array.isArray(document.adoptedStyleSheets) && typeof Sheet.prototype.replaceSync === 'function') {
    if (document.adoptedStyleSheets.some((sheet) => adoptedHighlightSheets.has(sheet))) return
    try {
      // The sheet must come from the artifact window's own constructor to be adoptable there.
      const sheet = new Sheet()
      sheet.replaceSync(HIGHLIGHT_STYLE)
      adoptedHighlightSheets.add(sheet)
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
      return
    } catch {
      // Fall back to a style element below.
    }
  }
  if (document.querySelector('style[data-gap-search-highlight]')) return
  const style = document.createElement('style')
  style.dataset.gapSearchHighlight = ''
  style.textContent = HIGHLIGHT_STYLE
  ;(document.head ?? document.documentElement).append(style)
}

function isSearchableText(node: Node) {
  for (let element = node.parentElement; element; element = element.parentElement) {
    if (SKIPPED_ELEMENTS.has(element.tagName)) return false
    if (element.hidden || element.getAttribute('aria-hidden')?.toLowerCase() === 'true' || element.hasAttribute('data-search-ignore')) return false
  }
  return true
}

// Characters that NFKC may compose with the preceding character: combining
// marks, half-width katakana (semi-)voiced sound marks and conjoining Hangul
// vowel/trailing jamo. Keeping them in the same cluster lets each cluster be
// normalized on its own and still produce the same text as normalizing the
// whole string, which is what the full-text core does.
const COMBINING = /^[\p{M}\uFF9E\uFF9F\u1160-\u11FF\uD7B0-\uD7FF]$/u

/**
 * Normalizes text the way the full-text core does (NFKC, then lowercase) and
 * maps each UTF-16 unit of the result back to the source range of the
 * character cluster it came from. Exported for tests.
 */
export function normalizeWithOffsets(text: string) {
  const clusters: { start: number; end: number; folded: string }[] = []
  let offset = 0
  for (const character of text) {
    const last = clusters[clusters.length - 1]
    if (last && COMBINING.test(character)) last.end += character.length
    else clusters.push({ start: offset, end: offset + character.length, folded: '' })
    offset += character.length
  }
  let composed = ''
  for (const cluster of clusters) {
    cluster.folded = text.slice(cluster.start, cluster.end).normalize('NFKC')
    composed += cluster.folded
  }
  // Lowercasing the whole string applies context rules such as the Greek final
  // sigma exactly as the core does. When that changes the length relative to
  // per-cluster lowercasing (no known case), fall back to per-cluster results.
  const whole = composed.toLowerCase()
  const lowered = clusters.map((cluster) => cluster.folded.toLowerCase())
  const sameShape = lowered.reduce((length, value) => length + value.length, 0) === whole.length
  let normalized = ''
  const starts: number[] = []
  const ends: number[] = []
  clusters.forEach((cluster, index) => {
    const folded = sameShape ? whole.slice(normalized.length, normalized.length + lowered[index].length) : lowered[index]
    for (let unit = 0; unit < folded.length; unit += 1) {
      starts.push(cluster.start)
      ends.push(cluster.end)
    }
    normalized += folded
  })
  return { normalized, starts, ends }
}
