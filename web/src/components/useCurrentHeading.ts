import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/** A heading counts as being read once its top has passed this distance from the top of the reading pane. */
const READING_LINE = 96

/** A navigation scroll counts as settled once no scroll event has arrived for this long. */
const SCROLL_IDLE_MS = 200
/** How long to wait for the first scroll event of a navigation (none arrives when the target is already in place). */
const SCROLL_START_MS = 500
/** Reader input counts toward ending a pin only if the pane scrolls within this time. */
const INPUT_ARM_MS = 400
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
 * by the reader's own scrolling of the reading pane (wheel, touch, scroll keys with focus in the pane,
 * a scrollbar drag) at once, and
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
  // The pin lives outside the effect: the effect is re-created when the HTML frame (re)loads, and
  // a pin made before that must keep holding the marker while the navigation scroll starts.
  // 'moving': the navigation scroll is running; 'settled': it ended, the pin holds until the next reading-pane scroll or a measurement that returns the target.
  const hold = useRef<{ id: string, phase: 'moving' | 'settled' } | null>(null)
  const holdTimer = useRef(0)
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  // Set by the effect: measure once when a navigation scroll has settled.
  const settled = useCallback(() => settledImpl.current?.(), [])
  const settledImpl = useRef<(() => void) | null>(null)
  const settleSoon = useCallback((ms: number) => {
    window.clearTimeout(holdTimer.current)
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = 0
      if (hold.current) {
        hold.current.phase = 'settled'
        settled()
      }
    }, ms)
  }, [])
  const pin = useCallback((id: string) => {
    if (!entriesRef.current.some((entry) => entry.id === id)) return
    hold.current = { id, phase: 'moving' }
    settleSoon(SCROLL_START_MS)
    setCurrent(id)
  }, [settleSoon])

  // Another document, format or enabled state ends a pin; so does unmounting.
  useEffect(() => {
    return () => {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = 0
      hold.current = null
    }
  }, [enabled, format, entries])

  useEffect(() => {
    if (!enabled || entries.length === 0) {
      setCurrent(null)
      return
    }
    let frame = 0
    // A frame (re)load restarts the wait for the navigation scroll of a pin made before it.
    if (hold.current) {
      hold.current.phase = 'moving'
      settleSoon(SCROLL_START_MS)
    }
    // A pointer pressed on the scroller itself (its scrollbar or blank area), until it is released.
    let pointerOnScroller = false
    // Reader input that may scroll the reading pane: the pin ends only if the pane then really scrolls.
    let armed = false
    let armedTimer = 0
    const arm = () => {
      armed = true
      window.clearTimeout(armedTimer)
      armedTimer = window.setTimeout(() => { armed = false }, INPUT_ARM_MS)
    }
    // The heading being read, or undefined when the document cannot be measured.
    const readingHeading = (): string | null | undefined => {
      const find = format === 'markdown'
        ? (id: string) => document.getElementById(id) ?? document.getElementById(`md-${id}`)
        : (id: string) => frameRef.current?.contentDocument?.getElementById(id) ?? null
      let paneTop = 0
      if (format === 'markdown') {
        const scroller = stageRef.current?.querySelector('.markdown-scroll')
        if (!scroller) return undefined
        paneTop = scroller.getBoundingClientRect().top
      } else if (format === 'html') {
        if (!frameRef.current?.contentDocument) return undefined
      } else {
        return undefined
      }
      let picked: string | null = null
      for (const [position, entry] of entries.entries()) {
        const element = find(entry.id)
        if (!element) continue
        if (picked === null && position === 0) picked = entry.id
        if (element.getBoundingClientRect().top - paneTop <= READING_LINE) picked = entry.id
      }
      return picked
    }
    const measure = () => {
      frame = 0
      try {
        const held = hold.current
        if (held?.phase === 'moving') return
        const picked = readingHeading()
        if (picked === undefined) return
        if (held) {
          // Settled pin: it ends only when the measurement itself returns the target (it can reach the
          // reading line) or the target is gone; otherwise the clicked entry stays marked.
          if (picked !== held.id && entries.some((entry) => entry.id === held.id)) return
          window.clearTimeout(holdTimer.current)
          holdTimer.current = 0
          hold.current = null
        }
        setCurrent((previous) => previous === picked ? previous : picked)
      } catch {
        // A frame that cannot be read marks nothing.
      }
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure)
    }

    const release = () => {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = 0
      armed = false
      window.clearTimeout(armedTimer)
      if (!hold.current) return
      hold.current = null
      schedule()
    }
    // The Contents column sits inside the stage but is not the reading pane: input there never scrolls the document.
    // Targets inside the HTML frame belong to another realm, so elements are recognised by duck typing, not instanceof.
    const asElement = (target: EventTarget | null) => target !== null && typeof (target as Element).closest === 'function' ? target as Element : null
    const inColumn = (target: EventTarget | null) => asElement(target)?.closest('[data-reader-column]') != null
    settledImpl.current = schedule
    const onScroll = (event?: Event) => {
      // Only the reading pane's own scroll counts. The stage's capturing listener also sees the Contents list and
      // nested scrollers (wide code blocks, tables, diagrams); they never move the pin. Scrolls in the HTML frame
      // reach this listener only from its document, because element scroll events do not bubble to the window.
      const target = event?.target ?? null
      if (inColumn(target)) return
      if (format === 'markdown' && asElement(target)?.classList.contains('markdown-scroll') !== true) {
        if (!hold.current) schedule()
        return
      }
      const held = hold.current
      if (!held) {
        schedule()
      } else if (held.phase === 'settled' || pointerOnScroller || armed) {
        release()
      } else {
        settleSoon(SCROLL_IDLE_MS)
      }
    }
    const onUserScroll = (event: Event) => { if (hold.current && !inColumn(event.target)) arm() }
    // Scroll keys count only with focus inside the reading pane.
    const onKey = (event: KeyboardEvent) => { if (SCROLL_KEYS.has(event.key)) onUserScroll(event) }
    const pointerEnds = ['pointerup', 'pointercancel', 'lostpointercapture'] as const
    const cleanups: Array<() => void> = []
    const userInputTarget = (target: EventTarget, isScroller: (element: EventTarget | null) => boolean) => {
      const onPointerDown = (event: Event) => { if (isScroller(event.target)) pointerOnScroller = true }
      const onPointerEnd = () => { pointerOnScroller = false }
      target.addEventListener('wheel', onUserScroll, { capture: true, passive: true })
      target.addEventListener('touchmove', onUserScroll, { capture: true, passive: true })
      target.addEventListener('keydown', onKey as EventListener, { capture: true })
      target.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
      for (const type of pointerEnds) target.addEventListener(type, onPointerEnd, { capture: true, passive: true })
      cleanups.push(() => {
        target.removeEventListener('wheel', onUserScroll, { capture: true })
        target.removeEventListener('touchmove', onUserScroll, { capture: true })
        target.removeEventListener('keydown', onKey as EventListener, { capture: true })
        target.removeEventListener('pointerdown', onPointerDown, { capture: true })
        for (const type of pointerEnds) target.removeEventListener(type, onPointerEnd, { capture: true })
      })
    }
    const stage = stageRef.current
    if (format === 'markdown' && stage) {
      stage.addEventListener('scroll', onScroll, { capture: true, passive: true })
      userInputTarget(stage, (element) => asElement(element)?.classList.contains('markdown-scroll') === true)
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
          userInputTarget(frameWindow, (element) => element === frameWindow.document.documentElement)
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
      window.clearTimeout(armedTimer)
      settledImpl.current = null
      for (const cleanup of cleanups) cleanup()
    }
  }, [enabled, format, entries, stageRef, frameRef, frameLoads, settleSoon])

  return { current: enabled ? current : null, pin }
}
