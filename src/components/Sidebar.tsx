import { useEffect, useMemo, useState } from 'react'
import type { ArtifactIndexEntry, SiteIndex, SiteSummary } from '../domain/index'
import type { ThemeMode } from '../domain/theme'
import { ArtifactTree, type TreeStyle } from './ArtifactTree'
import { Icon } from './Icon'
import { ThemeSwitcher } from './ThemeSwitcher'

export function Sidebar({
  id,
  index,
  sites,
  artifactPath,
  expandedPaths,
  onExpandedPathsChange,
  onOpenPalette,
  onOpenArtifact,
  themeMode,
  onSetThemeMode,
  onCollapse,
  treeStyle = 'branch-guides',
}: {
  id?: string
  index: SiteIndex
  sites: SiteSummary[]
  artifactPath?: string
  expandedPaths: Set<string>
  onExpandedPathsChange: (update: (current: Set<string>) => Set<string>) => void
  onOpenPalette: (seed: string) => void
  onOpenArtifact: (artifact: ArtifactIndexEntry) => void
  themeMode: ThemeMode
  onSetThemeMode: (mode: ThemeMode) => void
  onCollapse: () => void
  treeStyle?: TreeStyle
}) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const recent = useMemo(
    () => [...index.artifacts]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 4),
    [index.artifacts],
  )
  const matchCount = index.artifacts.filter((artifact) => matches(artifact, normalizedQuery)).length

  useEffect(() => {
    const ancestors = folderAncestors(artifactPath)
    if (ancestors.length > 0) {
      onExpandedPathsChange((current) => new Set([...current, ...ancestors]))
    }
  }, [artifactPath, onExpandedPathsChange])

  return (
    <aside id={id} className={`sidebar-panel tree-style-${treeStyle}`} aria-label={`${index.site.title} navigation`}>
      <div className="sidebar-top">
        <div className="sidebar-top-row">
          <button
            className="site-switcher"
            id="site-switcher"
            title="Switch site"
            aria-label={`Switch site. Current site: ${index.site.title}`}
            onClick={(event) => {
              event.currentTarget.focus()
              onOpenPalette('@')
            }}
          >
            <span className="site-mark site-mark-small" aria-hidden="true">
              {index.site.title.slice(0, 1).toUpperCase()}
            </span>
            <span className="site-switcher-name">{index.site.title}</span>
            <span className="site-switcher-hint">{sites.length || 1}</span>
            <Icon name="chevron" size={12} />
          </button>
          <button
            className="icon-button sidebar-collapse-trigger"
            id="sidebar-collapse-trigger"
            title="Collapse sidebar (⌘ B)"
            aria-label="Collapse sidebar"
            aria-controls={id}
            aria-expanded="true"
            onClick={onCollapse}
          >
            <Icon name="sidebar" size={16} />
          </button>
        </div>

        <div className="sidebar-filter">
          <Icon name="search" size={14} />
          <input
            aria-label="Filter this site"
            placeholder="Filter this site"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('')
                event.currentTarget.blur()
              } else if (event.key === 'Enter') {
                const first = index.artifacts.find((artifact) => matches(artifact, normalizedQuery))
                if (first) onOpenArtifact(first)
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className="filter-clear"
              aria-label="Clear filter"
              onClick={() => setQuery('')}
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
          <button
            type="button"
            className="sidebar-palette-trigger"
            aria-label="Open command palette (⌘ K)"
            aria-keyshortcuts="Meta+K Control+K"
            title="Open command palette (⌘ K)"
            onClick={(event) => {
              event.currentTarget.focus()
              onOpenPalette('')
            }}
          >
            <kbd>⌘ K</kbd>
          </button>
        </div>
      </div>

      <nav className="sidebar-body" aria-label="Artifacts">
        {normalizedQuery ? (
          <div className="sidebar-section">
            <div className="sidebar-section-title">
              <span className="sidebar-section-label"><Icon name="search" size={12} />Matches</span>
              <span className="mono">{matchCount}</span>
            </div>
            {matchCount === 0 ? (
              <p className="sidebar-empty">
                Nothing in {index.site.title} matches.<br />
                <span>Press ⌘ K, then @, to find another site.</span>
              </p>
            ) : (
              <ArtifactTree
                artifacts={index.artifacts}
                activePath={artifactPath}
                query={normalizedQuery}
                style={treeStyle}
                view={treeStyle === 'path-list' ? 'paths' : 'tree'}
                expandedPaths={expandedPaths}
                onExpandedPathsChange={onExpandedPathsChange}
                onOpenArtifact={onOpenArtifact}
              />
            )}
          </div>
        ) : (
          <>
            <div className="sidebar-section">
              <div className="sidebar-section-title">
                <span className="sidebar-section-label"><Icon name="clock" size={12} />Recently updated</span>
                <span className="mono">{recent.length}</span>
              </div>
              {recent.length === 0 ? (
                <p className="sidebar-empty">No artifacts have been published yet.</p>
              ) : (
                <ArtifactTree
                  artifacts={recent}
                  activePath={artifactPath}
                  style={treeStyle}
                  view="recent"
                  onOpenArtifact={onOpenArtifact}
                />
              )}
            </div>
            <div className="sidebar-section browse-tree">
              <div className="sidebar-section-title">
                <span className="sidebar-section-label"><Icon name="tree" size={12} />Browse</span>
              </div>
              {index.artifacts.length === 0 ? (
                <p className="sidebar-empty">No artifacts have been published yet.</p>
              ) : (
                <ArtifactTree
                  artifacts={index.artifacts}
                  activePath={artifactPath}
                  style={treeStyle}
                  view={treeStyle === 'path-list' ? 'paths' : 'tree'}
                  expandedPaths={expandedPaths}
                  onExpandedPathsChange={onExpandedPathsChange}
                  onOpenArtifact={onOpenArtifact}
                />
              )}
            </div>
          </>
        )}
      </nav>

      <footer className="sidebar-footer">
        <span className="index-date">
          Index updated <time dateTime={index.generatedAt}>{formatDate(index.generatedAt)}</time>
        </span>
        <ThemeSwitcher
          buttonClassName="icon-button theme-toggle"
          mode={themeMode}
          onChange={onSetThemeMode}
        />
      </footer>
    </aside>
  )
}

function matches(artifact: ArtifactIndexEntry, query: string) {
  if (!query) return true
  return `${artifact.title} ${artifact.path} ${artifact.filename ?? ''}`.toLocaleLowerCase().includes(query)
}

function folderAncestors(path?: string) {
  if (!path) return []
  const segments = path.split('/').filter(Boolean).slice(0, -1)
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)
}
