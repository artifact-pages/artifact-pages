import { SiteMenu } from './SiteMenu'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ArtifactIndexEntry, SiteIndex, SiteSummary } from '../domain/index'
import type { ThemeMode } from '../domain/theme'
import { artifactSourceLinks } from '../domain/source-links'
import { artifactRouteHref } from '../routing'
import type { ArtifactRowActions } from './ArtifactTree'
import { ArtifactTree, type TreeStyle } from './ArtifactTree'
import { Icon } from './Icon'
import { ThemeSwitcher } from './ThemeSwitcher'

export type SidebarPageTextSearch = {
  /** Opens the full-text results page for a query. */
  onSearchFullText: (query: string) => void
}

export function Sidebar({
  id,
  visible = true,
  navigationKey,
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
  onAllSites,
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
  visible?: boolean
  navigationKey?: string
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
  onAllSites?: () => void
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
  const [pinsOpen, setPinsOpen] = useState(true)
  const pinnedId = useId()
  const sidebarRef = useRef<HTMLElement>(null)
  const lastRevealedRequest = useRef<number | null>(null)
  const pinned = useMemo(() => {
    const artifactsById = new Map(index.artifacts.map((artifact) => [artifact.id, artifact]))
    return pinnedArtifactIds.map((id) => artifactsById.get(id)).filter((artifact): artifact is ArtifactIndexEntry => artifact !== undefined)
  }, [index.artifacts, pinnedArtifactIds])
  const currentArtifactId = artifactPath
    ? index.artifacts.find((artifact) => artifact.path === artifactPath)?.id
    : undefined

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

    const browseTree = sidebarRef.current?.querySelector('.browse-tree')
    const rows = Array.from(browseTree?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? [])
    // A folded index page has no row of its own; its folder row stands for it.
    const target = rows.find((element) => element.dataset.treePath === revealRequest.path)
      ?? rows.find((element) => element.dataset.treePath === revealRequest.path.split('/').slice(0, -1).join('/'))
    if (!target) return

    target.scrollIntoView({ block: 'nearest' })
    lastRevealedRequest.current = revealRequest.request
  }, [expandedPaths, revealRequest])


  return (
    <aside ref={sidebarRef} id={id} className={`sidebar-panel sidebar-panel--refined tree-style-${treeStyle}`} aria-label={`${index.site.title} navigation`}>
      <div className="sidebar-top">
        <div className="sidebar-top-row">
          <SiteMenu dismissKey={`${navigationKey}:${visible}`} homeHref={`/${encodeURIComponent(index.site.id)}`} title={index.site.title} count={sites.length}
            onHome={() => onOpenRoot?.()} onSwitch={() => onOpenPalette('@')} onAllSites={() => onAllSites?.()} />
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
      </div>

      <nav className="sidebar-body" aria-label={previewSection ? 'Preview documents' : 'Artifacts'}>
        {previewSection ? previewSection : (
          <>
            {pinned.length > 0 ? (
              <div className="sidebar-section pinned-tree">
                <button type="button" className="sidebar-section-title sidebar-pin-toggle" aria-expanded={pinsOpen} aria-controls={pinnedId} onClick={() => setPinsOpen(!pinsOpen)}>
                  <span className="sidebar-section-label"><Icon name="pin" size={12} />Pinned</span><Icon name="chevron" size={12} />
                </button>
                <div id={pinnedId} hidden={!pinsOpen}><ArtifactTree
                  artifacts={pinned}
                  activePath={artifactPath}
                  style={treeStyle}
                  view="recent"
                  onOpenArtifact={onOpenArtifact}
                  artifactHref={rowHref}
                  getArtifactActions={getArtifactActions}
                /></div>
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
        <span className="sidebar-footer-spacer" />
        <ThemeSwitcher
          buttonClassName="icon-button theme-toggle"
          mode={themeMode}
          onChange={onSetThemeMode}
        />
      </footer>
    </aside>
  )
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
