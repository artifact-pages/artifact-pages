import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import type { ArtifactIndexEntry, SiteIndex } from '../domain/index'
import { RECENT_SECTION_MINIMUM_ARTIFACT_COUNT } from '../domain/navigation-sections'
import { loadPreviewCandidates, PREVIEW_EXPLANATION, PreviewLoadError } from '../data/previews'
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
  onOpenPalette,
  treeStyle = 'path-list',
  defaultExpandedPaths,
}: {
  index: SiteIndex
  onOpenArtifact: (href: string) => void
  onOpenPreviews?: () => void
  onOpenPalette?: () => void
  treeStyle?: TreeStyle
  defaultExpandedPaths?: string[]
}) {
  const [previewAvailability, setPreviewAvailability] = useState<PreviewAvailabilityState>({ status: 'loading' })
  const hasPreviewEntry = Boolean(onOpenPreviews)
  const noPreviews = previewAvailability.status === 'success' && previewAvailability.count === 0
  const showRecentSection = index.artifacts.length >= RECENT_SECTION_MINIMUM_ARTIFACT_COUNT
  const recentArtifacts = useMemo(
    () => showRecentSection ? selectMostRecent(index.artifacts, 6) : [],
    [index.artifacts, showRecentSection],
  )
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
            ? 'Browse the latest work or jump to an artifact by name.'
            : 'Browse artifacts or jump to one by name.'}
        </p>
        {onOpenPreviews ? (
          <div className="site-home-preview">
            <button
              className="site-home-preview-link"
              onClick={noPreviews ? undefined : onOpenPreviews}
              aria-disabled={noPreviews ? 'true' : undefined}
              aria-describedby={noPreviews ? 'site-home-preview-status' : undefined}
            >View previews{noPreviews ? null : <> <span aria-hidden="true">→</span></>}</button>
            <p className="site-home-preview-status" id="site-home-preview-status" role="status">
              {previewAvailability.status === 'loading'
                ? 'Checking preview availability…'
                : previewAvailability.status === 'error'
                  ? 'Preview availability could not be checked.'
                  : previewAvailability.count === 0
                    ? 'There are no available previews for this site.'
                    : `${previewAvailability.count} preview${previewAvailability.count === 1 ? '' : 's'} listed.`}
            </p>
            <p className="site-home-preview-note">{PREVIEW_EXPLANATION}</p>
          </div>
        ) : null}
        {onOpenPalette ? (
          <button
            type="button"
            className="site-home-jump"
            aria-keyshortcuts="Meta+K Control+K"
            onClick={(event) => {
              // Safari and Firefox do not focus buttons on click; focus first so closing the palette returns here.
              event.currentTarget.focus()
              onOpenPalette()
            }}
          >
            <Icon name="search" size={16} />
            <span>Jump to a page…</span>
            <kbd>⌘ K</kbd>
          </button>
        ) : null}
      </div>

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
  listRef,
  onExitTop,
}: {
  title: string
  icon: 'clock' | 'search'
  artifacts: ArtifactIndexEntry[]
  siteId: string
  query?: string
  onOpenArtifact: (href: string) => void
  emptyMessage: ReactNode
  listRef?: Ref<HTMLDivElement>
  /** Called when ↑ is pressed on the first row, so the caller can return focus to its search field. */
  onExitTop?: () => void
}) {
  // Arrow keys move between rows like the palette and the menu components; Home/End jump to either end.
  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || hasModifier(event)) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.artifact-list-row')]
    const current = rows.indexOf(event.target as HTMLButtonElement)
    if (current < 0) return
    if (event.key === 'ArrowUp' && current === 0) {
      if (!onExitTop) return
      event.preventDefault()
      onExitTop()
      return
    }
    event.preventDefault()
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
    rows[next]?.focus()
  }

  return (
    <section className="artifact-list-section" aria-label={title}>
      <h2 className="home-section-title"><Icon name={icon} size={13} />{title}</h2>
      {artifacts.length === 0 ? (
        <p className="empty-note">{emptyMessage}</p>
      ) : (
        <div className="artifact-list" ref={listRef} onKeyDown={handleListKeyDown}>
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

function hasModifier(event: KeyboardEvent<HTMLElement>) {
  return event.shiftKey || event.altKey || event.metaKey || event.ctrlKey
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
