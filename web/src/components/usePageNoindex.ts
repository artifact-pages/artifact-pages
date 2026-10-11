import { useEffect } from 'react'

/**
 * Asks search engines not to index the document while the calling view is shown.
 * The reader serves one HTML shell for every route, so a not-found view cannot
 * carry its own status code; the meta tag is its only signal to crawlers that
 * run scripts. It is removed again when the view goes away.
 */
export function usePageNoindex(active = true) {
  useEffect(() => {
    if (!active) return
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex'
    meta.dataset.pageNoindex = ''
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [active])
}
