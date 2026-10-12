import type { SiteDiscoveryMetadata } from '../domain/index'
import type { Leaf, Root, SectionRow } from '../domain/fulltext-codec'
import type { SearchExcerpt } from '../domain/fulltext-snippets'
import { isValidSiteId } from './indexes'
import { assertSupportedSchema, isSupportedSchema, UnsupportedSchemaError } from './schema'

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
  constructor(readonly code: 'unavailable' | 'network' | 'invalid-data' | 'needs-republish', message: string, readonly status?: number, options?: ErrorOptions) {
    super(message, options); this.name = 'FullTextSearchError'
  }
}
type ObjectRef = { url: string; sha256: string; bytes: number; rawBytes: number }
type Manifest = { version: 1; generation: string; site: string; documents: number; root: ObjectRef; shards: (ObjectRef | null)[] }
/** The optional section table and text packs (ISSUE-085); null when absent or invalid. */
type SnippetFields = { sections: ObjectRef; texts: ObjectRef[]; truncated: string[]; omitted: string[] }
type Generation = {
  manifest: Manifest
  root: Root
  leaves: Map<number, Promise<Leaf>>
  snippet: SnippetFields | null
  sections?: Promise<Map<string, SectionRow[]> | null>
  packs: Map<string, Promise<Uint8Array>>
}
type Options = { fetcher?: typeof fetch; now?: () => number }
type SearchOptions = { signal?: AbortSignal; offset?: number; limit?: number }
type ExcerptOptions = { signal?: AbortSignal }

/** A text pack holds at most this many raw bytes (docs/architecture/fulltext-search.md, Packing and caps). */
const MAX_PACK_RAW_BYTES = 262144

function validRef(r: ObjectRef, kind: string, site: string) {
  return r && typeof r === 'object' && typeof r.sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.sha256) &&
    r.url === `/_indexes/${site}/search/${kind}-${r.sha256}.gz` &&
    Number.isSafeInteger(r.bytes) && r.bytes > 0 && Number.isSafeInteger(r.rawBytes) && r.rawBytes > 0
}

/** Reads the additive snippet fields. Never throws: anything unusable disables excerpts only. */
function parseSnippetFields(payload: unknown, site: string): SnippetFields | null {
  if (!payload || typeof payload !== 'object') return null
  const m = payload as Record<string, unknown>
  if (m.sections === undefined && m.texts === undefined) return null
  if (m.sections === undefined || m.texts === undefined) return null
  if (!Array.isArray(m.texts) || m.texts.length === 0) return null
  if (!validRef(m.sections as ObjectRef, 'sections', site) || m.texts.some((ref: ObjectRef) => !validRef(ref, 'text', site) || ref.rawBytes > MAX_PACK_RAW_BYTES)) return null
  const limits = m.snippetLimits as Record<string, unknown> | null | undefined
  if (!limits || typeof limits !== 'object' || limits.maxDocumentBytes !== 262144 || limits.maxSiteBytes !== 33554432) return null
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
  if (!strings(limits.truncatedDocuments) || !strings(limits.omittedDocuments)) return null
  return { sections: m.sections as ObjectRef, texts: m.texts as ObjectRef[], truncated: limits.truncatedDocuments, omitted: limits.omittedDocuments }
}

function parseManifest(payload: unknown, site: string): Manifest {
  const fail = () => { throw new FullTextSearchError('invalid-data', 'Invalid full-text manifest') }
  if (!payload || typeof payload !== 'object') return fail()
  // The manifest's version field is named `version` (TD2 renames it to
  // schemaVersion in its next breaking change); an unknown value needs a republish.
  try { assertSupportedSchema(payload, 'full-text-manifest', `/_indexes/${site}/search/manifest.json`, 'version') }
  catch (cause) {
    if (cause instanceof UnsupportedSchemaError) throw new FullTextSearchError('needs-republish', 'Search data needs to be republished', undefined, { cause })
    throw cause
  }
  const m = payload as Manifest
  if (!isSupportedSchema('full-text-manifest', m.version) || !/^[a-f0-9]{64}$/.test(m.generation) || m.site !== site || !Number.isSafeInteger(m.documents) || m.documents < 0 || !Array.isArray(m.shards) || m.shards.length !== 128) return fail()
  if (!validRef(m.root, 'root', site) || m.shards.some((r) => r !== null && !validRef(r, 'leaf', site))) return fail()
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
      let manifest: Manifest, snippet: SnippetFields | null
      try {
        const payload: unknown = await (await request(url, true)).json()
        manifest = parseManifest(payload, siteId)
        snippet = parseSnippetFields(payload, siteId)
      }
      catch (cause) { if (cause instanceof FullTextSearchError) throw cause; throw new FullTextSearchError('invalid-data', 'Invalid search manifest JSON', undefined, { cause }) }
      const root = codec.decodeRoot(await unpack(manifest.root))
      if (root.documents !== manifest.documents) throw new FullTextSearchError('invalid-data', 'Search document count mismatch')
      // Empty shard references are legitimate only when no external token routes there.
      if (root.tokens.some((token, i) => !root.ids[i] && !manifest.shards[codec.tokenShard(token, manifest.shards.length)])) throw new FullTextSearchError('invalid-data', 'Missing search shard reference')
      return { manifest, root, leaves: new Map<number, Promise<Leaf>>(), snippet, packs: new Map<string, Promise<Uint8Array>>() }
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
    // The decoder is a lazily loaded chunk: failing to fetch it is a network
    // failure like failing to fetch search data, so the caller can retry.
    let codec: typeof import('../domain/fulltext-codec')
    try { codec = await cancellable(import('../domain/fulltext-codec'), signal) }
    catch (cause) {
      if (signal?.aborted) throw cause
      throw new FullTextSearchError('network', 'Failed to load the search decoder', undefined, { cause })
    }
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

  // Excerpts (ISSUE-085): optional and never fatal. They read the section table and the
  // text packs of the displayed hits only, and never change the result list.
  type Attempt = { excerpts: Map<string, SearchExcerpt | null>; missing: boolean }
  async function attempt(
    g: Generation,
    query: string,
    paths: readonly string[],
    snippets: typeof import('../domain/fulltext-snippets'),
    codec: typeof import('../domain/fulltext-codec'),
    signal?: AbortSignal,
  ): Promise<Attempt> {
    const excerpts = new Map<string, SearchExcerpt | null>(paths.map((path) => [path, null]))
    const snippet = g.snippet
    if (!snippet) return { excerpts, missing: false }
    const omitted = new Set(snippet.omitted), wanted = paths.filter((path) => !omitted.has(path))
    if (wanted.length === 0) return { excerpts, missing: false }
    let pendingTable = g.sections
    if (!pendingTable) {
      const created = unpack(snippet.sections).then((bytes) => {
        try {
          const rows = codec.decodeSectionTable(bytes, g.root.paths, snippet.texts.map((ref) => ref.rawBytes))
          // The cap record must name root paths, and an omitted document has no section row.
          const known = new Set(g.root.paths)
          if ([...snippet.truncated, ...snippet.omitted].some((path) => !known.has(path)) || snippet.omitted.some((path) => rows.has(path))) return null
          return rows
        } catch { return null }
      }, (cause: unknown) => {
        // A missing or unreachable table is retried later; invalid data stays cached as null.
        if (cause instanceof FullTextSearchError && cause.code === 'invalid-data') return null
        throw cause
      })
      pendingTable = created
      g.sections = created
      void created.catch(() => { if (g.sections === created) g.sections = undefined })
    }
    let table: Map<string, SectionRow[]> | null
    try { table = await cancellable(pendingTable, signal) }
    catch (cause) {
      if (signal?.aborted) throw cause
      return { excerpts, missing: cause instanceof FullTextSearchError && cause.status === 404 }
    }
    if (!table) return { excerpts, missing: false }
    const rows = new Map<string, SectionRow[]>()
    for (const path of wanted) { const row = table.get(path); if (row) rows.set(path, row) }
    const needed = [...new Set([...rows.values()].map((row) => row[0].pack))]
    const bytesByPack = new Map<number, Uint8Array>()
    let missing = false
    await Promise.all(Array.from({ length: Math.min(6, needed.length) }, async () => {
      for (;;) {
        signal?.throwIfAborted()
        const index = needed.shift(); if (index === undefined) break
        const ref = snippet.texts[index]
        let pending = g.packs.get(ref.sha256)
        if (!pending) {
          const created = unpack(ref)
          pending = created
          g.packs.set(ref.sha256, created)
          void created.catch(() => { if (g.packs.get(ref.sha256) === created) g.packs.delete(ref.sha256) })
        }
        try { bytesByPack.set(index, await cancellable(pending, signal)) }
        catch (cause) {
          if (signal?.aborted) throw cause
          if (cause instanceof FullTextSearchError && cause.status === 404) missing = true
        }
      }
    }))
    signal?.throwIfAborted()
    const terms = snippets.excerptTerms(query), decoder = new TextDecoder('utf-8', { fatal: true })
    for (const [path, row] of rows) {
      const bytes = bytesByPack.get(row[0].pack)
      if (!bytes) continue
      try {
        const sections = row.map((section) => ({
          heading: section.heading,
          anchor: section.anchor,
          text: decoder.decode(bytes.subarray(section.offset, section.offset + section.length)),
        }))
        excerpts.set(path, snippets.excerptFor(sections, terms))
      } catch { /* a hit whose sections fail to decode has no excerpt */ }
    }
    return { excerpts, missing }
  }

  async function excerpts(query: string, generationId: string, paths: readonly string[], { signal }: ExcerptOptions = {}): Promise<Map<string, SearchExcerpt | null>> {
    signal?.throwIfAborted()
    const none = () => new Map<string, SearchExcerpt | null>(paths.map((path) => [path, null]))
    if (!url || !query.normalize('NFKC').trim() || !generation || paths.length === 0) return none()
    let g: Generation
    try { g = await cancellable(generation, signal) }
    catch (cause) { if (signal?.aborted) throw cause; return none() }
    if (g.manifest.generation !== generationId) return none()
    try {
      const [snippets, codec] = await cancellable(Promise.all([import('../domain/fulltext-snippets'), import('../domain/fulltext-codec')]), signal)
      const first = await attempt(g, query, paths, snippets, codec, signal)
      if (!first.missing) return first.excerpts
      // A 404 means the generation was reconciled away: reload the manifest once.
      clear()
      let fresh: Generation
      try { fresh = await cancellable(load(codec), signal) }
      catch (cause) { if (signal?.aborted) throw cause; return first.excerpts }
      if (fresh.manifest.generation === g.manifest.generation) return first.excerpts
      return (await attempt(fresh, query, paths, snippets, codec, signal)).excerpts
    } catch (cause) {
      if (signal?.aborted) throw cause
      return none()
    }
  }
  return { available: url !== undefined, search, excerpts, clear }
}

export type SiteFullTextSearch = ReturnType<typeof createSiteFullTextSearch>
