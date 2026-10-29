import { useEffect, useRef, useState } from 'react'
import type { PreviewGroup } from '../domain/preview'
import { listedGroups, loadPreviewList, peekPreviewList, resetPreviewList, type CheckedGroup, type PreviewListResult } from '../data/preview-list'
import { previewRouteHref } from '../data/previews'
import { formatPreviewTime } from '../domain/preview-time'
import { formatCount } from '../domain/display-locale'
import { splitPreviewDocuments, sharedChangedResources } from '../domain/preview-reader'
import type { AppRoute } from '../routing'
import { pageTitle, usePageTitle } from './usePageTitle'
import { useRestoredScroll } from './useRestoredScroll'

type PreviewListRoute = Extract<AppRoute, { kind: 'preview-list' }>
type PreviewListState =
  | { status: 'loading' }
  | { status: 'success'; groups: CheckedGroup[]; invalidCount: number; unsupportedCount: number }
  | { status: 'error'; error: Error }
  | { status: 'needs-republish' }

/** What one view shows of the shared catalog load: all groups, or only the one a group link names. */
function previewListState(result: PreviewListResult, groupId?: string): PreviewListState {
  if (result.status !== 'success') return result
  const checked = groupId ? result.checked.filter(({ group }) => group.id === groupId) : result.checked
  return {
    status: 'success',
    groups: listedGroups(checked),
    invalidCount: checked.filter(({ availability }) => availability === 'invalid').length,
    unsupportedCount: checked.filter(({ availability }) => availability === 'unsupported').length,
  }
}

export function PreviewListPage({ route, navigate, siteTitle }: {
  route: PreviewListRoute
  /** The registered site's title once the registry is loaded; the site ID until then. */
  siteTitle?: string
  navigate: (href: string) => void
}) {
  const siteName = siteTitle ?? route.siteId
  usePageTitle(pageTitle('Previews', siteName))
  // Shares the history entry's scroll offset with the site home's Previews section, so the swap keeps the place.
  const page = useRef<HTMLElement>(null)
  useRestoredScroll(page)

  return (
    <main className="preview-page" ref={page}>
      <header className="preview-page-header">
        <a className="preview-back-link" href={`/${encodeURIComponent(route.siteId)}`} onClick={(event) => {
          event.preventDefault()
          navigate(`/${encodeURIComponent(route.siteId)}`)
        }}>← {siteName}</a>
        <p className="eyebrow">{siteName} · Previews</p>
        <h1>{route.groupId ? 'Preview link' : 'Previews'}</h1>
        <p className="preview-page-lede">{PREVIEW_LEDE}</p>
      </header>
      <PreviewListContent siteId={route.siteId} groupId={route.groupId} navigate={navigate} showHomeLink />
    </main>
  )
}

export const PREVIEW_LEDE = 'Review changed documents, and documents affected by changed resources, from a specific source revision.'

/**
 * The preview list itself: loading, error (with retry), republish, empty and expired states, and the groups.
 * Shared by the standalone page and the Previews section of the site home (ISSUE-107).
 */
export function PreviewListContent({ siteId, groupId, navigate, showHomeLink = false }: {
  siteId: string
  groupId?: string
  navigate: (href: string) => void
  /** The standalone page offers a way back to the site home from its empty state; the site home has its own navigation. */
  showHomeLink?: boolean
}) {
  const [attempt, setAttempt] = useState(0)
  // A load another view already made (the section badge, the standalone page before the site index arrived)
  // shows at once, without a loading state.
  // The state belongs to the site, group and attempt it was computed for; for any other it is recomputed from
  // the shared load while rendering, so a changed `?group=` never shows the previous group's results.
  const key = `${siteId}\n${groupId ?? ''}\n${attempt}`
  const [stored, setStored] = useState<{ key: string; state: PreviewListState } | null>(null)
  const settledNow = peekPreviewList(siteId)
  const state: PreviewListState = stored?.key === key
    ? stored.state
    : settledNow ? previewListState(settledNow, groupId) : { status: 'loading' }
  const retryRef = useRef<HTMLButtonElement>(null)
  const focusRetry = useRef(false)

  useEffect(() => {
    let cancelled = false
    const settled = peekPreviewList(siteId)
    if (settled) {
      setStored({ key, state: previewListState(settled, groupId) })
    } else {
      loadPreviewList(siteId).then((result) => {
        if (!cancelled) setStored({ key, state: previewListState(result, groupId) })
      })
    }
    return () => { cancelled = true }
  }, [siteId, groupId, key])

  // After a retry the button is replaced by the loading status; focus returns to a failed retry's button.
  useEffect(() => {
    if (state.status === 'error' && focusRetry.current) {
      focusRetry.current = false
      retryRef.current?.focus()
    }
  }, [state])

  const siteHomeHref = `/${encodeURIComponent(siteId)}`

  return (
    <>
      {state.status === 'loading' ? <p role="status">Loading previews…</p> : null}
      {state.status === 'error' ? (
        <div className="preview-error">
          <p className="preview-empty" role="alert">The preview list could not be loaded.</p>
          <button
            ref={retryRef}
            type="button"
            className="text-action"
            onClick={() => {
              focusRetry.current = true
              resetPreviewList(siteId)
              setAttempt((n) => n + 1)
            }}
          >Try again</button>
        </div>
      ) : null}
      {state.status === 'needs-republish' ? (
        <section className="preview-empty-state" aria-label="Previews need to be republished">
          <h2>Previews need to be republished</h2>
          <p className="preview-empty" role="status">This site's preview list uses a format this version of Artifact Pages cannot read.</p>
          <p className="preview-empty-explanation">Ask the site owner to publish the previews again. The published site itself is not affected.</p>
        </section>
      ) : null}
      {state.status === 'success' && state.unsupportedCount > 0 ? (
        <p className="preview-availability" role="alert">Some previews need to be republished and are not listed.</p>
      ) : null}
      {state.status === 'success' && state.invalidCount > 0 ? (
        <p className="preview-availability" role="alert">Some preview catalog records did not match their revision manifests.</p>
      ) : null}
      {state.status === 'success' && state.groups.length === 0 ? groupId ? (
        <p className="preview-empty" role="status">This preview is no longer listed.</p>
      ) : (
        <section className="preview-empty-state" aria-label="No available previews">
          <p className="preview-empty" role="status">There are no available previews for this site.</p>
          <p className="preview-empty-explanation">
            Previews show changed documents from pull requests and manual preview builds. Once one is published for this site, its documents will appear here. If you expected a preview, check that publishing completed successfully.
          </p>
          {showHomeLink ? (
            <a className="preview-return-link" href={siteHomeHref} onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              event.preventDefault()
              navigate(siteHomeHref)
            }}>Back to site home</a>
          ) : null}
        </section>
      ) : null}
      {state.status === 'success' ? (
        <div className="preview-groups">
          {state.groups.map(({ group, availability }) => {
            const { changed, affected } = splitPreviewDocuments(group.documents)
            const sharedResources = sharedChangedResources(affected)
            return (
            <section className="preview-group" key={group.id} aria-label={`Preview ${group.id}`}>
              <div className="preview-group-heading">
                <div>
                  <p className="eyebrow">{group.kind === 'pull-request' ? 'Pull request' : 'Manual preview'}</p>
                  <h2>{group.kind === 'pull-request' ? `PR #${group.id.slice(3)}` : `Revision ${group.headSha.slice(0, 8)}`}</h2>
                  <p className="preview-group-meta mono">{group.headSha.slice(0, 12)} · <PreviewTimeLabel value={group.updatedAt} /></p>
                </div>
                {group.prUrl ? <a className="preview-external-link" href={group.prUrl} target="_blank" rel="noreferrer noopener">Open PR ↗</a> : null}
              </div>
              {availability === 'unknown' ? <p className="preview-availability" role="status">Availability could not be checked. Direct document links may still work.</p> : null}
              <PreviewDocumentList
                documents={changed}
                siteId={siteId}
                group={group}
                navigate={navigate}
              />
              {affected.length > 0 ? (
                <details className="preview-dependency-section">
                  <summary className="preview-dependency-summary"><h3 className="preview-dependency-heading">Affected by resource change <span>({formatCount(affected.length, 'page')})</span></h3></summary>
                  <p className="preview-dependency-note">These pages did not change, but a stylesheet, script, image, or other resource they use did.</p>
                  {sharedResources.length ? <p className="preview-shared-resources">Shared changed resources: {sharedResources.join(', ')}</p> : null}
                  <PreviewDocumentList
                    documents={affected}
                    sharedResources={sharedResources}
                    siteId={siteId}
                    group={group}
                    navigate={navigate}
                  />
                </details>
              ) : null}
            </section>
          )})}
        </div>
      ) : null}
    </>
  )
}

function PreviewDocumentList({ documents, siteId, group, navigate, sharedResources = [] }: {
  sharedResources?: readonly string[]
  documents: PreviewGroup['documents']
  siteId: string
  group: PreviewGroup
  navigate: (href: string) => void
}) {
  if (documents.length === 0) return null
  return (
    <ul className="preview-document-list">
      {documents.map((document) => {
        const uniqueResources = document.changedResources?.filter((resource) => !sharedResources.includes(resource)) ?? []
        const href = previewRouteHref(siteId, group.headSha, document.path, group.id)
        return (
          <li key={document.path}>
            <a href={href} onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              event.preventDefault()
              navigate(href)
            }}>
              <span>{document.title}</span>
              <code>{document.path}</code>
              {document.reason === 'dependency' && uniqueResources.length ? (
                <span className="preview-document-trigger">Uses changed {uniqueResources.join(', ')}</span>
              ) : null}
            </a>
          </li>
        )
      })}
    </ul>
  )
}

function PreviewTimeLabel({ value }: { value: string }) {
  const time = formatPreviewTime(value)
  return time.dateTime ? <time dateTime={time.dateTime} title={time.title}>{time.label}</time> : <>{time.label}</>
}
