import { useCallback, useEffect, useState } from 'react'

/**
 * How long a frame stays unpainted while its document loads. Without this bound a page that never
 * fires `load` (a stalled sub-resource) would stay invisible.
 */
export const FRAME_REVEAL_TIMEOUT_MS = 1500

/**
 * Keeps an artifact iframe unpainted until its document has loaded (ISSUE-119).
 *
 * Firefox and Safari paint an opaque light canvas for a frame whose `color-scheme` (the reader's dark
 * theme) differs from the scheme of the document inside it, which is the case for the initial blank
 * document and for an authored page whose own stylesheet has not applied yet. Until the frame is
 * revealed it is transparent, so the reader's surface behind it stays visible. The author's document
 * is never touched. `frameKey` identifies one frame mount (a new key starts hidden again).
 */
export function useFrameReveal(frameKey: string | undefined) {
  const [revealedKey, setRevealedKey] = useState<string | undefined>(undefined)
  const reveal = useCallback(() => setRevealedKey(frameKey), [frameKey])
  useEffect(() => {
    if (frameKey === undefined) {
      // The frame is gone (a Markdown or directory page is open): returning to the same key mounts a new iframe.
      setRevealedKey(undefined)
      return
    }
    const timer = window.setTimeout(() => setRevealedKey(frameKey), FRAME_REVEAL_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [frameKey])
  return { revealed: frameKey === undefined || revealedKey === frameKey, reveal }
}
