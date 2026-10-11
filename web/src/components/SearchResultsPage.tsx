import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { FullTextSearchError, type FullTextHit } from '../data/fulltext'
import type { ArtifactIndexEntry } from '../domain/index'
import { folderFacets } from '../domain/search-facets'
import { scopeHits } from '../domain/search-ranking'
import { searchTerms } from '../domain/text-highlight'
import { Icon } from './Icon'
import { followInApp } from './spa-link'
import { describePageTextSearchError, PAGE_TEXT_SEARCH_PAGE_SIZE, type PageTextSearchState } from './usePageTextSearch'

export const SEARCH_PAGE_INPUT_ID = 'search-page-input'
/** Typing searches after this pause; Enter searches at once. */
const TYPING_DEBOUNCE_MS = 200

type SuccessState = Extract<PageTextSearchState, { status: 'success' }>

export function SearchResultsPage({
  siteTitle,
  pageCount,
  artifacts,
  available,
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
}: {
  siteTitle: string
  /** Pages in the site, named while searching. */
  pageCount: number
  artifacts: ArtifactIndexEntry[]
  /** False for a site published without page text search. */
  available: boolean
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
  onOpenHit: (hit: FullTextHit) => void
  /** Offers the sidebar-style title and path search for a query that matched no text. */
  onSearchTitles: (query: string) => void
}) {
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
    listRef.current?.querySelectorAll<HTMLElement>('a')[first]?.focus()
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
      if (active >= 0 && !stale && hits[active]) onOpenHit(hits[active])
      else commitNow()
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && hits.length > 0 && !stale) {
      event.preventDefault()
      setActive((index) => event.key === 'ArrowDown' ? Math.min(index + 1, hits.length - 1) : Math.max(index - 1, -1))
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

  useEffect(() => {
    if (active < 0) return
    listRef.current?.querySelectorAll<HTMLElement>('a')[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const scope = folder ? ` in ${folder}/` : ''
  const count = !available ? '' : !query
    ? 'Type to search page text.'
    : state.status === 'loading'
      ? `Searching ${pageCount.toLocaleString('en-US')} pages…`
      : state.status === 'error'
        ? `Search for “${query}” failed.`
        : shown.status === 'success'
          ? folder && !complete
            // Only part of the list is loaded: say so instead of presenting a folder total.
            ? `${hits.length.toLocaleString('en-US')} ${hits.length === 1 ? 'page' : 'pages'} in ${folder}/ so far, among ${shown.hits.length.toLocaleString('en-US')} of ${shown.total.toLocaleString('en-US')} pages that contain “${query}”`
            : `${folder ? hits.length.toLocaleString('en-US') : shown.total.toLocaleString('en-US')} ${(folder ? hits.length : shown.total) === 1 ? 'page' : 'pages'}${scope} ${(folder ? hits.length : shown.total) === 1 ? 'contains' : 'contain'} “${query}”`
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
                <span className="search-page-keys" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>↵</kbd> open</span>
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
                      label={`${facet.folder}/`}
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
                    multiWord={searchTerms(query).length > 1}
                    onSearchTitles={() => onSearchTitles(query)}
                    onClearFolder={() => onFolderChange(undefined)}
                  />
                ) : shown.status === 'success' ? (
                  <>
                    {hits.length === 0 ? (
                      <p className="search-page-partial">No pages in {folder}/ among the results loaded so far.</p>
                    ) : null}
                    <ul ref={listRef} id={listId} className={`search-page-results${stale ? ' is-stale' : ''}`} aria-label="Results">
                      {hits.map((hit, position) => {
                        const artifact = artifactsById.get(hit.id)
                        const title = artifact?.title ?? hit.path.slice(hit.path.lastIndexOf('/') + 1)
                        return (
                          <li key={hit.id} className="search-page-result" id={`${listId}-${position}`} data-active={position === active || undefined}>
                            <a
                              href={hitHref(hit)}
                              className="search-page-result-link"
                              data-hit-id={hit.id}
                              aria-current={position === active && !stale ? 'true' : undefined}
                              onClick={(event) => followInApp(event, () => onOpenHit(hit))}
                            >
                              <span className="search-page-result-title"><Highlighted text={title} query={query} /></span>
                              <span className="search-page-result-path">{hit.path}</span>
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
                            : `Show ${Math.min(PAGE_TEXT_SEARCH_PAGE_SIZE, shown.total - shown.hits.length)} more (${shown.hits.length} of ${shown.total} shown)`}
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
        ) : (
          <div className="search-page-main">
            <ErrorMessage error={new FullTextSearchError('unavailable', 'Full-text search is not enabled for this site')} onRetry={() => {}} />
          </div>
        )}
      </div>
    </div>
  )
}

function FacetButton({ label, count, selected, stale, onSelect }: { label: string; count: number; selected: boolean; stale: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="search-page-facet" aria-pressed={selected} data-empty={count === 0 || undefined} onClick={onSelect}>
      <span>{label}</span>
      {stale ? <span className="search-page-skeleton-bar" style={{ width: 14, height: 10 }} /> : <span className="search-page-facet-count">{count}</span>}
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
  multiWord,
  onSearchTitles,
  onClearFolder,
}: {
  query: string
  folder?: string
  multiWord: boolean
  onSearchTitles: () => void
  onClearFolder: () => void
}) {
  return (
    <div className="search-page-empty">
      <Icon name="search" size={22} />
      <h2>{folder ? `No pages in ${folder}/ contain “${query}”` : `No pages contain “${query}”`}</h2>
      <p>{multiWord ? 'Only pages that contain every word are listed. Try fewer words.' : 'Check the spelling or try a different word.'}</p>
      <div className="search-page-empty-actions">
        <button type="button" className="context-button" onClick={onSearchTitles}>
          <Icon name="tree" size={14} /><span>Search titles and paths only</span>
        </button>
        {folder ? (
          <button type="button" className="context-button" onClick={onClearFolder}>
            <Icon name="close" size={14} /><span>Clear folder filter ({folder}/)</span>
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
