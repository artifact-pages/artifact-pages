import { useEffect, useState } from 'react'
import type { ThemeMode } from '../domain/theme'
import { hasSiteDiscoveryMetadata, type SiteCatalogEntry } from '../domain/index'
import { CommandPalette, type PaletteCommand } from './CommandPalette'
import { Icon } from './Icon'

export function SitePicker({
  sites,
  onNavigate,
  themeMode = 'system',
  onSetThemeMode,
}: {
  sites: SiteCatalogEntry[]
  onNavigate: (href: string) => void
  themeMode?: ThemeMode
  onSetThemeMode?: (mode: ThemeMode) => void
}) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const sortedSites = [...sites].sort((left, right) => left.site.title.localeCompare(right.site.title))
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <>
      <main className="site-picker-page">
        <div className="site-picker-content">
          <p className="brand-label"><span className="brand-mark">G</span> Git Artifact Pages</p>
          <p className="eyebrow">Artifact library</p>
          <h1>Choose a site</h1>
          <p className="site-picker-lede">Browse published artifacts from the sites available in this environment.</p>
          <button
            type="button"
            className="site-picker-search-trigger"
            aria-label="Search sites"
            aria-keyshortcuts="Meta+K Control+K"
            title="Search sites (⌘ K)"
            onClick={() => setPaletteOpen(true)}
          >
            <Icon name="search" size={16} />
            <span className="site-picker-search-desktop-label">Search sites...</span>
            <span className="site-picker-search-mobile-label">Tap to search sites</span>
            <kbd>⌘ K</kbd>
          </button>
          {sortedSites.length === 0 ? (
            <p className="empty-note">No registered sites were found.</p>
          ) : (
            <div className="site-picker-list">
              {sortedSites.map((entry) => (
                <button
                  className="site-picker-row"
                  key={entry.site.id}
                  onClick={() => onNavigate(`/${encodeURIComponent(entry.site.id)}`)}
                >
                  <span className="site-mark" aria-hidden="true">{entry.site.title.slice(0, 1).toUpperCase()}</span>
                  <span className="site-picker-main">
                    <strong>{entry.site.title}</strong>
                    <span className="mono">/{entry.site.id}</span>
                  </span>
                  <span className="site-picker-count">{catalogStatusLabel(entry)}</span>
                  <Icon name="arrow" size={16} />
                </button>
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
          onClose={() => setPaletteOpen(false)}
          onNavigate={onNavigate}
          onJumpToHeading={() => undefined}
        />
      ) : null}
    </>
  )
}

function catalogStatusLabel(entry: SiteCatalogEntry) {
  if (hasSiteDiscoveryMetadata(entry)) {
    return `${entry.artifactCount} artifacts · updated ${formatDate(entry.generatedAt)}`
  }
  if (entry.status === 'not-published') return 'Registered · not published yet'
  return 'Registered · details unavailable'
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)
}
