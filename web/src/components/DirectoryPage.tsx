import { useEffect, useRef, useState, type ReactNode } from 'react'
import { pageCountLabel, pageHeadings, type DirectoryListing } from '../domain/directory'
import { DIRECTORY_PAGE_SIZE, clampPage, pageRange, pageTotal, splitRange } from '../domain/row-window'
import { artifactRouteHref } from '../routing'
import { Icon } from './Icon'
import { followInApp } from './spa-link'

// Above this many children the compact list shows only the first rows (ISSUE-075, owner decision 2026-10-12).
const COMPACT_LIST_CAP_THRESHOLD = 12
const COMPACT_LIST_COLLAPSED_ROWS = 10
const COMPACT_LIST_ID = 'directory-children-list'

/**
 * A directory as a page (ISSUE-075). The header comes first, then the children,
 * then the README or index page (`body`, rendered by the caller) under a file
 * label. Without a body the children are full rows (variant A); with one they are
 * a compact list that shows the first rows and expands on request.
 */
export function DirectoryPage({
  listing,
  siteId,
  body,
  header,
  footer,
  resolveHref = (href) => href,
  onOpen,
}: {
  listing: DirectoryListing
  siteId: string
  /** The rendered README or index page; present exactly when `listing.indexArtifact` is. */
  body?: ReactNode
  /** Replaces the folder header (the site root passes the site header). */
  header?: ReactNode
  /** Rendered at the end of the page, after the body. */
  footer?: ReactNode
  /** Resolves a logical route to the link target a row carries (for example with `?q=` kept). */
  resolveHref?: (href: string) => string
  onOpen: (href: string) => void
}) {
  const { folders, pages } = listing
  const routeOf = (path: string) => artifactRouteHref(siteId, path)
  const total = folders.length + pages.length
  const hasChildren = total > 0
  const capped = total > COMPACT_LIST_CAP_THRESHOLD
  const [expanded, setExpanded] = useState(false)
  const moreButton = useRef<HTMLButtonElement>(null)
  // The page index belongs to one folder: it is ignored once `listing.path` changes.
  const [pageState, setPageState] = useState({ path: listing.path, page: 0 })
  const page = clampPage(pageState.path === listing.path ? pageState.page : 0, total)
  const pagerNeeded = total > DIRECTORY_PAGE_SIZE && (!body || !capped || expanded)
  const collapsed = Boolean(body) && capped && !expanded
  const { start, end } = collapsed ? { start: 0, end: COMPACT_LIST_COLLAPSED_ROWS } : pageRange(page, total)
  const range = splitRange(folders.length, pages.length, start, end)
  const scrollRoot = useRef<HTMLDivElement>(null)
  const focusFirstRow = useRef(false)
  useEffect(() => {
    if (!focusFirstRow.current) return
    focusFirstRow.current = false
    const first = scrollRoot.current?.querySelector<HTMLElement>('a[data-directory-folder], a[data-directory-page]')
    first?.focus()
    first?.scrollIntoView({ block: 'nearest' })
  }, [page, listing.path])

  function goToPage(next: number) {
    focusFirstRow.current = true
    setPageState({ path: listing.path, page: clampPage(next, total) })
  }

  function link(path: string, hash = '') {
    const route = `${routeOf(path)}${hash}`
    return { href: resolveHref(route), onClick: (event: React.MouseEvent<HTMLElement>) => followInApp(event, () => onOpen(route)) }
  }

  const shownFolders = folders.slice(...range.folders)
  const shownPages = pages.slice(...range.pages)
  const pager = pagerNeeded ? (
    <nav className="directory-pager" aria-label="Pages of this folder">
      <button type="button" className="text-action" disabled={page === 0} onClick={() => goToPage(page - 1)}>Previous</button>
      <span aria-live="polite">
        Showing {(start + 1).toLocaleString('en-US')}–{end.toLocaleString('en-US')} of {total.toLocaleString('en-US')}
      </span>
      <button type="button" className="text-action" disabled={page >= pageTotal(total) - 1} onClick={() => goToPage(page + 1)}>Next</button>
    </nav>
  ) : null
  const compactRows = [
    ...shownFolders.map((folder) => (
      <li key={folder.path}>
        <a {...link(folder.path)} data-directory-folder={folder.path}>
          <Icon name="folder" size={14} />
          <span className="directory-compact-title">{folder.label}{folder.label === folder.name ? '/' : ''}</span>
          <span className="directory-meta">{pageCountLabel(folder.pageCount)}</span>
        </a>
      </li>
    )),
    ...shownPages.map((page) => (
      <li key={page.id}>
        <a {...link(page.path)} data-directory-page={page.path}>
          <Icon name="file" size={14} />
          <span className="directory-compact-title">{page.title}</span>
          <span className="directory-meta"><time dateTime={page.updatedAt}>{formatDate(page.updatedAt)}</time></span>
        </a>
      </li>
    )),
  ]

  return (
    <div className="directory-scroll" ref={scrollRoot} data-testid="directory-page" data-directory-variant={body ? 'index' : 'list'}>
      <div className="directory-page">
        {header ?? (
          <header className="directory-header">
            <p className="directory-eyebrow">Folder · {listing.path}/</p>
            <h1>{listing.label}</h1>
            <p className="directory-sub">
              {pageCountLabel(listing.pageCount)}
              {listing.latestUpdatedAt ? <> · updated <time dateTime={listing.latestUpdatedAt}>{formatDate(listing.latestUpdatedAt)}</time></> : null}
            </p>
          </header>
        )}

        {body ? (
          hasChildren ? (
            <nav className="directory-children" aria-labelledby="directory-children-title">
              <h2 id="directory-children-title">In this folder · {pageCountLabel(total)}</h2>
              <ul className="directory-compact" id={COMPACT_LIST_ID}>{compactRows}</ul>
              {pager}
              {capped ? (
                <button
                  ref={moreButton}
                  type="button"
                  className="directory-more"
                  aria-expanded={expanded}
                  aria-controls={COMPACT_LIST_ID}
                  onClick={() => {
                    setExpanded((current) => !current)
                    moreButton.current?.focus()
                  }}
                >{expanded ? 'Show fewer' : `Show all ${total} items`}</button>
              ) : null}
            </nav>
          ) : null
        ) : (
          <>
            {shownFolders.length > 0 ? (
              <section aria-labelledby="directory-folders-title">
                <h2 className="directory-group-label" id="directory-folders-title">Folders</h2>
                <ul className="directory-list">
                  {shownFolders.map((folder) => (
                    <li key={folder.path} className="directory-row">
                      <span className="directory-row-icon"><Icon name="folder" size={16} /></span>
                      <span className="directory-row-main">
                        <a className="directory-row-title directory-row-link" {...link(folder.path)} data-directory-folder={folder.path}>{folder.label}</a>
                      </span>
                      <span className="directory-meta">
                        {pageCountLabel(folder.pageCount)}
                        {folder.latestUpdatedAt ? <> · <time dateTime={folder.latestUpdatedAt}>{formatDate(folder.latestUpdatedAt)}</time></> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {shownPages.length > 0 ? (
              <section aria-labelledby="directory-pages-title">
                <h2 className="directory-group-label" id="directory-pages-title">Pages</h2>
                <ul className="directory-list">
                  {shownPages.map((page) => {
                    const { shown, hidden } = pageHeadings(page)
                    const committer = page.lastCommitter?.name.trim()
                    return (
                      <li key={page.id} className="directory-row">
                        <span className="directory-row-icon"><Icon name="file" size={16} /></span>
                        <span className="directory-row-main">
                          <a className="directory-row-title directory-row-link" {...link(page.path)} data-directory-page={page.path}>{page.title}</a>
                          {shown.length > 0 ? (
                            <ul className="directory-chips" aria-label={`Sections of ${page.title}`}>
                              {shown.map((heading) => (
                                <li key={`${heading.id}:${heading.text}`}>
                                  <a className="directory-chip" {...link(page.path, `#${encodeURIComponent(heading.id)}`)}>{heading.text}</a>
                                </li>
                              ))}
                              {hidden > 0 ? (
                                <li><a className="directory-chip directory-chip-more" {...link(page.path)} aria-label={`${hidden} more sections in ${page.title}`}>+{hidden}</a></li>
                              ) : null}
                            </ul>
                          ) : null}
                        </span>
                        <span className="directory-meta">
                          <time dateTime={page.updatedAt}>{formatDate(page.updatedAt)}</time>
                          {committer ? <> · {committer}</> : null}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : null}
            {pager}
          </>
        )}

        {body ? (
          <>
            <div className="directory-readme-label">
              <Icon name="file" size={14} />
              <code>{listing.indexArtifact?.path.split('/').at(-1)}</code>
            </div>
            <div className="directory-body">{body}</div>
          </>
        ) : null}
        {footer}
      </div>
    </div>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}
