import type { MouseEvent } from 'react'

/**
 * Click handler for a real `<a href>` that the application routes itself: a plain
 * primary click navigates in the app, while modified clicks (new tab or window,
 * download) and middle clicks keep the browser's own link behavior.
 */
export function followInApp(event: MouseEvent<HTMLElement>, go: () => void) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  go()
}
