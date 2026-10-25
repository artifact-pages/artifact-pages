import { formatDate, formatLongDate, displayLocale } from '../domain/display-locale'
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { Icon } from './Icon'
import type { ArtifactIndexEntry } from '../domain/index'
import { artifactByline } from '../domain/author-byline'
import { artifactSourceLinks } from '../domain/source-links'

export type ReaderColumnPart = 'contents' | 'details'

export const READER_COLUMN_QUERY = '(min-width: 1200px)'

type TocEntry = NonNullable<ArtifactIndexEntry['toc']>[number]

/**
 * The persistent right column of a document page at wide viewports (ISSUE-108): a compact source-update summary and Details trigger above Contents. On a Markdown page it sits inside the scrolling document, so Details scrolls
 * away while Contents stays; beside an HTML frame it scrolls on its own (`standalone`).
 */
export function ReaderContextColumn({ artifact, entries, activeId, standalone, summary, onDetails, detailsOpen, detailsButtonRef, onJump }: {
  artifact: ArtifactIndexEntry
  entries: TocEntry[]
  activeId: string | null
  standalone?: boolean
  /** Preview build summary; production uses the source update date. */
  summary?: ReactNode
  onDetails?: (trigger: HTMLButtonElement) => void
  detailsOpen?: boolean
  detailsButtonRef?: Ref<HTMLButtonElement>
  onJump: (id: string) => void
}) {
  const listRef = useRef<HTMLElement>(null)

  // The marked entry stays visible inside the list; only the list scrolls, never the document.
  useEffect(() => {
    const list = listRef.current
    const current = list?.querySelector<HTMLElement>('[aria-current="location"]')
    if (!list || !current) return
    const listRect = list.getBoundingClientRect()
    const rect = current.getBoundingClientRect()
    if (rect.top < listRect.top) list.scrollTop -= listRect.top - rect.top + 4
    else if (rect.bottom > listRect.bottom) list.scrollTop += rect.bottom - listRect.bottom + 4
  }, [activeId, entries])

  return (
    <aside
      className={`reader-column${standalone ? ' reader-column-standalone' : ''}`}
      aria-label="Reading context"
      data-reader-column=""
      lang="en"
    >
      <section className="reader-column-details" aria-labelledby="reader-column-details-heading">
        <div className="reader-column-summary">
          <span className="reader-update">{summary ?? <>Updated <time lang={displayLocale()} dateTime={artifact.updatedAt} title={artifact.updatedAt}>{formatDate(artifact.updatedAt)}</time></>}</span>
          <button ref={detailsButtonRef} id="reader-column-details-heading" type="button" className="reader-details-trigger" data-reader-part="details" aria-expanded={Boolean(detailsOpen)} aria-controls={detailsOpen ? 'reader-details-panel' : undefined} onClick={(event) => onDetails?.(event.currentTarget)}><Icon name="info" size={13} />Details</button>
        </div>
      </section>
      <section className="reader-column-contents" aria-labelledby="reader-column-contents-heading">
        <h2 id="reader-column-contents-heading" className="reader-column-heading">Contents</h2>
        {entries.length === 0 ? (
          <p className="toc-empty" tabIndex={-1} data-reader-part="contents-empty">This artifact does not include indexed headings.</p>
        ) : (
          <ContentsList navRef={listRef} entries={entries} activeId={activeId} onJump={onJump} />
        )}
      </section>
    </aside>
  )
}

/** Moves focus to a part of the column: Details, or Contents (the current entry, the first one, or the empty message). */
export function focusReaderColumnPart(part: ReaderColumnPart): boolean {
  const column = document.querySelector<HTMLElement>('[data-reader-column]')
  if (!column) return false
  const target = part === 'details'
    ? column.querySelector<HTMLElement>('[data-reader-part="details"]')
    : column.querySelector<HTMLElement>('.toc-link[aria-current="location"]')
      ?? column.querySelector<HTMLElement>('.toc-link')
      ?? column.querySelector<HTMLElement>('[data-reader-part="contents-empty"]')
  if (!target) return false
  target.focus()
  return document.activeElement === target
}

/**
 * The Contents list: chapters as dots on a vertical rail, with the part already read marked
 * (ISSUE-114). Shared by the reader column and the narrow-screen Contents panel.
 */
export function ContentsList({ entries, activeId, onJump, navRef }: {
  entries: TocEntry[]
  activeId: string | null
  onJump: (id: string) => void
  navRef?: Ref<HTMLElement>
}) {
  const activeIndex = activeId === null ? -1 : entries.findIndex((entry) => entry.id === activeId)
  let parentIndex = -1
  for (let i = activeIndex; i >= 0; i -= 1) {
    if (entries[i].level < 3) { parentIndex = i; break }
  }
  return (
    <nav ref={navRef} className="toc-list toc-rail" aria-label="Artifact headings">
      {entries.map((entry, i) => {
        const classes = ['toc-item', entry.level >= 3 ? 'toc-item-3' : 'toc-item-2']
        if (i === activeIndex) classes.push('is-current')
        else if (activeIndex >= 0 && i < activeIndex) classes.push('is-done')
        if (i === parentIndex && i !== activeIndex) classes.push('is-parent')
        return (
          <div className={classes.join(' ')} key={`${entry.id}:${entry.text}`}>
            <button
              className={`toc-link${entry.level >= 3 ? ' toc-level-3' : ''}`}
              type="button"
              title={entry.text}
              aria-current={i === activeIndex ? 'location' : undefined}
              onClick={() => onJump(entry.id)}
            >
              {entry.text}
            </button>
          </div>
        )
      })}
    </nav>
  )
}

/** The decorative byline circle: the author's GitHub avatar, or the name's initial when there is none or it fails to load. */
function DetailsAvatar({ name, avatarUrl }: { name: string, avatarUrl?: string }) {
  const [failedUrl, setFailedUrl] = useState<string>()
  const showImage = avatarUrl !== undefined && failedUrl !== avatarUrl
  return (
    <span className="details-avatar" aria-hidden="true">
      {showImage ? (
        <img
          className="details-avatar-image"
          src={avatarUrl}
          alt=""
          width={24}
          height={24}
          decoding="async"
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : Array.from(name)[0]?.toUpperCase()}
    </span>
  )
}

/** Details of a published document: a byline and a direct link to its source file (ISSUE-114). */
export function ArtifactDetails({ artifact }: { artifact: ArtifactIndexEntry }) {
  const { name: authorName, avatarUrl } = artifactByline(artifact)
  const source = artifact.source
  const sourceUrl = source ? artifactSourceLinks(artifact).sourceUrl : undefined
  const filePath = source?.filePath
  const sourceLabel = filePath || source?.repository

  return (
    <div className="artifact-details">
      <div className="details-byline">
        {authorName ? <DetailsAvatar name={authorName} avatarUrl={avatarUrl} /> : null}
        <span className="details-who">
          {authorName ? <span className="details-committer-name" title={authorName}>{authorName}</span> : null}
          <span className="details-updated">
            Updated <time lang={displayLocale()} dateTime={artifact.updatedAt}>{formatLongDate(artifact.updatedAt)}</time>
          </span>
        </span>
      </div>
      {source ? (
        <div className="details-source">
          {sourceUrl ? (
            <a className="details-file" href={sourceUrl} target="_blank" rel="noreferrer">
              <Icon name="file" size={13} />
              <span className={filePath ? 'details-path' : 'details-path-name'}>{sourceLabel}</span>
              <Icon name="external" size={12} />
            </a>
          ) : (
            <span className="details-file">
              <Icon name="file" size={13} />
              <span className={filePath ? 'details-path' : 'details-path-name'}>{sourceLabel}</span>
            </span>
          )}
          <span className="details-repo">
            {filePath ? <span className="details-repo-name">{source.repository}</span> : null}
            <span className="details-source-ref">{source.ref}</span>
          </span>
        </div>
      ) : null}
    </div>
  )
}
