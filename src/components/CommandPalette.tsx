import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactIndexEntry, SiteDiscoveryMetadata, SiteIndex, TocEntry } from '../domain/index'
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

type PaletteEntry = {
  id: string
  kind: 'artifact' | 'site' | 'command' | 'heading'
  title: string
  subtitle?: string
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
type PageSearchCache = { terms: string[]; candidates: ArtifactIndexEntry[] }
const preparedArtifactText = new WeakMap<ArtifactIndexEntry, PreparedArtifactText>()
const pageSearchCache = new WeakMap<SiteIndex, PageSearchCache>()

export function CommandPalette({
  seed,
  sites,
  context,
  currentIndex,
  currentArtifact,
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
  commands: PaletteCommand[]
  loading: boolean
  onClose: () => void
  onNavigate: (href: string) => void
  onJumpToHeading: (headingId: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(seed)
  const [selectedIndex, setSelectedIndex] = useState(0)
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
          : 'Search pages, headings, and commands...'

  const sections = useMemo(
    () => buildSections({ mode, context, term, sites, currentIndex, currentArtifact, commands, onNavigate, onJumpToHeading }),
    [mode, context, term, sites, currentIndex, currentArtifact, commands, onNavigate, onJumpToHeading],
  )
  const entries = sections.flatMap((section) => section.entries)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query, context])

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
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
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

        <div className="palette-results" role="listbox" aria-label="Search results">
          {sections.length === 0 ? (
            <p className="palette-empty">
              {mode === 'heading' && !currentArtifact
                ? 'Open an artifact first to search its headings.'
                : mode === 'heading' && (currentArtifact?.toc?.length ?? 0) === 0
                  ? 'This artifact has no indexed headings.'
                  : mode === 'site' && sites.length === 0
                    ? 'No sites are available.'
                : 'Nothing matches. Try > for commands, @ for sites, or # for headings.'}
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
          <span><code>&gt;</code> commands</span>
          <span><code>@</code> sites</span>
          <span><code>#</code> headings</span>
        </footer>
      </section>
    </div>
  )
}

function buildSections({
  mode,
  context,
  term,
  sites,
  currentIndex,
  currentArtifact,
  commands,
  onNavigate,
  onJumpToHeading,
}: {
  mode: 'site' | 'command' | 'heading' | 'search'
  context: PaletteContext
  term: string
  sites: SiteDiscoveryMetadata[]
  currentIndex?: SiteIndex
  currentArtifact?: ArtifactIndexEntry
  commands: PaletteCommand[]
  onNavigate: (href: string) => void
  onJumpToHeading: (headingId: string) => void
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

  if (!term.trim()) {
    if (context === 'sites') {
      const siteEntries = buildSiteEntries(sites, '', onNavigate)
      const commandEntries = buildCommandEntries(commands, '').slice(0, 3)
      return [
        ...(siteEntries.length ? [{ title: 'Sites', entries: siteEntries }] : []),
        ...(commandEntries.length ? [{ title: 'Commands', entries: commandEntries }] : []),
      ]
    }

    if (!currentIndex) return []
    const recent = [...currentIndex.artifacts]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 4)
      .map((artifact) => artifactEntry(currentIndex, artifact, onNavigate))
    const commandEntries = buildCommandEntries(commands, '').slice(0, 3)
    return [
      ...(recent.length ? [{ title: 'Recently updated', entries: recent }] : []),
      ...(commandEntries.length ? [{ title: 'Commands', entries: commandEntries }] : []),
    ]
  }

  const pageSections = buildPageSections(currentIndex, term, onNavigate)
  const headingEntries = context === 'artifact'
    ? buildHeadingEntries(currentArtifact, term, onJumpToHeading)
    : []
  const headingSection = headingEntries.length
    ? [{ title: `In ${currentArtifact?.title ?? 'this artifact'}`, entries: headingEntries }]
    : []
  const commandEntries = buildCommandEntries(commands, term)
  const commandSection = commandEntries.length ? [{ title: 'Commands', entries: commandEntries }] : []

  if (context === 'sites') {
    const siteEntries = buildSiteEntries(sites, term, onNavigate)
    const siteSection = siteEntries.length ? [{ title: 'Sites', entries: siteEntries }] : []
    return [...siteSection, ...commandSection]
  }

  return [
    ...headingSection,
    ...pageSections,
    ...commandSection,
  ]
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
): PaletteSection[] {
  if (!currentIndex) return []
  const query = prepareFuzzyQuery(term)
  const previousSearch = pageSearchCache.get(currentIndex)
  const isQueryExtension = previousSearch !== undefined
    && query.terms.length >= previousSearch.terms.length
    && previousSearch.terms.every((previousTerm, index) => (
      query.terms[index].normalized.startsWith(previousTerm)
    ))
  const artifactsToSearch = isQueryExtension
    ? previousSearch.candidates
    : currentIndex.artifacts
  const entries: Array<{ artifact: ArtifactIndexEntry; score: number }> = []
  const matchingArtifacts: ArtifactIndexEntry[] = []
  for (const artifact of artifactsToSearch) {
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
    if (titleScore === undefined && pathScore === undefined) continue
    matchingArtifacts.push(artifact)

    const score = (titleScore ?? 0) * 1.12 + (pathScore ?? 0)
    let position = 0
    while (position < entries.length && entries[position].score >= score) position += 1
    if (position < 8) {
      entries.splice(position, 0, { artifact, score })
      if (entries.length > 8) entries.pop()
    }
  }
  pageSearchCache.set(currentIndex, {
    terms: query.terms.map(({ normalized }) => normalized),
    candidates: matchingArtifacts,
  })
  if (!entries.length) return []
  return [{
    title: `Pages in ${currentIndex.site.title}`,
    entries: entries.map(({ artifact }) => (
      artifactEntry(
        currentIndex,
        artifact,
        onNavigate,
        fuzzyMatch(artifact.title, term),
        fuzzyMatch(artifact.path, term),
      )
    )),
  }]
}

function artifactEntry(
  index: SiteIndex,
  artifact: ArtifactIndexEntry,
  onNavigate: (href: string) => void,
  titleMatch?: FuzzyMatch,
  pathMatch?: FuzzyMatch,
): PaletteEntry {
  return {
    id: `artifact:${index.site.id}:${artifact.id}`,
    kind: 'artifact',
    title: artifact.title,
    subtitle: artifact.path,
    titleMatch,
    subtitleMatch: pathMatch,
    onSelect: () => onNavigate(artifactRouteHref(index.site.id, artifact.path)),
  }
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
