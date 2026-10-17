import { useEffect, useRef } from 'react'
import { Icon } from './Icon'
import type { ArtifactIndexEntry } from '../domain/index'

export type ReaderColumnPart = 'contents' | 'details'

export const READER_COLUMN_QUERY = '(min-width: 1200px)'

type TocEntry = NonNullable<ArtifactIndexEntry['toc']>[number]

/**
 * The persistent right column of a document page at wide viewports (ISSUE-108): Details on top,
 * Contents below. On a Markdown page it sits inside the scrolling document, so Details scrolls
 * away while Contents stays; beside an HTML frame it scrolls on its own (`standalone`).
 */
export function ReaderContextColumn({ artifact, entries, activeId, standalone, onJump }: {
  artifact: ArtifactIndexEntry
  entries: TocEntry[]
  activeId: string | null
  standalone?: boolean
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
        <h2 id="reader-column-details-heading" className="reader-column-heading" tabIndex={-1} data-reader-part="details">Details</h2>
        <ArtifactDetails artifact={artifact} />
      </section>
      <section className="reader-column-contents" aria-labelledby="reader-column-contents-heading">
        <h2 id="reader-column-contents-heading" className="reader-column-heading">Contents</h2>
        {entries.length === 0 ? (
          <p className="toc-empty" tabIndex={-1} data-reader-part="contents-empty">This artifact does not include indexed headings.</p>
        ) : (
          <nav ref={listRef} className="toc-list" aria-label="Artifact headings">
            {entries.map((entry) => (
              <button
                className={`toc-link${entry.level >= 3 ? ' toc-level-3' : ''}`}
                key={`${entry.id}:${entry.text}`}
                type="button"
                title={entry.text}
                aria-current={activeId === entry.id ? 'location' : undefined}
                onClick={() => onJump(entry.id)}
              >
                {entry.text}
              </button>
            ))}
          </nav>
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

export function ArtifactDetails({ artifact }: { artifact: ArtifactIndexEntry }) {
  const committerName = artifact.lastCommitter?.name.trim()
  const repositoryUrl = safeHttpsUrl(artifact.source?.repositoryUrl)

  return (
    <div className="artifact-details">
      {committerName ? (
        <section className="details-committer" aria-label="Last commit">
          <p className="details-section-label">Last committed by</p>
          <div className="details-committer-card">
            <span className="details-avatar" aria-hidden="true">{Array.from(committerName)[0]?.toUpperCase()}</span>
            <span className="details-committer-name">{committerName}</span>
          </div>
        </section>
      ) : null}

      <div className="details-facts">
        <div className="details-fact">
          <span className="details-label">Updated</span>
          <time dateTime={artifact.updatedAt}>{formatLongDate(artifact.updatedAt)}</time>
        </div>
        {artifact.source ? (
          <div className="details-fact details-source-fact">
            <span className="details-label">Source</span>
            <div className="details-source-value">
              {repositoryUrl ? (
                <a className="details-source-link" href={repositoryUrl} target="_blank" rel="noreferrer">
                  <span>{artifact.source.repository}</span>
                  <Icon name="external" size={12} />
                </a>
              ) : (
                <span className="details-source-name">{artifact.source.repository}</span>
              )}
              <span className="details-source-ref">{artifact.source.ref}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function safeHttpsUrl(value?: string) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function formatLongDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}

