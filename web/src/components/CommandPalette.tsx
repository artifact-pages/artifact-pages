import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ArtifactIndexEntry, SiteCatalogEntry, SiteIndex } from '../domain/index'
import type { RecentArtifactRead } from '../domain/recent-reads'
import { createPaletteProductionScorer } from '../domain/palette-scoring'
import {
  buildPaletteScoringExperiment,
  isPaletteBenchmarkBuild,
  paletteScoringExperimentConfig,
} from '../domain/palette-scoring-experiment'
import type { FuzzyMatch } from '../domain/fuzzy-search'
import {
  buildSections,
  defaultSelectionIndex,
  resolveSelectedIndex,
  EMPTY_HISTORY_HINT,
  getEmptyMessage,
  nextSelectionIndex,
  paletteMode,
  type PaletteCommand,
  type PaletteContext,
  type PaletteEntry,
} from '../domain/palette-sections'
import { warmHeadingSearch } from '../domain/palette-headings'
import { Icon } from './Icon'

export type { PaletteCommand, PaletteContext } from '../domain/palette-sections'
export type { RecentArtifactRead } from '../domain/recent-reads'

const FOCUSABLE = 'input, button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

function visibleFocusables(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.getClientRects().length > 0)
}

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
  /** Opens the full-text results page for the query; present only when the site supports it. */
  onSearchPageText?: (query: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()
  const optionId = (index: number) => `${listboxId}-option-${index}`
  // The element that opened the palette, read during the first render before the input takes focus.
  const [opener] = useState(() => {
    const active = document.activeElement
    return active instanceof HTMLElement && active !== document.body ? active : null
  })
  const [query, setQuery] = useState(seed)
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
        ? (currentIndex ? 'All pages' : undefined)
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
        ? 'Search headings in all pages...'
        : context === 'sites'
          ? 'Search sites...'
          : currentIndex
            ? 'Search pages... (> commands, # headings, @ sites)'
            : 'Search pages... (> commands, @ sites)'

  const { sections, emptyHistory, onlyCurrent } = useMemo(
    () => buildSections({ mode, context, term, sites, currentIndex, currentArtifact, recentReads, pinnedArtifactIds, commands, onNavigate, onJumpToHeading, scoringExperiment, productionScorer, onSearchPageText }),
    [mode, context, term, sites, currentIndex, currentArtifact, recentReads, pinnedArtifactIds, commands, onNavigate, onJumpToHeading, scoringExperiment, productionScorer, onSearchPageText],
  )
  const entries = useMemo(() => sections.flatMap((section) => section.entries), [sections])
  const defaultIndex = useMemo(
    () => defaultSelectionIndex(query, context, currentIndex, sites.length, entries),
    [query, context, currentIndex, sites.length, entries],
  )
  const isBlank = query.trim() === ''
  // The default row follows the list while the query is blank or an unfiltered @; typed queries reset on each change.
  const entrySequence = mode === 'site' || isBlank ? JSON.stringify(entries.map(({ id }) => id)) : ''
  const blankInSite = isBlank && context !== 'sites' && currentIndex !== undefined
  const emptyMessage = getEmptyMessage({ mode, context, currentArtifact, siteCount: sites.length, blank: mode === 'search' ? blankInSite : term === '' })

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // The palette is modal: the app root is inert while it is open, so focus cannot reach the page behind.
  useEffect(() => {
    const root = document.getElementById('root')
    if (!root) return undefined
    const previous = root.inert
    root.inert = true
    return () => { root.inert = previous }
  }, [])

  // Escape, the close button and a backdrop click return focus to the opener; choosing an entry does not.
  function dismiss() {
    onClose()
    window.requestAnimationFrame(() => {
      if (opener && opener.isConnected && opener.getClientRects().length > 0) opener.focus()
    })
  }

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return
    const focusables = visibleFocusables(event.currentTarget)
    if (focusables.length === 0) return
    const first = focusables[0], last = focusables[focusables.length - 1]
    const active = document.activeElement
    if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  // Prepare other pages' headings in the background so the first keystroke stays cheap.
  useEffect(() => (currentIndex ? warmHeadingSearch(currentIndex) : undefined), [currentIndex])

  // A selection is valid only for the context, site, query and (where the list drives the default)
  // entry sequence it was made under; anything else falls back to the current default during render.
  const selectionKey = `${context}|${currentIndex?.site.id ?? ''}|${currentIndex?.generatedAt ?? ''}|${sites.length}|${query}|${entrySequence}`
  const [selection, setSelection] = useState({ key: selectionKey, index: defaultIndex })
  const selectedIndex = resolveSelectedIndex(selection, selectionKey, defaultIndex, entries.length)
  const selectIndex = (index: number) => setSelection({ key: selectionKey, index })

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
      selectIndex(nextSelectionIndex(entries, selectedIndex, 1))
    } else if (moveUp) {
      event.preventDefault()
      if (event.ctrlKey) event.stopPropagation()
      selectIndex(nextSelectionIndex(entries, selectedIndex, -1))
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
      dismiss()
    }
  }

  let entryIndex = 0

  return createPortal(
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss()
      }}
    >
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleDialogKeyDown}
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
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={entries.length > 0}
            aria-controls={entries.length > 0 ? listboxId : undefined}
            aria-activedescendant={entries[selectedIndex] ? optionId(selectedIndex) : undefined}
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
            onClick={dismiss}
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        {emptyHistory && sections.length > 0 ? <p className="palette-hint">{EMPTY_HISTORY_HINT}</p> : null}

        {sections.length === 0 ? (
          <div className="palette-results">
            <p className="palette-empty">
              {emptyMessage}
            </p>
          </div>
        ) : (
          <div className="palette-results" role="listbox" id={listboxId} aria-label="Search results">
            {sections.map((section, sectionIndex) => (
              <div className="palette-section" key={section.title} role="group" aria-labelledby={`${listboxId}-section-${sectionIndex}`}>
                <div className="palette-section-title" id={`${listboxId}-section-${sectionIndex}`}>{section.title}</div>
                {section.entries.map((entry) => {
                  const index = entryIndex++
                  const selected = index === selectedIndex
                  return (
                    <button
                      className={`palette-entry${entry.current ? ' palette-entry--current' : ''}${entry.kind === 'site' ? ' palette-entry--site' : ''}${entry.kind === 'page-text' ? ' palette-entry--page-text' : ''}${selected ? ' is-selected' : ''}`}
                      key={entry.id}
                      id={optionId(index)}
                      role="option"
                      tabIndex={-1}
                      data-palette-entry-id={entry.id}
                      aria-selected={selected}
                      aria-current={entry.current ? 'page' : undefined}
                      data-palette-current={entry.current ? 'true' : undefined}
                      data-palette-selected={selected ? 'true' : undefined}
                      onMouseMove={() => { if (index !== selectedIndex) selectIndex(index) }}
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
                      {selected ? <kbd className="palette-entry-enter" aria-hidden="true">↵</kbd> : null}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}

        {blankInSite ? (
          <p className="palette-hint">
            Type <code>&gt;</code> for commands, <code>#</code> for headings, <code>@</code> to switch sites.
            {onlyCurrent ? ' Open another page to build your recent list.' : ''}
          </p>
        ) : null}

        {loading ? <p className="palette-loading" role="status">Loading site information…</p> : null}

        <footer className="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> or <kbd>Ctrl+J/K</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          {onSearchPageText && mode === 'search' && context !== 'sites' ? <span><kbd>⌘↵</kbd> search full text</span> : null}
          <span><code>&gt;</code> commands</span>
          <span><code>@</code> sites</span>
          {currentIndex ? <span><code>#</code> headings</span> : null}
        </footer>
      </section>
    </div>,
    document.body,
  )
}

function iconForEntry(kind: PaletteEntry['kind']) {
  if (kind === 'site' || kind === 'folder') return 'folder' as const
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
