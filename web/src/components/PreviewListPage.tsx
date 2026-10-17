import { useEffect, useRef, useState } from 'react'
import type { PreviewGroup } from '../domain/preview'
import { UnsupportedSchemaError } from '../data/schema'
import { loadPreviewCatalog, loadPreviewManifest, PreviewLoadError, previewRouteHref } from '../data/previews'
import { formatPreviewTime } from '../domain/preview-time'
import type { AppRoute } from '../routing'
import { pageTitle, usePageTitle } from './usePageTitle'

type PreviewListRoute = Extract<AppRoute, { kind: 'preview-list' }>
type GroupAvailability = 'available' | 'missing' | 'unknown' | 'invalid' | 'unsupported'

export function PreviewListPage({ route, navigate, siteTitle }: {
  route: PreviewListRoute
  /** The registered site's title once the registry is loaded; the site ID until then. */
  siteTitle?: string
  navigate: (href: string) => void
}) {
  const siteName = siteTitle ?? route.siteId
  usePageTitle(pageTitle('Previews', siteName))

  return (
    <main className="preview-page">
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
export function PreviewListContent({ siteId, groupId, navigate, showHomeLink = false, onCount }: {
  siteId: string
  groupId?: string
  navigate: (href: string) => void
  /** The standalone page offers a way back to the site home from its empty state; the site home has its own navigation. */
  showHomeLink?: boolean
  /** Called with the number of listed previews once the whole list (not a single group) has loaded. */
  onCount?: (count: number) => void
}) {
  const route = { siteId, groupId }
  const onCountRef = useRef(onCount)
  onCountRef.current = onCount
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'success'; groups: Array<{ group: PreviewGroup; availability: GroupAvailability }>; invalidCount: number; unsupportedCount: number }
    | { status: 'error'; error: Error }
    | { status: 'needs-republish' }
  >({ status: 'loading' })
  const retryRef = useRef<HTMLButtonElement>(null)
  const focusRetry = useRef(false)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    loadPreviewCatalog(route.siteId).then(async (catalog) => {
      const groups = route.groupId
        ? catalog.groups.filter(({ id }) => id === route.groupId)
        : catalog.groups
      const manifestsByHead = new Map<string, Promise<GroupAvailability>>()
      const checked = await Promise.all(groups.map(async (group) => {
        let availability = manifestsByHead.get(group.headSha)
        if (!availability) {
          availability = loadPreviewManifest(route.siteId, group.headSha).then((manifest) => (
            sameDocuments(group.documents, manifest.documents) ? 'available' as const : 'invalid' as const
          )).catch((error: unknown) => {
            if (error instanceof PreviewLoadError && error.status === 404) return 'missing' as const
            if (error instanceof UnsupportedSchemaError) return 'unsupported' as const
            if (error instanceof PreviewLoadError && error.kind === 'invalid') return 'invalid' as const
            return 'unknown' as const
          })
          manifestsByHead.set(group.headSha, availability)
        }
        return { group, availability: await availability }
      }))
      if (!cancelled) {
        const listed = checked.filter(({ availability }) => availability === 'available' || availability === 'unknown')
        if (!route.groupId) onCountRef.current?.(listed.length)
        setState({
          status: 'success',
          groups: listed
            .sort((left, right) => right.group.updatedAt.localeCompare(left.group.updatedAt)),
          invalidCount: checked.filter(({ availability }) => availability === 'invalid').length,
          unsupportedCount: checked.filter(({ availability }) => availability === 'unsupported').length,
        })
      }
    }).catch((error: unknown) => {
      if (cancelled) return
      if (error instanceof Error && 'status' in error && error.status === 404) {
        if (!route.groupId) onCountRef.current?.(0)
        setState({ status: 'success', groups: [], invalidCount: 0, unsupportedCount: 0 })
      } else if (error instanceof UnsupportedSchemaError) {
        setState({ status: 'needs-republish' })
      } else {
        setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) })
      }
    })
    return () => { cancelled = true }
  }, [route.siteId, route.groupId, attempt])

  // After a retry the button is replaced by the loading status; focus returns to a failed retry's button.
  useEffect(() => {
    if (state.status === 'error' && focusRetry.current) {
      focusRetry.current = false
      retryRef.current?.focus()
    }
  }, [state])

  const siteHomeHref = `/${encodeURIComponent(route.siteId)}`

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
              setAttempt((n) => n + 1)
            }}
          >Try again</button>
        </div>
      ) : null}
      {state.status === 'needs-republish' ? (
        <section className="preview-empty-state" aria-label="Previews need to be republished">
          <h2>Previews need to be republished</h2>
          <p className="preview-empty" role="status">This site's preview list uses a format this version of Git Artifact Pages cannot read.</p>
          <p className="preview-empty-explanation">Ask the site owner to publish the previews again. The published site itself is not affected.</p>
        </section>
      ) : null}
      {state.status === 'success' && state.unsupportedCount > 0 ? (
        <p className="preview-availability" role="alert">Some previews need to be republished and are not listed.</p>
      ) : null}
      {state.status === 'success' && state.invalidCount > 0 ? (
        <p className="preview-availability" role="alert">Some preview catalog records did not match their revision manifests.</p>
      ) : null}
      {state.status === 'success' && state.groups.length === 0 ? route.groupId ? (
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
          {state.groups.map(({ group, availability }) => (
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
                documents={group.documents.filter(({ reason }) => reason !== 'dependency')}
                siteId={route.siteId}
                group={group}
                navigate={navigate}
              />
              {group.documents.some(({ reason }) => reason === 'dependency') ? (
                <div className="preview-dependency-section" role="group" aria-label="Affected by resource change">
                  <h3 className="preview-dependency-heading">Affected by resource change</h3>
                  <p className="preview-dependency-note">These pages did not change, but a stylesheet, script, image, or other resource they use did.</p>
                  <PreviewDocumentList
                    documents={group.documents.filter(({ reason }) => reason === 'dependency')}
                    siteId={route.siteId}
                    group={group}
                    navigate={navigate}
                  />
                </div>
              ) : null}
            </section>
          ))}
        </div>
      ) : null}
    </>
  )
}

function PreviewDocumentList({ documents, siteId, group, navigate }: {
  documents: PreviewGroup['documents']
  siteId: string
  group: PreviewGroup
  navigate: (href: string) => void
}) {
  if (documents.length === 0) return null
  return (
    <ul className="preview-document-list">
      {documents.map((document) => {
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
              {document.reason === 'dependency' && document.changedResources?.length ? (
                <span className="preview-document-trigger">Uses changed {document.changedResources.join(', ')}</span>
              ) : null}
            </a>
          </li>
        )
      })}
    </ul>
  )
}

function sameDocuments(left: PreviewGroup['documents'], right: PreviewGroup['documents']) {
  return left.length === right.length && left.every((document, index) => (
    document.path === right[index]?.path && document.title === right[index]?.title && document.format === right[index]?.format
  ))
}

function PreviewTimeLabel({ value }: { value: string }) {
  const time = formatPreviewTime(value)
  return time.dateTime ? <time dateTime={time.dateTime} title={time.title}>{time.label}</time> : <>{time.label}</>
}
