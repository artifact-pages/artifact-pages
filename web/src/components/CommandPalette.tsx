import { useEffect, useMemo, useRef, useState } from 'react'
import { hasSiteDiscoveryMetadata, type ArtifactIndexEntry, type SiteCatalogEntry, type SiteIndex, type TocEntry } from '../domain/index'
import type { RecentArtifactRead } from '../domain/recent-reads'
import { artifactCountLabel } from '../domain/site-count-label'
import {
  createPaletteProductionScorer,
  getPaletteFreshnessBoost,
  getPalettePathAffinity,
  getPaletteRecencyBoost,
  getPaletteSharedWordAffinity,
  type PaletteProductionScorer,
} from '../domain/palette-scoring'
import {
  buildPaletteScoringExperiment,
  isPaletteBenchmarkBuild,
  paletteScoringExperimentConfig,
  type PaletteScoringExperiment,
} from '../domain/palette-scoring-experiment'
import {
  fuzzyMatch,
  fuzzyScoreNormalizedText,
  prepareFuzzyQuery,
  prepareFuzzyScoreText,
} from '../domain/fuzzy-search'
import type { FuzzyMatch } from '../domain/fuzzy-search'
import { artifactRouteHref } from '../routing'
import { Icon } from './Icon'

export type PaletteCommand = {
  title: string
  subtitle?: string
  shortcut?: string
  onSelect: () => void
  available?: boolean
}

export type PaletteContext = 'sites' | 'site' | 'artifact'
export type { RecentArtifactRead } from '../domain/recent-reads'

type PaletteEntry = {
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

type PaletteSection = {
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

export function CommandPalette({
  seed,
  sites,
  context,
  currentIndex,
  currentArtifact,
  recentReads = [],
  pinnedArtifactIds = [],
  commands,
  loading,
  onClose,
  onNavigate,
  onJumpToHeading,
  onSearchPageText,
}: {
  seed: string
  sites: SiteCatalogEntry[]
  context: PaletteContext
  currentIndex?: SiteIndex
  currentArtifact?: ArtifactIndexEntry
  recentReads?: RecentArtifactRead[]
  pinnedArtifactIds?: string[]
  commands: PaletteCommand[]
  loading: boolean
  onClose: () => void
  onNavigate: (href: string) => void
  onJumpToHeading: (headingId: string) => void
  /** Hands the query to the sidebar's page text search; present only when the site supports it. */
  onSearchPageText?: (query: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(seed)
  const [selectedIndex, setSelectedIndex] = useState(() => defaultSelectionIndex(seed, context, currentIndex, sites.length))
  const scoringConfig = paletteScoringExperimentConfig(window.location.search)
  const mode = paletteMode(query)
  const hasScopePrefix = mode !== 'search'
  const term = (hasScopePrefix ? query.slice(1) : query).trim()
  const scoringExperiment = useMemo(() => {
    if (!scoringConfig || !currentIndex) return undefined
    return buildPaletteScoringExperiment({
      index: currentIndex,
      currentArtifact,
      recentReads,
      pinnedArtifactIds,
      config: scoringConfig,
    })
  }, [
    scoringConfig?.context,
    scoringConfig?.signals,
    currentIndex,
    currentArtifact,
    recentReads,
    pinnedArtifactIds,
  ])
  const productionScorer = useMemo(() => {
    if (isPaletteBenchmarkBuild() || mode !== 'search' || !currentIndex) return undefined
    return createPaletteProductionScorer({ index: currentIndex, currentArtifact, recentReads, pinnedArtifactIds })
  }, [mode, currentIndex, currentArtifact, recentReads, pinnedArtifactIds])

  const scopeLabel = mode === 'site'
    ? 'Sites'
    : mode === 'command'
      ? 'Commands'
      : mode === 'heading'
        ? 'This artifact'
        : context === 'sites'
          ? 'Sites'
          : currentIndex?.site.title
            ? `${currentIndex.site.title} only`
            : undefined
  const placeholder = mode === 'site'
    ? 'Search sites...'
    : mode === 'command'
      ? 'Search commands...'
      : mode === 'heading'
        ? 'Search headings in this artifact...'
        : context === 'sites'
          ? 'Search sites...'
          : 'Jump to a page, heading, or command...'

  const sections = useMemo(
    () => buildSections({ mode, context, term, sites, currentIndex, currentArtifact, recentReads, pinnedArtifactIds, commands, onNavigate, onJumpToHeading, scoringExperiment, productionScorer, onSearchPageText }),
    [mode, context, term, sites, currentIndex, currentArtifact, recentReads, pinnedArtifactIds, commands, onNavigate, onJumpToHeading, scoringExperiment, productionScorer, onSearchPageText],
  )
  const entries = sections.flatMap((section) => section.entries)
  const entrySequence = mode === 'site' ? JSON.stringify(entries.map(({ id }) => id)) : ''
  const emptyMessage = getEmptyMessage({ mode, context, currentArtifact, siteCount: sites.length })

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setSelectedIndex(defaultSelectionIndex(query, context, currentIndex, sites.length))
  }, [query, context, currentIndex, sites.length])

  const previousEntrySequence = useRef(entrySequence)
  useEffect(() => {
    if (previousEntrySequence.current === entrySequence) return
    previousEntrySequence.current = entrySequence
    setSelectedIndex(defaultSelectionIndex(query, context, currentIndex, sites.length))
  }, [entrySequence, query, context, currentIndex, sites.length])

  useEffect(() => {
    document.querySelector<HTMLElement>('[data-palette-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const moveDown = event.key === 'ArrowDown' || (event.ctrlKey && event.key.toLowerCase() === 'j')
    const moveUp = event.key === 'ArrowUp' || (event.ctrlKey && event.key.toLowerCase() === 'k')

    if (moveDown) {
      event.preventDefault()
      if (event.ctrlKey) event.stopPropagation()
      setSelectedIndex((current) => Math.min(current + 1, Math.max(entries.length - 1, 0)))
    } else if (moveUp) {
      event.preventDefault()
      if (event.ctrlKey) event.stopPropagation()
      setSelectedIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
      // Confirming an IME conversion is not a selection.
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onSearchPageText && mode === 'search' && term) {
      event.preventDefault()
      onSearchPageText(term)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const selectedEntry = entries[selectedIndex]
      if (selectedEntry) {
        onClose()
        selectedEntry.onSelect()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  let entryIndex = 0

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-palette-context-strategy={scoringExperiment?.metrics.context}
        data-palette-signal-strategy={scoringExperiment?.metrics.signals}
        data-palette-scoring-setup-ms={scoringExperiment?.metrics.setupMs}
        data-palette-context-build-ms={scoringExperiment?.metrics.contextBuildMs}
        data-palette-signal-build-ms={scoringExperiment?.metrics.signalBuildMs}
        data-palette-typed-array-bytes={scoringExperiment?.metrics.typedArrayBytes}
        data-palette-context-vector-bytes={scoringExperiment?.metrics.contextVectorBytes}
        data-palette-signal-vector-bytes={scoringExperiment?.metrics.signalVectorBytes}
      >
        <div className="palette-input-row">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            aria-label="Search artifacts, sites, commands, and headings"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="palette-scope" hidden={!scopeLabel}>{scopeLabel}</span>
          <kbd>esc</kbd>
          <button
            className="palette-close-button"
            type="button"
            aria-label="Close command palette"
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="palette-results" role="listbox" aria-label="Search results">
          {sections.length === 0 ? (
            <p className="palette-empty">
              {emptyMessage}
            </p>
          ) : (
            sections.map((section) => (
              <div className="palette-section" key={section.title}>
                <div className="palette-section-title">{section.title}</div>
                {section.entries.map((entry) => {
                  const index = entryIndex++
                  const selected = index === selectedIndex
                  return (
                    <button
                      className={`palette-entry${entry.kind === 'site' ? ' palette-entry--site' : ''}${entry.kind === 'page-text' ? ' palette-entry--page-text' : ''}${selected ? ' is-selected' : ''}`}
                      key={entry.id}
                      role="option"
                      data-palette-entry-id={entry.id}
                      aria-selected={selected}
                      data-palette-selected={selected ? 'true' : undefined}
                      onMouseEnter={() => setSelectedIndex(index)}
                      onClick={() => {
                        onClose()
                        entry.onSelect()
                      }}
                    >
                      <span className="palette-entry-icon">
                        <Icon name={iconForEntry(entry.kind)} size={14} />
                      </span>
                      {entry.kind === 'site' ? (
                        <span className="palette-entry-copy">
                          <span className="palette-entry-title">{highlightMatches(entry.title, entry.titleMatch)}</span>
                          {entry.description ? (
                            <span className="palette-entry-description">
                              {highlightMatches(entry.description, entry.descriptionMatch)}
                            </span>
                          ) : null}
                          {entry.subtitle ? (
                            <span className="palette-entry-subtitle">
                              <span className="palette-entry-site-id">
                                {highlightMatches(`/${entry.siteId}`, entry.subtitleMatch)}
                              </span>
                              <span className="palette-entry-site-separator" aria-hidden="true">·</span>
                              <span>{entry.siteStatus}</span>
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <>
                          <span className="palette-entry-title">{highlightMatches(entry.title, entry.titleMatch)}</span>
                          {entry.subtitle ? (
                            <span className="palette-entry-subtitle">
                              {highlightMatches(entry.subtitle, entry.subtitleMatch)}
                            </span>
                          ) : null}
                        </>
                      )}
                      {entry.badge ? <span className="palette-entry-badge">{entry.badge}</span> : null}
                      {entry.shortcut ? <kbd>{entry.shortcut}</kbd> : null}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        {loading ? <p className="palette-loading" role="status">Loading site information…</p> : null}

        <footer className="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> or <kbd>Ctrl+J/K</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          {onSearchPageText && mode === 'search' && context !== 'sites' ? <span><kbd>⌘↵</kbd> search page text</span> : null}
          <span><code>&gt;</code> commands</span>
          <span><code>@</code> sites</span>
          {currentArtifact ? <span><code>#</code> headings</span> : null}
        </footer>
      </section>
    </div>
  )
}

function defaultSelectionIndex(query: string, context: PaletteContext, currentIndex: SiteIndex | undefined, siteCount: number) {
  const isUnfilteredSiteSwitch = query.trim().normalize('NFKC') === '@' && context !== 'sites' && currentIndex !== undefined
  return isUnfilteredSiteSwitch && siteCount !== 1 ? -1 : 0
}

function getEmptyMessage({
  mode,
  context,
  currentArtifact,
  siteCount,
}: {
  mode: 'site' | 'command' | 'heading' | 'search'
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
function paletteMode(query: string): 'site' | 'command' | 'heading' | 'search' {
  const prefix = query.slice(0, 1).normalize('NFKC')
  return prefix === '@' ? 'site' : prefix === '>' ? 'command' : prefix === '#' ? 'heading' : 'search'
}

function buildSections({
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
  mode: 'site' | 'command' | 'heading' | 'search'
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

function iconForEntry(kind: PaletteEntry['kind']) {
  if (kind === 'site') return 'folder' as const
  if (kind === 'command') return 'chevron' as const
  if (kind === 'heading') return 'contents' as const
  if (kind === 'page-text') return 'search' as const
  return 'file' as const
}

function highlightMatches(text: string, match?: FuzzyMatch) {
  if (!match) return text
  const positions = new Set(match.positions)
  return (
    Array.from(text).map((character, index) => positions.has(index)
      ? <mark className="palette-match" key={index}>{character}</mark>
      : character)
  )
}

function offsetMatch(match: FuzzyMatch, offset: number): FuzzyMatch {
  return { ...match, positions: match.positions.map((position) => position + offset) }
}
