// Pure section building for the command palette: what each query shows, in which
// order, and which row starts selected. No React; unit-tested by
// scripts/palette-sections.test.mjs (npm run test:palette-sections).
import { hasSiteDiscoveryMetadata, type ArtifactIndexEntry, type SiteCatalogEntry, type SiteIndex, type TocEntry } from './index'
import type { RecentArtifactRead } from './recent-reads'
import { artifactCountLabel } from './site-count-label'
import {
  getPaletteFreshnessBoost,
  getPalettePathAffinity,
  getPaletteRecencyBoost,
  getPaletteSharedWordAffinity,
  type PaletteProductionScorer,
} from './palette-scoring'
import type { PaletteScoringExperiment } from './palette-scoring-experiment'
import {
  fuzzyMatch,
  fuzzyScoreNormalizedText,
  prepareFuzzyQuery,
  prepareFuzzyScoreText,
} from './fuzzy-search'
import type { FuzzyMatch } from './fuzzy-search'
import { artifactRouteHref } from '../routing'

export type PaletteCommand = {
  title: string
  subtitle?: string
  shortcut?: string
  onSelect: () => void
  available?: boolean
}


export type PaletteMode = 'site' | 'command' | 'heading' | 'search'
export type PaletteContext = 'sites' | 'site' | 'artifact'

export type PaletteEntry = {
  id: string
  kind: 'artifact' | 'site' | 'command' | 'heading' | 'page-text'
  title: string
  description?: string
  siteId?: string
  siteStatus?: string
  subtitle?: string
  badge?: string
  shortcut?: string
  titleMatch?: FuzzyMatch
  descriptionMatch?: FuzzyMatch
  subtitleMatch?: FuzzyMatch
  onSelect: () => void
}

export type PaletteSection = {
  title: string
  entries: PaletteEntry[]
}

type PreparedArtifactText = { title: string; path: string }
type PageSearchCache = {
  terms: string[]
  candidateOrdinals: number[]
}
const preparedArtifactText = new WeakMap<ArtifactIndexEntry, PreparedArtifactText>()
const pageSearchCache = new WeakMap<SiteIndex, PageSearchCache>()

export function defaultSelectionIndex(query: string, context: PaletteContext, currentIndex: SiteIndex | undefined, siteCount: number) {
  const isUnfilteredSiteSwitch = query.trim().normalize('NFKC') === '@' && context !== 'sites' && currentIndex !== undefined
  return isUnfilteredSiteSwitch && siteCount !== 1 ? -1 : 0
}

export function getEmptyMessage({
  mode,
  context,
  currentArtifact,
  siteCount,
}: {
  mode: PaletteMode
  context: PaletteContext
  currentArtifact?: ArtifactIndexEntry
  siteCount: number
}): string {
  if (mode === 'heading') {
    if (!currentArtifact) return 'Open an artifact first to search its headings.'
    if ((currentArtifact.toc?.length ?? 0) === 0) return 'This artifact has no indexed headings.'
    return 'No headings match. Change or clear your search.'
  }
  if (mode === 'site') {
    return siteCount === 0
      ? 'No sites are available.'
      : 'No sites match. Change or clear your search.'
  }
  if (mode === 'command') return 'No commands match. Change or clear your search.'
  if (context === 'sites') return 'No sites or commands match. Pages are searched after you choose a site.'
  return currentArtifact
    ? 'Nothing matches. Try > for commands, @ for sites, or # for headings.'
    : 'Nothing matches. Try > for commands or @ for sites.'
}

// A full-width prefix (＠, ＞, ＃) selects the same mode as its ordinary form.
export function paletteMode(query: string): PaletteMode {
  const prefix = query.slice(0, 1).normalize('NFKC')
  return prefix === '@' ? 'site' : prefix === '>' ? 'command' : prefix === '#' ? 'heading' : 'search'
}

export function buildSections({
  mode,
  context,
  term,
  sites,
  currentIndex,
  currentArtifact,
  recentReads,
  pinnedArtifactIds,
  commands,
  onNavigate,
  onJumpToHeading,
  scoringExperiment,
  productionScorer,
  onSearchPageText,
}: {
  mode: PaletteMode
  context: PaletteContext
  term: string
  sites: SiteCatalogEntry[]
  currentIndex?: SiteIndex
  currentArtifact?: ArtifactIndexEntry
  recentReads: RecentArtifactRead[]
  pinnedArtifactIds: string[]
  commands: PaletteCommand[]
  onNavigate: (href: string) => void
  onJumpToHeading: (headingId: string) => void
  scoringExperiment?: PaletteScoringExperiment
  productionScorer?: PaletteProductionScorer
  onSearchPageText?: (query: string) => void
}): PaletteSection[] {
  if (mode === 'site') {
    const entries = buildSiteEntries(sites, term, onNavigate)
    return entries.length ? [{ title: 'Sites', entries }] : []
  }

  if (mode === 'command') {
    const entries = buildCommandEntries(commands, term)
    return entries.length ? [{ title: 'Commands', entries }] : []
  }

  if (mode === 'heading') {
    const headings = buildHeadingEntries(currentArtifact, term, onJumpToHeading)
    return headings.length
      ? [{ title: `In ${currentArtifact?.title ?? 'this artifact'}`, entries: headings }]
      : []
  }

  if (context === 'sites') {
    const siteEntries = buildSiteEntries(sites, term, onNavigate)
    const siteSection = siteEntries.length ? [{ title: 'Sites', entries: siteEntries }] : []
    const commandEntries = buildCommandEntries(commands, term)
    const commandSection = commandEntries.length ? [{ title: 'Commands', entries: commandEntries }] : []
    return [...siteSection, ...commandSection]
  }

  if (!currentIndex) return []
  const allCommandEntries = buildCommandEntries(commands, term)
  if (!term.trim()) {
    const returnSections = buildReturnSections(currentIndex, currentArtifact, recentReads, pinnedArtifactIds, onNavigate)
    const commandSection = allCommandEntries.length ? [{ title: 'Commands', entries: allCommandEntries.slice(0, 3) }] : []
    if (returnSections.length) return [...returnSections, ...commandSection]
  }
  const pageSections = buildPageSections(
    currentIndex,
    term,
    onNavigate,
    recentReads,
    pinnedArtifactIds,
    currentArtifact,
    scoringExperiment,
    productionScorer,
  )
  const headingEntries = term.trim() && context === 'artifact'
    ? buildHeadingEntries(currentArtifact, term, onJumpToHeading)
    : []
  const headingSection = headingEntries.length
    ? [{ title: `In ${currentArtifact?.title ?? 'this artifact'}`, entries: headingEntries }]
    : []
  // Listed after page matches, it becomes the default selection when no page name matches.
  const pageTextSection: PaletteSection[] = onSearchPageText && term.trim()
    ? [{
        title: 'Page text',
        entries: [{
          id: 'page-text-search',
          kind: 'page-text',
          title: `Search page text for “${term}”`,
          shortcut: '⌘ ↵',
          onSelect: () => onSearchPageText(term),
        }],
      }]
    : []
  const commandEntries = term.trim() ? allCommandEntries : allCommandEntries.slice(0, 3)
  const commandSection = commandEntries.length ? [{ title: 'Commands', entries: commandEntries }] : []

  return [
    ...pageSections,
    ...pageTextSection,
    ...headingSection,
    ...commandSection,
  ]
}

// A blank palette is where readers return from: pinned pages first, then their own recent reads.
function buildReturnSections(
  index: SiteIndex,
  currentArtifact: ArtifactIndexEntry | undefined,
  recentReads: RecentArtifactRead[],
  pinnedArtifactIds: string[],
  onNavigate: (href: string) => void,
): PaletteSection[] {
  const artifactsById = new Map(index.artifacts.map((artifact) => [artifact.id, artifact]))
  const pinnedIds = new Set(pinnedArtifactIds)
  const currentBadge = (artifact: ArtifactIndexEntry) => artifact.id === currentArtifact?.id ? 'Current page' : undefined
  const pinned = pinnedArtifactIds.flatMap((id) => {
    const artifact = artifactsById.get(id)
    return artifact ? [artifactEntry(index, artifact, onNavigate, undefined, undefined, currentBadge(artifact))] : []
  })
  const recent = [...recentReads]
    .sort((left, right) => right.viewedAt - left.viewedAt)
    .flatMap((read) => {
      const artifact = artifactsById.get(read.artifactId)
      if (!artifact || pinnedIds.has(artifact.id)) return []
      const badge = [currentBadge(artifact), formatRecentRead(read.viewedAt)].filter(Boolean).join(' · ')
      return [artifactEntry(index, artifact, onNavigate, undefined, undefined, badge)]
    })
    .slice(0, 8)
  return [
    ...(pinned.length ? [{ title: 'Pinned', entries: pinned }] : []),
    ...(recent.length ? [{ title: 'Recently read', entries: recent }] : []),
  ]
}

function buildSiteEntries(
  sites: SiteCatalogEntry[],
  term: string,
  onNavigate: (href: string) => void,
): PaletteEntry[] {
  return sites.flatMap((siteEntry) => {
    const titleMatch = fuzzyMatch(siteEntry.site.title, term)
    const idMatch = fuzzyMatch(siteEntry.site.id, term)
    const description = siteEntry.site.description?.trim() ? siteEntry.site.description : undefined
    const descriptionMatch = description ? fuzzyMatch(description, term) : undefined
    if (term.trim() && !titleMatch && !idMatch && !descriptionMatch) return []
    const statusLabel = hasSiteDiscoveryMetadata(siteEntry)
      ? artifactCountLabel(siteEntry.artifactCount)
      : siteEntry.status === 'not-published'
        ? 'not published yet'
        : siteEntry.status === 'needs-republish'
          ? 'needs to be republished'
          : 'details unavailable'
    const subtitle = `/${siteEntry.site.id} · ${statusLabel}`
    const subtitleMatch = idMatch ? offsetMatch(idMatch, 1) : undefined
    return [{
      entry: {
        id: `site:${siteEntry.site.id}`,
        kind: 'site' as const,
        title: siteEntry.site.title,
        description,
        siteId: siteEntry.site.id,
        siteStatus: statusLabel,
        subtitle,
        titleMatch,
        descriptionMatch,
        subtitleMatch,
        onSelect: () => onNavigate(`/${encodeURIComponent(siteEntry.site.id)}`),
      },
      // A match on the name or ID outranks one that only appears in the description.
      nameMatched: Boolean(titleMatch || idMatch),
      score: Math.max(titleMatch?.score ?? 0, idMatch?.score ?? 0, descriptionMatch?.score ?? 0),
    }]
  })
    .sort((left, right) => term.trim()
      ? Number(right.nameMatched) - Number(left.nameMatched) || right.score - left.score
      : left.entry.title.localeCompare(right.entry.title))
    .map(({ entry }) => entry)
}

function buildCommandEntries(commands: PaletteCommand[], term: string): PaletteEntry[] {
  return commands.flatMap((command) => {
    if (command.available === false) return []
    const titleMatch = fuzzyMatch(command.title, term)
    const subtitleMatch = command.subtitle ? fuzzyMatch(command.subtitle, term) : undefined
    if (term.trim() && !titleMatch && !subtitleMatch) return []
    return [{
      entry: {
        id: `command:${command.title}`,
        kind: 'command' as const,
        title: command.title,
        subtitle: command.subtitle,
        shortcut: command.shortcut,
        titleMatch,
        subtitleMatch,
        onSelect: command.onSelect,
      },
      score: Math.max(titleMatch?.score ?? 0, subtitleMatch?.score ?? 0),
    }]
  })
    .sort((left, right) => right.score - left.score)
    .map(({ entry }) => entry)
}

function buildHeadingEntries(
  currentArtifact: ArtifactIndexEntry | undefined,
  term: string,
  onJumpToHeading: (headingId: string) => void,
): PaletteEntry[] {
  return (currentArtifact?.toc ?? []).flatMap((heading) => {
    const titleMatch = fuzzyMatch(heading.text, term)
    if (term.trim() && !titleMatch) return []
    return [headingEntry(heading, currentArtifact, onJumpToHeading, titleMatch)]
  }).sort((left, right) => (right.titleMatch?.score ?? 0) - (left.titleMatch?.score ?? 0))
}

function buildPageSections(
  currentIndex: SiteIndex | undefined,
  term: string,
  onNavigate: (href: string) => void,
  recentReads: RecentArtifactRead[],
  pinnedArtifactIds: string[],
  currentArtifact?: ArtifactIndexEntry,
  scoringExperiment?: PaletteScoringExperiment,
  productionScorer?: PaletteProductionScorer,
): PaletteSection[] {
  if (!currentIndex) return []
  const query = prepareFuzzyQuery(term)
  const recentReadById = new Map(recentReads.map((read) => [read.artifactId, read] as const))
  const pinnedIds = new Set(pinnedArtifactIds)
  const previousSearch = pageSearchCache.get(currentIndex)
  const isQueryExtension = previousSearch !== undefined
    && query.terms.length >= previousSearch.terms.length
    && previousSearch.terms.every((previousTerm, index) => (
      query.terms[index].normalized.startsWith(previousTerm)
    ))
  let candidateOrdinals: number[] | undefined
  if (isQueryExtension) {
    candidateOrdinals = previousSearch.candidateOrdinals
  }
  const candidateCount = candidateOrdinals?.length ?? currentIndex.artifacts.length
  const entries: Array<{ artifact: ArtifactIndexEntry; score: number; badge?: string }> = []
  const matchingOrdinals: number[] = []
  for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
    const ordinal = candidateOrdinals ? candidateOrdinals[candidateIndex] : candidateIndex
    const artifact = currentIndex.artifacts[ordinal]
    let prepared = preparedArtifactText.get(artifact)
    if (!prepared) {
      prepared = {
        title: prepareFuzzyScoreText(artifact.title),
        path: prepareFuzzyScoreText(artifact.path),
      }
      preparedArtifactText.set(artifact, prepared)
    }
    const titleScore = fuzzyScoreNormalizedText(prepared.title, query)
    const pathScore = fuzzyScoreNormalizedText(prepared.path, query)
    if (term.trim() && titleScore === undefined && pathScore === undefined) continue
    matchingOrdinals.push(ordinal)

    const isPinned = pinnedIds.has(artifact.id)
    const isCurrent = artifact.id === currentArtifact?.id

    const read = recentReadById.get(artifact.id)
    const score = scoreArtifact({
      artifact,
      currentArtifact,
      titleScore,
      pathScore,
      viewedAt: read?.viewedAt,
      isPinned,
      scoringExperiment,
      productionScorer,
      ordinal,
    })
    const badge = [
      isCurrent ? 'Current page' : undefined,
      isPinned ? 'Pinned' : undefined,
      read ? formatRecentRead(read.viewedAt) : undefined,
    ].filter(Boolean).join(' · ') || undefined
    let position = 0
    while (position < entries.length && entries[position].score >= score) position += 1
    if (position < 8) {
      entries.splice(position, 0, { artifact, score, badge })
      if (entries.length > 8) entries.pop()
    }
  }
  pageSearchCache.set(currentIndex, {
    terms: query.terms.map(({ normalized }) => normalized),
    candidateOrdinals: matchingOrdinals,
  })
  if (!entries.length) return []
  return [{
    title: 'Pages',
    entries: entries.slice(0, 8).map(({ artifact, badge }) => (
      artifactEntry(
        currentIndex,
        artifact,
        onNavigate,
        fuzzyMatch(artifact.title, term),
        fuzzyMatch(artifact.path, term),
        badge,
      )
    )),
  }]
}

function scoreArtifact({
  artifact,
  currentArtifact,
  titleScore,
  pathScore,
  viewedAt,
  isPinned,
  scoringExperiment,
  productionScorer,
  ordinal,
}: {
  artifact: ArtifactIndexEntry
  currentArtifact?: ArtifactIndexEntry
  titleScore?: number
  pathScore?: number
  viewedAt?: number
  isPinned: boolean
  scoringExperiment?: PaletteScoringExperiment
  productionScorer?: PaletteProductionScorer
  ordinal?: number
}): number {
  // Query fit leads; contextual signals only refine the order among matching pages.
  const queryScore = (titleScore ?? 0) * 1.12 + (pathScore ?? 0)
  const contextScore = scoringExperiment?.contextScore(artifact, ordinal)
    ?? productionScorer?.contextScore?.(artifact, ordinal ?? -1)
    ?? getPalettePathAffinity(artifact.path, currentArtifact?.path) + getPaletteSharedWordAffinity(artifact, currentArtifact)
  const signalScore = scoringExperiment?.signalScore(artifact, isPinned, ordinal)
    ?? productionScorer?.signalScore?.(ordinal ?? -1, viewedAt, isPinned)
    ?? (viewedAt === undefined ? 0 : getPaletteRecencyBoost(viewedAt))
      + (isPinned ? 5 : 0)
      + getPaletteFreshnessBoost(artifact.updatedAt)
  return queryScore + contextScore + signalScore
}

function artifactEntry(
  index: SiteIndex,
  artifact: ArtifactIndexEntry,
  onNavigate: (href: string) => void,
  titleMatch?: FuzzyMatch,
  pathMatch?: FuzzyMatch,
  recentReadLabel?: string,
): PaletteEntry {
  return {
    id: `artifact:${index.site.id}:${artifact.id}`,
    kind: 'artifact',
    title: artifact.title,
    subtitle: artifact.path,
    titleMatch,
    subtitleMatch: pathMatch,
    badge: recentReadLabel,
    onSelect: () => onNavigate(artifactRouteHref(index.site.id, artifact.path)),
  }
}

function formatRecentRead(viewedAt: number): string {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - viewedAt) / 60_000))
  if (elapsedMinutes < 1) return 'Read just now'
  if (elapsedMinutes < 60) return `Read ${elapsedMinutes}m ago`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `Read ${elapsedHours}h ago`
  const elapsedDays = Math.floor(elapsedHours / 24)
  return `Read ${elapsedDays}d ago`
}

function headingEntry(
  heading: TocEntry,
  artifact: ArtifactIndexEntry | undefined,
  onJumpToHeading: (headingId: string) => void,
  titleMatch?: FuzzyMatch,
): PaletteEntry {
  return {
    id: `heading:${heading.id}`,
    kind: 'heading',
    title: heading.text,
    subtitle: heading.level > 1 ? `Heading ${heading.level}` : 'Heading',
    titleMatch,
    onSelect: () => {
      if (artifact) onJumpToHeading(heading.id)
    },
  }
}



function offsetMatch(match: FuzzyMatch, offset: number): FuzzyMatch {
  return { ...match, positions: match.positions.map((position) => position + offset) }
}
