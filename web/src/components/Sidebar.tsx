import { useEffect, useMemo, useRef, useState } from 'react'
import type { FullTextHit } from '../data/fulltext'
import type { ArtifactIndexEntry, SiteIndex, SiteSummary } from '../domain/index'
import type { ThemeMode } from '../domain/theme'
import { artifactSourceLinks } from '../domain/source-links'
import { artifactRouteHref } from '../routing'
import type { ArtifactRowActions } from './ArtifactTree'
import { ArtifactTree, type TreeStyle } from './ArtifactTree'
import { Icon } from './Icon'
import { siteCountLabel } from '../domain/site-count-label'
import { ThemeSwitcher } from './ThemeSwitcher'
import { PAGE_TEXT_SEARCH_INPUT_ID, PageTextSearchBar, PageTextSearchResults } from './PageTextSearch'
import type { PageTextSearchState } from './usePageTextSearch'

export type SidebarPageTextSearch = {
  committedQuery: string
  state: PageTextSearchState
  onCommit: (query: string) => void
  onClear: () => void
  onRetry: () => void
  onLoadMore: () => void
  onOpenHit: (hit: FullTextHit) => void
}

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
  pinnedArtifactIds,
  onTogglePin,
  pageTextSearch,
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
  pinnedArtifactIds: string[]
  onTogglePin: (artifact: ArtifactIndexEntry) => void
  /** Present only when the site publishes page text search data. */
  pageTextSearch?: SidebarPageTextSearch
  treeStyle?: TreeStyle
}) {
  const committedQuery = pageTextSearch?.committedQuery ?? ''
  const [draft, setDraft] = useState(committedQuery)
  const sidebarRef = useRef<HTMLElement>(null)
  const resultListRef = useRef<HTMLDivElement>(null)
  const lastRevealedRequest = useRef<number | null>(null)
  const pinned = useMemo(() => {
    const artifactsById = new Map(index.artifacts.map((artifact) => [artifact.id, artifact]))
    return pinnedArtifactIds.map((id) => artifactsById.get(id)).filter((artifact): artifact is ArtifactIndexEntry => artifact !== undefined)
  }, [index.artifacts, pinnedArtifactIds])
  const currentArtifactId = artifactPath
    ? index.artifacts.find((artifact) => artifact.path === artifactPath)?.id
    : undefined

  // The URL owns the committed query; the field follows it after back/forward or a palette hand-off.
  useEffect(() => {
    setDraft(committedQuery)
  }, [committedQuery])

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
      pinned: pinnedArtifactIds.includes(artifact.id),
      sourceUrl: sourceLinks.sourceUrl,
      historyUrl: sourceLinks.historyUrl,
      rawUrl: safeRawArtifactUrl(artifact.artifactUrl),
      onTogglePin: () => onTogglePin(artifact),
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
    if (committedQuery) return

    const browseTree = sidebarRef.current?.querySelector('.browse-tree')
    const target = Array.from(browseTree?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? [])
      .find((element) => element.dataset.treePath === revealRequest.path)
    if (!target) return

    target.scrollIntoView({ block: 'nearest' })
    lastRevealedRequest.current = revealRequest.request
  }, [expandedPaths, committedQuery, revealRequest])

  const siteCount = sites.length
  const countLabel = siteCountLabel(siteCount)

  return (
    <aside ref={sidebarRef} id={id} className={`sidebar-panel sidebar-panel--refined tree-style-${treeStyle}`} aria-label={`${index.site.title} navigation`}>
      <div className="sidebar-top">
        <div className="sidebar-top-row">
          <button
            className="site-switcher"
            id="site-switcher"
            title={`Switch site — ${countLabel}`}
            aria-label={`Switch site. Current site: ${index.site.title}. ${countLabel}`}
            onClick={(event) => {
              event.currentTarget.focus()
              onOpenPalette('@')
            }}
          >
            <span className="site-mark site-mark-small" aria-hidden="true">
              {index.site.title.slice(0, 1).toUpperCase()}
            </span>
            <span className="site-switcher-name">{index.site.title}</span>
            <span className="site-switcher-hint" aria-hidden="true">{siteCount}</span>
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

        {pageTextSearch ? (
          <PageTextSearchBar
            siteTitle={index.site.title}
            draft={draft}
            committedQuery={committedQuery}
            onDraftChange={setDraft}
            onCommit={pageTextSearch.onCommit}
            onClear={() => {
              setDraft('')
              pageTextSearch.onClear()
            }}
            onFocusResults={() => resultListRef.current?.querySelector<HTMLElement>('[data-text-search-item="hit"]')?.focus()}
          />
        ) : (
          <button
            type="button"
            className="sidebar-palette-trigger sidebar-palette-trigger--wide"
            aria-label={`Jump to a page in ${index.site.title}`}
            aria-keyshortcuts="Meta+K Control+K"
            title={`Jump to a page in ${index.site.title} (⌘ K)`}
            onClick={(event) => {
              event.currentTarget.focus()
              onOpenPalette('')
            }}
          >
            <Icon name="search" size={14} />
            <span className="sidebar-palette-label">Jump to a page…</span>
            <kbd>⌘ K</kbd>
          </button>
        )}
      </div>

      <nav className="sidebar-body" aria-label="Artifacts">
        {pageTextSearch && committedQuery ? (
          <PageTextSearchResults
            index={index}
            state={pageTextSearch.state}
            committedQuery={committedQuery}
            draft={draft}
            currentArtifactId={currentArtifactId}
            listRef={resultListRef}
            onOpen={pageTextSearch.onOpenHit}
            onRetry={pageTextSearch.onRetry}
            onLoadMore={pageTextSearch.onLoadMore}
            onFocusInput={() => document.getElementById(PAGE_TEXT_SEARCH_INPUT_ID)?.focus()}
          />
        ) : (
          <>
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
          Index generated <time dateTime={index.generatedAt}>{formatDate(index.generatedAt)}</time>
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

function safeRawArtifactUrl(value: string) {
  try {
    const url = new URL(value, window.location.origin)
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/_artifacts/')) return undefined
    return url.href
  } catch {
    return undefined
  }
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
