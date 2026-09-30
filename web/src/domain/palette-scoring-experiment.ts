import type { ArtifactIndexEntry, SiteIndex } from './index'
import type { RecentArtifactRead } from './recent-reads'

export type PaletteContextStrategy = 'raw' | 'profile' | 'csr' | 'inverted' | 'indexed'
export type PaletteSignalStrategy = 'dynamic' | 'float64' | 'float32' | 'split' | 'sparse' | 'lazy'
export type PaletteCandidateStrategy = 'scan' | 'prefilter'
export type PaletteScopeCountStrategy = 'live' | 'memo'

export type PaletteScoringExperimentConfig = {
  context: PaletteContextStrategy
  signals: PaletteSignalStrategy
}

export type PaletteScopeExperimentConfig = {
  candidates: PaletteCandidateStrategy
  counts: PaletteScopeCountStrategy
}

export type PaletteScoringExperiment = {
  contextScore: (artifact: ArtifactIndexEntry, ordinal?: number) => number
  signalScore: (artifact: ArtifactIndexEntry, isPinned: boolean, ordinal?: number) => number
  metrics: {
    context: PaletteContextStrategy
    signals: PaletteSignalStrategy
    setupMs: number
    contextBuildMs: number
    signalBuildMs: number
    typedArrayBytes: number
    featureReferences: number
    contextVectorBytes: number
    signalVectorBytes: number
  }
}

type PackedPaletteProfiles = {
  wordOffsets: ArrayLike<number>
  wordIds: ArrayLike<number>
  folderOffsets: ArrayLike<number>
  folderIds: ArrayLike<number>
  wordIdWidth?: 16 | 32
  folderIdWidth?: 16 | 32
}

const ignoredWords = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'index', 'html', 'md',
  'incidents', 'architecture', 'reports', 'guides', 'runbooks', 'diagrams', 'docs',
])

export const paletteContextStrategies: PaletteContextStrategy[] = ['raw', 'profile', 'csr', 'inverted', 'indexed']
export const paletteSignalStrategies: PaletteSignalStrategy[] = ['dynamic', 'float64', 'float32', 'split', 'sparse', 'lazy']

export function isPaletteBenchmarkBuild(): boolean {
  return import.meta.env.MODE === 'palette-bench'
}

export function paletteScoringExperimentConfig(search: string): PaletteScoringExperimentConfig | undefined {
  if (!isPaletteBenchmarkBuild()) return undefined
  const params = new URLSearchParams(search)
  const context = params.get('paletteContext')
  const signals = params.get('paletteSignals')
  if (context === 'baseline' && signals === 'dynamic') return undefined
  if (!paletteContextStrategies.includes(context as PaletteContextStrategy)
    || !paletteSignalStrategies.includes(signals as PaletteSignalStrategy)) return undefined
  return { context: context as PaletteContextStrategy, signals: signals as PaletteSignalStrategy }
}

export function paletteScopeExperimentConfig(search: string): PaletteScopeExperimentConfig | undefined {
  if (!isPaletteBenchmarkBuild()) return undefined
  const params = new URLSearchParams(search)
  return {
    candidates: params.get('paletteCandidateScope') === 'prefilter' ? 'prefilter' : 'scan',
    counts: params.get('paletteScopeCounts') === 'memo' ? 'memo' : 'live',
  }
}

export function buildPaletteScoringExperiment({
  index,
  currentArtifact,
  recentReads,
  pinnedArtifactIds,
  config,
}: {
  index: SiteIndex
  currentArtifact?: ArtifactIndexEntry
  recentReads: RecentArtifactRead[]
  pinnedArtifactIds: string[]
  config: PaletteScoringExperimentConfig
}): PaletteScoringExperiment {
  const setupStarted = performance.now()
  const records = index.artifacts
  const recentReadById = new Map(recentReads.map((read) => [read.artifactId, read.viewedAt] as const))
  const pinnedIds = new Set(pinnedArtifactIds)
  const nowMs = Date.now()
  let typedArrayBytes = 0
  let featureReferences = 0
  let contextVectorBytes = 0
  let signalVectorBytes = 0
  let contextBuildMs = 0
  let signalBuildMs = 0
  let contextScore = (_artifact: ArtifactIndexEntry, _ordinal?: number) => 0
  let signalScore = (_artifact: ArtifactIndexEntry, _isPinned: boolean, _ordinal?: number) => 0

  if (config.context === 'indexed') {
    const contextStarted = performance.now()
    const packed = prepareIndexedPaletteProfiles(index)
    typedArrayBytes += paletteProfilesByteLength(packed)
    const currentOrdinal = currentArtifact ? records.indexOf(currentArtifact) : -1
    const currentWordIds = new Set<number>()
    if (currentOrdinal >= 0) {
      for (let offset = packed.wordOffsets[currentOrdinal]; offset < packed.wordOffsets[currentOrdinal + 1]; offset += 1) {
        currentWordIds.add(packed.wordIds[offset])
      }
    }
    featureReferences = packed.wordIds.length + packed.folderIds.length
    contextScore = createCsrContextScorer(packed, currentOrdinal, currentWordIds)
    contextBuildMs = performance.now() - contextStarted
  } else if (config.context === 'raw') {
    contextScore = (artifact) => rawContextScore(artifact, currentArtifact)
  } else if (config.context === 'profile' || config.context === 'csr') {
    const contextStarted = performance.now()
    const profile = buildProfiles(records)
    featureReferences = profile.wordReferences + profile.folderReferences
    const currentOrdinal = currentArtifact ? records.indexOf(currentArtifact) : -1
    if (config.context === 'profile') {
      contextScore = createProfileContextScorer(profile.profiles, currentOrdinal)
    } else {
      const packed = packProfiles(profile.profiles, profile.wordDictionary.size, profile.folderDictionary.size)
      typedArrayBytes += packed.wordOffsets.byteLength + packed.wordIds.byteLength
        + packed.folderOffsets.byteLength + packed.folderIds.byteLength
      const currentWordIds = new Set<number>()
      for (let offset = packed.wordOffsets[currentOrdinal] ?? 0; offset < (packed.wordOffsets[currentOrdinal + 1] ?? 0); offset += 1) {
        currentWordIds.add(packed.wordIds[offset])
      }
      contextScore = createCsrContextScorer(packed, currentOrdinal, currentWordIds)
    }
    contextBuildMs = performance.now() - contextStarted
  } else {
    const contextStarted = performance.now()
    const profile = buildProfiles(records)
    featureReferences = profile.wordReferences + profile.folderReferences
    const wordPostings = new Map<number, number[]>()
    const pathPrefixPostings = [new Map<string, number[]>(), new Map<string, number[]>(), new Map<string, number[]>()]
    profile.profiles.forEach((candidate, ordinal) => {
      candidate.wordIds.forEach((wordId) => appendPosting(wordPostings, wordId, ordinal))
      for (let level = 1; level <= Math.min(3, candidate.folderIds.length); level += 1) {
        appendPosting(pathPrefixPostings[level - 1], JSON.stringify(candidate.folderIds.slice(0, level)), ordinal)
      }
    })
    const currentOrdinal = currentArtifact ? records.indexOf(currentArtifact) : -1
    const currentProfile = profile.profiles[currentOrdinal]
    const scores = new Uint8Array(records.length)
    if (currentProfile) {
      const wordScores = new Uint8Array(records.length)
      for (const wordId of currentProfile.wordIds) {
        for (const ordinal of wordPostings.get(wordId) ?? []) wordScores[ordinal] = Math.min(6, wordScores[ordinal] + 2)
      }
      const folderIncrements = [6, 2, 2]
      for (let level = 1; level <= Math.min(3, currentProfile.folderIds.length); level += 1) {
        const key = JSON.stringify(currentProfile.folderIds.slice(0, level))
        for (const ordinal of pathPrefixPostings[level - 1].get(key) ?? []) scores[ordinal] += folderIncrements[level - 1]
      }
      for (let ordinal = 0; ordinal < records.length; ordinal += 1) scores[ordinal] += wordScores[ordinal]
    }
    typedArrayBytes += scores.byteLength
    contextVectorBytes = scores.byteLength
    contextScore = createVectorContextScorer(scores)
    contextBuildMs = performance.now() - contextStarted
  }

  const signalStarted = performance.now()
  if (config.signals === 'dynamic') {
    signalScore = createDynamicSignalScorer(recentReadById)
  } else if (config.signals === 'float64' || config.signals === 'float32') {
    const values = config.signals === 'float64'
      ? new Float64Array(records.length)
      : new Float32Array(records.length)
    for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
      const artifact = records[ordinal]
      values[ordinal] = currentSignalScore(artifact, recentReadById.get(artifact.id), pinnedIds.has(artifact.id), nowMs)
    }
    typedArrayBytes += values.byteLength
    signalVectorBytes = values.byteLength
    signalScore = createVectorSignalScorer(values)
  } else if (config.signals === 'split') {
    const recency = new Float32Array(records.length)
    const pin = new Uint8Array(records.length)
    const freshness = new Uint8Array(records.length)
    for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
      const artifact = records[ordinal]
      recency[ordinal] = recencyScore(recentReadById.get(artifact.id), nowMs)
      pin[ordinal] = pinnedIds.has(artifact.id) ? 5 : 0
      freshness[ordinal] = freshnessScore(artifact.updatedAt, nowMs)
    }
    typedArrayBytes += recency.byteLength + pin.byteLength + freshness.byteLength
    signalVectorBytes = recency.byteLength + pin.byteLength + freshness.byteLength
    signalScore = createSplitSignalScorer(recency, pin, freshness)
  } else if (config.signals === 'sparse') {
    const freshness = new Uint8Array(records.length)
    for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
      freshness[ordinal] = freshnessScore(records[ordinal].updatedAt, nowMs)
    }
    typedArrayBytes += freshness.byteLength
    signalVectorBytes = freshness.byteLength
    signalScore = createSparseSignalScorer(freshness, recentReadById)
  } else {
    const freshnessByArtifact = new WeakMap<ArtifactIndexEntry, number>()
    signalScore = createLazySignalScorer(freshnessByArtifact, recentReadById)
  }
  signalBuildMs = performance.now() - signalStarted

  return {
    contextScore,
    signalScore,
    metrics: {
      context: config.context,
      signals: config.signals,
      setupMs: performance.now() - setupStarted,
      contextBuildMs,
      signalBuildMs,
      typedArrayBytes,
      featureReferences,
      contextVectorBytes,
      signalVectorBytes,
    },
  }
}

function prepareIndexedPaletteProfiles(index: SiteIndex): PackedPaletteProfiles {
  const indexed = index as unknown as { paletteScoringProfile?: PackedPaletteProfiles }
  const source = indexed.paletteScoringProfile
  if (!source) throw new Error('The index fixture does not contain precomputed palette scoring profiles.')
  if (source.wordOffsets instanceof Uint32Array
    && (source.wordIds instanceof Uint16Array || source.wordIds instanceof Uint32Array)
    && source.folderOffsets instanceof Uint32Array
    && (source.folderIds instanceof Uint16Array || source.folderIds instanceof Uint32Array)) return source
  const packed: PackedPaletteProfiles = {
    wordOffsets: Uint32Array.from(source.wordOffsets),
    wordIds: source.wordIdWidth === 32 ? Uint32Array.from(source.wordIds) : Uint16Array.from(source.wordIds),
    folderOffsets: Uint32Array.from(source.folderOffsets),
    folderIds: source.folderIdWidth === 32 ? Uint32Array.from(source.folderIds) : Uint16Array.from(source.folderIds),
  }
  indexed.paletteScoringProfile = packed
  return packed
}

function paletteProfilesByteLength(profiles: PackedPaletteProfiles) {
  return [profiles.wordOffsets, profiles.wordIds, profiles.folderOffsets, profiles.folderIds]
    .reduce((total, values) => total + (ArrayBuffer.isView(values) ? values.byteLength : 0), 0)
}

function createProfileContextScorer(
  profiles: Array<{ wordIds: number[]; folderIds: number[] }>,
  currentOrdinal: number,
) {
  const currentProfile = profiles[currentOrdinal]
  const currentWordIds = new Set(currentProfile?.wordIds ?? [])
  const currentFolderIds = currentProfile?.folderIds ?? []
  return (_artifact: ArtifactIndexEntry, ordinal?: number) => {
    const candidate = ordinal === undefined ? undefined : profiles[ordinal]
    if (!candidate) return 0
    return profileContextScore(candidate.wordIds, candidate.folderIds, currentWordIds, currentFolderIds)
  }
}

function createCsrContextScorer(
  packed: PackedPaletteProfiles,
  currentOrdinal: number,
  currentWordIds: Set<number>,
) {
  return (_artifact: ArtifactIndexEntry, ordinal?: number) => {
    if (ordinal === undefined) return 0
    let sharedFolders = 0
    let candidateFolderOffset = packed.folderOffsets[ordinal]
    let currentFolderOffset = currentOrdinal >= 0 ? packed.folderOffsets[currentOrdinal] : 0
    const currentFolderEnd = currentOrdinal >= 0 ? packed.folderOffsets[currentOrdinal + 1] : 0
    while (candidateFolderOffset < packed.folderOffsets[ordinal + 1]
      && currentFolderOffset < currentFolderEnd
      && packed.folderIds[candidateFolderOffset] === packed.folderIds[currentFolderOffset]) {
      sharedFolders += 1
      candidateFolderOffset += 1
      currentFolderOffset += 1
    }
    let sharedWords = 0
    for (let wordOffset = packed.wordOffsets[ordinal]; wordOffset < packed.wordOffsets[ordinal + 1]; wordOffset += 1) {
      if (currentWordIds.has(packed.wordIds[wordOffset])) sharedWords += 1
    }
    return (sharedFolders === 0 ? 0 : Math.min(10, 4 + sharedFolders * 2)) + Math.min(6, sharedWords * 2)
  }
}

function createVectorContextScorer(scores: Uint8Array) {
  return (_artifact: ArtifactIndexEntry, ordinal?: number) => ordinal === undefined ? 0 : scores[ordinal]
}

function createDynamicSignalScorer(recentReadById: Map<string, number>) {
  return (artifact: ArtifactIndexEntry, isPinned: boolean) => currentSignalScore(
    artifact,
    recentReadById.get(artifact.id),
    isPinned,
  )
}

function createVectorSignalScorer(values: Float64Array | Float32Array) {
  return (_artifact: ArtifactIndexEntry, _isPinned: boolean, ordinal?: number) => ordinal === undefined ? 0 : values[ordinal]
}

function createSplitSignalScorer(recency: Float32Array, pin: Uint8Array, freshness: Uint8Array) {
  return (_artifact: ArtifactIndexEntry, _isPinned: boolean, ordinal?: number) => (
    ordinal === undefined ? 0 : recency[ordinal] + pin[ordinal] + freshness[ordinal]
  )
}

function createSparseSignalScorer(freshness: Uint8Array, recentReadById: Map<string, number>) {
  return (artifact: ArtifactIndexEntry, isPinned: boolean, ordinal?: number) => {
    if (ordinal === undefined) return 0
    return recencyScore(recentReadById.get(artifact.id), Date.now()) + (isPinned ? 5 : 0) + freshness[ordinal]
  }
}

function createLazySignalScorer(
  freshnessByArtifact: WeakMap<ArtifactIndexEntry, number>,
  recentReadById: Map<string, number>,
) {
  return (artifact: ArtifactIndexEntry, isPinned: boolean) => {
    let freshness = freshnessByArtifact.get(artifact)
    if (freshness === undefined) {
      freshness = freshnessScore(artifact.updatedAt, Date.now())
      freshnessByArtifact.set(artifact, freshness)
    }
    return recencyScore(recentReadById.get(artifact.id), Date.now()) + (isPinned ? 5 : 0) + freshness
  }
}

function buildProfiles(records: ArtifactIndexEntry[]) {
  const wordDictionary = new Map<string, number>()
  const folderDictionary = new Map<string, number>()
  let wordReferences = 0
  let folderReferences = 0
  const intern = (dictionary: Map<string, number>, value: string) => {
    const existing = dictionary.get(value)
    if (existing !== undefined) return existing
    const id = dictionary.size
    dictionary.set(value, id)
    return id
  }
  const profiles = records.map((artifact) => {
    const wordIds = [...new Set([...words(artifact.title), ...words(artifact.path)])]
      .map((word) => intern(wordDictionary, word))
    const folderIds = pathFolders(artifact.path).map((folder) => intern(folderDictionary, folder))
    wordReferences += wordIds.length
    folderReferences += folderIds.length
    return { wordIds, folderIds }
  })
  return { profiles, wordDictionary, folderDictionary, wordReferences, folderReferences }
}

function packProfiles(profiles: Array<{ wordIds: number[]; folderIds: number[] }>, wordCount: number, folderCount: number) {
  const WordIdArray = wordCount <= 65_536 ? Uint16Array : Uint32Array
  const FolderIdArray = folderCount <= 65_536 ? Uint16Array : Uint32Array
  const wordOffsets = new Uint32Array(profiles.length + 1)
  const folderOffsets = new Uint32Array(profiles.length + 1)
  const wordIds = new WordIdArray(profiles.reduce((sum, profile) => sum + profile.wordIds.length, 0))
  const folderIds = new FolderIdArray(profiles.reduce((sum, profile) => sum + profile.folderIds.length, 0))
  let wordOffset = 0
  let folderOffset = 0
  profiles.forEach((profile, ordinal) => {
    wordOffsets[ordinal] = wordOffset
    folderOffsets[ordinal] = folderOffset
    wordIds.set(profile.wordIds, wordOffset)
    folderIds.set(profile.folderIds, folderOffset)
    wordOffset += profile.wordIds.length
    folderOffset += profile.folderIds.length
  })
  wordOffsets[profiles.length] = wordOffset
  folderOffsets[profiles.length] = folderOffset
  return { wordOffsets, wordIds, folderOffsets, folderIds }
}

function profileContextScore(candidateWordIds: number[], candidateFolderIds: number[], currentWordIds: Set<number>, currentFolderIds: number[]) {
  let sharedFolders = 0
  while (sharedFolders < candidateFolderIds.length && sharedFolders < currentFolderIds.length
    && candidateFolderIds[sharedFolders] === currentFolderIds[sharedFolders]) sharedFolders += 1
  let sharedWords = 0
  for (const wordId of candidateWordIds) if (currentWordIds.has(wordId)) sharedWords += 1
  return (sharedFolders === 0 ? 0 : Math.min(10, 4 + sharedFolders * 2)) + Math.min(6, sharedWords * 2)
}

function rawContextScore(artifact: ArtifactIndexEntry, currentArtifact?: ArtifactIndexEntry) {
  const candidateFolders = pathFolders(artifact.path)
  const currentFolders = currentArtifact ? pathFolders(currentArtifact.path) : []
  let sharedFolders = 0
  while (sharedFolders < candidateFolders.length && sharedFolders < currentFolders.length
    && candidateFolders[sharedFolders] === currentFolders[sharedFolders]) sharedFolders += 1
  const pathScore = sharedFolders === 0 ? 0 : Math.min(10, 4 + sharedFolders * 2)
  if (!currentArtifact) return pathScore
  const currentWords = new Set([...words(currentArtifact.title), ...words(currentArtifact.path)])
  const candidateWords = new Set([...words(artifact.title), ...words(artifact.path)])
  let sharedWords = 0
  for (const word of candidateWords) if (currentWords.has(word)) sharedWords += 1
  return pathScore + Math.min(6, sharedWords * 2)
}

function currentSignalScore(artifact: ArtifactIndexEntry, viewedAt?: number, isPinned = false, nowMs = Date.now()) {
  return recencyScore(viewedAt, nowMs) + (isPinned ? 5 : 0) + freshnessScore(artifact.updatedAt, nowMs)
}

function recencyScore(viewedAt?: number, nowMs = Date.now()) {
  if (viewedAt === undefined) return 0
  const ageHours = Math.max(0, (nowMs - viewedAt) / 3_600_000)
  return 24 * Math.pow(0.5, ageHours / 24)
}

function freshnessScore(updatedAt: string, nowMs = Date.now()) {
  const timestamp = Date.parse(updatedAt)
  if (!Number.isFinite(timestamp)) return 0
  const ageDays = Math.max(0, (nowMs - timestamp) / 86_400_000)
  if (ageDays <= 1) return 2
  if (ageDays <= 7) return 1
  return 0
}

function words(value: string) {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && !ignoredWords.has(word))
}

function pathFolders(path: string) {
  return path.split('/').filter(Boolean).slice(0, -1)
}

function appendPosting<Key>(postings: Map<Key, number[]>, key: Key, ordinal: number) {
  const values = postings.get(key) ?? []
  values.push(ordinal)
  postings.set(key, values)
}
