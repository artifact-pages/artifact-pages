export type RecentArtifactRead = {
  artifactId: string
  viewedAt: number
}

const STORAGE_KEY = 'git-artifact-pages:recent-artifacts:v1'
const MAX_RECENT_READS_PER_SITE = 20

export function readRecentArtifactReads(siteId: string): RecentArtifactRead[] {
  return readRecentArtifactStore()[siteId] ?? []
}

export function recordRecentArtifactRead(
  siteId: string,
  artifactId: string,
  previousReads: RecentArtifactRead[] = [],
  viewedAt = Date.now(),
): RecentArtifactRead[] {
  const store = readRecentArtifactStore()
  const current = mergeReads(store[siteId] ?? [], previousReads)
  const next = [
    { artifactId, viewedAt },
    ...current.filter((read) => read.artifactId !== artifactId),
  ].slice(0, MAX_RECENT_READS_PER_SITE)

  store[siteId] = next
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
    }
  } catch {
    // Recent reads remain available in memory when browser storage is disabled.
  }

  return next
}

function readRecentArtifactStore(): Record<string, RecentArtifactRead[]> {
  try {
    if (typeof window === 'undefined') return emptyStore()
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyStore()

    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyStore()

    const store = emptyStore()
    for (const [siteId, reads] of Object.entries(parsed)) store[siteId] = normalizeReads(reads)
    return store
  } catch {
    return emptyStore()
  }
}

function emptyStore(): Record<string, RecentArtifactRead[]> {
  return Object.create(null) as Record<string, RecentArtifactRead[]>
}

function mergeReads(...lists: RecentArtifactRead[][]): RecentArtifactRead[] {
  const byId = new Map<string, RecentArtifactRead>()
  for (const reads of lists) {
    for (const read of reads) {
      const existing = byId.get(read.artifactId)
      if (!existing || read.viewedAt > existing.viewedAt) byId.set(read.artifactId, read)
    }
  }
  return [...byId.values()]
    .sort((left, right) => right.viewedAt - left.viewedAt)
    .slice(0, MAX_RECENT_READS_PER_SITE)
}

function normalizeReads(value: unknown): RecentArtifactRead[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const reads: RecentArtifactRead[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const { artifactId, viewedAt } = item as Record<string, unknown>
    if (typeof artifactId !== 'string' || !artifactId || typeof viewedAt !== 'number' || !Number.isFinite(viewedAt)) {
      continue
    }
    if (seen.has(artifactId)) continue
    seen.add(artifactId)
    reads.push({ artifactId, viewedAt })
    if (reads.length >= MAX_RECENT_READS_PER_SITE) break
  }
  return reads
}
