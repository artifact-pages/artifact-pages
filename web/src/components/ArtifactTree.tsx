import { useEffect, useMemo, useState } from 'react'
import type { ArtifactIndexEntry } from '../domain/index'
import { compareArtifactsByPath } from '../domain/listing-order.ts'
import { TREE_BRANCH_ROW_LIMIT, TREE_FLAT_ROW_LIMIT, boundRows } from '../domain/row-window'
import { buildArtifactTree, countArtifacts, flattenArtifacts, foldedIndexArtifact, type ArtifactTreeNode } from '../domain/tree'
import { ArtifactActionsMenu } from './ArtifactActionsMenu'
import { Icon } from './Icon'
import { followInApp } from './spa-link'

export type TreeStyle = 'quiet' | 'branch-guides' | 'path-list'
type TreeView = 'tree' | 'recent' | 'paths'

export type ArtifactRowActions = {
  pinned: boolean
  sourceUrl?: string
  historyUrl?: string
  rawUrl?: string
  onTogglePin: () => void
  onCopyLink: () => void
}

export function ArtifactTree({
  artifacts,
  activePath,
  query = '',
  style = 'branch-guides',
  view = 'tree',
  expandedPaths,
  onExpandedPathsChange,
  defaultExpandedPaths,
  onOpenArtifact,
  artifactHref,
  getArtifactActions,
  activeDirectoryPath,
  directoryHref,
  onOpenDirectory,
  rootHref,
  onOpenRoot,
}: {
  artifacts: ArtifactIndexEntry[]
  activePath?: string
  query?: string
  style?: TreeStyle
  view?: TreeView
  expandedPaths?: Set<string>
  onExpandedPathsChange?: (update: (current: Set<string>) => Set<string>) => void
  defaultExpandedPaths?: string[]
  onOpenArtifact: (artifact: ArtifactIndexEntry) => void
  /** The link target of an artifact row; plain clicks still go through `onOpenArtifact`. */
  artifactHref: (artifact: ArtifactIndexEntry) => string
  getArtifactActions?: (artifact: ArtifactIndexEntry) => ArtifactRowActions
  /** The folder whose page is open; its row is highlighted and its ancestors are expanded. */
  activeDirectoryPath?: string
  /**
   * The link target of a folder row. When given, a folder label is a link to the
   * folder page and the chevron is a separate button that only toggles; without it
   * the whole row is one toggle button.
   */
  directoryHref?: (directory: ArtifactTreeNode) => string
  onOpenDirectory?: (directory: ArtifactTreeNode) => void
  /** The link target of the site root folder page; used by the overflow row of the root branch. */
  rootHref?: string
  onOpenRoot?: () => void
}) {
  const needsTree = view === 'tree' && style !== 'path-list'
  const [localExpandedPaths, setLocalExpandedPaths] = useState(
    () => new Set(defaultExpandedPaths ?? (needsTree ? rootPaths(artifacts) : [])),
  )
  const expanded = expandedPaths ?? localExpandedPaths
  const setExpanded = onExpandedPathsChange ?? setLocalExpandedPaths
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const tree = useMemo(() => needsTree ? buildArtifactTree(artifacts) : undefined, [artifacts, needsTree])
  const allArtifacts = useMemo(
    // Flat lists use the same folders-first filename order as the tree (ISSUE-076).
    () => tree ? flattenArtifacts(tree) : [...artifacts].sort(compareArtifactsByPath),
    [artifacts, tree],
  )
  const filteredArtifacts = useMemo(
    () => normalizedQuery ? allArtifacts.filter((artifact) => matches(artifact, normalizedQuery)) : allArtifacts,
    [allArtifacts, normalizedQuery],
  )
  const items = view === 'recent'
    ? artifacts.filter((artifact) => matches(artifact, normalizedQuery))
    : filteredArtifacts
  const flat = boundRows(items, TREE_FLAT_ROW_LIMIT, (artifact) => artifact.path === activePath)
  const isPathListView = view === 'paths' || (view === 'tree' && style === 'path-list')

  useEffect(() => {
    const ancestors = [...folderAncestors(activePath), ...folderPaths(activeDirectoryPath)]
    if (ancestors.length > 0) {
      setExpanded((current) => new Set([...current, ...ancestors]))
    }
  }, [activePath, activeDirectoryPath, setExpanded])

  function toggleDirectory(path: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function renderArtifact(artifact: ArtifactIndexEntry, depth: number, rowStyle: TreeStyle, showPath = false) {
    return (
      <ArtifactRow
        key={artifact.id}
        artifact={artifact}
        active={artifact.path === activePath}
        depth={depth}
        style={rowStyle}
        query={normalizedQuery}
        showPath={showPath}
        onOpenArtifact={onOpenArtifact}
        href={artifactHref(artifact)}
        actions={getArtifactActions?.(artifact)}
      />
    )
  }

  function renderNode(node: ArtifactTreeNode, depth: number): React.ReactNode {
    const directories = [...node.directories.values()].filter(
      (directory) => !normalizedQuery
        || folderMatches(directory, normalizedQuery)
        || countMatching(directory, normalizedQuery) > 0,
    )
    // With folder links, the folder row stands for its index page (not while filtering).
    const foldedIndex = directoryHref && !normalizedQuery ? foldedIndexArtifact(node) : undefined
    const files = node.artifacts.filter(
      (artifact) => artifact !== foldedIndex && matches(artifact, normalizedQuery),
    )

    const isActiveDirectoryRow = (directory: ArtifactTreeNode) => {
      const hiddenIndex = directoryHref && !normalizedQuery ? foldedIndexArtifact(directory) : undefined
      return directory.path === activeDirectoryPath
        || (hiddenIndex !== undefined && hiddenIndex.path === activePath)
        // The folder that holds the active page or folder keeps its row too.
        || [activePath, activeDirectoryPath].some((active) => active?.startsWith(`${directory.path}/`))
    }
    // Directories first, then files; the branch mounts at most TREE_BRANCH_ROW_LIMIT of them (ISSUE-093).
    const rows = [
      ...directories.map((directory) => ({ directory })),
      ...files.map((artifact) => ({ artifact })),
    ]
    const { shown, hidden } = boundRows(
      rows,
      TREE_BRANCH_ROW_LIMIT,
      (row) => 'directory' in row ? isActiveDirectoryRow(row.directory) : row.artifact.path === activePath,
    )
    const shownDirectories = shown.flatMap((row) => 'directory' in row ? [row.directory] : [])
    const shownFiles = shown.flatMap((row) => 'artifact' in row ? [row.artifact] : [])
    const moreHref = node.path ? directoryHref?.(node) : rootHref
    const moreLabel = node.path ? node.label : 'this site'
    const moreOpen = () => node.path ? onOpenDirectory?.(node) : onOpenRoot?.()

    return (
      <>
        {shownDirectories.map((directory) => {
          const isExpanded = normalizedQuery.length > 0 || expanded.has(directory.path)
          const count = normalizedQuery
            ? countMatching(directory, normalizedQuery)
            : countArtifacts(directory)

          const hiddenIndex = directoryHref && !normalizedQuery ? foldedIndexArtifact(directory) : undefined
          const isActiveDirectory = directory.path === activeDirectoryPath
            || (hiddenIndex !== undefined && hiddenIndex.path === activePath)

          return (
            <div className="tree-directory" key={directory.path}>
              {directoryHref ? (
                <div
                  className={`tree-directory-row${isActiveDirectory ? ' is-active' : ''}`}
                  data-tree-depth={depth}
                >
                  <button
                    type="button"
                    className="tree-directory-button tree-directory-toggle"
                    style={{ marginInlineStart: style === 'branch-guides' ? '4px' : `${5 + depth * 14}px` }}
                    data-tree-depth={depth}
                    data-tree-path={directory.path}
                    aria-expanded={isExpanded}
                    aria-label={`Toggle ${directory.label}`}
                    onClick={() => toggleDirectory(directory.path)}
                  >
                    <Icon name="chevron" size={11} />
                  </button>
                  <a
                    className="tree-directory-link"
                    href={directoryHref(directory)}
                    data-tree-folder={directory.path}
                    aria-current={isActiveDirectory ? 'page' : undefined}
                    title={directory.path}
                    onClick={(event) => followInApp(event, () => onOpenDirectory?.(directory))}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowRight' && !isExpanded) {
                        event.preventDefault()
                        toggleDirectory(directory.path)
                      } else if (event.key === 'ArrowLeft' && isExpanded && !normalizedQuery) {
                        event.preventDefault()
                        toggleDirectory(directory.path)
                      }
                    }}
                  >
                    <span className="tree-label">{highlight(directory.label, normalizedQuery)}</span>
                    <span className="tree-count">{count}</span>
                  </a>
                </div>
              ) : (
                <button
                  className="tree-directory-button"
                  style={{ paddingInlineStart: style === 'branch-guides' ? '8px' : `${9 + depth * 14}px` }}
                  data-tree-depth={depth}
                  data-tree-path={directory.path}
                  aria-expanded={isExpanded}
                  onClick={() => toggleDirectory(directory.path)}
                >
                  <Icon name="chevron" size={11} />
                  <span className="tree-label">{highlight(directory.label, normalizedQuery)}</span>
                  <span className="tree-count">{count}</span>
                </button>
              )}
              {isExpanded ? (
                <div className={`tree-children tree-children-${style}`}>
                  {renderNode(directory, depth + 1)}
                </div>
              ) : null}
            </div>
          )
        })}
        {shownFiles.map((artifact) => renderArtifact(artifact, depth, style))}
        {hidden > 0 ? (
          moreHref ? (
            <a
              className="tree-more"
              href={moreHref}
              style={{ paddingInlineStart: style === 'branch-guides' ? '8px' : `${10 + depth * 14}px` }}
              onClick={(event) => followInApp(event, moreOpen)}
            >{hidden} more {normalizedQuery ? 'matches ' : ''}in {moreLabel}</a>
          ) : (
            <p className="tree-more" style={{ paddingInlineStart: style === 'branch-guides' ? '8px' : `${10 + depth * 14}px` }}>
              {normalizedQuery
                ? `${hidden} more matches not shown. Refine the filter to narrow the list.`
                : `${hidden} more not shown. Use the filter to narrow the list.`}
            </p>
          )
        ) : null}
      </>
    )
  }

  return (
    <div className={`artifact-tree tree-view-${view} tree-style-${style}`}>
      {view === 'recent' ? flat.shown.map((artifact) => renderArtifact(artifact, 0, style)) : null}
      {isPathListView ? flat.shown.map((artifact) => renderArtifact(artifact, 0, 'path-list', true)) : null}
      {(view === 'recent' || isPathListView) && flat.hidden > 0 ? (
        <p className="tree-more">
          {normalizedQuery
            ? `Showing ${TREE_FLAT_ROW_LIMIT} of ${items.length} matches. Refine the filter to narrow the list.`
            : `Showing ${TREE_FLAT_ROW_LIMIT} of ${items.length}. Use the filter to narrow the list.`}
        </p>
      ) : null}
      {view === 'tree' && style !== 'path-list' && tree ? renderNode(tree, 0) : null}
    </div>
  )
}

function ArtifactRow({
  artifact,
  active,
  depth,
  style,
  query,
  showPath = false,
  onOpenArtifact,
  href,
  actions,
}: {
  artifact: ArtifactIndexEntry
  active: boolean
  depth: number
  style: TreeStyle
  query: string
  showPath?: boolean
  onOpenArtifact: (artifact: ArtifactIndexEntry) => void
  href: string
  actions?: ArtifactRowActions
}) {
  const reason = !showPath && query && !artifact.title.toLocaleLowerCase().includes(query)
    ? matchReason(artifact, query)
    : undefined
  const pathText = showPath ? artifact.path : reason
  const withPath = showPath || Boolean(reason)
  return (
    <div className={`tree-artifact-row${actions ? ' has-actions' : ''}`}>
      <a
        href={href}
        className={`tree-artifact${active ? ' is-active' : ''}${withPath ? ' tree-path-row' : ''}`}
        style={{ paddingInlineStart: style === 'branch-guides' ? '8px' : `${10 + depth * 14}px` }}
        data-tree-depth={depth}
        data-tree-path={artifact.path}
        title={artifact.path}
        aria-current={active ? 'page' : undefined}
        onClick={(event) => followInApp(event, () => onOpenArtifact(artifact))}
      >
        <span className={withPath ? 'tree-path-copy' : 'tree-label'}>
          <span className="tree-label">{highlight(artifact.title, query)}</span>
          {withPath ? (
            <span className="tree-path mono" aria-hidden="true">
              {highlight(pathText ?? artifact.path, query)}
            </span>
          ) : null}
        </span>
        {artifact.format === 'markdown' ? (
          <span className="tree-format-tag" title="Markdown document">MD</span>
        ) : null}
      </a>
      {actions ? (
        <ArtifactActionsMenu
          artifact={artifact}
          pinned={actions.pinned}
          sourceUrl={actions.sourceUrl}
          historyUrl={actions.historyUrl}
          rawUrl={actions.rawUrl}
          onTogglePin={actions.onTogglePin}
          onCopyLink={actions.onCopyLink}
        />
      ) : null}
    </div>
  )
}

function rootPaths(artifacts: ArtifactIndexEntry[]) {
  return [...new Set(artifacts.map(({ path }) => path.split('/').filter(Boolean)[0]).filter(Boolean))]
}

function folderPaths(path?: string) {
  if (!path) return []
  const segments = path.split('/').filter(Boolean)
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

function folderAncestors(path?: string) {
  if (!path) return []
  const segments = path.split('/').filter(Boolean).slice(0, -1)
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

function matches(artifact: ArtifactIndexEntry, query: string) {
  if (!query) return true
  return [artifact.title, artifact.path, artifact.filename ?? ''].some((text) => text.toLocaleLowerCase().includes(query))
}

/** Whether the sidebar's title and path filter lists the artifact (`query` lower-cased and trimmed). */
export function artifactMatchesFilter(artifact: ArtifactIndexEntry, query: string) {
  return matches(artifact, query)
}

function matchReason(artifact: ArtifactIndexEntry, query: string) {
  const text = artifact.path.toLocaleLowerCase().includes(query)
    ? artifact.path
    : artifact.filename?.toLocaleLowerCase().includes(query) ? artifact.filename : undefined
  if (!text) return undefined
  const index = text.toLocaleLowerCase().indexOf(query)
  // Keep the matched part visible when the row truncates a long path.
  return index > 14 ? `\u2026${text.slice(index - 10)}` : text
}

function folderMatches(node: ArtifactTreeNode, query: string) {
  return [node.label, node.name].some((text) => text.toLocaleLowerCase().includes(query))
}

function countMatching(node: ArtifactTreeNode, query: string): number {
  return node.artifacts.filter((artifact) => matches(artifact, query)).length
    + [...node.directories.values()].reduce((total, directory) => total + countMatching(directory, query), 0)
}

function highlight(text: string, query: string) {
  if (!query) return text
  const index = text.toLocaleLowerCase().indexOf(query)
  if (index < 0) return text
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  )
}
