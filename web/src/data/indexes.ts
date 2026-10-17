import { assertSupportedSchema, isSupportedSchema, UnsupportedSchemaError } from './schema'
import type { ArtifactIndexEntry, SiteCatalogEntry, SiteDiscoveryMetadata, SiteIndex, SiteRegistryProjection, SiteSummary } from '../domain/index'

const INDEX_ROOT = '/_indexes'
const SITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export class IndexLoadError extends Error {
  readonly status?: number
  /** The payload was read but its content is not a valid index (not a transport or schema-version problem). */
  readonly invalidData?: boolean
  /** The application deadline passed before the read finished (a transient failure; retrying starts a fresh request). */
  readonly timedOut?: boolean

  constructor(
    message: string,
    readonly url: string,
    options?: ErrorOptions & { status?: number; invalidData?: boolean; timedOut?: boolean },
  ) {
    super(message, options)
    this.name = 'IndexLoadError'
    this.status = options?.status
    this.invalidData = options?.invalidData
    this.timedOut = options?.timedOut
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

  assertSupportedSchema(payload, 'site-metadata', url)
  const metadata = payload as Partial<SiteDiscoveryMetadata>
  if (
    !isSupportedSchema('site-metadata', metadata.schemaVersion) ||
    !metadata.site ||
    metadata.site.id !== expectedSiteId ||
    typeof metadata.site.title !== 'string' ||
    (metadata.site.description !== undefined && typeof metadata.site.description !== 'string') ||
    typeof metadata.generatedAt !== 'string' ||
    !Number.isSafeInteger(metadata.artifactCount) ||
    (metadata.artifactCount ?? -1) < 0 ||
    typeof metadata.artifactIndexUrl !== 'string' ||
    !isLocalIndexUrl(metadata.artifactIndexUrl) ||
    (metadata.fullTextUrl !== undefined && metadata.fullTextUrl !== `/_indexes/${expectedSiteId}/search/manifest.json`)
  ) {
    throw new IndexLoadError(`Invalid site discovery metadata: ${url}.`, url)
  }

  return metadata as SiteDiscoveryMetadata
}

/** How long a shared index read is reused. Keeps picker -> site navigation to one request, yet picks up a newer publish soon. */
export const SITE_INDEX_CACHE_TTL_MS = 30_000
/** At most this many shared index reads stay cached; entries still awaited by a caller are never evicted for the cap. */
export const SITE_INDEX_CACHE_MAX_ENTRIES = 4
/** How long the registry request (headers and body) may take. */
export const REGISTRY_TIMEOUT_MS = 15_000
/** How long one site index request (headers and body) may take. */
export const SITE_INDEX_TIMEOUT_MS = 20_000

type CachedIndex = {
  promise: Promise<SiteIndex>
  startedAt: number
  controller: AbortController
  /** Callers currently awaiting the promise. */
  waiting: number
  fulfilled: boolean
  settled: boolean
  timer?: ReturnType<typeof setTimeout>
}
const indexCache = new Map<string, CachedIndex>()

/** For tests. */
export function clearSiteIndexCache() {
  for (const entry of indexCache.values()) clearTimeout(entry.timer)
  indexCache.clear()
}

/** For tests only: the number of cached entries. */
export function siteIndexCacheSize() {
  return indexCache.size
}

function dropEntry(key: string, entry: CachedIndex) {
  clearTimeout(entry.timer)
  entry.timer = undefined
  if (indexCache.get(key) === entry) indexCache.delete(key)
}

function isExpired(entry: CachedIndex) {
  return Date.now() - entry.startedAt >= SITE_INDEX_CACHE_TTL_MS
}

function sweepExpiredEntries() {
  for (const [key, entry] of [...indexCache]) {
    if (entry.fulfilled && entry.waiting === 0 && isExpired(entry)) dropEntry(key, entry)
  }
}

function enforceCacheCap(keep: CachedIndex) {
  while (indexCache.size > SITE_INDEX_CACHE_MAX_ENTRIES) {
    let victim: [string, CachedIndex] | undefined
    for (const candidate of indexCache) {
      if (candidate[1] !== keep && candidate[1].waiting === 0) { victim = candidate; break }
    }
    if (!victim) return
    dropEntry(victim[0], victim[1])
  }
}

/**
 * Loads a site's artifact index. Reads through the global `fetch` are shared per URL for
 * SITE_INDEX_CACHE_TTL_MS (the site picker's count reads, the site view and the preview page reuse
 * one request); failures and aborted reads are never cached. At most SITE_INDEX_CACHE_MAX_ENTRIES
 * entries are kept, and expired entries are evicted without waiting for the same site to be read
 * again. A custom fetcher bypasses the cache.
 * `options.signal` cancels this caller's wait; the underlying request is aborted only when every
 * caller that joined it has aborted. Every request ends within SITE_INDEX_TIMEOUT_MS.
 */
export async function loadSiteIndex(
  siteId: string,
  fetcher: Fetcher = fetch,
  indexUrl = defaultSiteIndexUrl(siteId),
  options: { signal?: AbortSignal } = {},
): Promise<SiteIndex> {
  if (!isValidSiteId(siteId)) {
    throw new IndexLoadError(`Invalid site id: ${siteId}.`, indexUrl)
  }
  const { signal } = options
  if (fetcher !== globalThis.fetch) return fetchSiteIndex(siteId, fetcher, indexUrl, signal)

  sweepExpiredEntries()
  const key = `${siteId}\0${indexUrl}`
  let entry = indexCache.get(key)
  if (!entry || isExpired(entry)) {
    if (entry) dropEntry(key, entry)
    const controller = new AbortController()
    const startedAt = Date.now()
    const created: CachedIndex = {
      controller,
      startedAt,
      waiting: 0,
      fulfilled: false,
      settled: false,
      promise: fetchSiteIndex(siteId, fetcher, indexUrl, controller.signal).then(
        (index) => {
          created.settled = true
          created.fulfilled = true
          if (indexCache.get(key) === created) {
            created.timer = setTimeout(() => {
              created.timer = undefined
              if (created.waiting === 0) dropEntry(key, created)
            }, Math.max(0, SITE_INDEX_CACHE_TTL_MS - (Date.now() - startedAt)))
          }
          return index
        },
        (error: unknown) => {
          created.settled = true
          dropEntry(key, created)
          throw error
        },
      ),
    }
    created.promise.catch(() => undefined) // consumed by callers; this only avoids an unhandled rejection when all abort
    indexCache.set(key, created)
    enforceCacheCap(created)
    entry = created
  }
  const joined = entry
  joined.waiting += 1
  let left = false
  const leave = (aborted: boolean) => {
    if (left) return
    left = true
    joined.waiting -= 1
    if (joined.waiting > 0) return
    if (!joined.settled) {
      if (aborted) {
        dropEntry(key, joined)
        joined.controller.abort()
      }
    } else if (joined.fulfilled && isExpired(joined)) {
      dropEntry(key, joined)
    }
  }
  if (!signal) {
    return joined.promise.then(
      (index) => { leave(false); return index },
      (error: unknown) => { leave(false); throw error },
    )
  }
  if (signal.aborted) {
    leave(true)
    throw new IndexLoadError(`Aborted ${indexUrl}.`, indexUrl)
  }
  return new Promise<SiteIndex>((resolve, reject) => {
    const onAbort = () => {
      leave(true)
      reject(new IndexLoadError(`Aborted ${indexUrl}.`, indexUrl))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    joined.promise.then(
      (index) => { signal.removeEventListener('abort', onAbort); leave(false); resolve(index) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); leave(false); reject(error) },
    )
  })
}

async function fetchSiteIndex(siteId: string, fetcher: Fetcher, url: string, signal?: AbortSignal): Promise<SiteIndex> {
  let payload: unknown
  const controller = new AbortController()
  let timedOut = false
  const onOuterAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onOuterAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, SITE_INDEX_TIMEOUT_MS)

  try {
    const response = await fetcher(url, { signal: controller.signal })
    if (!response.ok) {
      throw new IndexLoadError(`Request failed with status ${response.status}: ${url}.`, url, { status: response.status })
    }
    payload = await response.json()
  } catch (error) {
    if (timedOut) throw new IndexLoadError(`Timed out loading ${url}.`, url, { timedOut: true, cause: error })
    if (error instanceof IndexLoadError) {
      throw error
    }
    throw new IndexLoadError(`Could not fetch ${url}.`, url, { cause: error })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }

  return parseSiteIndex(payload, url, siteId)
}

function parseSiteIndex(payload: unknown, url: string, expectedSiteId: string): SiteIndex {
  const invalid = () => new IndexLoadError(`Invalid site artifact index data: ${url}.`, url, { invalidData: true })
  if (!payload || typeof payload !== 'object') {
    throw invalid()
  }

  assertSupportedSchema(payload, 'artifact-index', url)
  const index = payload as Partial<SiteIndex>
  if (
    !isSupportedSchema('artifact-index', index.schemaVersion) ||
    !index.site ||
    index.site.id !== expectedSiteId ||
    typeof index.site.title !== 'string' ||
    (index.site.description !== undefined && typeof index.site.description !== 'string') ||
    typeof index.generatedAt !== 'string' ||
    !Array.isArray(index.artifacts)
  ) {
    throw invalid()
  }

  const seenIds = new Set<string>()
  const seenPaths = new Set<string>()
  for (const row of index.artifacts as unknown[]) {
    if (!isValidArtifactRow(row, expectedSiteId) || seenIds.has(row.id) || seenPaths.has(row.path)) throw invalid()
    seenIds.add(row.id)
    seenPaths.add(row.path)
  }

  return index as SiteIndex
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === 'string'
}

function isValidArtifactRow(row: unknown, siteId: string): row is ArtifactIndexEntry {
  if (!isRecord(row)) return false
  const { id, title, path, format, filename, artifactUrl, updatedAt, lastCommitter, source, toc } = row
  if (typeof id !== 'string' || !id || typeof title !== 'string' || typeof updatedAt !== 'string') return false
  if (typeof path !== 'string' || !path || path.startsWith('/')) return false
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return false
  if (format !== 'html' && format !== 'markdown') return false
  if (!isOptionalString(filename)) return false
  if (typeof artifactUrl !== 'string' || !isSameOriginRootPath(artifactUrl, siteId)) return false
  if (lastCommitter !== undefined && !(isRecord(lastCommitter) && typeof lastCommitter.name === 'string')) return false
  if (source !== undefined) {
    if (!isRecord(source) || typeof source.repository !== 'string' || typeof source.ref !== 'string'
      || !isOptionalString(source.repositoryUrl) || !isOptionalString(source.filePath)) return false
  }
  if (toc !== undefined) {
    if (!Array.isArray(toc)) return false
    for (const item of toc as unknown[]) {
      if (!isRecord(item) || !Number.isInteger(item.level) || (item.level as number) < 1 || (item.level as number) > 6
        || typeof item.text !== 'string' || typeof item.id !== 'string') return false
    }
  }
  return true
}

function isSameOriginRootPath(value: string, siteId: string) {
  const prefix = `/_artifacts/${encodeURIComponent(siteId)}/`
  if (!value.startsWith(prefix) || value.length === prefix.length || /[?#]/.test(value)) return false
  if (value.startsWith('//') || value.includes('\\')) return false
  try {
    return new URL(value, 'https://artifact-pages.invalid').origin === 'https://artifact-pages.invalid'
  } catch {
    return false
  }
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

/** How long one site's metadata read may take before the site is listed as unavailable. */
export const SITE_METADATA_TIMEOUT_MS = 10_000
/** At most this many metadata reads are in flight at once. */
export const SITE_METADATA_CONCURRENCY = 6

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const position = next
      next += 1
      results[position] = await task(items[position])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export async function discoverSites(
  fetcher: Fetcher = fetch,
  options: { metadataTimeoutMs?: number; registryTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SiteCatalogEntry[]> {
  const metadataTimeoutMs = options.metadataTimeoutMs ?? SITE_METADATA_TIMEOUT_MS
  const { signal } = options
  const registry = await loadSiteRegistry(fetcher, options.registryTimeoutMs ?? REGISTRY_TIMEOUT_MS, signal)
  const deadline = Date.now() + metadataTimeoutMs
  const sites = await mapWithConcurrency(registry.sites, SITE_METADATA_CONCURRENCY, async (site): Promise<SiteCatalogEntry> => {
    const registeredSummary: SiteSummary = {
      id: site.id,
      title: site.name,
      ...(site.description?.trim() ? { description: site.description } : {}),
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0 || signal?.aborted) return { site: registeredSummary, status: 'metadata-unavailable' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remaining)
    const onCallerAbort = () => controller.abort()
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    try {
      const metadata = await loadSiteDiscoveryMetadata(site.id, fetcher, controller.signal)
      return { ...metadata, site: registeredSummary, status: 'available' }
    } catch (error) {
      return {
        site: registeredSummary,
        status: error instanceof UnsupportedSchemaError
          ? 'needs-republish'
          : error instanceof IndexLoadError && error.status === 404
            ? 'not-published'
            : 'metadata-unavailable',
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
    }
  })
  if (signal?.aborted) throw new IndexLoadError(`Aborted ${REGISTRY_URL}.`, REGISTRY_URL)
  return sites.sort((left, right) => left.site.title.localeCompare(right.site.title))
}

const REGISTRY_URL = `${INDEX_ROOT}/sites.json`

/** Reads and validates the registry; headers and body share one deadline, and the caller can cancel. */
async function loadSiteRegistry(fetcher: Fetcher, timeoutMs: number, callerSignal?: AbortSignal): Promise<SiteRegistryProjection> {
  const controller = new AbortController()
  let timedOut = false
  const onCallerAbort = () => controller.abort()
  if (callerSignal?.aborted) controller.abort()
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  // A deadline or cancellation takes precedence over whatever error the interrupted read produced.
  const interrupted = (cause: unknown) => {
    if (timedOut) return new IndexLoadError(`Timed out loading ${REGISTRY_URL}.`, REGISTRY_URL, { timedOut: true, cause })
    if (callerSignal?.aborted) return new IndexLoadError(`Aborted ${REGISTRY_URL}.`, REGISTRY_URL, { cause })
    return undefined
  }

  try {
    if (callerSignal?.aborted) throw interrupted(undefined)
    let response: Response
    try {
      response = await fetcher(REGISTRY_URL, { signal: controller.signal })
    } catch (error) {
      throw interrupted(error) ?? new IndexLoadError(`Could not fetch ${REGISTRY_URL}.`, REGISTRY_URL, { cause: error })
    }
    if (!response.ok) {
      throw new IndexLoadError(`Request failed with status ${response.status}: ${REGISTRY_URL}.`, REGISTRY_URL, { status: response.status })
    }
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      throw interrupted(error) ?? new IndexLoadError(`Could not fetch ${REGISTRY_URL}.`, REGISTRY_URL, { cause: error })
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch (error) {
      throw new IndexLoadError(`Invalid site registry: ${REGISTRY_URL}.`, REGISTRY_URL, { cause: error, invalidData: true })
    }
    return parseSiteRegistry(payload)
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
}

function parseSiteRegistry(payload: unknown): SiteRegistryProjection {
  if (!payload || typeof payload !== 'object') {
    throw new IndexLoadError(`Invalid site registry: ${REGISTRY_URL}.`, REGISTRY_URL, { invalidData: true })
  }
  assertSupportedSchema(payload, 'registry', `${INDEX_ROOT}/sites.json`)
  const registry = payload as Partial<SiteRegistryProjection>
  if (!isSupportedSchema('registry', registry.schemaVersion) || !Array.isArray(registry.sites)) {
    throw new IndexLoadError(`Invalid site registry: ${REGISTRY_URL}.`, REGISTRY_URL, { invalidData: true })
  }
  const seenIDs = new Set<string>()
  const seenSources = new Set<string>()
  let previousID = ''
  for (const rawEntry of registry.sites) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      throw new IndexLoadError(`Invalid site registry: ${REGISTRY_URL}.`, REGISTRY_URL, { invalidData: true })
    }
    const entry = rawEntry as Partial<SiteRegistryProjection['sites'][number]>
    if (
      typeof entry.id !== 'string' || !isValidSiteId(entry.id) || entry.id <= previousID
      || typeof entry.name !== 'string' || !entry.name.trim()
      || (entry.description !== undefined && typeof entry.description !== 'string')
      || typeof entry.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(entry.repository) || entry.repository.endsWith('.git')
      || typeof entry.sourcePath !== 'string' || !isCanonicalSourcePath(entry.sourcePath)
      || seenIDs.has(entry.id) || seenSources.has(`${entry.repository.toLowerCase()}\0${entry.sourcePath}`)
    ) {
      throw new IndexLoadError(`Invalid site registry: ${REGISTRY_URL}.`, REGISTRY_URL, { invalidData: true })
    }
    previousID = entry.id
    seenIDs.add(entry.id)
    seenSources.add(`${entry.repository.toLowerCase()}\0${entry.sourcePath}`)
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
  signal: AbortSignal,
): Promise<SiteDiscoveryMetadata> {
  const url = `${INDEX_ROOT}/${encodeURIComponent(siteId)}/meta.json`
  let payload: unknown
  try {
    const response = await fetcher(url, { signal })
    if (!response.ok) {
      throw new IndexLoadError(`Request failed with status ${response.status}: ${url}.`, url, { status: response.status })
    }
    payload = await response.json()
  } catch (error) {
    if (error instanceof IndexLoadError) throw error
    throw new IndexLoadError(`Could not fetch ${url}.`, url, { cause: error })
  }
  const metadata = parseSiteDiscoveryMetadata(payload, url, siteId)
  return metadata
}
