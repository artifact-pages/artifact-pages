import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { FullTextHit } from '../data/fulltext'
import type { ArtifactIndexEntry, SiteIndex } from '../domain/index'
import { searchTerms } from '../domain/text-highlight'
import { Icon } from './Icon'
import { describePageTextSearchError, type PageTextSearchState } from './usePageTextSearch'

export const PAGE_TEXT_SEARCH_INPUT_ID = 'page-text-search'

export function PageTextSearchBar({
  siteTitle,
  draft,
  committedQuery,
  onDraftChange,
  onCommit,
  onClear,
  onFocusResults,
}: {
  siteTitle: string
  draft: string
  committedQuery: string
  onDraftChange: (value: string) => void
  onCommit: (query: string) => void
  onClear: () => void
  onFocusResults: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="sidebar-filter page-text-search-bar">
      <Icon name="search" size={14} />
      <input
        ref={inputRef}
        id={PAGE_TEXT_SEARCH_INPUT_ID}
        type="search"
        enterKeyHint="search"
        aria-label={`Search page text in ${siteTitle}`}
        aria-describedby="page-text-search-status"
        aria-keyshortcuts="Meta+Shift+F Control+Shift+F"
        placeholder="Search page text…"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter that confirms an IME conversion must not submit the query.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (event.key === 'Enter') {
            event.preventDefault()
            const query = draft.trim()
            if (query) onCommit(query)
            else onClear()
          } else if (event.key === 'ArrowDown' && committedQuery) {
            event.preventDefault()
            onFocusResults()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            if (draft || committedQuery) onClear()
            else event.currentTarget.blur()
          }
        }}
      />
      {draft || committedQuery ? (
        <button type="button" className="filter-clear" aria-label="Clear page text search"
          onClick={() => {
            // The button removes itself; keep focus in the search field.
            onClear()
            inputRef.current?.focus()
          }}
        >
          <Icon name="close" size={12} />
        </button>
      ) : (
        <kbd className="page-text-search-shortcut" aria-hidden="true">⌘ ⇧ F</kbd>
      )}
    </div>
  )
}

type ResultGroup = { folder: string; hits: FullTextHit[] }

export function PageTextSearchResults({
  index,
  state,
  committedQuery,
  draft,
  currentArtifactId,
  listRef,
  onOpen,
  onRetry,
  onLoadMore,
  onFocusInput,
}: {
  index: SiteIndex
  state: PageTextSearchState
  committedQuery: string
  draft: string
  currentArtifactId?: string
  listRef: RefObject<HTMLDivElement | null>
  onOpen: (hit: FullTextHit) => void
  onRetry: () => void
  onLoadMore: () => void
  onFocusInput: () => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const artifactsById = useMemo(() => new Map(index.artifacts.map((artifact) => [artifact.id, artifact])), [index.artifacts])
  const pendingDraft = draft.trim() && draft.trim() !== committedQuery ? draft.trim() : ''
  const hits = state.status === 'success' ? state.hits : []
  const groups = useMemo(() => groupByFolder(hits), [hits])
  const position = currentArtifactId ? hits.findIndex(({ id }) => id === currentArtifactId) : -1

  // "Show more" keeps keyboard focus: once the next page arrives, focus moves
  // from the button to the first newly listed result. Focus that the reader
  // moved elsewhere while the page loaded (including to <body>, by clicking
  // plain text) stays where it is.
  const focusAfterMore = useRef<PendingMoreFocus | null>(null)
  // A result whose folder had to be expanded first; it is focused once rendered.
  const focusAfterExpand = useRef<string | null>(null)
  useEffect(() => {
    setCollapsed(new Set())
    focusAfterMore.current = null
    focusAfterExpand.current = null
  }, [committedQuery])
  useEffect(() => {
    const pending = focusAfterMore.current
    if (pending === null || state.status !== 'success' || state.more === 'loading') return
    focusAfterMore.current = null
    const list = listRef.current
    if (!list || state.more === 'error') return
    // Focus is still on the button, or on <body> because the button itself was
    // removed with the last page (not because the reader left it earlier).
    const active = document.activeElement
    const onMoreButton = pending.button.isConnected && active === pending.button
    const buttonRemoved = !pending.button.isConnected && !pending.leftByReader && (!active || active === document.body)
    if (!onMoreButton && !buttonRemoved) return
    // After a republish the list is re-listed from the start and may be shorter
    // than before; then focus its first result unless the button is still there.
    const target = state.hits[pending.first] ?? (onMoreButton ? undefined : state.hits[0])
    if (!target) return
    const row = [...list.querySelectorAll<HTMLElement>('[data-text-search-item="hit"]')]
      .find((element) => element.dataset.hitId === target.id)
    if (row) {
      row.focus()
      return
    }
    // The reader collapsed the folder the result belongs to: expand it, then focus the result.
    focusAfterExpand.current = target.id
    setCollapsed((set) => toggled(set, folderOf(target.path), false))
  }, [state, listRef])
  useEffect(() => {
    const id = focusAfterExpand.current
    if (id === null) return
    focusAfterExpand.current = null
    ;[...(listRef.current?.querySelectorAll<HTMLElement>('[data-text-search-item="hit"]') ?? [])]
      .find((element) => element.dataset.hitId === id)?.focus()
  }, [collapsed, listRef])

  function loadMore(button: HTMLButtonElement) {
    if (state.status !== 'success' || state.more === 'loading') return
    if (document.activeElement !== button) {
      focusAfterMore.current = null
    } else {
      const pending: PendingMoreFocus = { first: state.hits.length, button, leftByReader: false }
      focusAfterMore.current = pending
      // A blur while the button is still in the document means the reader moved
      // focus. Removing the focused button may also blur it, so the check waits
      // until that removal has finished.
      button.addEventListener('blur', () => {
        window.setTimeout(() => {
          if (button.isConnected && focusAfterMore.current === pending) pending.leftByReader = true
        }, 0)
      }, { once: true })
    }
    onLoadMore()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-text-search-item]')]
    const current = items.indexOf(event.target as HTMLButtonElement)
    if (current < 0) return
    const item = items[current]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (event.key === 'ArrowUp' && current === 0) {
        onFocusInput()
        return
      }
      items[Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const folder = item.dataset.folder ?? ''
      const isGroup = item.dataset.textSearchItem === 'group'
      if (isGroup) {
        event.preventDefault()
        setCollapsed((set) => toggled(set, folder, event.key === 'ArrowLeft'))
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        items.find((candidate) => candidate.dataset.textSearchItem === 'group' && candidate.dataset.folder === folder)?.focus()
      }
    }
  }

  return (
    <div className="sidebar-section page-text-results" role="region" aria-labelledby="page-text-search-status">
      <div className="sidebar-section-title page-text-results-title">
        {/* Only loading, result and error changes are announced; the pending-draft hint is not live. */}
        <span
          className={`sidebar-section-label${pendingDraft ? ' page-text-search-status-hidden' : ''}`}
          id="page-text-search-status"
          role="status"
        >
          <Icon name="search" size={12} />
          {statusLabel(state, index.artifacts.length)}
        </span>
        {pendingDraft ? (
          <span className="sidebar-section-label page-text-search-pending">
            <Icon name="search" size={12} />
            {`Press Enter to search “${pendingDraft}”`}
          </span>
        ) : null}
        {state.status === 'success' && state.total > 0 ? (
          <span className="mono">{position >= 0 ? `${position + 1} / ${state.total}` : state.total}</span>
        ) : null}
      </div>

      {state.status === 'loading' ? null : state.status === 'error' ? (
        <ErrorMessage
          error={state.error}
          onRetry={() => {
            // "Try again" disappears while the query reloads; keep focus in the search field.
            onRetry()
            onFocusInput()
          }}
        />
      ) : state.status === 'success' && state.total === 0 ? (
        <PageTextSearchMessage
          title="No pages contain these words"
          detail={searchTerms(state.query).length > 1
            ? 'Only pages that contain every word are listed. Try fewer words.'
            : 'Check the spelling or try a different word.'}
        />
      ) : state.status === 'success' ? (
        <div
          ref={listRef}
          className={`page-text-result-list${pendingDraft ? ' is-stale' : ''}`}
          onKeyDown={handleKeyDown}
        >
          {groups.map(({ folder, hits: groupHits }) => {
            const isCollapsed = collapsed.has(folder)
            return (
              <div className="page-text-result-group" key={folder}>
                <button
                  type="button"
                  className="page-text-result-folder"
                  data-text-search-item="group"
                  data-folder={folder}
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((set) => toggled(set, folder, !isCollapsed))}
                >
                  <Icon name="chevron" size={11} />
                  <span className="page-text-result-folder-name">{folder ? `${folder}/` : 'Top level'}</span>
                  <span className="page-text-result-folder-count">{groupHits.length}</span>
                </button>
                {isCollapsed ? null : groupHits.map((hit) => (
                  <ResultRow
                    key={hit.id}
                    hit={hit}
                    folder={folder}
                    artifact={artifactsById.get(hit.id)}
                    current={hit.id === currentArtifactId}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            )
          })}
          {state.hasMore ? (
            <button
              type="button"
              className="page-text-result-more"
              data-text-search-item="more"
              aria-disabled={state.more === 'loading' ? true : undefined}
              onClick={(event) => loadMore(event.currentTarget)}
            >
              {state.more === 'loading'
                ? 'Loading…'
                : state.more === 'error'
                  ? 'Could not load more. Try again'
                  : `Show ${Math.min(20, state.total - state.hits.length)} more (${state.hits.length} of ${state.total} shown)`}
            </button>
          ) : null}
          {/* The button's own "Try again" text is not announced when it changes; this polite region is. */}
          <span className="page-text-search-live" role="status">
            {state.more === 'error' ? 'Could not load more results.' : ''}
          </span>
        </div>
      ) : null}
    </div>
  )
}

type PendingMoreFocus = { first: number; button: HTMLButtonElement; leftByReader: boolean }

function ResultRow({
  hit,
  folder,
  artifact,
  current,
  onOpen,
}: {
  hit: FullTextHit
  folder: string
  artifact?: ArtifactIndexEntry
  current: boolean
  onOpen: (hit: FullTextHit) => void
}) {
  const filename = hit.path.slice(folder ? folder.length + 1 : 0)
  return (
    <button
      type="button"
      className={`page-text-result${current ? ' is-current' : ''}`}
      data-text-search-item="hit"
      data-folder={folder}
      data-hit-id={hit.id}
      aria-current={current ? 'page' : undefined}
      title={hit.path}
      onClick={() => onOpen(hit)}
    >
      <span className="page-text-result-title">{artifact?.title ?? filename}</span>
      <span className="page-text-result-path">{filename}</span>
    </button>
  )
}

function ErrorMessage({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { title, detail, retryable } = describePageTextSearchError(error)
  return <PageTextSearchMessage tone="error" title={title} detail={detail} action={retryable ? { label: 'Try again', onClick: onRetry } : undefined} />
}

function PageTextSearchMessage({
  title,
  detail,
  tone,
  action,
}: {
  title: string
  detail: string
  tone?: 'error'
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="page-text-search-message" role={tone === 'error' ? 'alert' : undefined}>
      <strong>{title}</strong>
      <span>{detail}</span>
      {action ? <button type="button" className="page-text-search-retry" onClick={action.onClick}>{action.label}</button> : null}
    </div>
  )
}

function statusLabel(state: PageTextSearchState, documentCount: number) {
  if (state.status === 'loading') return `Searching ${documentCount.toLocaleString('en-US')} pages…`
  if (state.status === 'error') return `“${state.query}”`
  if (state.status === 'success') return `${state.total.toLocaleString('en-US')} ${state.total === 1 ? 'page contains' : 'pages contain'} “${state.query}”`
  return 'Page text'
}

// Results arrive in path order; grouping by folder keeps that order readable.
function groupByFolder(hits: FullTextHit[]): ResultGroup[] {
  const groups = new Map<string, FullTextHit[]>()
  for (const hit of hits) {
    const folder = folderOf(hit.path)
    const group = groups.get(folder)
    if (group) group.push(hit)
    else groups.set(folder, [hit])
  }
  return [...groups].map(([folder, groupHits]) => ({ folder, hits: groupHits }))
}

function folderOf(path: string) {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function toggled(set: Set<string>, value: string, include: boolean) {
  if (set.has(value) === include) return set
  const next = new Set(set)
  if (include) next.add(value)
  else next.delete(value)
  return next
}
