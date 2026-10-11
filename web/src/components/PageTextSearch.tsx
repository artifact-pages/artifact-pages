import { useRef, type KeyboardEvent } from 'react'
import { Icon } from './Icon'
import { followInApp } from './spa-link'

/** The sidebar's title and path filter. On a site with page text search it also leads to the full-text results page. */
export const SIDEBAR_FILTER_INPUT_ID = 'sidebar-filter'

export function SidebarFilterBar({
  siteTitle,
  draft,
  onDraftChange,
  onSearchFullText,
  onFocusFirstMatch,
}: {
  siteTitle: string
  draft: string
  onDraftChange: (value: string) => void
  /** Enter on the field: open the results page for the trimmed draft. */
  onSearchFullText: (query: string) => void
  onFocusFirstMatch: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter that confirms an IME conversion must not submit the query.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      const query = draft.trim()
      if (query) onSearchFullText(query)
    } else if (event.key === 'ArrowDown' && draft.trim()) {
      event.preventDefault()
      onFocusFirstMatch()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (draft) onDraftChange('')
      else event.currentTarget.blur()
    }
  }

  return (
    <div className="sidebar-filter page-text-search-bar">
      <Icon name="search" size={14} />
      <input
        ref={inputRef}
        id={SIDEBAR_FILTER_INPUT_ID}
        type="search"
        enterKeyHint="search"
        aria-label={`Filter pages in ${siteTitle} by title or path`}
        aria-keyshortcuts="Meta+Shift+F Control+Shift+F"
        placeholder="Filter pages…"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {draft ? (
        <button type="button" className="filter-clear" aria-label="Clear filter"
          onClick={() => {
            // The button removes itself; keep focus in the field.
            onDraftChange('')
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

/** The last row of the filter's matches: opens the full-text results page. */
export function SearchFullTextRow({ query, href, onOpen }: { query: string; href: string; onOpen: () => void }) {
  return (
    <a href={href} className="tree-artifact sidebar-fulltext-row" onClick={(event) => followInApp(event, onOpen)}>
      <Icon name="search" size={13} />
      <span className="tree-label">Search full text for “{query}”</span>
      <kbd className="sidebar-fulltext-kbd" aria-label="Enter">↵</kbd>
    </a>
  )
}
