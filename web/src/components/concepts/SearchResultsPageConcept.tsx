import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Icon } from '../Icon'
import { MockContextBar, MockSidebar, ReaderFrame } from './chrome'
import { buildTree, architectureSite } from './data'
import { useConceptLayout } from './parts'
import {
  folderOf,
  navigatorArticle,
  queryTerms,
  searchFolders,
  searchPages,
  type FolderFilter,
  type SearchPage,
} from './searchResultsData'

/** Concept for the full-text search results page. Mock data only; production components are untouched. */

export type SearchPageState = 'results' | 'loading' | 'no-snippets' | 'navigator'

const MAX_GROUPS = 3
const sidebarRoot = buildTree(architectureSite.pages)

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Wraps query terms in <mark>. `current` gives the document-wide index of this text's first mark and the active one. */
function Highlight({ text, terms, current }: { text: string; terms: string[]; current?: { index: number; start: number } }) {
  if (!terms.length) return <>{text}</>
  const parts = text.split(new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi'))
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part
        const isCurrent = current !== undefined && current.start + (i - 1) / 2 === current.index
        return <mark key={i} className={isCurrent ? 'srp-mark-current' : undefined} data-current={isCurrent || undefined}>{part}</mark>
      })}
    </>
  )
}

function FullTextRow({ query }: { query: string }) {
  return (
    <a href="#results" className="tree-artifact srp-ft-row" aria-current="page" onClick={(e) => e.preventDefault()}>
      <Icon name="search" size={13} />
      <span className="tree-label">Search full text for “{query}”</span>
      <kbd className="srp-kbd" aria-label="Enter">↵</kbd>
    </a>
  )
}

/** Sidebar filter: titles and paths only, ending with the row that opens the results page. */
function SidebarFilter({ query }: { query: string }) {
  const q = query.trim().toLowerCase()
  const hits = q ? architectureSite.pages.filter((p) => `${p.title} ${p.path}`.toLowerCase().includes(q)) : []
  return (
    <div className="sidebar-section">
      <div className="sidebar-section-title"><span className="sidebar-section-label"><Icon name="search" size={12} />Titles and paths</span></div>
      {hits.length ? (
        hits.slice(0, 5).map((p) => (
          <div className="tree-artifact-row" key={p.path}>
            <a href="#page" className="tree-artifact" style={{ paddingInlineStart: 10 }} onClick={(e) => e.preventDefault()}>
              <span className="tree-label">{p.title}</span>
              <span className="page-text-result-path">{p.path}</span>
            </a>
          </div>
        ))
      ) : (
        <p className="sidebar-empty">No titles or paths match “{query}”.</p>
      )}
      <FullTextRow query={query} />
    </div>
  )
}

/** Desktop reader frame with the sidebar, or a 390 px phone without it in the narrow layout. */
function Frame({ sidebarQuery, crumb, children }: { sidebarQuery: string; crumb: string; children: ReactNode }) {
  const layout = useConceptLayout()
  if (layout === 'narrow') {
    return (
      <div className="nv-phone srp-phone" data-pattern="menu">
        <div className="nv-main">
          <header className="nv-bar">
            <button type="button" className="icon-button" aria-label="Open navigation"><Icon name="sidebar" size={16} /></button>
            <span className="nv-title">{crumb}</span>
          </header>
          <div className="rux-pane">{children}</div>
        </div>
      </div>
    )
  }
  return (
    <div className="srp-frame">
      <ReaderFrame
        sidebar={
          <MockSidebar siteTitle="Architecture" root={sidebarRoot} expanded={['ja']} query={sidebarQuery}>
            <SidebarFilter query={sidebarQuery} />
          </MockSidebar>
        }
        bar={<MockContextBar crumbs={[{ label: 'Architecture', link: true }, { label: crumb }]} />}
      >
        {children}
      </ReaderFrame>
    </div>
  )
}

function Skeleton() {
  return (
    <ul className="srp-results" aria-busy="true" aria-label="Loading results">
      {[0, 1, 2].map((i) => (
        <li className="srp-result srp-skel" key={i}>
          <span className="srp-skel-bar" style={{ width: '38%', height: 15 }} />
          <span className="srp-skel-bar" style={{ width: '24%', height: 10, marginTop: 8 }} />
          <span className="srp-skel-bar" style={{ width: '46%', height: 10, marginTop: 14 }} />
          <span className="srp-skel-bar" style={{ width: '92%', height: 11, marginTop: 8 }} />
          <span className="srp-skel-bar" style={{ width: '70%', height: 11, marginTop: 6 }} />
        </li>
      ))}
    </ul>
  )
}

function ResultItem({ page, terms, active, id, withSnippets }: { page: SearchPage; terms: string[]; active: boolean; id: string; withSnippets: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const groups = expanded ? page.matches : page.matches.slice(0, MAX_GROUPS)
  const more = page.matches.length - MAX_GROUPS
  return (
    <li className="srp-result" id={id} data-active={active || undefined} aria-current={active || undefined} lang={folderOf(page.path)}>
      <a href="#page" className="srp-title" onClick={(e) => e.preventDefault()}><Highlight text={page.title} terms={terms} /></a>
      <span className="srp-path">{page.path}</span>
      {withSnippets ? (
        <>
          <ol className="srp-groups">
            {groups.map((m, i) => (
              <li className="srp-group" key={i}>
                <a href="#anchor" className="srp-trail" onClick={(e) => e.preventDefault()}>
                  {m.trail.map((h, j) => (
                    <span key={j}>{j > 0 ? <span className="srp-trail-sep" aria-hidden="true"> › </span> : null}{h}</span>
                  ))}
                </a>
                <p className="srp-snippet"><Highlight text={m.text} terms={terms} /></p>
              </li>
            ))}
          </ol>
          {more > 0 ? (
            <button type="button" className="srp-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show fewer matches' : `+${more} more ${more === 1 ? 'match' : 'matches'} in this page`}
            </button>
          ) : null}
        </>
      ) : null}
    </li>
  )
}

export function SearchResultsPage({
  initialQuery,
  initialFolder = 'all',
  state = 'results',
}: {
  initialQuery: string
  initialFolder?: FolderFilter
  state?: Exclude<SearchPageState, 'navigator'>
}) {
  const [query, setQuery] = useState(initialQuery)
  const [folder, setFolder] = useState<FolderFilter>(initialFolder)
  const [active, setActive] = useState(-1)
  const [opened, setOpened] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const terms = queryTerms(query)
  const all = searchPages(query)
  const folderCounts = searchFolders.map((f) => [f, all.filter((p) => folderOf(p.path) === f).length] as const)
  const shown = folder === 'all' ? all : all.filter((p) => folderOf(p.path) === folder)
  const matchTotal = shown.reduce((sum, p) => sum + p.matches.length, 0)
  const withSnippets = state !== 'no-snippets'
  const loading = state === 'loading'
  const scope = folder === 'all' ? '' : ` in ${folder}/`

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (loading || !shown.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpened(null)
      setActive((i) => (e.key === 'ArrowDown' ? Math.min(i + 1, shown.length - 1) : Math.max(i - 1, 0)))
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault()
      setOpened(shown[active].title)
    }
  }

  const count = !query.trim()
    ? 'Type to search page text.'
    : loading
      ? 'Searching…'
      : !shown.length
        ? `No pages${scope} contain “${query}”`
        : withSnippets
          ? `${shown.length} ${shown.length === 1 ? 'page' : 'pages'} · ${matchTotal} ${matchTotal === 1 ? 'match' : 'matches'} for “${query}”${scope}`
          : `${shown.length} ${shown.length === 1 ? 'page' : 'pages'} for “${query}”${scope}`

  return (
    <Frame sidebarQuery={query} crumb="Search">
      <div className="srp-wrap" ref={listRef}>
        <div className="srp">
          <form className="srp-field" role="search" onSubmit={(e) => e.preventDefault()}>
            <Icon name="search" size={16} />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(-1); setOpened(null) }}
              placeholder="Search page text…"
              aria-label="Search page text"
              onKeyDown={onKeyDown}
              autoComplete="off"
            />
            {query ? <button type="button" className="icon-button" aria-label="Clear search" onClick={() => { setQuery(''); setActive(-1) }}><Icon name="close" size={13} /></button> : null}
          </form>
          <p className="srp-count" role="status">
            {loading ? <span className="srp-skel-bar" style={{ width: 190, height: 12 }} /> : count}
            {!loading && shown.length ? <span className="srp-keys"><kbd className="srp-kbd">↑</kbd><kbd className="srp-kbd">↓</kbd> move <kbd className="srp-kbd">↵</kbd> open</span> : null}
          </p>
          <div className="srp-body">
            <nav className="srp-facets" aria-label="Folders">
              <span className="srp-facets-label">Folders</span>
              <FacetButton label="All" count={all.length} selected={folder === 'all'} loading={loading} onSelect={() => { setFolder('all'); setActive(-1) }} />
              {folderCounts.map(([f, n]) => (
                <FacetButton key={f} label={`${f}/`} count={n} selected={folder === f} loading={loading} onSelect={() => { setFolder(f); setActive(-1) }} />
              ))}
            </nav>
            <div className="srp-main">
              {loading ? (
                <Skeleton />
              ) : !query.trim() ? null : !shown.length ? (
                <NoMatches query={query} folder={folder} onClearFolder={() => setFolder('all')} />
              ) : (
                <>
                  {!withSnippets ? (
                    <p className="srp-note"><Icon name="info" size={14} />Preview not available for this site yet. Pages are listed without the matching passage.</p>
                  ) : null}
                  <ul className="srp-results" id="srp-list" aria-label="Results">
                    {shown.map((p, i) => (
                      <ResultItem key={p.path} page={p} terms={terms} active={i === active} id={`srp-result-${i}`} withSnippets={withSnippets} />
                    ))}
                  </ul>
                  {opened ? <p className="srp-opened" role="status">Mock: would open “{opened}”.</p> : null}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </Frame>
  )
}

function FacetButton({ label, count, selected, loading, onSelect }: { label: string; count: number; selected: boolean; loading: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="srp-facet" aria-pressed={selected} data-empty={(!loading && count === 0) || undefined} onClick={onSelect}>
      <span>{label}</span>
      {loading ? <span className="srp-skel-bar" style={{ width: 14, height: 10 }} /> : <span className="srp-facet-count">{count}</span>}
    </button>
  )
}

function NoMatches({ query, folder, onClearFolder }: { query: string; folder: FolderFilter; onClearFolder: () => void }) {
  return (
    <div className="srp-empty">
      <Icon name="search" size={22} />
      <h2>{folder === 'all' ? `No pages contain “${query}”` : `No pages in ${folder}/ contain “${query}”`}</h2>
      <p>Check the spelling, try a shorter word, or widen the search.</p>
      <div className="srp-empty-actions">
        <button type="button" className="context-button"><Icon name="tree" size={14} /><span>Search titles and paths only</span></button>
        {folder !== 'all' ? <button type="button" className="context-button" onClick={onClearFolder}><Icon name="close" size={14} /><span>Clear folder filter ({folder}/)</span></button> : null}
      </div>
    </div>
  )
}

/** Destination page: article with the floating "term  2 / 5  ↑ ↓  ×" bar. */
export function MatchNavigatorPage({ query }: { query: string }) {
  const terms = queryTerms(query)
  const [open, setOpen] = useState(true)
  const [index, setIndex] = useState(1)
  const docRef = useRef<HTMLDivElement>(null)
  const pattern = new RegExp(terms.map(escapeRegExp).join('|'), 'gi')
  const counts = navigatorArticle.map((b) => (terms.length ? b.text.match(pattern)?.length ?? 0 : 0))
  const offsets = counts.map((_, i) => counts.slice(0, i).reduce((a, b) => a + b, 0))
  const total = counts.reduce((a, b) => a + b, 0)
  const articleRef = useRef<HTMLElement>(null)

  useEffect(() => {
    docRef.current?.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'center' })
  }, [index, open])

  const step = (d: number) => { if (total) setIndex((i) => (i + d + total) % total) }
  const close = () => { setOpen(false); articleRef.current?.focus() }
  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === 'Escape') close()
    else if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); step(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
  }

  return (
    <Frame sidebarQuery={query} crumb="04 インデックスと検索">
      <div className="srp-doc-host">
        <div className="srp-doc-scroll" ref={docRef}>
          <article className="markdown-article srp-doc" lang="ja" tabIndex={-1} ref={articleRef}>
            {navigatorArticle.map((b, i) => {
              const content = <Highlight text={b.text} terms={open ? terms : []} current={{ index, start: offsets[i] }} />
              return b.kind === 'h1' ? <h1 key={i}>{content}</h1> : b.kind === 'h2' ? <h2 key={i}>{content}</h2> : <p key={i}>{content}</p>
            })}
          </article>
        </div>
        {open && total > 0 ? (
          <div className="srp-navbar" role="group" aria-label="Matches in this page" onKeyDown={onKeyDown}>
            <span className="srp-navbar-term">{query}</span>
            <span className="srp-navbar-count">{index + 1} / {total}</span>
            <button type="button" className="icon-button" aria-label="Previous match" onClick={() => step(-1)}>↑</button>
            <button type="button" className="icon-button" aria-label="Next match" onClick={() => step(1)}>↓</button>
            <button type="button" className="icon-button" aria-label="Close match navigator" onClick={close}><Icon name="close" size={13} /></button>
          </div>
        ) : null}
      </div>
    </Frame>
  )
}
