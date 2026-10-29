import { IndexLoadError } from '../data/indexes'
import { UnsupportedSchemaError } from '../data/schema'
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

export type DiscoveryErrorKind = 'unsupported' | 'invalid-data' | 'timed-out' | 'http' | 'network'
export type DiscoveryErrorDescription = { kind: DiscoveryErrorKind; title: string; detail: string; retryable: boolean }

/**
 * The results page's guidance for a failed discovery, classified like the rest of the app: a format
 * this version cannot read or a damaged catalog needs the administrator (retrying cannot help);
 * transport failures can be retried.
 */
export function describeDiscoveryError(error?: Error): DiscoveryErrorDescription {
  if (error instanceof UnsupportedSchemaError) {
    return {
      kind: 'unsupported',
      title: 'This library needs to be updated',
      detail: 'The list of sites uses a format this version of Artifact Pages cannot read. Ask the administrator to register the sites again and republish each one.',
      retryable: false,
    }
  }
  if (error instanceof IndexLoadError && error.invalidData) {
    return {
      kind: 'invalid-data',
      title: 'Unable to load sites',
      detail: 'The site catalog is damaged or was written by an incompatible version. Ask the administrator to run the registry sync again.',
      retryable: false,
    }
  }
  if (error instanceof IndexLoadError && error.timedOut) {
    return { kind: 'timed-out', title: 'Search data could not be loaded', detail: 'The site catalog is taking too long to load. Try again in a moment.', retryable: true }
  }
  if (error instanceof IndexLoadError && error.status) {
    return { kind: 'http', title: 'Search data could not be loaded', detail: `The site catalog could not be loaded (HTTP ${error.status}). Please try again in a moment.`, retryable: true }
  }
  return {
    kind: 'network',
    title: 'Search data could not be loaded',
    detail: 'We could not load the site catalog. Check your connection and try again.',
    retryable: true,
  }
}
