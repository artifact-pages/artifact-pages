import { useEffect, useMemo, useState } from 'react'
import type { ArtifactIndexEntry } from '../domain/index'
import { buildArtifactTree, countArtifacts, flattenArtifacts, type ArtifactTreeNode } from '../domain/tree'
import { Icon } from './Icon'

export type TreeStyle = 'quiet' | 'branch-guides' | 'path-list'
type TreeView = 'tree' | 'recent' | 'paths'

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
}) {
  const [localExpandedPaths, setLocalExpandedPaths] = useState(
    () => new Set(defaultExpandedPaths ?? rootPaths(artifacts)),
  )
  const expanded = expandedPaths ?? localExpandedPaths
  const setExpanded = onExpandedPathsChange ?? setLocalExpandedPaths
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const tree = useMemo(() => buildArtifactTree(artifacts), [artifacts])
  const allArtifacts = useMemo(() => flattenArtifacts(tree), [tree])
  const filteredArtifacts = allArtifacts.filter((artifact) => matches(artifact, normalizedQuery))

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
        {files.map((artifact) => (
          <ArtifactRow
            key={artifact.id}
            artifact={artifact}
            active={artifact.path === activePath}
            depth={depth}
            style={style}
            query={normalizedQuery}
            onOpenArtifact={onOpenArtifact}
          />
        ))}
      </>
    )
  }

  const items = view === 'recent'
    ? artifacts.filter((artifact) => matches(artifact, normalizedQuery))
    : filteredArtifacts

  return (
    <div className={`artifact-tree tree-view-${view} tree-style-${style}`}>
      {view === 'recent' ? items.map((artifact) => (
        <ArtifactRow
          key={artifact.id}
          artifact={artifact}
          active={artifact.path === activePath}
          depth={0}
          style={style}
          query={normalizedQuery}
          onOpenArtifact={onOpenArtifact}
        />
      )) : null}
      {view === 'paths' || (view === 'tree' && style === 'path-list') ? items.map((artifact) => (
        <ArtifactRow
          key={artifact.id}
          artifact={artifact}
          active={artifact.path === activePath}
          depth={0}
          style="path-list"
          query={normalizedQuery}
          showPath
          onOpenArtifact={onOpenArtifact}
        />
      )) : null}
      {view === 'tree' && style !== 'path-list' ? renderNode(tree, 0) : null}
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
}: {
  artifact: ArtifactIndexEntry
  active: boolean
  depth: number
  style: TreeStyle
  query: string
  showPath?: boolean
  onOpenArtifact: (artifact: ArtifactIndexEntry) => void
}) {
  return (
    <button
      className={`tree-artifact${active ? ' is-active' : ''}${showPath ? ' tree-path-row' : ''}`}
      style={{ paddingInlineStart: style === 'branch-guides' ? '8px' : `${10 + depth * 14}px` }}
      data-tree-depth={depth}
      data-tree-path={artifact.path}
      title={artifact.path}
      aria-current={active ? 'page' : undefined}
      onClick={() => onOpenArtifact(artifact)}
    >
      <span className={showPath ? 'tree-path-copy' : 'tree-label'}>
        <span className="tree-label">{highlight(artifact.title, query)}</span>
        {showPath ? <span className="tree-path mono">{highlight(artifact.path, query)}</span> : null}
      </span>
      {artifact.format === 'markdown' ? (
        <span className="tree-format-tag" title="Markdown document">MD</span>
      ) : null}
    </button>
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
  return `${artifact.title} ${artifact.path} ${artifact.filename ?? ''}`.toLocaleLowerCase().includes(query)
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
