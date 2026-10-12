import { useEffect, useState } from 'react'

/** False on first render, true once `delayMs` has elapsed. Used to avoid flashing loading text on fast loads. */
export function useDelayedVisible(delayMs = 300): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [delayMs])
  return visible
}
