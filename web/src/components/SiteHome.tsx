import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ArtifactIndexEntry, SiteIndex } from '../domain/index'
import { RECENT_SECTION_MINIMUM_ARTIFACT_COUNT } from '../domain/navigation-sections'
import { loadPreviewCandidates, PreviewLoadError } from '../data/previews'
import { artifactRouteHref } from '../routing'
import { ArtifactTree, type TreeStyle } from './ArtifactTree'
import { Icon } from './Icon'

type PreviewAvailabilityState =
  | { status: 'loading' }
  | { status: 'success'; count: number }
  | { status: 'error' }

export function SiteHome({
  index,
  onOpenArtifact,
  onOpenPreviews,
  treeStyle = 'path-list',
  defaultExpandedPaths,
}: {
  index: SiteIndex
  onOpenArtifact: (href: string) => void
  onOpenPreviews?: () => void
  treeStyle?: TreeStyle
  defaultExpandedPaths?: string[]
}) {
  const [query, setQuery] = useState('')
  const [previewAvailability, setPreviewAvailability] = useState<PreviewAvailabilityState>({ status: 'loading' })
  const hasPreviewEntry = Boolean(onOpenPreviews)
  const showRecentSection = index.artifacts.length >= RECENT_SECTION_MINIMUM_ARTIFACT_COUNT
  const recentArtifacts = useMemo(
    () => showRecentSection ? selectMostRecent(index.artifacts, 6) : [],
    [index.artifacts, showRecentSection],
  )
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matches = useMemo(() => {
    if (!normalizedQuery) return []
    return index.artifacts
      .filter((artifact) => (
        `${artifact.title} ${artifact.path} ${artifact.filename ?? ''}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }, [index.artifacts, normalizedQuery])

  useEffect(() => {
    if (!hasPreviewEntry) return

    let cancelled = false
    setPreviewAvailability({ status: 'loading' })
    loadPreviewCandidates(index.site.id).then(
      (candidates) => {
        const count = candidates.filter(({ availability }) => availability === 'available' || availability === 'unknown').length
        if (!cancelled) setPreviewAvailability({ status: 'success', count })
      },
      (error: unknown) => {
        if (cancelled) return
        if (error instanceof PreviewLoadError && error.status === 404) {
          setPreviewAvailability({ status: 'success', count: 0 })
        } else {
          setPreviewAvailability({ status: 'error' })
        }
      },
    )

    return () => { cancelled = true }
  }, [hasPreviewEntry, index.site.id])

  return (
    <div className="site-home">
      <div className="site-home-heading">
        <div className="site-home-identity">
          <span className="site-mark" aria-hidden="true">{index.site.title.slice(0, 1).toUpperCase()}</span>
          <span className="mono">/{index.site.id}</span>
        </div>
        <h1>{index.site.title}</h1>
        <p className="site-home-lede">
          {index.artifacts.length} published {index.artifacts.length === 1 ? 'artifact' : 'artifacts'}.
          {' '}{showRecentSection
            ? 'Browse the latest work or find an artifact by title or path.'
            : 'Browse artifacts or find one by title or path.'}
        </p>
        {onOpenPreviews ? (
          <div className="site-home-preview">
            <button className="site-home-preview-link" onClick={onOpenPreviews}>View previews <span aria-hidden="true">→</span></button>
            <p className="site-home-preview-status" role="status">
              {previewAvailability.status === 'loading'
                ? 'Checking preview availability…'
                : previewAvailability.status === 'error'
                  ? 'Preview availability could not be checked.'
                  : previewAvailability.count === 0
                    ? 'There are no available previews for this site.'
                    : `${previewAvailability.count} preview${previewAvailability.count === 1 ? '' : 's'} listed.`}
            </p>
          </div>
        ) : null}
        <label className="site-search">
          <Icon name="search" size={16} />
          <input
            type="search"
            aria-label={`Filter artifacts in ${index.site.title}`}
            aria-describedby="site-search-help"
            aria-keyshortcuts="Meta+K Control+K"
            placeholder={`Filter artifacts in ${index.site.title}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return

              if (event.key === 'Escape') {
                event.preventDefault()
                setQuery('')
                event.currentTarget.blur()
              } else if (event.key === 'Enter' && matches.length === 1) {
                event.preventDefault()
                onOpenArtifact(artifactRouteHref(index.site.id, matches[0].path))
              }
            }}
          />
          <kbd>⌘ K / Ctrl K</kbd>
        </label>
        <p className="site-search-help" id="site-search-help" aria-live="polite">
          {!normalizedQuery
            ? 'Typing filters artifacts in this site. '
            : matches.length === 1
              ? 'Press Enter to open this match. '
              : matches.length > 1
                ? 'Use Tab to focus a match, then press Enter to open it. '
                : 'No matches to open. Clear the filter to browse this site. '}
          <span className="search-help-keyboard">⌘ K / Ctrl K opens full search.</span>
          <span className="search-help-touch">Use Search pages in the navigation to open full search.</span>
        </p>
      </div>

      {normalizedQuery ? (
        <ArtifactSection
          title={`${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`}
          icon="search"
          artifacts={matches}
          siteId={index.site.id}
          query={normalizedQuery}
          onOpenArtifact={onOpenArtifact}
          emptyMessage={(
            <>
              Nothing in this site matches your search.{' '}
              <span className="search-help-keyboard">Use ⌘ K, then @, to find another site.</span>
              <span className="search-help-touch">Use the site switcher to find another site.</span>
            </>
          )}
        />
      ) : (
        <>
          {showRecentSection ? (
            <ArtifactSection
              title="Recently updated"
              icon="clock"
              artifacts={recentArtifacts}
              siteId={index.site.id}
              onOpenArtifact={onOpenArtifact}
              emptyMessage="No artifacts have been published to this site yet."
            />
          ) : null}

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
                virtualizePaths
              />
            )}
          </section>
        </>
      )}
    </div>
  )
}

function selectMostRecent(artifacts: ArtifactIndexEntry[], limit: number) {
  const recent: ArtifactIndexEntry[] = []
  for (const artifact of artifacts) {
    let start = 0
    let end = recent.length
    while (start < end) {
      const middle = Math.floor((start + end) / 2)
      if (recent[middle].updatedAt >= artifact.updatedAt) start = middle + 1
      else end = middle
    }
    if (start >= limit) continue
    recent.splice(start, 0, artifact)
    if (recent.length > limit) recent.pop()
  }
  return recent
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
  emptyMessage: ReactNode
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
