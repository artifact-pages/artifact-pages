import { useEffect, useState } from 'react'

/**
 * False until `delayMs` has elapsed since mount or since `resetKey` last changed. Used to avoid
 * flashing loading text on fast loads.
 */
export function useDelayedVisible(resetKey?: unknown, delayMs = 300): boolean {
  const [shownFor, setShownFor] = useState<{ key: unknown } | null>(null)
  useEffect(() => {
    const timer = window.setTimeout(() => setShownFor({ key: resetKey }), delayMs)
    return () => window.clearTimeout(timer)
  }, [resetKey, delayMs])
  return shownFor !== null && Object.is(shownFor.key, resetKey)
}
