import { useEffect, useState } from 'react'
import { hasSiteDiscoveryMetadata, type SiteCatalogEntry } from '../domain/index'
import { topLevelFolderCounts, type FolderCount } from '../domain/site-folder-counts'
import { loadSiteIndex } from './indexes'

/** The landing page reads at most this many site indexes (in display order). */
export const MAX_COUNTED_SITES = 8
export const COUNT_CONCURRENCY = 3

export type SiteFolderCounts = {
  counts: Record<string, FolderCount[]>
  /** Sites whose count read is queued or in flight (used to reserve space on the card). */
  pending: ReadonlySet<string>
}

/**
 * Lazily loads per-top-level-folder counts for site cards. Per-folder counts are not in
 * discovery metadata, so this reads each published site's index after the first paint, through
 * the shared index cache (the site view reuses the read). It is bounded (MAX_COUNTED_SITES,
 * COUNT_CONCURRENCY), cancelled on unmount, and failures are silent: the card keeps the metadata
 * total. Pass `override` to skip loading (stories, tests).
 */
export function useSiteFolderCounts(
  sites: SiteCatalogEntry[],
  override?: Record<string, FolderCount[]>,
): SiteFolderCounts {
  const [counts, setCounts] = useState<Record<string, FolderCount[]>>({})
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const key = sites.map((entry) => (hasSiteDiscoveryMetadata(entry) ? `${entry.site.id}\0${entry.artifactIndexUrl}` : '')).join('\n')

  useEffect(() => {
    if (override) return
    const controller = new AbortController()
    const eligible = sites.filter(hasSiteDiscoveryMetadata).slice(0, MAX_COUNTED_SITES)
    const queue = [...eligible]
    const ids = new Set(eligible.map((entry) => entry.site.id))
    setPending(new Set(ids))
    setCounts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))))
    const settle = (id: string) => setPending((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
    const worker = async () => {
      for (let entry = queue.shift(); entry && !controller.signal.aborted; entry = queue.shift()) {
        const id = entry.site.id
        try {
          const index = await loadSiteIndex(id, fetch, entry.artifactIndexUrl, { signal: controller.signal })
          if (controller.signal.aborted) return
          const folders = topLevelFolderCounts(index.artifacts)
          setCounts((current) => ({ ...current, [id]: folders }))
        } catch {
          // Keep the metadata total for this site and drop any stale breakdown.
          if (controller.signal.aborted) return
          setCounts(({ [id]: _dropped, ...rest }) => rest)
        }
        settle(id)
      }
    }
    const handle = window.setTimeout(() => {
      void Promise.all(Array.from({ length: COUNT_CONCURRENCY }, worker))
    }, 0)
    return () => {
      controller.abort()
      window.clearTimeout(handle)
    }
    // `key` captures what the effect reads from `sites`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, override])

  return override ? { counts: override, pending: new Set() } : { counts, pending }
}
