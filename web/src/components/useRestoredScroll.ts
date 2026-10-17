import { useEffect, type RefObject } from 'react'

// Scroll offsets of site-home sections, keyed by an id stored in the history entry (ISSUE-107). A section
// opened by a new navigation has a fresh entry and starts at the top; Back and Forward land on an entry
// that already has an id and get their offset back. Nothing is shared between entries, so nothing leaks
// between sites.
const offsets = new Map<string, number>()
let nextEntry = 0

function entryId() {
  const state: unknown = window.history.state
  const current = state && typeof state === 'object' && 'scrollEntry' in state ? (state as { scrollEntry: unknown }).scrollEntry : undefined
  if (typeof current === 'string') return current
  const id = `${Date.now().toString(36)}-${(nextEntry += 1)}`
  try {
    window.history.replaceState({ ...(state && typeof state === 'object' ? state : {}), scrollEntry: id }, '')
  } catch {
    // The offset is simply not restored when the history entry cannot be tagged.
  }
  return id
}

/**
 * Remembers the scroll offset of `ref` for the current history entry and restores it when the entry is
 * shown again. Content that loads late (a Markdown introduction, the preview list) is waited for briefly;
 * any input from the reader ends the wait.
 */
export function useRestoredScroll(ref: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    const element = ref.current
    if (!element || !enabled) return
    const id = entryId()
    const target = offsets.get(id) ?? 0
    let restoring = target > 0
    let frame = 0
    let attempts = 0
    const stop = () => { restoring = false }
    const step = () => {
      if (!restoring) return
      element.scrollTop = target
      attempts += 1
      if (Math.abs(element.scrollTop - target) < 2 || attempts > 120) {
        restoring = false
        return
      }
      frame = window.requestAnimationFrame(step)
    }
    if (restoring) frame = window.requestAnimationFrame(step)
    const onScroll = () => {
      if (!restoring) offsets.set(id, element.scrollTop)
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) element.addEventListener(type, stop, { passive: true })
    return () => {
      window.cancelAnimationFrame(frame)
      element.removeEventListener('scroll', onScroll)
      for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) element.removeEventListener(type, stop)
    }
  }, [ref, enabled])
}
