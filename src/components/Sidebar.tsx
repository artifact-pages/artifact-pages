import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactIndexEntry, SiteIndex, SiteSummary } from '../domain/index'
import type { ThemeMode } from '../domain/theme'
import { artifactSourceLinks } from '../domain/source-links'
import { artifactRouteHref } from '../routing'
import type { ArtifactRowActions } from './ArtifactTree'
import { ArtifactTree, type TreeStyle } from './ArtifactTree'
import { Icon } from './Icon'
import { ThemeSwitcher } from './ThemeSwitcher'

const EMPTY_PINNED_IDS: string[] = []

export function Sidebar({
  id,
  index,
  sites,
  artifactPath,
  expandedPaths,
  onExpandedPathsChange,
  revealRequest,
  onOpenPalette,
  onOpenArtifact,
  onToast,
  themeMode,
  onSetThemeMode,
  onCollapse,
  onPinnedIdsChange,
  treeStyle = 'branch-guides',
}: {
  id?: string
  index: SiteIndex
  sites: SiteSummary[]
  artifactPath?: string
  expandedPaths: Set<string>
  onExpandedPathsChange: (update: (current: Set<string>) => Set<string>) => void
  revealRequest: { path: string; request: number } | null
  onOpenPalette: (seed: string) => void
  onOpenArtifact: (artifact: ArtifactIndexEntry) => void
  onToast: (message: string) => void
  themeMode: ThemeMode
  onSetThemeMode: (mode: ThemeMode) => void
  onCollapse: () => void
  onPinnedIdsChange?: (ids: string[]) => void
  treeStyle?: TreeStyle
}) {
  const [query, setQuery] = useState('')
  const [pinnedBySite, setPinnedBySite] = useState<Record<string, string[]>>(readPinnedArtifacts)
  const sidebarRef = useRef<HTMLElement>(null)
  const lastRevealedRequest = useRef<number | null>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const recent = useMemo(
    () => [...index.artifacts]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 4),
    [index.artifacts],
  )
  const pinnedIds = pinnedBySite[index.site.id] ?? EMPTY_PINNED_IDS
  const pinned = useMemo(() => {
    const artifactsById = new Map(index.artifacts.map((artifact) => [artifact.id, artifact]))
    return pinnedIds.map((id) => artifactsById.get(id)).filter((artifact): artifact is ArtifactIndexEntry => artifact !== undefined)
  }, [index.artifacts, pinnedIds])
  const matchCount = index.artifacts.filter((artifact) => matches(artifact, normalizedQuery)).length

  useEffect(() => {
    onPinnedIdsChange?.(pinnedIds)
  }, [onPinnedIdsChange, pinnedIds])

  useEffect(() => {
    try {
      window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(pinnedBySite))
    } catch {
      // Pinning remains available for this session if browser storage is disabled.
    }
  }, [pinnedBySite])

  function togglePin(artifact: ArtifactIndexEntry) {
    const willPin = !pinnedIds.includes(artifact.id)
    setPinnedBySite((current) => {
      const sitePins = current[index.site.id] ?? []
      const nextPins = willPin
        ? [...sitePins, artifact.id]
        : sitePins.filter((id) => id !== artifact.id)
      return { ...current, [index.site.id]: nextPins }
    })
    onToast(willPin ? `Pinned ${artifact.title}.` : `Unpinned ${artifact.title}.`)
  }

  async function copyArtifactLink(artifact: ArtifactIndexEntry) {
    const href = new URL(artifactRouteHref(index.site.id, artifact.path), window.location.origin).href
    if (!navigator.clipboard?.writeText) {
      onToast('Clipboard access is unavailable.')
      return
    }
    try {
      await navigator.clipboard.writeText(href)
      onToast('Link copied to clipboard.')
    } catch {
      onToast('Clipboard access is unavailable.')
    }
  }

  function getArtifactActions(artifact: ArtifactIndexEntry): ArtifactRowActions {
    const sourceLinks = artifactSourceLinks(artifact)
    return {
      pinned: pinnedIds.includes(artifact.id),
      sourceUrl: sourceLinks.sourceUrl,
      historyUrl: sourceLinks.historyUrl,
      rawUrl: safeRawArtifactUrl(artifact.artifactUrl),
      onTogglePin: () => togglePin(artifact),
      onCopyLink: () => void copyArtifactLink(artifact),
    }
  }

  useEffect(() => {
    const ancestors = folderAncestors(artifactPath)
    if (ancestors.length > 0) {
      onExpandedPathsChange((current) => new Set([...current, ...ancestors]))
    }
  }, [artifactPath, onExpandedPathsChange])

  useEffect(() => {
    if (!revealRequest || lastRevealedRequest.current === revealRequest.request) return
    if (query) {
      setQuery('')
      return
    }

    const browseTree = sidebarRef.current?.querySelector('.browse-tree')
    const target = Array.from(browseTree?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? [])
      .find((element) => element.dataset.treePath === revealRequest.path)
    if (!target) return

    target.scrollIntoView({ block: 'nearest' })
    lastRevealedRequest.current = revealRequest.request
  }, [expandedPaths, query, revealRequest])

  return (
    <aside ref={sidebarRef} id={id} className={`sidebar-panel sidebar-panel--refined tree-style-${treeStyle}`} aria-label={`${index.site.title} navigation`}>
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
                getArtifactActions={getArtifactActions}
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
                  getArtifactActions={getArtifactActions}
                />
              )}
            </div>
            {pinned.length > 0 ? (
              <div className="sidebar-section pinned-tree">
                <div className="sidebar-section-title">
                  <span className="sidebar-section-label"><Icon name="pin" size={12} />Pinned</span>
                </div>
                <ArtifactTree
                  artifacts={pinned}
                  activePath={artifactPath}
                  style={treeStyle}
                  view="recent"
                  onOpenArtifact={onOpenArtifact}
                  getArtifactActions={getArtifactActions}
                />
              </div>
            ) : null}
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
                  getArtifactActions={getArtifactActions}
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

const PINNED_STORAGE_KEY = 'git-artifact-pages:pinned-artifacts:v1'

function readPinnedArtifacts(): Record<string, string[]> {
  try {
    const value = window.localStorage.getItem(PINNED_STORAGE_KEY)
    if (!value) return {}
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).flatMap(([siteId, ids]) => {
      if (!Array.isArray(ids)) return []
      return [[siteId, ids.filter((id): id is string => typeof id === 'string')]]
    }))
  } catch {
    return {}
  }
}

function safeRawArtifactUrl(value: string) {
  try {
    const url = new URL(value, window.location.origin)
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/_artifacts/')) return undefined
    return url.href
  } catch {
    return undefined
  }
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
