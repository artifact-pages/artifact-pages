import type { SiteCatalogEntry } from './index'

export type DiscoveryStatus = 'loading' | 'success' | 'error'

/**
 * What the full-text results page may say about the site. `fullTextUrl` lives in the site's
 * discovery metadata, so the absence of page text search is only known once that metadata has
 * loaded (ISSUE-113); before then the page is loading, and when discovery failed it is a load
 * failure, never "published without page text search".
 */
export type SearchAvailability = 'loading' | 'discovery-error' | 'available' | 'unavailable'

export function searchAvailability(
  discovery: DiscoveryStatus,
  entry: SiteCatalogEntry | undefined,
  hasClient: boolean,
): SearchAvailability {
  if (discovery === 'loading') return 'loading'
  if (discovery === 'error') return 'discovery-error'
  // This site's own metadata could not be read: its fullTextUrl is unknown, not absent.
  if (entry?.status === 'metadata-unavailable') return 'discovery-error'
  return hasClient ? 'available' : 'unavailable'
}
