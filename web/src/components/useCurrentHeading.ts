import { useEffect, useState, type RefObject } from 'react'

/** A heading counts as being read once its top has passed this distance from the top of the reading pane. */
const READING_LINE = 96

type Entry = { id: string }

/**
 * The id of the heading being read (ISSUE-108), updated as the document scrolls.
 * Markdown scrolls inside the stage, so a capturing scroll listener on the stage sees it; an HTML
 * artifact scrolls inside its frame, which is read only when it is same-origin (best effort:
 * otherwise nothing is marked and nothing breaks).
 */
export function useCurrentHeading({ enabled, format, entries, stageRef, frameRef, frameLoads }: {
  enabled: boolean
  format: 'markdown' | 'html' | undefined
  entries: Entry[]
  stageRef: RefObject<HTMLElement | null>
  frameRef: RefObject<HTMLIFrameElement | null>
  /** Changes whenever the HTML frame (re)loads, so the listener moves to the new window. */
  frameLoads: number
}): string | null {
  const [current, setCurrent] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || entries.length === 0) {
      setCurrent(null)
      return
    }
    let frame = 0
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

    const cleanups: Array<() => void> = []
    const stage = stageRef.current
    if (format === 'markdown' && stage) {
      stage.addEventListener('scroll', schedule, { capture: true, passive: true })
      const observer = new MutationObserver(schedule)
      observer.observe(stage, { childList: true, subtree: true })
      window.addEventListener('resize', schedule)
      cleanups.push(
        () => stage.removeEventListener('scroll', schedule, { capture: true }),
        () => observer.disconnect(),
        () => window.removeEventListener('resize', schedule),
      )
    } else if (format === 'html') {
      try {
        const frameWindow = frameRef.current?.contentWindow
        if (frameWindow) {
          frameWindow.addEventListener('scroll', schedule, { passive: true })
          frameWindow.addEventListener('resize', schedule)
          cleanups.push(
            () => frameWindow.removeEventListener('scroll', schedule),
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

  return enabled ? current : null
}
