import type { SiteDiscoveryMetadata } from '../domain/index'
import type { Leaf, Root } from '../domain/fulltext-codec'
import { isValidSiteId } from './indexes'

export type FullTextHit = { id: string; path: string; href: string }
export type FullTextResult = {
  siteId: string
  query: string
  /** Manifest identity covers root and leaves, including posting-only updates. */
  generation: string | null
  total: number
  hits: FullTextHit[]
  hasMore: boolean
}
export class FullTextSearchError extends Error {
  constructor(readonly code: 'unavailable' | 'network' | 'invalid-data', message: string, readonly status?: number, options?: ErrorOptions) {
    super(message, options); this.name = 'FullTextSearchError'
  }
}
type ObjectRef = { url: string; sha256: string; bytes: number; rawBytes: number }
type Manifest = { version: 1; generation: string; site: string; documents: number; root: ObjectRef; shards: (ObjectRef | null)[] }
type Generation = { manifest: Manifest; root: Root; leaves: Map<number, Promise<Leaf>> }
type Options = { fetcher?: typeof fetch; now?: () => number }
type SearchOptions = { signal?: AbortSignal; offset?: number; limit?: number }

function parseManifest(payload: unknown, site: string): Manifest {
  const fail = () => { throw new FullTextSearchError('invalid-data', 'Invalid full-text manifest') }
  if (!payload || typeof payload !== 'object') return fail()
  const m = payload as Manifest
  if (m.version !== 1 || !/^[a-f0-9]{64}$/.test(m.generation) || m.site !== site || !Number.isSafeInteger(m.documents) || m.documents < 0 || !Array.isArray(m.shards) || m.shards.length !== 128) return fail()
  const validRef = (r: ObjectRef, kind: string) => r && /^[a-f0-9]{64}$/.test(r.sha256) &&
    r.url === `/_indexes/${site}/search/${kind}-${r.sha256}.gz` &&
    Number.isSafeInteger(r.bytes) && r.bytes > 0 && Number.isSafeInteger(r.rawBytes) && r.rawBytes > 0
  if (!validRef(m.root, 'root') || m.shards.some((r) => r !== null && !validRef(r, 'leaf'))) return fail()
  return m
}

// Cancellation detaches one caller from shared cached requests. A different
// concurrent search can still use them; no aborted promise poisons the cache.
function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError')) }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** No network work at construction. Call search only after committing a query.
 * One client owns one site's cache. clear() releases it on site switch/close. */
export function createSiteFullTextSearch(metadata: Pick<SiteDiscoveryMetadata, 'site' | 'fullTextUrl'>, options: Options = {}) {
  const siteId = metadata.site.id, url = metadata.fullTextUrl
  if (!isValidSiteId(siteId) || (url !== undefined && url !== `/_indexes/${siteId}/search/manifest.json`)) throw new FullTextSearchError('invalid-data', 'Invalid full-text site or URL')
  const fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now
  let generation: Promise<Generation> | undefined
  let expiresAt = 0

  async function request(url: string, revalidate = false) {
    let response: Response
    try { response = await fetcher(url, { cache: revalidate ? 'no-cache' : 'default' }) }
    catch (cause) { throw new FullTextSearchError('network', `Failed to fetch search data: ${url}`, undefined, { cause }) }
    if (!response.ok) throw new FullTextSearchError('network', `Search request failed: ${url}`, response.status)
    return response
  }
  async function unpack(ref: ObjectRef) {
    try {
      const response = await request(ref.url), bytes = await response.arrayBuffer()
      if (bytes.byteLength !== ref.bytes) throw new Error('Search byte length mismatch')
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
      if (hash !== ref.sha256) throw new Error('Search integrity mismatch')
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
      // Read incrementally to enforce the declared size before retaining output.
      const reader = stream.getReader(), chunks: Uint8Array[] = []; let length = 0
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break
          length += value.length
          if (length > ref.rawBytes) throw new Error('Search decoded length mismatch')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      if (length !== ref.rawBytes) throw new Error('Search decoded length mismatch')
      const output = new Uint8Array(length); let offset = 0
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
      return output
    } catch (cause) {
      if (cause instanceof FullTextSearchError) throw cause
      throw new FullTextSearchError('invalid-data', 'Invalid compressed search data', undefined, { cause })
    }
  }
  function load(codec: typeof import('../domain/fulltext-codec')) {
    if (generation && now() < expiresAt) return generation
    expiresAt = now() + 60_000
    const pending = (async () => {
      if (!url) throw new FullTextSearchError('unavailable', 'Full-text search is not enabled for this site')
      let manifest: Manifest
      try { manifest = parseManifest(await (await request(url, true)).json(), siteId) }
      catch (cause) { if (cause instanceof FullTextSearchError) throw cause; throw new FullTextSearchError('invalid-data', 'Invalid search manifest JSON', undefined, { cause }) }
      const root = codec.decodeRoot(await unpack(manifest.root))
      if (root.documents !== manifest.documents) throw new FullTextSearchError('invalid-data', 'Search document count mismatch')
      // Empty shard references are legitimate only when no external token routes there.
      if (root.tokens.some((token, i) => !root.ids[i] && !manifest.shards[codec.tokenShard(token, manifest.shards.length)])) throw new FullTextSearchError('invalid-data', 'Missing search shard reference')
      return { manifest, root, leaves: new Map<number, Promise<Leaf>>() }
    })()
    generation = pending
    void pending.catch(() => { if (generation === pending) generation = undefined })
    return pending
  }
  function clear() { generation = undefined; expiresAt = 0 }

  async function search(query: string, { signal, offset = 0, limit = 20 }: SearchOptions = {}): Promise<FullTextResult> {
    signal?.throwIfAborted()
    if (!url) throw new FullTextSearchError('unavailable', 'Full-text search is not enabled for this site')
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid search page')
    if (query.length > 4096) throw new RangeError('Search query is too long')
    const empty = { siteId, query, generation: null, total: 0, hits: [], hasMore: false }
    if (!query.normalize('NFKC').trim()) return empty
    const codec = await cancellable(import('../domain/fulltext-codec'), signal)
    async function run(): Promise<FullTextResult> {
      const g = await cancellable(load(codec), signal)
      const queryPlan = codec.plan(g.root, query, g.manifest.shards.length), leaves = new Map<number, Leaf>()
      // Bound fan-out for broad substrings; do not issue all 128 downloads at once.
      const needed = [...queryPlan.needed]
      await Promise.all(Array.from({ length: Math.min(6, needed.length) }, async () => {
        for (;;) {
          signal?.throwIfAborted()
          const shard = needed.shift(); if (shard === undefined) break
          let pending = g.leaves.get(shard)
          if (!pending) {
            pending = unpack(g.manifest.shards[shard]!).then((bytes) => codec.decodeLeaf(bytes, g.root.documents))
            g.leaves.set(shard, pending)
            const active = pending
            void pending.catch(() => { if (g.leaves.get(shard) === active) g.leaves.delete(shard) })
          }
          leaves.set(shard, await cancellable(pending, signal))
        }
      }))
      signal?.throwIfAborted()
      const ids = codec.execute(g.root, queryPlan, leaves)
      const hits = ids.slice(offset, offset + limit).map((id) => {
        const path = g.root.paths[id]
        return { id: path, path, href: `/${siteId}/${path.split('/').map(encodeURIComponent).join('/')}` }
      })
      return { siteId, query, generation: g.manifest.generation, total: ids.length, hits, hasMore: offset + hits.length < ids.length }
    }
    try { return await run() }
    catch (cause) {
      // A cached generation may have been reconciled away after site publish.
      // Refresh once on 404; never silently report a partial result.
      if (cause instanceof FullTextSearchError && cause.status === 404 && !signal?.aborted) {
        clear()
        try { return await run() } catch (retryCause) { cause = retryCause }
      }
      if (cause instanceof FullTextSearchError || signal?.aborted) throw cause
      throw new FullTextSearchError('invalid-data', 'Invalid full-text index', undefined, { cause })
    }
  }
  return { available: url !== undefined, search, clear }
}
