import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactIndexEntry, SiteDiscoveryMetadata, SiteIndex, TocEntry } from '../domain/index'
import type { RecentArtifactRead } from '../domain/recent-reads'
import type { PreviewCandidate } from '../data/previews'
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
  paletteScopeExperimentConfig,
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
import { loadPreviewCandidates, PreviewLoadError, previewRouteHref } from '../data/previews'
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
type PaletteScope = 'all' | 'recent' | 'pinned' | 'previews'
export type { RecentArtifactRead } from '../domain/recent-reads'

type PaletteEntry = {
  id: string
  kind: 'artifact' | 'site' | 'command' | 'heading'
  title: string
  subtitle?: string
  badge?: string
  shortcut?: string
  titleMatch?: FuzzyMatch
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
  scope: PaletteScope
  recentReads: RecentArtifactRead[]
  pinnedArtifactIds: string[]
}
type PreviewPaletteState = {
  siteId: string
  status: 'idle' | 'loading' | 'success' | 'error'
  candidates: PreviewCandidate[]
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
}: {
  seed: string
  sites: SiteDiscoveryMetadata[]
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
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(seed)
  const [selectedIndex, setSelectedIndex] = useState(() => defaultSelectionIndex(seed, context, currentIndex))
  const [scope, setScope] = useState<PaletteScope>('all')
  const [previewState, setPreviewState] = useState<PreviewPaletteState>({ siteId: '', status: 'idle', candidates: [] })
  const currentSiteId = currentIndex?.site.id
  const scoringConfig = paletteScoringExperimentConfig(window.location.search)
  const scopeExperiment = paletteScopeExperimentConfig(window.location.search)
  const recentArtifactIds = useMemo(() => new Set(recentReads.map(({ artifactId }) => artifactId)), [recentReads])
  const pinnedArtifactIdSet = useMemo(() => new Set(pinnedArtifactIds), [pinnedArtifactIds])
  const normalized = query.toLocaleLowerCase()
  const mode = normalized.startsWith('@')
    ? 'site'
    : normalized.startsWith('>')
      ? 'command'
      : normalized.startsWith('#')
        ? 'heading'
        : 'search'
  const hasScopePrefix = normalized.startsWith('@') || normalized.startsWith('>') || normalized.startsWith('#')
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
  const prefilterScopeCandidates = scopeExperiment
    ? scopeExperiment.candidates === 'prefilter'
    : true
  const memoizeScopeCounts = scopeExperiment
    ? scopeExperiment.counts === 'memo'
    : true

  const scopeLabel = mode === 'site'
    ? 'Sites'
    : mode === 'command'
      ? 'Commands'
      : mode === 'heading'
        ? 'This artifact'
        : context === 'sites'
          ? 'Sites'
          : scope === 'previews'
            ? 'Previews'
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
          : scope === 'previews'
            ? 'Search preview documents...'
          : scope === 'recent'
            ? 'Search recently read pages...'
            : scope === 'pinned'
              ? 'Search pinned pages...'
              : 'Search pages, headings, and commands...'

  const availablePreviewCandidates = previewState.siteId === currentSiteId
    ? previewState.candidates.filter(({ availability }) => availability === 'available' || availability === 'unknown')
    : []
  const previewDocumentCount = availablePreviewCandidates.reduce((count, { group }) => count + group.documents.length, 0)
  const sections = useMemo(
    () => buildSections({ mode, context, term, sites, currentIndex, currentArtifact, recentReads, pinnedArtifactIds, scope, commands, onNavigate, onJumpToHeading, scoringExperiment, productionScorer, prefilterScopeCandidates, previewCandidates: availablePreviewCandidates }),
    [mode, context, term, sites, currentIndex, currentArtifact, recentReads, pinnedArtifactIds, scope, commands, onNavigate, onJumpToHeading, scoringExperiment, productionScorer, prefilterScopeCandidates, availablePreviewCandidates],
  )
  const entries = sections.flatMap((section) => section.entries)
  const entrySequence = mode === 'site' ? JSON.stringify(entries.map(({ id }) => id)) : ''
  const showScopePicker = mode === 'search' && context !== 'sites' && Boolean(currentIndex)
  const memoizedScopeCounts = useMemo(() => {
    if (!memoizeScopeCounts || !currentIndex) return undefined
    let recent = 0
    let pinned = 0
    for (const { id } of currentIndex.artifacts) {
      if (recentArtifactIds.has(id)) recent += 1
      if (pinnedArtifactIdSet.has(id)) pinned += 1
    }
    return { all: currentIndex.artifacts.length, recent, pinned }
  }, [memoizeScopeCounts, currentIndex, recentArtifactIds, pinnedArtifactIdSet])
  const recentCount = memoizedScopeCounts?.recent
    ?? currentIndex?.artifacts.filter(({ id }) => recentArtifactIds.has(id)).length ?? 0
  const pinnedCount = memoizedScopeCounts?.pinned
    ?? currentIndex?.artifacts.filter(({ id }) => pinnedArtifactIdSet.has(id)).length ?? 0
  const scopedCount = scope === 'all'
    ? memoizedScopeCounts?.all ?? currentIndex?.artifacts.length ?? 0
    : scope === 'recent' ? recentCount : scope === 'pinned' ? pinnedCount : previewDocumentCount
  const currentArtifactInScope = currentArtifact !== undefined && (
    scope === 'all'
    || (scope === 'recent' && recentArtifactIds.has(currentArtifact.id))
    || (scope === 'pinned' && pinnedArtifactIdSet.has(currentArtifact.id))
  )
  const availableScopeCount = scope === 'previews' ? previewDocumentCount : memoizedScopeCounts
    ? scopedCount - (!term.trim() && currentArtifactInScope ? 1 : 0)
    : currentIndex?.artifacts.filter((artifact) => (
      (scope === 'all'
        || (scope === 'recent' && recentArtifactIds.has(artifact.id))
        || (scope === 'pinned' && pinnedArtifactIdSet.has(artifact.id)))
      && (term.trim() || artifact.id !== currentArtifact?.id)
    )).length ?? 0
  const emptyMessage = getEmptyMessage({ mode, scope, currentArtifact, siteCount: sites.length, availableScopeCount })

  useEffect(() => {
    if (scope !== 'previews' || !currentSiteId) return
    let cancelled = false
    setPreviewState({ siteId: currentSiteId, status: 'loading', candidates: [] })
    loadPreviewCandidates(currentSiteId).then((candidates) => {
      if (!cancelled) setPreviewState({ siteId: currentSiteId, status: 'success', candidates })
    }).catch((error: unknown) => {
      if (cancelled) return
      if (error instanceof PreviewLoadError && error.status === 404) {
        setPreviewState({ siteId: currentSiteId, status: 'success', candidates: [] })
      } else {
        setPreviewState({ siteId: currentSiteId, status: 'error', candidates: [] })
      }
    })
    return () => { cancelled = true }
  }, [scope, currentSiteId])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setSelectedIndex(defaultSelectionIndex(query, context, currentIndex))
  }, [query, context, currentIndex])

  const previousEntrySequence = useRef(entrySequence)
  useEffect(() => {
    if (previousEntrySequence.current === entrySequence) return
    previousEntrySequence.current = entrySequence
    setSelectedIndex(defaultSelectionIndex(query, context, currentIndex))
  }, [entrySequence, query, context, currentIndex])

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
        </div>

        {showScopePicker ? (
          <div className="palette-scope-tabs" role="group" aria-label="Filter site results">
            {(['all', 'recent', 'pinned', 'previews'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={scope === value}
                aria-label={`${value === 'all' ? 'All pages' : value === 'recent' ? 'Recently read pages' : value === 'pinned' ? 'Pinned pages' : 'Previews'}${value === scope ? ', selected' : ''}`}
                onClick={() => {
                  setScope(value)
                  setSelectedIndex(0)
                  inputRef.current?.focus()
                }}
              >
                {value === 'all' ? 'All' : value === 'recent' ? 'Recent' : value === 'pinned' ? 'Pinned' : 'Previews'}
                {value === 'recent' ? <span aria-hidden="true">{recentCount}</span> : null}
                {value === 'pinned' ? <span aria-hidden="true">{pinnedCount}</span> : null}
                {value === 'previews' && previewState.status === 'success' && previewState.siteId === currentSiteId ? <span aria-hidden="true">{previewDocumentCount}</span> : null}
              </button>
            ))}
          </div>
        ) : null}

        <div className="palette-results" role="listbox" aria-label="Search results">
          {scope === 'previews' && previewState.siteId === currentSiteId && previewState.status === 'loading' ? (
            <p className="palette-empty" role="status">Loading previews…</p>
          ) : scope === 'previews' && previewState.siteId === currentSiteId && previewState.status === 'error' ? (
            <p className="palette-empty" role="alert">The preview list could not be loaded.</p>
          ) : sections.length === 0 ? (
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
                      className={`palette-entry${selected ? ' is-selected' : ''}`}
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
                      <span className="palette-entry-title">{highlightMatches(entry.title, entry.titleMatch)}</span>
                      {entry.subtitle ? (
                        <span className="palette-entry-subtitle">
                          {highlightMatches(entry.subtitle, entry.subtitleMatch)}
                        </span>
                      ) : null}
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
        {scope === 'previews' && previewState.status === 'success' && previewState.candidates.some(({ availability }) => availability === 'invalid') ? (
          <p className="palette-loading" role="status">Some preview records did not match their revision manifests.</p>
        ) : null}

        <footer className="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> or <kbd>Ctrl+J/K</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><code>&gt;</code> commands</span>
          <span><code>@</code> sites</span>
          <span><code>#</code> headings</span>
        </footer>
      </section>
    </div>
  )
}

function defaultSelectionIndex(query: string, context: PaletteContext, currentIndex?: SiteIndex) {
  const isEmptySiteSwitch = query.trim() === '@' && context !== 'sites' && currentIndex !== undefined
  return isEmptySiteSwitch ? -1 : 0
}

function getEmptyMessage({
  mode,
  scope,
  currentArtifact,
  siteCount,
  availableScopeCount,
}: {
  mode: 'site' | 'command' | 'heading' | 'search'
  scope: PaletteScope
  currentArtifact?: ArtifactIndexEntry
  siteCount: number
  availableScopeCount: number
}): string {
  if (mode === 'heading') {
    if (!currentArtifact) return 'Open an artifact first to search its headings.'
    if ((currentArtifact.toc?.length ?? 0) === 0) return 'This artifact has no indexed headings.'
  }

  if (mode === 'site' && siteCount === 0) return 'No sites are available.'

  if (mode === 'search' && scope === 'recent') {
    return availableScopeCount === 0
      ? 'No other recently read pages are available in this site.'
      : 'No matches in Recent. Clear the query or switch scopes.'
  }

  if (mode === 'search' && scope === 'pinned') {
    return availableScopeCount === 0
      ? 'No other pinned pages are available in this site.'
      : 'No matches in Pinned. Clear the query or switch scopes.'
  }

  if (mode === 'search' && scope === 'previews') {
    return availableScopeCount === 0
      ? 'There are no available previews for this site.'
      : 'No matches in Previews. Clear the query to see all preview documents.'
  }

  return 'Nothing matches. Try > for commands, @ for sites, or # for headings.'
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
  scope,
  commands,
  onNavigate,
  onJumpToHeading,
  scoringExperiment,
  productionScorer,
  prefilterScopeCandidates,
  previewCandidates,
}: {
  mode: 'site' | 'command' | 'heading' | 'search'
  context: PaletteContext
  term: string
  sites: SiteDiscoveryMetadata[]
  currentIndex?: SiteIndex
  currentArtifact?: ArtifactIndexEntry
  recentReads: RecentArtifactRead[]
  pinnedArtifactIds: string[]
  scope: PaletteScope
  commands: PaletteCommand[]
  onNavigate: (href: string) => void
  onJumpToHeading: (headingId: string) => void
  scoringExperiment?: PaletteScoringExperiment
  productionScorer?: PaletteProductionScorer
  prefilterScopeCandidates: boolean
  previewCandidates: PreviewCandidate[]
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
  if (scope === 'previews') {
    return buildPreviewSections(currentIndex.site.id, previewCandidates, term, onNavigate)
  }
  const pageSections = buildPageSections(
    currentIndex,
    term,
    onNavigate,
    recentReads,
    pinnedArtifactIds,
    scope,
    currentArtifact,
    scoringExperiment,
    productionScorer,
    prefilterScopeCandidates,
  )
  const includeOtherResults = scope === 'all'
  const headingEntries = includeOtherResults && term.trim() && context === 'artifact'
    ? buildHeadingEntries(currentArtifact, term, onJumpToHeading)
    : []
  const headingSection = headingEntries.length
    ? [{ title: `In ${currentArtifact?.title ?? 'this artifact'}`, entries: headingEntries }]
    : []
  const allCommandEntries = includeOtherResults ? buildCommandEntries(commands, term) : []
  const commandEntries = term.trim() ? allCommandEntries : allCommandEntries.slice(0, 3)
  const commandSection = commandEntries.length ? [{ title: 'Commands', entries: commandEntries }] : []

  return [
    ...headingSection,
    ...pageSections,
    ...commandSection,
  ]
}

function buildPreviewSections(
  siteId: string,
  candidates: PreviewCandidate[],
  term: string,
  onNavigate: (href: string) => void,
): PaletteSection[] {
  return candidates.flatMap(({ group, availability }) => {
    if (availability !== 'available' && availability !== 'unknown') return []
    const entries = group.documents.flatMap((document) => {
      const titleMatch = fuzzyMatch(document.title, term)
      const pathMatch = fuzzyMatch(document.path, term)
      if (term.trim() && !titleMatch && !pathMatch) return []
      return [{
        id: `preview:${siteId}:${group.id}:${document.path}`,
        kind: 'artifact' as const,
        title: document.title,
        subtitle: document.path,
        badge: availability === 'unknown' ? 'Availability unknown' : undefined,
        titleMatch,
        subtitleMatch: pathMatch,
        onSelect: () => onNavigate(previewRouteHref(siteId, group.headSha, document.path, group.id)),
      }]
    }).sort((left, right) => (right.titleMatch?.score ?? right.subtitleMatch?.score ?? 0) - (left.titleMatch?.score ?? left.subtitleMatch?.score ?? 0))
    if (entries.length === 0) return []
    const title = group.kind === 'pull-request'
      ? `PR #${group.id.slice(3)}`
      : `Manual preview · ${group.headSha.slice(0, 8)}`
    return [{ title, entries }]
  })
}

function buildSiteEntries(
  sites: SiteDiscoveryMetadata[],
  term: string,
  onNavigate: (href: string) => void,
): PaletteEntry[] {
  return sites.flatMap((metadata) => {
    const titleMatch = fuzzyMatch(metadata.site.title, term)
    const idMatch = fuzzyMatch(metadata.site.id, term)
    if (term.trim() && !titleMatch && !idMatch) return []
    const subtitle = `/${metadata.site.id} · ${metadata.artifactCount} artifacts`
    const subtitleMatch = idMatch ? offsetMatch(idMatch, 1) : undefined
    return [{
      entry: {
        id: `site:${metadata.site.id}`,
        kind: 'site' as const,
        title: metadata.site.title,
        subtitle,
        titleMatch,
        subtitleMatch,
        onSelect: () => onNavigate(`/${encodeURIComponent(metadata.site.id)}`),
      },
      score: Math.max(titleMatch?.score ?? 0, idMatch?.score ?? 0),
    }]
  })
    .sort((left, right) => term.trim()
      ? right.score - left.score
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
  scope: PaletteScope,
  currentArtifact?: ArtifactIndexEntry,
  scoringExperiment?: PaletteScoringExperiment,
  productionScorer?: PaletteProductionScorer,
  prefilterScopeCandidates = false,
): PaletteSection[] {
  if (!currentIndex) return []
  const query = prepareFuzzyQuery(term)
  const recentReadById = new Map(recentReads.map((read) => [read.artifactId, read] as const))
  const pinnedIds = new Set(pinnedArtifactIds)
  const cacheScope = prefilterScopeCandidates ? scope : 'all'
  const previousSearch = pageSearchCache.get(currentIndex)
  const scopeIdentityIsCurrent = !prefilterScopeCandidates
    || scope === 'all'
    || (previousSearch?.recentReads === recentReads && previousSearch.pinnedArtifactIds === pinnedArtifactIds)
  const isQueryExtension = previousSearch !== undefined
    && previousSearch.scope === cacheScope
    && scopeIdentityIsCurrent
    && query.terms.length >= previousSearch.terms.length
    && previousSearch.terms.every((previousTerm, index) => (
      query.terms[index].normalized.startsWith(previousTerm)
    ))
  let candidateOrdinals: number[] | undefined
  if (isQueryExtension) {
    candidateOrdinals = previousSearch.candidateOrdinals
  } else if (prefilterScopeCandidates && scope !== 'all') {
    candidateOrdinals = []
    for (let ordinal = 0; ordinal < currentIndex.artifacts.length; ordinal += 1) {
      const artifact = currentIndex.artifacts[ordinal]
      if (scope === 'recent' ? recentReadById.has(artifact.id) : pinnedIds.has(artifact.id)) {
        candidateOrdinals.push(ordinal)
      }
    }
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

    const isRecent = recentReadById.has(artifact.id)
    const isPinned = pinnedIds.has(artifact.id)
    if ((scope === 'recent' && !isRecent) || (scope === 'pinned' && !isPinned)) continue
    if (!term.trim() && artifact.id === currentArtifact?.id) continue

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
    scope: cacheScope,
    recentReads,
    pinnedArtifactIds,
  })
  if (!entries.length) return []
  return [{
    title: scope === 'recent' ? 'Recent pages' : scope === 'pinned' ? 'Pinned pages' : 'Pages',
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
