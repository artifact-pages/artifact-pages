import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThemeMode } from '../domain/theme'
import { artifactCountLabel } from '../domain/site-count-label'
import { hasSiteDiscoveryMetadata, type SiteCatalogEntry } from '../domain/index'
import { summarizeSiteCounts, type FolderCount } from '../domain/site-folder-counts'
import { useSiteFolderCounts } from '../data/use-site-folder-counts'
import { CommandPalette, type PaletteCommand } from './CommandPalette'
import { Icon } from './Icon'
import { followInApp } from './spa-link'
import { pageTitle, usePageTitle } from './usePageTitle'

// A short list is easier to scan than to search; ⌘ K still opens the palette.
const SEARCH_TRIGGER_MINIMUM_SITE_COUNT = 9

export function SitePicker({
  sites,
  onNavigate,
  themeMode = 'system',
  onSetThemeMode,
  folderCounts: folderCountsOverride,
}: {
  sites: SiteCatalogEntry[]
  onNavigate: (href: string) => void
  themeMode?: ThemeMode
  onSetThemeMode?: (mode: ThemeMode) => void
  /** Per-top-level-folder counts by site ID; when given, no site index is fetched. */
  folderCounts?: Record<string, FolderCount[]>
}) {
  usePageTitle(pageTitle())
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paletteReturnFocus = useRef<HTMLElement | null>(null)
  const sortedSites = [...sites].sort((left, right) => left.site.title.localeCompare(right.site.title))
  const folderCounts = useSiteFolderCounts(sortedSites, folderCountsOverride)
  const commands: PaletteCommand[] = [
    {
      title: 'Use light theme',
      subtitle: themeMode === 'light' ? 'Current' : undefined,
      onSelect: () => onSetThemeMode?.('light'),
    },
    {
      title: 'Use dark theme',
      subtitle: themeMode === 'dark' ? 'Current' : undefined,
      onSelect: () => onSetThemeMode?.('dark'),
    },
    {
      title: 'Use system theme',
      subtitle: themeMode === 'system' ? 'Current' : undefined,
      onSelect: () => onSetThemeMode?.('system'),
    },
  ]

  const openPalette = useCallback(() => {
    const activeElement = document.activeElement
    paletteReturnFocus.current = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement
      : null
    setPaletteOpen(true)
  }, [])

  const closePalette = useCallback(() => {
    setPaletteOpen(false)
    window.requestAnimationFrame(() => {
      const target = paletteReturnFocus.current
      if (target?.isConnected && target.getClientRects().length > 0) target.focus()
      else document.querySelector<HTMLElement>('.site-picker-search-trigger')?.focus()
    })
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        if (paletteOpen) closePalette()
        else openPalette()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [paletteOpen, closePalette, openPalette])

  return (
    <>
      <main className="site-picker-page">
        <div className="site-picker-content">
          <p className="brand-label"><span className="brand-mark">G</span> Git Artifact Pages</p>
          <p className="eyebrow">Artifact library</p>
          <h1>Choose a site</h1>
          <p className="site-picker-lede">Browse published artifacts from the sites available in this environment.</p>
          {sortedSites.length >= SEARCH_TRIGGER_MINIMUM_SITE_COUNT ? <button
            type="button"
            className="site-picker-search-trigger"
            aria-label="Search sites"
            aria-keyshortcuts="Meta+K Control+K"
            title="Search sites (⌘ K)"
            onClick={openPalette}
          >
            <Icon name="search" size={16} />
            <span className="site-picker-search-desktop-label">Search sites...</span>
            <span className="site-picker-search-mobile-label">Tap to search sites</span>
            <kbd>⌘ K</kbd>
          </button> : null}
          {sortedSites.length === 0 ? (
            <p className="empty-note">No registered sites were found.</p>
          ) : (
            <div className="site-picker-list">
              {sortedSites.map((entry) => (
                <a
                  className="site-picker-row"
                  key={entry.site.id}
                  href={`/${encodeURIComponent(entry.site.id)}`}
                  onClick={(event) => followInApp(event, () => onNavigate(`/${encodeURIComponent(entry.site.id)}`))}
                >
                  <span className="site-mark" aria-hidden="true">{entry.site.title.slice(0, 1).toUpperCase()}</span>
                  <span className="site-picker-main">
                    <strong>{entry.site.title}</strong>
                    {entry.site.description?.trim() ? (
                      <span className="site-picker-description">{entry.site.description}</span>
                    ) : null}
                    <FolderCountChips entry={entry} folders={folderCounts[entry.site.id]} />
                    <span className="site-picker-meta">
                      <span className="mono">/{entry.site.id}</span>
                      <span className="site-picker-meta-separator" aria-hidden="true">·</span>
                      <span>{catalogStatusLabel(entry, folderCounts[entry.site.id])}</span>
                      {hasSiteDiscoveryMetadata(entry) ? (
                        <span className="site-picker-start">Start reading <Icon name="arrow" size={12} /></span>
                      ) : null}
                    </span>
                  </span>
                  {hasSiteDiscoveryMetadata(entry) && entry.fullTextUrl ? (
                    <span className="site-picker-badge" title="Page text can be searched in this site">Page text search</span>
                  ) : null}
                  {hasSiteDiscoveryMetadata(entry) ? null : <Icon name="arrow" size={16} />}
                </a>
              ))}
            </div>
          )}
        </div>
      </main>
      {paletteOpen ? (
        <CommandPalette
          seed=""
          context="sites"
          sites={sites}
          commands={commands}
          loading={false}
          onClose={closePalette}
          onNavigate={onNavigate}
          onJumpToHeading={() => undefined}
        />
      ) : null}
    </>
  )
}

function FolderCountChips({ entry, folders }: { entry: SiteCatalogEntry; folders?: FolderCount[] }) {
  if (!hasSiteDiscoveryMetadata(entry)) return null
  const summary = summarizeSiteCounts(entry.artifactCount, folders)
  if (summary.kind !== 'folders') return null
  return (
    <span className="site-picker-folders" role="group" aria-label="Pages per top-level folder">
      {summary.folders.map(({ folder, count }) => (
        <span className="site-picker-folder" key={folder}><b>{folder}</b> {count}</span>
      ))}
    </span>
  )
}

function catalogStatusLabel(entry: SiteCatalogEntry, folders?: FolderCount[]) {
  if (hasSiteDiscoveryMetadata(entry)) {
    const summary = summarizeSiteCounts(entry.artifactCount, folders)
    const updated = `updated ${formatDate(entry.generatedAt)}`
    if (summary.kind === 'folders') return updated
    const total = artifactCountLabel(summary.total)
    return `${summary.folderCount ? `${total} in ${summary.folderCount} folders` : total} · ${updated}`
  }
  if (entry.status === 'not-published') return 'Registered · not published yet'
  if (entry.status === 'needs-republish') return 'Registered · needs to be republished'
  return 'Registered · details unavailable'
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)
}
