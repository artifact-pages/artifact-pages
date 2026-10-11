import { useEffect, useState } from 'react'

/** Whether a CSS media query matches now, and as the window changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const update = () => setMatches(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])

  return matches
}

/** The narrow reader chrome (ISSUE-080); keep in step with the 620px rules in styles.css. */
export const NARROW_CHROME_QUERY = '(max-width: 620px)'
