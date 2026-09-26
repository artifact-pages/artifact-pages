import type { SiteDiscoveryMetadata, SiteIndex } from '../domain/index'

const INDEX_ROOT = '/_indexes'
const SITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export class IndexLoadError extends Error {
  readonly status?: number

  constructor(
    message: string,
    readonly url: string,
    options?: ErrorOptions & { status?: number },
  ) {
    super(message, options)
    this.name = 'IndexLoadError'
    this.status = options?.status
  }
}

export function isValidSiteId(siteId: string) {
  return SITE_ID_PATTERN.test(siteId)
}

type Fetcher = typeof fetch

async function fetchText(url: string, fetcher: Fetcher): Promise<string> {
  let response: Response

  try {
    response = await fetcher(url)
  } catch (error) {
    throw new IndexLoadError(`Could not fetch ${url}.`, url, { cause: error })
  }

  if (!response.ok) {
    throw new IndexLoadError(`Request failed with status ${response.status}: ${url}.`, url, { status: response.status })
  }

  return response.text()
}

function extractSiteIds(directoryListing: string): string[] {
  const document = new DOMParser().parseFromString(directoryListing, 'text/html')
  const siteIds = Array.from(document.querySelectorAll('a[href]'))
    .flatMap((anchor) => {
      const href = anchor.getAttribute('href')
      if (!href) return []

      try {
        const url = new URL(href, `https://artifact-pages.invalid${INDEX_ROOT}/`)
        if (url.origin !== 'https://artifact-pages.invalid') return []
        const directory = url.pathname.match(/^\/_indexes\/([^/]+)\/$/u)
        return directory ? [decodeURIComponent(directory[1])] : []
      } catch {
        return []
      }
    })
    .filter(isValidSiteId)

  return [...new Set(siteIds)].sort()
}

function parseSiteDiscoveryMetadata(payload: unknown, url: string, expectedSiteId: string): SiteDiscoveryMetadata {
  if (!payload || typeof payload !== 'object') {
    throw new IndexLoadError(`Invalid site discovery metadata: ${url}.`, url)
  }

  const metadata = payload as Partial<SiteDiscoveryMetadata>
  if (
    typeof metadata.schemaVersion !== 'number' ||
    !metadata.site ||
    metadata.site.id !== expectedSiteId ||
    typeof metadata.site.title !== 'string' ||
    typeof metadata.generatedAt !== 'string' ||
    !Number.isSafeInteger(metadata.artifactCount) ||
    (metadata.artifactCount ?? -1) < 0 ||
    typeof metadata.artifactIndexUrl !== 'string' ||
    !isLocalIndexUrl(metadata.artifactIndexUrl)
  ) {
    throw new IndexLoadError(`Invalid site discovery metadata: ${url}.`, url)
  }

  return metadata as SiteDiscoveryMetadata
}

export async function loadSiteIndex(
  siteId: string,
  fetcher: Fetcher = fetch,
  indexUrl = defaultSiteIndexUrl(siteId),
): Promise<SiteIndex> {
  if (!isValidSiteId(siteId)) {
    throw new IndexLoadError(`Invalid site id: ${siteId}.`, indexUrl)
  }

  const url = indexUrl
  let payload: unknown

  try {
    const response = await fetcher(url)
    if (!response.ok) {
      throw new IndexLoadError(`Request failed with status ${response.status}: ${url}.`, url, { status: response.status })
    }
    payload = await response.json()
  } catch (error) {
    if (error instanceof IndexLoadError) {
      throw error
    }
    throw new IndexLoadError(`Could not fetch ${url}.`, url, { cause: error })
  }

  return parseSiteIndex(payload, url, siteId)
}

function parseSiteIndex(payload: unknown, url: string, expectedSiteId: string): SiteIndex {
  if (!payload || typeof payload !== 'object') {
    throw new IndexLoadError(`Invalid site artifact index data: ${url}.`, url)
  }

  const index = payload as Partial<SiteIndex>
  if (
    typeof index.schemaVersion !== 'number' ||
    !index.site ||
    index.site.id !== expectedSiteId ||
    typeof index.site.title !== 'string' ||
    typeof index.generatedAt !== 'string' ||
    !Array.isArray(index.artifacts)
  ) {
    throw new IndexLoadError(`Invalid site artifact index data: ${url}.`, url)
  }

  return index as SiteIndex
}

export function defaultSiteIndexUrl(siteId: string) {
  return `${INDEX_ROOT}/${encodeURIComponent(siteId)}/index.json`
}

function isLocalIndexUrl(value: string) {
  if (!value.startsWith(`${INDEX_ROOT}/`) || value.startsWith('//') || value.includes('\\')) return false

  try {
    const url = new URL(value, 'https://artifact-pages.invalid')
    return url.origin === 'https://artifact-pages.invalid'
      && url.pathname.startsWith(`${INDEX_ROOT}/`)
      && !url.search
      && !url.hash
      && !url.pathname.split('/').some((segment) => segment === '.' || segment === '..')
  } catch {
    return false
  }
}

export async function discoverSites(fetcher: Fetcher = fetch): Promise<SiteDiscoveryMetadata[]> {
  const directoryListing = await fetchText(`${INDEX_ROOT}/`, fetcher)
  const siteIds = extractSiteIds(directoryListing)
  const metadata = await Promise.all(siteIds.map((siteId) => loadSiteDiscoveryMetadata(siteId, fetcher)))
  return metadata.sort((left, right) => left.site.title.localeCompare(right.site.title))
}

async function loadSiteDiscoveryMetadata(
  siteId: string,
  fetcher: Fetcher,
): Promise<SiteDiscoveryMetadata> {
  const url = `${INDEX_ROOT}/${encodeURIComponent(siteId)}/meta.json`
  let payload: unknown
  try {
    const response = await fetcher(url)
    if (!response.ok) {
      throw new IndexLoadError(`Request failed with status ${response.status}: ${url}.`, url, { status: response.status })
    }
    payload = await response.json()
  } catch (error) {
    if (error instanceof IndexLoadError) throw error
    throw new IndexLoadError(`Could not fetch ${url}.`, url, { cause: error })
  }
  return parseSiteDiscoveryMetadata(payload, url, siteId)
}
