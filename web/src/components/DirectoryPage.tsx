import type { ReactNode } from 'react'
import { pageCountLabel, pageHeadings, type DirectoryListing } from '../domain/directory'
import { artifactRouteHref } from '../routing'
import { Icon } from './Icon'
import { followInApp } from './spa-link'

/**
 * A directory as a page (ISSUE-075). Without a README or index page it lists
 * subfolders then pages (variant A); with one, `body` (that page rendered by the
 * caller) comes first and the children follow as a compact list (variant C).
 */
export function DirectoryPage({
  listing,
  siteId,
  body,
  resolveHref,
  onOpen,
}: {
  listing: DirectoryListing
  siteId: string
  /** The rendered README or index page; present exactly when `listing.indexArtifact` is. */
  body?: ReactNode
  /** Resolves a logical route to the link target a row carries (for example with `?q=` kept). */
  resolveHref: (href: string) => string
  onOpen: (href: string) => void
}) {
  const { folders, pages } = listing
  const routeOf = (path: string) => artifactRouteHref(siteId, path)
  const hasChildren = folders.length + pages.length > 0

  function link(path: string, hash = '') {
    const route = `${routeOf(path)}${hash}`
    return { href: resolveHref(route), onClick: (event: React.MouseEvent<HTMLElement>) => followInApp(event, () => onOpen(route)) }
  }

  return (
    <div className="directory-scroll" data-testid="directory-page" data-directory-variant={body ? 'index' : 'list'}>
      <div className="directory-page">
        {body ? (
          <>
            <p className="directory-eyebrow">Folder · {listing.path}/ · rendered from <code>{listing.indexArtifact?.path.split('/').at(-1)}</code></p>
            <div className="directory-body">{body}</div>
          </>
        ) : (
          <header className="directory-header">
            <p className="directory-eyebrow">Folder · {listing.path}/</p>
            <h1>{listing.name}</h1>
            <p className="directory-sub">
              {pageCountLabel(listing.pageCount)}
              {listing.latestUpdatedAt ? <> · updated <time dateTime={listing.latestUpdatedAt}>{formatDate(listing.latestUpdatedAt)}</time></> : null}
            </p>
          </header>
        )}

        {body ? (
          hasChildren ? (
            <nav className="directory-children" aria-labelledby="directory-children-title">
              <h2 id="directory-children-title">In this folder · {pageCountLabel(folders.length + pages.length)}</h2>
              <ul className="directory-compact">
                {folders.map((folder) => (
                  <li key={folder.path}>
                    <a {...link(folder.path)} data-directory-folder={folder.path}>
                      <Icon name="folder" size={14} />
                      <span className="directory-compact-title">{folder.name}/</span>
                      <span className="directory-meta">{pageCountLabel(folder.pageCount)}</span>
                    </a>
                  </li>
                ))}
                {pages.map((page) => (
                  <li key={page.id}>
                    <a {...link(page.path)} data-directory-page={page.path}>
                      <Icon name="file" size={14} />
                      <span className="directory-compact-title">{page.title}</span>
                      <span className="directory-meta"><time dateTime={page.updatedAt}>{formatDate(page.updatedAt)}</time></span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null
        ) : (
          <>
            {folders.length > 0 ? (
              <section aria-labelledby="directory-folders-title">
                <h2 className="directory-group-label" id="directory-folders-title">Folders</h2>
                <ul className="directory-list">
                  {folders.map((folder) => (
                    <li key={folder.path} className="directory-row">
                      <span className="directory-row-icon"><Icon name="folder" size={16} /></span>
                      <span className="directory-row-main">
                        <a className="directory-row-title directory-row-link" {...link(folder.path)} data-directory-folder={folder.path}>{folder.name}</a>
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
            {pages.length > 0 ? (
              <section aria-labelledby="directory-pages-title">
                <h2 className="directory-group-label" id="directory-pages-title">Pages</h2>
                <ul className="directory-list">
                  {pages.map((page) => {
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
          </>
        )}
      </div>
    </div>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}
