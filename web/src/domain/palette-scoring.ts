import type { ArtifactIndexEntry, SiteIndex } from './index'
import type { RecentArtifactRead } from './recent-reads'

const SIGNAL_VECTOR_THRESHOLD = 100_000
const PALETTE_WORD_THRESHOLD = 5_000
const ignoredWords = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'index', 'html', 'md',
  'incidents', 'architecture', 'reports', 'guides', 'runbooks', 'diagrams', 'docs',
])

type PackedProfile = {
  wordOffsets: Uint32Array
  wordIds: Uint16Array | Uint32Array
  folderOffsets: Uint32Array
  folderIds: Uint16Array | Uint32Array
}

const packedProfileCache = new WeakMap<SiteIndex, PackedProfile | null>()

export type PaletteProductionScorer = {
  contextScore?: (artifact: ArtifactIndexEntry, ordinal: number) => number
  signalScore?: (ordinal: number, viewedAt?: number, isPinned?: boolean) => number
}

export function createPaletteProductionScorer({
  index,
  currentArtifact,
  recentReads,
  pinnedArtifactIds,
}: {
  index: SiteIndex
  currentArtifact?: ArtifactIndexEntry
  recentReads: RecentArtifactRead[]
  pinnedArtifactIds: string[]
}): PaletteProductionScorer | undefined {
  let contextScore: PaletteProductionScorer['contextScore']
  if (index.artifacts.length >= PALETTE_WORD_THRESHOLD && index.paletteScoringProfile) {
    const packed = preparePackedProfile(index)
    if (packed) contextScore = createCsrContextScorer(packed, currentArtifact ? index.artifacts.indexOf(currentArtifact) : -1)
  }

  let signalScore: PaletteProductionScorer['signalScore']
  if (index.artifacts.length >= SIGNAL_VECTOR_THRESHOLD) {
    signalScore = createSignalVectorScorer(index, recentReads, pinnedArtifactIds)
  }

  if (!contextScore && !signalScore) return undefined
  return { contextScore, signalScore }
}

function preparePackedProfile(index: SiteIndex): PackedProfile | undefined {
  if (packedProfileCache.has(index)) return packedProfileCache.get(index) ?? undefined
  const profile = index.paletteScoringProfile
  if (!profile) return undefined
  const count = index.artifacts.length
  if (typeof profile !== 'object'
    || !isNumberArrayLike(profile.wordOffsets)
    || !isNumberArrayLike(profile.wordIds)
    || !isNumberArrayLike(profile.folderOffsets)
    || !isNumberArrayLike(profile.folderIds)) {
    packedProfileCache.set(index, null)
    return undefined
  }
  const wordIdCount = profile.wordOffsets[profile.wordOffsets.length - 1]
  const folderIdCount = profile.folderOffsets[profile.folderOffsets.length - 1]
  if (profile.version !== 1
    || (profile.wordIdWidth !== 16 && profile.wordIdWidth !== 32)
    || (profile.folderIdWidth !== 16 && profile.folderIdWidth !== 32)
    || !validOffsets(profile.wordOffsets, count)
    || !validOffsets(profile.folderOffsets, count)
    || !validIds(profile.wordIds, profile.wordIdWidth, wordIdCount)
    || !validIds(profile.folderIds, profile.folderIdWidth, folderIdCount)) {
    packedProfileCache.set(index, null)
    return undefined
  }

  const packed: PackedProfile = {
    wordOffsets: profile.wordOffsets instanceof Uint32Array
      ? profile.wordOffsets
      : Uint32Array.from(profile.wordOffsets),
    wordIds: profile.wordIdWidth === 32
      ? profile.wordIds instanceof Uint32Array ? profile.wordIds : Uint32Array.from(profile.wordIds)
      : profile.wordIds instanceof Uint16Array ? profile.wordIds : Uint16Array.from(profile.wordIds),
    folderOffsets: profile.folderOffsets instanceof Uint32Array
      ? profile.folderOffsets
      : Uint32Array.from(profile.folderOffsets),
    folderIds: profile.folderIdWidth === 32
      ? profile.folderIds instanceof Uint32Array ? profile.folderIds : Uint32Array.from(profile.folderIds)
      : profile.folderIds instanceof Uint16Array ? profile.folderIds : Uint16Array.from(profile.folderIds),
  }

  // Drop the parsed number arrays once their compact typed-array replacements exist.
  profile.wordOffsets = packed.wordOffsets
  profile.wordIds = packed.wordIds
  profile.folderOffsets = packed.folderOffsets
  profile.folderIds = packed.folderIds
  packedProfileCache.set(index, packed)
  return packed
}

function isNumberArrayLike(value: unknown): value is ArrayLike<number> {
  if (Array.isArray(value)) return true
  return ArrayBuffer.isView(value)
    && typeof (value as ArrayBufferView & { length?: unknown }).length === 'number'
}

function validOffsets(offsets: ArrayLike<number>, artifactCount: number): boolean {
  if (offsets.length !== artifactCount + 1 || offsets[0] !== 0) return false
  let previous = 0
  for (let index = 1; index < offsets.length; index += 1) {
    const offset = offsets[index]
    if (!Number.isSafeInteger(offset) || offset < previous || offset > 0xffff_ffff) return false
    previous = offset
  }
  return true
}

function validIds(ids: ArrayLike<number>, width: 16 | 32, expectedLength: number): boolean {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0 || ids.length !== expectedLength) return false
  const maximum = width === 16 ? 0xffff : 0xffff_ffff
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]
    if (!Number.isSafeInteger(id) || id < 0 || id > maximum) return false
  }
  return true
}

function createCsrContextScorer(
  profile: PackedProfile,
  currentOrdinal: number,
): (artifact: ArtifactIndexEntry, ordinal: number) => number {
  if (currentOrdinal < 0) return (_artifact, _ordinal) => 0
  const currentWordIds = new Set<number>()
  for (let offset = profile.wordOffsets[currentOrdinal]; offset < profile.wordOffsets[currentOrdinal + 1]; offset += 1) {
    currentWordIds.add(profile.wordIds[offset])
  }

  return (_artifact: ArtifactIndexEntry, ordinal: number) => {
    if (ordinal < 0 || ordinal + 1 >= profile.wordOffsets.length) return 0
    let sharedFolders = 0
    let candidateFolderOffset = profile.folderOffsets[ordinal]
    let currentFolderOffset = currentOrdinal >= 0 ? profile.folderOffsets[currentOrdinal] : 0
    const currentFolderEnd = currentOrdinal >= 0 ? profile.folderOffsets[currentOrdinal + 1] : 0
    while (candidateFolderOffset < profile.folderOffsets[ordinal + 1]
      && currentFolderOffset < currentFolderEnd
      && profile.folderIds[candidateFolderOffset] === profile.folderIds[currentFolderOffset]) {
      sharedFolders += 1
      candidateFolderOffset += 1
      currentFolderOffset += 1
    }

    let sharedWords = 0
    for (let offset = profile.wordOffsets[ordinal]; offset < profile.wordOffsets[ordinal + 1]; offset += 1) {
      if (currentWordIds.has(profile.wordIds[offset])) sharedWords += 1
    }
    const folderScore = sharedFolders === 0 ? 0 : Math.min(10, 4 + sharedFolders * 2)
    return folderScore + Math.min(6, sharedWords * 2)
  }
}

function createSignalVectorScorer(
  index: SiteIndex,
  recentReads: RecentArtifactRead[],
  pinnedArtifactIds: string[],
) {
  const recentReadById = new Map(recentReads.map((read) => [read.artifactId, read.viewedAt] as const))
  const pinnedIds = new Set(pinnedArtifactIds)
  const now = Date.now()
  const recency = new Float32Array(index.artifacts.length)
  const pin = new Uint8Array(index.artifacts.length)
  const freshness = new Uint8Array(index.artifacts.length)

  for (let ordinal = 0; ordinal < index.artifacts.length; ordinal += 1) {
    const artifact = index.artifacts[ordinal]
    const viewedAt = recentReadById.get(artifact.id)
    if (viewedAt !== undefined) recency[ordinal] = getRecencyBoost(viewedAt, now)
    if (pinnedIds.has(artifact.id)) pin[ordinal] = 1
    freshness[ordinal] = getFreshnessBoost(artifact.updatedAt, now)
  }

  return (ordinal: number, viewedAt?: number, isPinned?: boolean) => {
    if (ordinal < 0 || ordinal >= recency.length) {
      return (viewedAt === undefined ? 0 : getRecencyBoost(viewedAt, Date.now()))
        + (isPinned ? 5 : 0)
    }
    return recency[ordinal] + (pin[ordinal] ? 5 : 0) + freshness[ordinal]
  }
}

export function getPaletteSharedWordAffinity(artifact: ArtifactIndexEntry, currentArtifact?: ArtifactIndexEntry): number {
  if (!currentArtifact) return 0
  const currentWords = new Set([...paletteWords(currentArtifact.title), ...paletteWords(currentArtifact.path)])
  const candidateWords = new Set([...paletteWords(artifact.title), ...paletteWords(artifact.path)])
  let sharedCount = 0
  for (const word of candidateWords) if (currentWords.has(word)) sharedCount += 1
  return Math.min(6, sharedCount * 2)
}

export function getPalettePathAffinity(path: string, currentPath?: string): number {
  if (!currentPath) return 0
  const folders = path.split('/').filter(Boolean).slice(0, -1)
  const currentFolders = currentPath.split('/').filter(Boolean).slice(0, -1)
  let sharedFolders = 0
  while (sharedFolders < folders.length
    && sharedFolders < currentFolders.length
    && folders[sharedFolders] === currentFolders[sharedFolders]) sharedFolders += 1
  return sharedFolders === 0 ? 0 : Math.min(10, 4 + sharedFolders * 2)
}

export function getPaletteRecencyBoost(viewedAt: number, now = Date.now()): number {
  const ageHours = Math.max(0, (now - viewedAt) / 3_600_000)
  return 24 * Math.pow(0.5, ageHours / 24)
}

export function getPaletteFreshnessBoost(updatedAt: string, now = Date.now()): number {
  const timestamp = Date.parse(updatedAt)
  if (!Number.isFinite(timestamp)) return 0
  const ageDays = Math.max(0, (now - timestamp) / 86_400_000)
  if (ageDays <= 1) return 2
  if (ageDays <= 7) return 1
  return 0
}

function getRecencyBoost(viewedAt: number, now: number): number {
  return getPaletteRecencyBoost(viewedAt, now)
}

function getFreshnessBoost(updatedAt: string, now: number): number {
  return getPaletteFreshnessBoost(updatedAt, now)
}

function paletteWords(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && !ignoredWords.has(word))
}
