import { pageCountLabel } from '../domain/directory'
import { formatNumber } from '../domain/display-locale'
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { FullTextSearchError, type FullTextHit } from '../data/fulltext'
import type { ArtifactIndexEntry } from '../domain/index'
import type { SearchExcerpt } from '../domain/fulltext-snippets'
import { folderFacets, searchFolderLabels } from '../domain/search-facets'
import { scopeHits } from '../domain/search-ranking'
import { searchTerms } from '../domain/text-highlight'
import type { DiscoveryErrorDescription, SearchAvailability } from '../domain/search-availability'
import { Icon } from './Icon'
import { followInApp } from './spa-link'
import { describePageTextSearchError, PAGE_TEXT_SEARCH_PAGE_SIZE, type PageTextSearchState } from './usePageTextSearch'

export const SEARCH_PAGE_INPUT_ID = 'search-page-input'
/** Typing searches after this pause; Enter searches at once. */
const TYPING_DEBOUNCE_MS = 200

type SuccessState = Extract<PageTextSearchState, { status: 'success' }>
/** Excerpts are requested for this many rows at a time. */
const EXCERPT_BATCH = 20
const NO_EXCERPTS: ReadonlyMap<string, SearchExcerpt | null> = new Map()

export function SearchResultsPage({
  siteTitle,
  pageCount,
  artifacts,
  availability,
  discoveryError,
  onRetryDiscovery,
  query,
  folder,
  state,
  onQueryChange,
  onFolderChange,
  onRetry,
  onLoadMore,
  hitHref,
  onOpenHit,
  onSearchTitles,
  loadExcerpts,
}: {
  siteTitle: string
  /** Pages in the site, named while searching. */
  pageCount: number
  artifacts: ArtifactIndexEntry[]
  /** `unavailable` is a site published without page text search; `loading` and `discovery-error` mean that is not known yet (ISSUE-113). */
  availability: SearchAvailability
  /** The guidance when `availability` is `discovery-error`. */
  discoveryError: DiscoveryErrorDescription
  onRetryDiscovery?: () => void
  /** The query in the URL. */
  query: string
  /** The folder the list is limited to (`in` in the URL); subfolders included. */
  folder?: string
  state: PageTextSearchState
  /** The reader typed (or cleared) a query; the URL entry is replaced, not added. */
  onQueryChange: (query: string) => void
  onFolderChange: (folder: string | undefined) => void
  onRetry: () => void
  onLoadMore: () => void
  /** The link target of a result row; it carries the query so the page highlights it. */
  hitHref: (hit: FullTextHit) => string
  /** The anchor of the section excerpt shown for the row, when there is one. */
  onOpenHit: (hit: FullTextHit, anchor?: string) => void
  /** Offers the sidebar-style title and path search for a query that matched no text. */
  onSearchTitles: (query: string) => void
  /** Loads excerpts for result paths of one query and generation. Absent: no excerpts. */
  loadExcerpts?: (query: string, generation: string, paths: readonly string[], signal: AbortSignal) => Promise<ReadonlyMap<string, SearchExcerpt | null>>
}) {
  const available = availability === 'available'
  const [draft, setDraft] = useState(query)
  const [composing, setComposing] = useState(false)
  const [active, setActive] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const artifactsById = useMemo(() => new Map(artifacts.map((artifact) => [artifact.id, artifact])), [artifacts])

  // The field follows the URL after back/forward; typing "foo " keeps its trailing space.
  useEffect(() => {
    setDraft((current) => current.trim() === query ? current : query)
  }, [query])
  const onQueryChangeRef = useRef(onQueryChange)
  onQueryChangeRef.current = onQueryChange
  useEffect(() => {
    const next = draft.trim()
    if (next === query || composing) return
    const timer = window.setTimeout(() => onQueryChangeRef.current(next), TYPING_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [draft, query, composing])
  useEffect(() => setActive(-1), [query, folder])

  // Route entry: the reader came here to search, so the field is ready.
  useEffect(() => {
    if (available) inputRef.current?.focus()
  }, [available])

  // While a newer query loads, the previous results stay (dimmed) instead of flashing a skeleton.
  const previous = useRef<SuccessState | null>(null)
  if (state.status === 'success') previous.current = state
  else if (state.status === 'idle' || state.status === 'error') previous.current = null
  const stale = state.status === 'loading' && previous.current !== null
  const shown: PageTextSearchState = stale ? previous.current! : state

  const allHits = shown.status === 'success' ? shown.hits : []
  const complete = shown.status === 'success' && shown.ranked
  const hits = useMemo(() => scopeHits(allHits, folder ?? null), [allHits, folder])
  const facets = useMemo(() => complete ? folderFacets(allHits, folder) : [], [complete, allHits, folder])

  // Page text excerpts (ISSUE-085). They belong to the shown list (query and generation), so
  // the dimmed previous list keeps its own while a newer query loads. Rows are excerpted in
  // batches of EXCERPT_BATCH: a ranked list shows all its hits at once, so the next batch is
  // requested when the last excerpted row scrolls into view; a path-ordered list is already
  // loaded in pages of that size.
  const excerptKey = shown.status === 'success' && shown.generation !== null ? `${shown.query}\u0000${shown.generation}` : null
  const [loaded, setLoaded] = useState<{ key: string; byPath: ReadonlyMap<string, SearchExcerpt | null> }>({ key: '', byPath: NO_EXCERPTS })
  const [batches, setBatches] = useState(1)
  const requests = useRef<{ controller: AbortController | null; inFlight: Set<string> }>({ controller: null, inFlight: new Set() })
  const byPath = excerptKey !== null && loaded.key === excerptKey ? loaded.byPath : NO_EXCERPTS
  useEffect(() => {
    const controller = new AbortController(), state = requests.current
    state.controller = controller
    state.inFlight = new Set()
    return () => controller.abort()
  }, [excerptKey])
  useEffect(() => setBatches(1), [excerptKey, folder])
  const excerptLimit = shown.status === 'success' && !shown.ranked ? hits.length : batches * EXCERPT_BATCH
  const excerptPaths = hits.slice(0, excerptLimit).map((hit) => hit.path)
  const excerptPathsKey = excerptPaths.join('\u0000')
  useEffect(() => {
    const { controller, inFlight } = requests.current
    if (!controller || controller.signal.aborted || excerptKey === null || shown.status !== 'success' || shown.generation === null || !loadExcerpts) return
    const todo = excerptPaths.filter((path) => !byPath.has(path) && !inFlight.has(path))
    if (todo.length === 0) return
    const { query: forQuery, generation } = shown
    for (const path of todo) inFlight.add(path)
    const merge = (result: ReadonlyMap<string, SearchExcerpt | null>) => {
      if (controller.signal.aborted) return
      setLoaded((current) => ({ key: excerptKey, byPath: new Map([...(current.key === excerptKey ? current.byPath : NO_EXCERPTS), ...result]) }))
    }
    loadExcerpts(forQuery, generation, todo, controller.signal).then(merge, () => merge(new Map(todo.map((path) => [path, null]))))
      .finally(() => { for (const path of todo) inFlight.delete(path) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excerptKey, excerptPathsKey, loadExcerpts, byPath])
  const moreExcerpts = shown.status === 'success' && shown.ranked && excerptLimit < hits.length
  useEffect(() => {
    if (!moreExcerpts || stale || typeof IntersectionObserver === 'undefined') return
    const row = listRef.current?.children[excerptLimit - 1]
    if (!row) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); setBatches((count) => count + 1) }
    })
    observer.observe(row)
    return () => observer.disconnect()
  }, [moreExcerpts, excerptLimit, stale, hits.length])

  // "Show more" keeps keyboard focus: once the next page arrives it moves to the first new result.
  const focusAfterMore = useRef<number | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    const first = focusAfterMore.current
    if (first === null || shown.status !== 'success' || shown.more === 'loading') return
    focusAfterMore.current = null
    if (shown.more === 'error') return
    const focused = document.activeElement
    if (focused && focused !== document.body && !focused.classList.contains('search-page-more')) return
    listRef.current?.querySelectorAll<HTMLElement>('.search-page-result-link')[first]?.focus()
  }, [shown])

  // Committing the query that is already shown adds no history entry; after a failure it retries.
  // A folder limit on a list that is not fully loaded: keep loading pages until one lies in the folder or the list ends.
  useEffect(() => {
    if (folder && shown.status === 'success' && !shown.ranked && shown.hasMore && shown.more === 'idle' && hits.length === 0 && !stale) onLoadMore()
  }, [folder, shown, hits.length, stale, onLoadMore])

  function commitNow() {
    const next = draft.trim()
    if (next !== query) onQueryChange(next)
    else if (state.status === 'error') onRetry()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter that confirms an IME conversion must not submit the query.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      commitNow()
    } else if (event.key === 'ArrowDown') {
      // Results are links: focus moves to the first one instead of a virtual selection. It does
      // nothing while the typed query is not committed yet or the list is stale.
      event.preventDefault()
      if (hits.length > 0 && !stale && draft.trim() === query) {
        setActive(0)
        resultLinks()[0]?.focus()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (draft) {
        setDraft('')
        onQueryChange('')
      } else {
        event.currentTarget.blur()
      }
    }
  }

  function resultLinks() {
    return Array.from(listRef.current?.querySelectorAll<HTMLElement>('.search-page-result-link') ?? [])
  }

  // A list that is going stale or a new query must not keep focus on an old result.
  useEffect(() => {
    if (listRef.current?.contains(document.activeElement)) inputRef.current?.focus()
  }, [stale, query])

  function handleLinkKeyDown(event: KeyboardEvent<HTMLAnchorElement>, position: number) {
    if (stale && (event.key === 'Enter' || event.key === ' ') && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (event.key === 'ArrowUp' && position === 0) {
        inputRef.current?.focus()
        return
      }
      const links = resultLinks()
      const next = event.key === 'ArrowDown' ? Math.min(position + 1, links.length - 1) : position - 1
      links[next]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      inputRef.current?.focus()
    }
  }

  useEffect(() => {
    if (active < 0) return
    listRef.current?.querySelectorAll<HTMLElement>('.search-page-result-link')[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const folderLabels = useMemo(() => searchFolderLabels(artifacts), [artifacts])
  const selectedFolderLabel = folder ? folderLabels.get(folder) ?? `${folder}/` : undefined
  const scope = folder ? ` in ${selectedFolderLabel}` : ''
  const count = !available ? '' : !query
    ? 'Type to search page text.'
    : state.status === 'loading'
      ? `Searching ${pageCountLabel(pageCount)}…`
      : state.status === 'error'
        ? `Search for “${query}” failed.`
        : shown.status === 'success'
          ? folder && !complete
            // Only part of the list is loaded: say so instead of presenting a folder total.
            ? `${pageCountLabel(hits.length)} in ${selectedFolderLabel} so far, among ${formatNumber(shown.hits.length)} of ${pageCountLabel(shown.total)} that contain “${query}”`
            : `${pageCountLabel(folder ? hits.length : shown.total)}${scope} ${(folder ? hits.length : shown.total) === 1 ? 'contains' : 'contain'} “${query}”`
          : ''

  return (
    <div className="search-page-wrap">
      <div className="search-page">
        <h1 className="page-text-visually-hidden">Search {siteTitle}</h1>
        {available ? (
          <>
            <form className="search-page-field" role="search" onSubmit={(event) => { event.preventDefault(); commitNow() }}>
              <Icon name="search" size={16} />
              <input
                ref={inputRef}
                id={SEARCH_PAGE_INPUT_ID}
                type="search"
                enterKeyHint="search"
                autoComplete="off"
                aria-label={`Search page text in ${siteTitle}`}
                placeholder="Search page text…"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                onKeyDown={handleKeyDown}
              />
              {draft ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Clear search"
                  onClick={() => {
                    setDraft('')
                    onQueryChange('')
                    inputRef.current?.focus()
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              ) : null}
            </form>
            <p className="search-page-count" role="status">
              <span className="search-page-count-text">{count}</span>
              {hits.length > 0 && !stale ? (
                <span className="search-page-keys" aria-hidden="true"><kbd>↓</kbd> results <kbd>↑</kbd><kbd>↓</kbd> move <kbd>↵</kbd> open</span>
              ) : null}
            </p>
            <div className="search-page-body">
              {query && facets.length > 0 ? (
                <nav className="search-page-facets" aria-label="Folders">
                  <span className="search-page-facets-label" aria-hidden="true">Folders</span>
                  <FacetButton label="All" count={allHits.length} selected={!folder} stale={stale} onSelect={() => onFolderChange(undefined)} />
                  {facets.map((facet) => (
                    <FacetButton
                      key={facet.folder}
                      label={folderLabels.get(facet.folder) ?? `${facet.folder}/`}
                      path={`${facet.folder}/`}
                      count={facet.count}
                      selected={facet.folder === folder}
                      stale={stale}
                      onSelect={() => onFolderChange(facet.folder)}
                    />
                  ))}
                </nav>
              ) : null}
              <div className="search-page-main" aria-busy={state.status === 'loading'}>
                {state.status === 'loading' && !stale ? (
                  <Skeleton />
                ) : state.status === 'error' ? (
                  <ErrorMessage error={state.error} onRetry={() => { onRetry(); inputRef.current?.focus() }} />
                ) : shown.status === 'success' && hits.length === 0 && !shown.hasMore ? (
                  <NoMatches
                    query={query}
                    folder={folder}
                    folderLabel={selectedFolderLabel}
                    multiWord={searchTerms(query).length > 1}
                    onSearchTitles={() => onSearchTitles(query)}
                    onClearFolder={() => onFolderChange(undefined)}
                  />
                ) : shown.status === 'success' ? (
                  <>
                    {hits.length === 0 ? (
                      <p className="search-page-partial">No pages in {selectedFolderLabel} among the results loaded so far.</p>
                    ) : null}
                    <ul ref={listRef} id={listId} className={`search-page-results${stale ? ' is-stale' : ''}`} aria-label="Results">
                      {hits.map((hit, position) => {
                        const artifact = artifactsById.get(hit.id)
                        const title = artifact?.title ?? hit.path.slice(hit.path.lastIndexOf('/') + 1)
                        const excerpt = byPath.get(hit.path) ?? null
                        const anchor = excerpt?.anchor || undefined
                        const href = anchor ? `${hitHref(hit)}#${encodeURIComponent(anchor)}` : hitHref(hit)
                        return (
                          <li key={hit.id} className="search-page-result" id={`${listId}-${position}`} data-active={position === active || undefined}>
                            <a
                              href={href}
                              className="search-page-result-link"
                              data-hit-id={hit.id}
                              onFocus={() => setActive(position)}
                              onKeyDown={(event) => handleLinkKeyDown(event, position)}
                              aria-disabled={stale ? 'true' : undefined}
                              onClick={(event) => {
                                // Plain activation of a stale result is ignored; modified clicks stay native.
                                if (stale && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                                  event.preventDefault()
                                  return
                                }
                                followInApp(event, () => onOpenHit(hit, anchor))
                              }}
                            >
                              <span className="search-page-result-title"><Highlighted text={title} query={query} /></span>
                              <span className="search-page-result-path">{hit.path}</span>
                              {excerpt ? (
                                <span className="search-page-result-excerpt">
                                  {excerpt.heading ? <span className="search-page-result-section">{excerpt.heading}</span> : null}
                                  <span className="search-page-result-snippet">{excerpt.parts.map((part, i) => part.mark ? <mark key={i}>{part.text}</mark> : <Fragment key={i}>{part.text}</Fragment>)}</span>
                                </span>
                              ) : null}
                            </a>
                          </li>
                        )
                      })}
                    </ul>
                    {shown.hasMore ? (
                      <button
                        type="button"
                        className="search-page-more"
                        aria-disabled={shown.more === 'loading' ? true : undefined}
                        onClick={(event) => {
                          if (shown.more === 'loading') return
                          if (document.activeElement === event.currentTarget) focusAfterMore.current = shown.hits.length
                          onLoadMore()
                        }}
                      >
                        {shown.more === 'loading'
                          ? 'Loading…'
                          : shown.more === 'error'
                            ? 'Could not load more. Try again'
                            : `Show ${formatNumber(Math.min(PAGE_TEXT_SEARCH_PAGE_SIZE, shown.total - shown.hits.length))} more (${formatNumber(shown.hits.length)} of ${formatNumber(shown.total)} shown)`}
                      </button>
                    ) : null}
                    {/* The button's own "Try again" text is not announced when it changes; this polite region is. */}
                    <span className="page-text-visually-hidden" role="status">
                      {shown.more === 'error' ? 'Could not load more results.' : ''}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </>
        ) : availability === 'loading' ? (
          <div className="search-page-main" aria-busy="true">
            <p className="search-page-count" role="status">Loading search…</p>
          </div>
        ) : availability === 'discovery-error' ? (
          <div className="search-page-main">
            <div className="page-text-search-message search-page-message" role="alert">
              <strong>{discoveryError.title}</strong>
              <span>{discoveryError.detail}</span>
              {onRetryDiscovery && discoveryError.retryable ? <button type="button" className="page-text-search-retry" onClick={onRetryDiscovery}>Try again</button> : null}
            </div>
          </div>
        ) : (
          <div className="search-page-main">
            <ErrorMessage error={new FullTextSearchError('unavailable', 'Full-text search is not enabled for this site')} onRetry={() => {}} />
          </div>
        )}
      </div>
    </div>
  )
}

function FacetButton({ label, path, count, selected, stale, onSelect }: { label: string; path?: string; count: number; selected: boolean; stale: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="search-page-facet" aria-pressed={selected} data-empty={count === 0 || undefined} onClick={onSelect}>
      <span className="search-page-facet-name"><span>{label}</span>{path ? <small>{path}</small> : null}</span>
      {stale ? <span className="search-page-skeleton-bar" style={{ width: 14, height: 10 }} /> : <span className="search-page-facet-count">{formatNumber(count)}</span>}
    </button>
  )
}

function Skeleton() {
  return (
    <ul className="search-page-results" aria-label="Loading results">
      {[0, 1, 2].map((item) => (
        <li className="search-page-result search-page-skeleton" key={item}>
          <span className="search-page-skeleton-bar" style={{ width: '38%', height: 15 }} />
          <span className="search-page-skeleton-bar" style={{ width: '24%', height: 10, marginTop: 8 }} />
        </li>
      ))}
    </ul>
  )
}

function NoMatches({
  query,
  folder,
  folderLabel,
  multiWord,
  onSearchTitles,
  onClearFolder,
}: {
  query: string
  folder?: string
  folderLabel?: string
  multiWord: boolean
  onSearchTitles: () => void
  onClearFolder: () => void
}) {
  return (
    <div className="search-page-empty">
      <Icon name="search" size={22} />
      <h2>{folder ? `No pages in ${folderLabel} contain “${query}”` : `No pages contain “${query}”`}</h2>
      <p>{multiWord ? 'Only pages that contain every word are listed. Try fewer words.' : 'Check the spelling or try a different word.'}</p>
      <div className="search-page-empty-actions">
        <button type="button" className="context-button" onClick={onSearchTitles}>
          <Icon name="tree" size={14} /><span>Search titles and paths only</span>
        </button>
        {folder ? (
          <button type="button" className="context-button" onClick={onClearFolder}>
            <Icon name="close" size={14} /><span>Clear folder filter ({folderLabel})</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ErrorMessage({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { title, detail, retryable } = describePageTextSearchError(error)
  return (
    <div className="page-text-search-message search-page-message" role="alert">
      <strong>{title}</strong>
      <span>{detail}</span>
      {retryable ? <button type="button" className="page-text-search-retry" onClick={onRetry}>Try again</button> : null}
    </div>
  )
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Marks the query's terms in a result title (case-insensitive; a display aid, not the core's matching). */
function Highlighted({ text, query }: { text: string; query: string }) {
  const terms = searchTerms(query).map(escapeRegExp)
  if (terms.length === 0) return <>{text}</>
  const parts = text.split(new RegExp(`(${terms.join('|')})`, 'gi'))
  return <>{parts.map((part, position) => position % 2 === 1 ? <mark key={position}>{part}</mark> : part)}</>
}
