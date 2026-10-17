import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ArtifactIndexEntry, SiteIndex, SiteSummary } from '../domain/index'
import type { ThemeMode } from '../domain/theme'
import { artifactSourceLinks } from '../domain/source-links'
import { artifactRouteHref, searchRouteHref } from '../routing'
import type { ArtifactRowActions } from './ArtifactTree'
import { ArtifactTree, artifactMatchesFilter, type TreeStyle } from './ArtifactTree'
import { Icon } from './Icon'
import { siteCountLabel } from '../domain/site-count-label'
import { ThemeSwitcher } from './ThemeSwitcher'
import { SearchFullTextRow, SidebarFilterBar } from './PageTextSearch'

export type SidebarPageTextSearch = {
  /** Opens the full-text results page for a query. */
  onSearchFullText: (query: string) => void
}

export function Sidebar({
  id,
  index,
  sites,
  artifactPath,
  directoryPath,
  expandedPaths,
  onExpandedPathsChange,
  revealRequest,
  onOpenPalette,
  onOpenArtifact,
  onOpenDirectory,
  onOpenRoot,
  onToast,
  themeMode,
  onSetThemeMode,
  onCollapse,
  pinnedArtifactIds,
  onTogglePin,
  pageTextSearch,
  treeStyle = 'branch-guides',
  previewSection,
}: {
  id?: string
  index: SiteIndex
  sites: SiteSummary[]
  artifactPath?: string
  /** The folder whose page is open, if any: its row is highlighted and the tree expands to it. */
  directoryPath?: string
  expandedPaths: Set<string>
  onExpandedPathsChange: (update: (current: Set<string>) => Set<string>) => void
  revealRequest: { path: string; request: number } | null
  onOpenPalette: (seed: string) => void
  onOpenArtifact: (artifact: ArtifactIndexEntry) => void
  onOpenDirectory: (path: string) => void
  /** Opens the site root folder page (the overflow row of the root branch). */
  onOpenRoot?: () => void
  onToast: (message: string) => void
  themeMode: ThemeMode
  onSetThemeMode: (mode: ThemeMode) => void
  onCollapse: () => void
  pinnedArtifactIds: string[]
  onTogglePin: (artifact: ArtifactIndexEntry) => void
  /** Present only when the site publishes page text search data. */
  pageTextSearch?: SidebarPageTextSearch
  treeStyle?: TreeStyle
  /** A preview document is open (ISSUE-109): this replaces the published tree, which is not part of the preview. */
  previewSection?: ReactNode
}) {
  const [draft, setDraft] = useState('')
  const filter = draft.trim()
  const sidebarRef = useRef<HTMLElement>(null)
  const lastRevealedRequest = useRef<number | null>(null)
  const pinned = useMemo(() => {
    const artifactsById = new Map(index.artifacts.map((artifact) => [artifact.id, artifact]))
    return pinnedArtifactIds.map((id) => artifactsById.get(id)).filter((artifact): artifact is ArtifactIndexEntry => artifact !== undefined)
  }, [index.artifacts, pinnedArtifactIds])
  const currentArtifactId = artifactPath
    ? index.artifacts.find((artifact) => artifact.path === artifactPath)?.id
    : undefined

  const filterMatches = useMemo(() => {
    const query = filter.toLocaleLowerCase()
    return query ? index.artifacts.filter((artifact) => artifactMatchesFilter(artifact, query)).length : 0
  }, [index.artifacts, filter])

  function searchFullText(query: string) {
    setDraft('')
    pageTextSearch?.onSearchFullText(query)
  }

  const rowHref = (artifact: ArtifactIndexEntry) => artifactRouteHref(index.site.id, artifact.path)

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
    const ancestors = [...folderAncestors(artifactPath), ...folderPaths(directoryPath)]
    if (ancestors.length > 0) {
      onExpandedPathsChange((current) => new Set([...current, ...ancestors]))
    }
  }, [artifactPath, directoryPath, onExpandedPathsChange])

  useEffect(() => {
    if (!revealRequest || lastRevealedRequest.current === revealRequest.request) return
    if (filter) return

    const browseTree = sidebarRef.current?.querySelector('.browse-tree')
    const rows = Array.from(browseTree?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? [])
    // A folded index page has no row of its own; its folder row stands for it.
    const target = rows.find((element) => element.dataset.treePath === revealRequest.path)
      ?? rows.find((element) => element.dataset.treePath === revealRequest.path.split('/').slice(0, -1).join('/'))
    if (!target) return

    target.scrollIntoView({ block: 'nearest' })
    lastRevealedRequest.current = revealRequest.request
  }, [expandedPaths, filter, revealRequest])

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

        {pageTextSearch && !previewSection ? (
          <SidebarFilterBar
            siteTitle={index.site.title}
            draft={draft}
            onDraftChange={setDraft}
            onSearchFullText={searchFullText}
            onFocusFirstMatch={() => sidebarRef.current?.querySelector<HTMLElement>('.sidebar-body .tree-artifact')?.focus()}
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

      <nav className="sidebar-body" aria-label={previewSection ? 'Preview documents' : 'Artifacts'}>
        {previewSection ? previewSection : pageTextSearch && filter ? (
          <div className="sidebar-section filter-results">
            <div className="sidebar-section-title">
              <span className="sidebar-section-label"><Icon name="search" size={12} />Titles and paths</span>
            </div>
            {filterMatches > 0 ? (
              <ArtifactTree
                artifacts={index.artifacts}
                activePath={artifactPath}
                query={filter}
                style={treeStyle}
                view="tree"
                onOpenArtifact={onOpenArtifact}
                artifactHref={rowHref}
              />
            ) : (
              <p className="sidebar-empty">No titles or paths match “{filter}”.</p>
            )}
            <SearchFullTextRow
              query={filter}
              href={searchRouteHref(index.site.id, filter)}
              onOpen={() => searchFullText(filter)}
            />
          </div>
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
                  artifactHref={rowHref}
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
                  activeDirectoryPath={directoryPath}
                  directoryHref={(directory) => artifactRouteHref(index.site.id, directory.path)}
                  onOpenDirectory={(directory) => onOpenDirectory(directory.path)}
                  rootHref={`/${encodeURIComponent(index.site.id)}`}
                  onOpenRoot={onOpenRoot}
                  style={treeStyle}
                  view={treeStyle === 'path-list' ? 'paths' : 'tree'}
                  expandedPaths={expandedPaths}
                  onExpandedPathsChange={onExpandedPathsChange}
                  onOpenArtifact={onOpenArtifact}
                  artifactHref={rowHref}
                  getArtifactActions={getArtifactActions}
                />
              )}
            </div>
          </>
        )}
      </nav>

      <footer className="sidebar-footer">
        {previewSection ? <span className="index-date" /> : (
          <span className="index-date">
            Index generated <time dateTime={index.generatedAt}>{formatDate(index.generatedAt)}</time>
          </span>
        )}
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

function folderPaths(path?: string) {
  if (!path) return []
  const segments = path.split('/').filter(Boolean)
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)
}
