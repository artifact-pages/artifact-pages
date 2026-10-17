import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import type { ArtifactIndexEntry, SiteIndex } from '../domain/index'
import { RECENT_SECTION_MINIMUM_ARTIFACT_COUNT } from '../domain/navigation-sections'
import { loadPreviewCandidates, PreviewLoadError } from '../data/previews'
import { pageCountLabel } from '../domain/directory'
import { artifactRouteHref, siteFilesHref, siteHomeHref, sitePreviewsHref } from '../routing'
import { Icon } from './Icon'
import { followInApp } from './spa-link'
import { useRestoredScroll } from './useRestoredScroll'

export type SiteSection = 'overview' | 'files' | 'previews'

type PreviewAvailabilityState =
  | { status: 'loading' }
  | { status: 'success'; count: number }
  | { status: 'unknown' }

/**
 * How many previews the site lists, once the catalog has loaded. Until then, and when the catalog cannot be
 * read, there is no number (never a made-up one). The Previews section reports its own failures.
 */
export function usePreviewCount(siteId: string, enabled: boolean): { count: number | undefined; report: (count: number) => void } {
  const [state, setState] = useState<{ siteId: string; availability: PreviewAvailabilityState }>({
    siteId,
    availability: { status: 'loading' },
  })
  const settled = state.siteId === siteId && state.availability.status !== 'loading'
  useEffect(() => {
    if (!enabled || settled) return
    let cancelled = false
    loadPreviewCandidates(siteId).then(
      (candidates) => {
        const count = candidates.filter(({ availability }) => availability === 'available' || availability === 'unknown').length
        if (!cancelled) setState({ siteId, availability: { status: 'success', count } })
      },
      (error: unknown) => {
        if (cancelled) return
        // No catalog at all is a site without previews; any other failure leaves the count unknown.
        if (error instanceof PreviewLoadError && error.status === 404) setState({ siteId, availability: { status: 'success', count: 0 } })
        else setState({ siteId, availability: { status: 'unknown' } })
      },
    )
    return () => { cancelled = true }
  }, [siteId, enabled, settled])
  const report = useCallback(
    (count: number) => setState({ siteId, availability: { status: 'success', count } }),
    [siteId],
  )
  return { count: state.siteId === siteId && state.availability.status === 'success' ? state.availability.count : undefined, report }
}

/** The frame of a site-home section: the scrolling page with the site header, the section row and the section. */
export function SiteHomeFrame({ header, children }: { header: ReactNode; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  useRestoredScroll(scroller)
  return (
    <div className="directory-scroll" ref={scroller} data-testid="site-home-page">
      <div className="directory-page">
        {header}
        {children}
      </div>
    </div>
  )
}

/** The empty site: the header, the section row and a note, because there is no root listing to show. */
export function SiteHome({
  index,
  previewCount,
  onNavigate,
  onOpenPalette,
}: {
  index: SiteIndex
  previewCount?: number
  onNavigate?: (href: string) => void
  onOpenPalette?: () => void
}) {
  return (
    <SiteHomeFrame header={(
      <SiteHomeHeader
        index={index}
        pageCount={index.artifacts.length}
        current="files"
        hasOverview={false}
        previewCount={previewCount}
        onNavigate={onNavigate}
        onOpenPalette={onOpenPalette}
      />
    )}>
      <p className="empty-note site-home-empty">No artifacts have been published to this site yet.</p>
    </SiteHomeFrame>
  )
}

/** The site root's compact header (title, description, page count, content update date) and its section row. */
export function SiteHomeHeader({
  index,
  pageCount,
  latestUpdatedAt,
  current,
  hasOverview,
  previewCount,
  onNavigate,
  onOpenPalette,
}: {
  index: SiteIndex
  pageCount: number
  /** The newest document update in the index (content freshness, not when the metadata was generated). */
  latestUpdatedAt?: string
  current: SiteSection
  hasOverview: boolean
  previewCount?: number
  onNavigate?: (href: string) => void
  onOpenPalette?: () => void
}) {
  const description = index.site.description?.trim()
  return (
    <>
      <header className="site-home-heading">
        <div className="site-home-title-row">
          <span className="site-mark" aria-hidden="true">{index.site.title.slice(0, 1).toUpperCase()}</span>
          <h1>{index.site.title}</h1>
          <span className="mono site-home-id">/{index.site.id}</span>
        </div>
        {description ? <p className="site-home-description">{description}</p> : null}
        <p className="site-home-lede">
          {pageCountLabel(pageCount)}
          {latestUpdatedAt ? <> · Updated <time dateTime={latestUpdatedAt}>{formatFullDate(latestUpdatedAt)}</time></> : null}
        </p>
      </header>
      <div className="site-home-bar">
        <nav className="site-sections" aria-label="Site sections">
          {hasOverview ? <SectionLink siteId={index.site.id} section="overview" current={current} onNavigate={onNavigate}>Overview</SectionLink> : null}
          <SectionLink siteId={index.site.id} section="files" current={current} onNavigate={onNavigate} hasOverview={hasOverview}>Files</SectionLink>
          <SectionLink siteId={index.site.id} section="previews" current={current} onNavigate={onNavigate} count={previewCount}>Previews</SectionLink>
        </nav>
        {onOpenPalette ? (
          <button
            type="button"
            className="site-home-search"
            aria-label="Search this site"
            aria-keyshortcuts="Meta+K Control+K"
            onClick={(event) => {
              // Safari and Firefox do not focus buttons on click; focus first so closing the palette returns here.
              event.currentTarget.focus()
              onOpenPalette()
            }}
          >
            <Icon name="search" size={15} />
            <span className="site-home-search-label">Search this site</span>
            <kbd>⌘ K</kbd>
          </button>
        ) : null}
      </div>
    </>
  )
}

function SectionLink({ siteId, section, current, onNavigate, count, hasOverview = true, children }: {
  siteId: string
  section: SiteSection
  current: SiteSection
  onNavigate?: (href: string) => void
  count?: number
  hasOverview?: boolean
  children: ReactNode
}) {
  const href = section === 'previews'
    ? sitePreviewsHref(siteId)
    // Without an introduction the site root already shows Files.
    : section === 'files' && hasOverview ? siteFilesHref(siteId) : siteHomeHref(siteId)
  return (
    <a
      className="site-section-link"
      href={href}
      aria-current={current === section ? 'page' : undefined}
      onClick={(event) => followInApp(event, () => onNavigate?.(href))}
    >
      {children}
      {count !== undefined ? <span className="site-section-count">{count}</span> : null}
    </a>
  )
}

/** The six most recently updated pages, shown last on the site root once the site is large enough. */
export function RecentlyUpdated({
  index,
  onOpenArtifact,
  linkHref = (href) => href,
}: {
  index: SiteIndex
  onOpenArtifact: (href: string) => void
  /** Maps a logical route to the link target a row carries (for example with `?q=` kept). */
  linkHref?: (href: string) => string
}) {
  const showRecentSection = index.artifacts.length >= RECENT_SECTION_MINIMUM_ARTIFACT_COUNT
  const recentArtifacts = useMemo(
    () => showRecentSection ? selectMostRecent(index.artifacts, 6) : [],
    [index.artifacts, showRecentSection],
  )
  if (!showRecentSection) return null
  return (
    <ArtifactSection
      title="Recently updated"
      icon="clock"
      artifacts={recentArtifacts}
      siteId={index.site.id}
      onOpenArtifact={onOpenArtifact}
      linkHref={linkHref}
      emptyMessage="No artifacts have been published to this site yet."
    />
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
  linkHref,
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
  linkHref: (href: string) => string
  emptyMessage: ReactNode
  listRef?: Ref<HTMLDivElement>
  /** Called when ↑ is pressed on the first row, so the caller can return focus to its search field. */
  onExitTop?: () => void
}) {
  // Arrow keys move between rows like the palette and the menu components; Home/End jump to either end.
  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || hasModifier(event)) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('.artifact-list-row')]
    const current = rows.indexOf(event.target as HTMLElement)
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
            <a
              className="artifact-list-row"
              key={artifact.id}
              href={linkHref(artifactRouteHref(siteId, artifact.path))}
              onClick={(event) => followInApp(event, () => onOpenArtifact(artifactRouteHref(siteId, artifact.path)))}
            >
              <span className="artifact-row-main">
                <span className="artifact-row-title">{highlight(artifact.title, query)}</span>
                <span className="artifact-row-path mono">{highlight(artifact.path, query)}</span>
              </span>
              <time dateTime={artifact.updatedAt}>{formatDate(artifact.updatedAt)}</time>
            </a>
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

function formatFullDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}
