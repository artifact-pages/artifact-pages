import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactIndexEntry } from '../domain/index'
import { buildArtifactTree, countArtifacts, flattenArtifacts, type ArtifactTreeNode } from '../domain/tree'
import { ArtifactActionsMenu } from './ArtifactActionsMenu'
import { Icon } from './Icon'

export type TreeStyle = 'quiet' | 'branch-guides' | 'path-list'
type TreeView = 'tree' | 'recent' | 'paths'
const VIRTUAL_PATH_ROW_HEIGHT = 44
const VIRTUAL_PATH_OVERSCAN = 8
const VIRTUAL_PATH_THRESHOLD = 100

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
  getArtifactActions,
  virtualizePaths = false,
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
  getArtifactActions?: (artifact: ArtifactIndexEntry) => ArtifactRowActions
  virtualizePaths?: boolean
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
    () => tree ? flattenArtifacts(tree) : artifacts,
    [artifacts, tree],
  )
  const filteredArtifacts = useMemo(
    () => normalizedQuery ? allArtifacts.filter((artifact) => matches(artifact, normalizedQuery)) : allArtifacts,
    [allArtifacts, normalizedQuery],
  )
  const items = view === 'recent'
    ? artifacts.filter((artifact) => matches(artifact, normalizedQuery))
    : filteredArtifacts
  const isPathListView = view === 'paths' || (view === 'tree' && style === 'path-list')
  const isVirtualizedPathList = virtualizePaths && isPathListView && items.length > VIRTUAL_PATH_THRESHOLD
  const pathListRef = useRef<HTMLDivElement>(null)
  const [pathRange, setPathRange] = useState({ start: 0, end: 80 })

  useLayoutEffect(() => {
    if (!isVirtualizedPathList) return
    const list = pathListRef.current
    const scrollContainer = list?.closest<HTMLElement>('.site-home')
    if (!list || !scrollContainer) return

    const updateRange = () => {
      const listTop = list.getBoundingClientRect().top
        - scrollContainer.getBoundingClientRect().top
        + scrollContainer.scrollTop
      const viewportStart = scrollContainer.scrollTop - listTop
      const viewportEnd = viewportStart + scrollContainer.clientHeight
      const totalHeight = items.length * VIRTUAL_PATH_ROW_HEIGHT
      const visibleStart = Math.max(0, Math.floor(Math.max(0, viewportStart) / VIRTUAL_PATH_ROW_HEIGHT))
      const visibleEnd = Math.min(items.length, Math.ceil(Math.min(totalHeight, viewportEnd) / VIRTUAL_PATH_ROW_HEIGHT))
      const windowSize = Math.ceil(scrollContainer.clientHeight / VIRTUAL_PATH_ROW_HEIGHT) + VIRTUAL_PATH_OVERSCAN * 2
      const start = viewportEnd <= 0
        ? 0
        : viewportStart >= totalHeight
          ? Math.max(0, items.length - windowSize)
          : Math.max(0, visibleStart - VIRTUAL_PATH_OVERSCAN)
      const end = viewportEnd <= 0
        ? Math.min(items.length, windowSize)
        : viewportStart >= totalHeight
          ? items.length
          : Math.min(items.length, visibleEnd + VIRTUAL_PATH_OVERSCAN)

      setPathRange((current) => current.start === start && current.end === end ? current : { start, end })
    }

    updateRange()
    scrollContainer.addEventListener('scroll', updateRange, { passive: true })
    const resizeObserver = new ResizeObserver(updateRange)
    resizeObserver.observe(scrollContainer)
    return () => {
      scrollContainer.removeEventListener('scroll', updateRange)
      resizeObserver.disconnect()
    }
  }, [isVirtualizedPathList, items.length])

  useEffect(() => {
    const ancestors = folderAncestors(activePath)
    if (ancestors.length > 0) {
      setExpanded((current) => new Set([...current, ...ancestors]))
    }
  }, [activePath, setExpanded])

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
        actions={getArtifactActions?.(artifact)}
      />
    )
  }

  function renderNode(node: ArtifactTreeNode, depth: number): React.ReactNode {
    const directories = [...node.directories.values()].filter(
      (directory) => !normalizedQuery || countMatching(directory, normalizedQuery) > 0,
    )
    const files = node.artifacts.filter((artifact) => matches(artifact, normalizedQuery))

    return (
      <>
        {directories.map((directory) => {
          const isExpanded = normalizedQuery.length > 0 || expanded.has(directory.path)
          const count = normalizedQuery
            ? countMatching(directory, normalizedQuery)
            : countArtifacts(directory)

          return (
            <div className="tree-directory" key={directory.path}>
              <button
                className="tree-directory-button"
                style={{ paddingInlineStart: style === 'branch-guides' ? '8px' : `${9 + depth * 14}px` }}
                data-tree-depth={depth}
                data-tree-path={directory.path}
                aria-expanded={isExpanded}
                onClick={() => toggleDirectory(directory.path)}
              >
                <Icon name="chevron" size={11} />
                <span className="tree-label">{highlight(directory.name, normalizedQuery)}</span>
                <span className="tree-count">{count}</span>
              </button>
              {isExpanded ? (
                <div className={`tree-children tree-children-${style}`}>
                  {renderNode(directory, depth + 1)}
                </div>
              ) : null}
            </div>
          )
        })}
        {files.map((artifact) => renderArtifact(artifact, depth, style))}
      </>
    )
  }

  const visiblePathItems = isVirtualizedPathList ? items.slice(pathRange.start, pathRange.end) : items
  const topSpacerHeight = isVirtualizedPathList ? pathRange.start * VIRTUAL_PATH_ROW_HEIGHT : 0
  const bottomSpacerHeight = isVirtualizedPathList
    ? (items.length - pathRange.end) * VIRTUAL_PATH_ROW_HEIGHT
    : 0

  return (
    <div
      ref={pathListRef}
      className={`artifact-tree tree-view-${view} tree-style-${style}${isVirtualizedPathList ? ' is-virtualized-path-list' : ''}`}
      role={isVirtualizedPathList ? 'list' : undefined}
    >
      {view === 'recent' ? items.map((artifact) => renderArtifact(artifact, 0, style)) : null}
      {isPathListView ? (
        <>
          {topSpacerHeight > 0 ? <div className="tree-virtual-spacer" style={{ height: topSpacerHeight }} aria-hidden="true" /> : null}
          {isVirtualizedPathList
            ? visiblePathItems.map((artifact, index) => (
                <div
                  key={artifact.id}
                  role="listitem"
                  aria-posinset={pathRange.start + index + 1}
                  aria-setsize={items.length}
                >
                  {renderArtifact(artifact, 0, 'path-list', true)}
                </div>
              ))
            : items.map((artifact) => renderArtifact(artifact, 0, 'path-list', true))}
          {bottomSpacerHeight > 0 ? <div className="tree-virtual-spacer" style={{ height: bottomSpacerHeight }} aria-hidden="true" /> : null}
        </>
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
  actions,
}: {
  artifact: ArtifactIndexEntry
  active: boolean
  depth: number
  style: TreeStyle
  query: string
  showPath?: boolean
  onOpenArtifact: (artifact: ArtifactIndexEntry) => void
  actions?: ArtifactRowActions
}) {
  const reason = !showPath && query && !artifact.title.toLocaleLowerCase().includes(query)
    ? matchReason(artifact, query)
    : undefined
  const pathText = showPath ? artifact.path : reason
  const withPath = showPath || Boolean(reason)
  return (
    <div className={`tree-artifact-row${actions ? ' has-actions' : ''}`}>
      <button
        className={`tree-artifact${active ? ' is-active' : ''}${withPath ? ' tree-path-row' : ''}`}
        style={{ paddingInlineStart: style === 'branch-guides' ? '8px' : `${10 + depth * 14}px` }}
        data-tree-depth={depth}
        data-tree-path={artifact.path}
        title={artifact.path}
        aria-current={active ? 'page' : undefined}
        onClick={() => onOpenArtifact(artifact)}
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
      </button>
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

function folderAncestors(path?: string) {
  if (!path) return []
  const segments = path.split('/').filter(Boolean).slice(0, -1)
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

function matches(artifact: ArtifactIndexEntry, query: string) {
  if (!query) return true
  return [artifact.title, artifact.path, artifact.filename ?? ''].some((text) => text.toLocaleLowerCase().includes(query))
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
