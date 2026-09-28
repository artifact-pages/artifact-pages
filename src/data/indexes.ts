import type { SiteDiscoveryMetadata, SiteIndex, SiteRegistryProjection } from '../domain/index'

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
  return SITE_ID_PATTERN.test(siteId) && siteId !== 'assets'
}

type Fetcher = typeof fetch

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
  const registryResponse = await fetchResponse(`${INDEX_ROOT}/sites.json`, fetcher)
  if (!registryResponse.ok) {
    throw new IndexLoadError(`Request failed with status ${registryResponse.status}: ${INDEX_ROOT}/sites.json.`, `${INDEX_ROOT}/sites.json`, { status: registryResponse.status })
  }
  let payload: unknown
  try {
    payload = await registryResponse.json()
  } catch (error) {
    throw new IndexLoadError(`Invalid site registry: ${INDEX_ROOT}/sites.json.`, `${INDEX_ROOT}/sites.json`, { cause: error })
  }
  const registry = parseSiteRegistry(payload)
  const metadata = await Promise.all(registry.sites.map((site) => loadSiteDiscoveryMetadata(site.id, fetcher, site.name)))
  return metadata.sort((left, right) => left.site.title.localeCompare(right.site.title))
}

async function fetchResponse(url: string, fetcher: Fetcher): Promise<Response> {
  try {
    return await fetcher(url)
  } catch (error) {
    throw new IndexLoadError(`Could not fetch ${url}.`, url, { cause: error })
  }
}

function parseSiteRegistry(payload: unknown): SiteRegistryProjection {
  if (!payload || typeof payload !== 'object') {
    throw new IndexLoadError(`Invalid site registry: ${INDEX_ROOT}/sites.json.`, `${INDEX_ROOT}/sites.json`)
  }
  const registry = payload as Partial<SiteRegistryProjection>
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.sites)) {
    throw new IndexLoadError(`Invalid site registry: ${INDEX_ROOT}/sites.json.`, `${INDEX_ROOT}/sites.json`)
  }
  const seenIDs = new Set<string>()
  const seenSources = new Set<string>()
  let previousID = ''
  for (const rawEntry of registry.sites) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      throw new IndexLoadError(`Invalid site registry: ${INDEX_ROOT}/sites.json.`, `${INDEX_ROOT}/sites.json`)
    }
    const entry = rawEntry as Partial<SiteRegistryProjection['sites'][number]>
    if (
      typeof entry.id !== 'string' || !isValidSiteId(entry.id) || entry.id <= previousID
      || typeof entry.name !== 'string' || !entry.name.trim()
      || typeof entry.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(entry.repository) || entry.repository.endsWith('.git')
      || typeof entry.sourcePath !== 'string' || !isCanonicalSourcePath(entry.sourcePath)
      || seenIDs.has(entry.id) || seenSources.has(`${entry.repository.toLowerCase()}\0${entry.sourcePath}`)
    ) {
      throw new IndexLoadError(`Invalid site registry: ${INDEX_ROOT}/sites.json.`, `${INDEX_ROOT}/sites.json`)
    }
    const allowed = new Set(['id', 'name', 'repository', 'sourcePath'])
    if (Object.keys(rawEntry).some((key) => !allowed.has(key)) || Object.keys(rawEntry).length !== allowed.size) {
      throw new IndexLoadError(`Invalid site registry: ${INDEX_ROOT}/sites.json.`, `${INDEX_ROOT}/sites.json`)
    }
    previousID = entry.id
    seenIDs.add(entry.id)
    seenSources.add(`${entry.repository.toLowerCase()}\0${entry.sourcePath}`)
  }
  const rootKeys = Object.keys(payload)
  if (rootKeys.length !== 2 || rootKeys.some((key) => key !== 'schemaVersion' && key !== 'sites')) {
    throw new IndexLoadError(`Invalid site registry: ${INDEX_ROOT}/sites.json.`, `${INDEX_ROOT}/sites.json`)
  }
  return registry as SiteRegistryProjection
}

function isCanonicalSourcePath(sourcePath: string) {
  if (!sourcePath || sourcePath !== sourcePath.trim() || sourcePath.includes('\\') || sourcePath.startsWith('/')) return false
  if (sourcePath === '.') return true
  const segments = sourcePath.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

async function loadSiteDiscoveryMetadata(
  siteId: string,
  fetcher: Fetcher,
  registeredTitle?: string,
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
  const metadata = parseSiteDiscoveryMetadata(payload, url, siteId)
  return registeredTitle ? { ...metadata, site: { ...metadata.site, title: registeredTitle } } : metadata
}
