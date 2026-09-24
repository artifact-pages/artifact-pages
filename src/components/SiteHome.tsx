import { useMemo, useState } from 'react'
import type { ArtifactIndexEntry, SiteIndex } from '../domain/index'
import { artifactRouteHref } from '../routing'
import { ArtifactTree, type TreeStyle } from './ArtifactTree'
import { Icon } from './Icon'

export function SiteHome({
  index,
  onOpenArtifact,
  treeStyle = 'path-list',
  defaultExpandedPaths,
}: {
  index: SiteIndex
  onOpenArtifact: (href: string) => void
  treeStyle?: TreeStyle
  defaultExpandedPaths?: string[]
}) {
  const [query, setQuery] = useState('')
  const artifacts = useMemo(
    () => [...index.artifacts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [index.artifacts],
  )
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matches = normalizedQuery
    ? artifacts.filter((artifact) =>
        `${artifact.title} ${artifact.path} ${artifact.filename ?? ''}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : []

  return (
    <div className="site-home">
      <div className="site-home-heading">
        <div className="site-home-identity">
          <span className="site-mark" aria-hidden="true">{index.site.title.slice(0, 1).toUpperCase()}</span>
          <span className="mono">/{index.site.id}</span>
        </div>
        <h1>{index.site.title}</h1>
        <p className="site-home-lede">
          {artifacts.length} published {artifacts.length === 1 ? 'artifact' : 'artifacts'}.
          {' '}Browse the latest work or find an artifact by title or path.
        </p>
        <label className="site-search">
          <Icon name="search" size={16} />
          <input
            type="search"
            aria-label={`Search ${index.site.title}`}
            placeholder={`Search ${index.site.title}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>⌘ K</kbd>
        </label>
      </div>

      {normalizedQuery ? (
        <ArtifactSection
          title={`${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`}
          icon="search"
          artifacts={matches}
          siteId={index.site.id}
          query={normalizedQuery}
          onOpenArtifact={onOpenArtifact}
          emptyMessage="Nothing in this site matches your search. Use ⌘ K, then @, to find another site."
        />
      ) : (
        <>
          <ArtifactSection
            title="Recently updated"
            icon="clock"
            artifacts={artifacts.slice(0, 6)}
            siteId={index.site.id}
            onOpenArtifact={onOpenArtifact}
            emptyMessage="No artifacts have been published to this site yet."
          />

          <section className="browse-section" aria-labelledby="browse-heading">
            <h2 className="home-section-title" id="browse-heading">
              <Icon name="tree" size={13} /> Browse
            </h2>
            {index.artifacts.length === 0 ? (
              <p className="empty-note">There are no artifact groups to browse yet.</p>
            ) : (
              <ArtifactTree
                artifacts={index.artifacts}
                style={treeStyle}
                defaultExpandedPaths={defaultExpandedPaths}
                onOpenArtifact={(artifact) => onOpenArtifact(artifactRouteHref(index.site.id, artifact.path))}
              />
            )}
          </section>
        </>
      )}
    </div>
  )
}

function ArtifactSection({
  title,
  icon,
  artifacts,
  siteId,
  query = '',
  onOpenArtifact,
  emptyMessage,
}: {
  title: string
  icon: 'clock' | 'search'
  artifacts: ArtifactIndexEntry[]
  siteId: string
  query?: string
  onOpenArtifact: (href: string) => void
  emptyMessage: string
}) {
  return (
    <section className="artifact-list-section" aria-label={title}>
      <h2 className="home-section-title"><Icon name={icon} size={13} />{title}</h2>
      {artifacts.length === 0 ? (
        <p className="empty-note">{emptyMessage}</p>
      ) : (
        <div className="artifact-list">
          {artifacts.map((artifact) => (
            <button
              className="artifact-list-row"
              key={artifact.id}
              onClick={() => onOpenArtifact(artifactRouteHref(siteId, artifact.path))}
            >
              <span className="artifact-row-main">
                <span className="artifact-row-title">{highlight(artifact.title, query)}</span>
                <span className="artifact-row-path mono">{highlight(artifact.path, query)}</span>
              </span>
              <time dateTime={artifact.updatedAt}>{formatDate(artifact.updatedAt)}</time>
            </button>
          ))}
        </div>
      )}
    </section>
  )
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

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)
}
