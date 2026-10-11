import { useEffect, useState } from 'react'
import { hasSiteDiscoveryMetadata, type SiteCatalogEntry } from '../domain/index'
import { topLevelFolderCounts, type FolderCount } from '../domain/site-folder-counts'
import { loadSiteIndex } from './indexes'

/** The landing page fetches at most this many site indexes (in display order). */
export const MAX_COUNTED_SITES = 8
const CONCURRENCY = 3

/**
 * Lazily loads per-top-level-folder counts for site cards. Per-folder counts are not in
 * discovery metadata, so this reads each published site's index after the first paint.
 * It is bounded (MAX_COUNTED_SITES, CONCURRENCY) and failures are silent: the card keeps
 * the metadata total. Pass `override` to skip loading (stories, tests).
 */
export function useSiteFolderCounts(
  sites: SiteCatalogEntry[],
  override?: Record<string, FolderCount[]>,
): Record<string, FolderCount[]> {
  const [loaded, setLoaded] = useState<Record<string, FolderCount[]>>({})
  const key = sites.map((entry) => (hasSiteDiscoveryMetadata(entry) ? `${entry.site.id}\0${entry.artifactIndexUrl}` : '')).join('\n')

  useEffect(() => {
    if (override) return
    let cancelled = false
    const queue = sites.filter(hasSiteDiscoveryMetadata).slice(0, MAX_COUNTED_SITES)
    const worker = async () => {
      for (let entry = queue.shift(); entry && !cancelled; entry = queue.shift()) {
        try {
          const index = await loadSiteIndex(entry.site.id, fetch, entry.artifactIndexUrl)
          if (cancelled) return
          const counts = topLevelFolderCounts(index.artifacts)
          setLoaded((current) => ({ ...current, [entry.site.id]: counts }))
        } catch {
          // Keep the metadata total for this site.
        }
      }
    }
    const handle = window.setTimeout(() => {
      void Promise.all(Array.from({ length: CONCURRENCY }, worker))
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
    // `key` captures what the effect reads from `sites`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, override])

  return override ?? loaded
}
