import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/** A heading counts as being read once its top has passed this distance from the top of the reading pane. */
const READING_LINE = 96

/** A navigation scroll counts as settled once no scroll event has arrived for this long. */
const SCROLL_IDLE_MS = 200
/** How long to wait for the first scroll event of a navigation (none arrives when the target is already in place). */
const SCROLL_START_MS = 500
/** Keys that scroll the document. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'])

type Entry = { id: string }

/**
 * The id of the heading being read (ISSUE-108), updated as the document scrolls.
 * Markdown scrolls inside the stage, so a capturing scroll listener on the stage sees it; an HTML
 * artifact scrolls inside its frame, which is read only when it is same-origin (best effort:
 * otherwise nothing is marked and nothing breaks).
 *
 * `pin(id)` marks an entry the reader activated (ISSUE-118): the marker stays on it while the
 * navigation scroll runs instead of passing through every heading on the way. The pin is released
 * by the reader's own scrolling (wheel, touch, keys, pointer on the scroller) at once, and
 * otherwise by the first scroll event after the navigation scroll has gone idle. The idle and
 * start timers always end the moving phase, so a missing scroll event cannot freeze tracking.
 */
export function useCurrentHeading({ enabled, format, entries, stageRef, frameRef, frameLoads }: {
  enabled: boolean
  format: 'markdown' | 'html' | undefined
  entries: Entry[]
  stageRef: RefObject<HTMLElement | null>
  frameRef: RefObject<HTMLIFrameElement | null>
  /** Changes whenever the HTML frame (re)loads, so the listener moves to the new window. */
  frameLoads: number
}): { current: string | null, pin: (id: string) => void } {
  const [current, setCurrent] = useState<string | null>(null)
  const pinImpl = useRef<((id: string) => void) | null>(null)
  const pin = useCallback((id: string) => pinImpl.current?.(id), [])

  useEffect(() => {
    if (!enabled || entries.length === 0) {
      setCurrent(null)
      return
    }
    let frame = 0
    // 'moving': the navigation scroll is running; 'settled': it ended, the pin holds until the next scroll.
    let hold: { id: string, phase: 'moving' | 'settled' } | null = null
    let holdTimer = 0
    const pick = (find: (id: string) => Element | null, paneTop: number) => {
      let picked: string | null = null
      for (const [position, entry] of entries.entries()) {
        const element = find(entry.id)
        if (!element) continue
        if (picked === null && position === 0) picked = entry.id
        if (element.getBoundingClientRect().top - paneTop <= READING_LINE) picked = entry.id
      }
      setCurrent((previous) => previous === picked ? previous : picked)
    }
    const measure = () => {
      frame = 0
      if (hold) return
      try {
        if (format === 'markdown') {
          const stage = stageRef.current
          const scroller = stage?.querySelector('.markdown-scroll')
          if (!scroller) return
          pick((id) => document.getElementById(id) ?? document.getElementById(`md-${id}`), scroller.getBoundingClientRect().top)
        } else if (format === 'html') {
          const iframe = frameRef.current
          const frameDocument = iframe?.contentDocument
          if (!iframe || !frameDocument) return
          pick((id) => frameDocument.getElementById(id), 0)
        }
      } catch {
        // A frame that cannot be read marks nothing.
      }
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure)
    }

    const release = () => {
      window.clearTimeout(holdTimer)
      holdTimer = 0
      if (!hold) return
      hold = null
      schedule()
    }
    const settleSoon = (ms: number) => {
      window.clearTimeout(holdTimer)
      holdTimer = window.setTimeout(() => {
        holdTimer = 0
        if (hold) hold.phase = 'settled'
      }, ms)
    }
    const onScroll = () => {
      if (!hold) {
        schedule()
      } else if (hold.phase === 'settled') {
        release()
      } else {
        settleSoon(SCROLL_IDLE_MS)
      }
    }
    const onUserInput = () => { if (hold) release() }
    const onKey = (event: KeyboardEvent) => { if (SCROLL_KEYS.has(event.key)) onUserInput() }
    pinImpl.current = (id) => {
      if (!entries.some((entry) => entry.id === id)) return
      hold = { id, phase: 'moving' }
      settleSoon(SCROLL_START_MS)
      setCurrent(id)
    }

    const cleanups: Array<() => void> = [() => { pinImpl.current = null; window.clearTimeout(holdTimer) }]
    const userInputTarget = (target: EventTarget) => {
      for (const type of ['wheel', 'touchstart', 'pointerdown'] as const) {
        target.addEventListener(type, onUserInput, { capture: true, passive: true })
        cleanups.push(() => target.removeEventListener(type, onUserInput, { capture: true }))
      }
      target.addEventListener('keydown', onKey as EventListener, { capture: true })
      cleanups.push(() => target.removeEventListener('keydown', onKey as EventListener, { capture: true }))
    }
    const stage = stageRef.current
    if (format === 'markdown' && stage) {
      stage.addEventListener('scroll', onScroll, { capture: true, passive: true })
      userInputTarget(stage)
      window.addEventListener('keydown', onKey)
      cleanups.push(() => window.removeEventListener('keydown', onKey))
      const observer = new MutationObserver(schedule)
      observer.observe(stage, { childList: true, subtree: true })
      window.addEventListener('resize', schedule)
      cleanups.push(
        () => stage.removeEventListener('scroll', onScroll, { capture: true }),
        () => observer.disconnect(),
        () => window.removeEventListener('resize', schedule),
      )
    } else if (format === 'html') {
      try {
        const frameWindow = frameRef.current?.contentWindow
        if (frameWindow) {
          frameWindow.addEventListener('scroll', onScroll, { passive: true })
          userInputTarget(frameWindow)
          window.addEventListener('keydown', onKey)
          cleanups.push(() => window.removeEventListener('keydown', onKey))
          frameWindow.addEventListener('resize', schedule)
          cleanups.push(
            () => frameWindow.removeEventListener('scroll', onScroll),
            () => frameWindow.removeEventListener('resize', schedule),
          )
        }
      } catch {
        // Cross-origin frame.
      }
    }
    schedule()
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      for (const cleanup of cleanups) cleanup()
    }
  }, [enabled, format, entries, stageRef, frameRef, frameLoads])

  return { current: enabled ? current : null, pin }
}
