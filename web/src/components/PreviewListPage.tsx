import { useEffect, useState } from 'react'
import type { PreviewGroup } from '../domain/preview'
import { loadPreviewCatalog, loadPreviewManifest, PreviewLoadError, previewRouteHref } from '../data/previews'
import type { AppRoute } from '../routing'
import { pageTitle, usePageTitle } from './usePageTitle'

type PreviewListRoute = Extract<AppRoute, { kind: 'preview-list' }>
type GroupAvailability = 'available' | 'missing' | 'unknown' | 'invalid'

export function PreviewListPage({ route, navigate, siteTitle }: {
  route: PreviewListRoute
  /** The registered site's title once the registry is loaded; the site ID until then. */
  siteTitle?: string
  navigate: (href: string) => void
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'success'; groups: Array<{ group: PreviewGroup; availability: GroupAvailability }>; invalidCount: number }
    | { status: 'error'; error: Error }
  >({ status: 'loading' })

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
            if (error instanceof PreviewLoadError && error.kind === 'invalid') return 'invalid' as const
            return 'unknown' as const
          })
          manifestsByHead.set(group.headSha, availability)
        }
        return { group, availability: await availability }
      }))
      if (!cancelled) {
        setState({
          status: 'success',
          groups: checked.filter(({ availability }) => availability === 'available' || availability === 'unknown')
            .sort((left, right) => right.group.updatedAt.localeCompare(left.group.updatedAt)),
          invalidCount: checked.filter(({ availability }) => availability === 'invalid').length,
        })
      }
    }).catch((error: unknown) => {
      if (cancelled) return
      if (error instanceof Error && 'status' in error && error.status === 404) {
        setState({ status: 'success', groups: [], invalidCount: 0 })
      } else {
        setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) })
      }
    })
    return () => { cancelled = true }
  }, [route.siteId, route.groupId])

  const siteName = siteTitle ?? route.siteId
  usePageTitle(pageTitle('Previews', siteName))
  const siteHomeHref = `/${encodeURIComponent(route.siteId)}`

  return (
    <main className="preview-page">
      <header className="preview-page-header">
        <a className="preview-back-link" href={`/${encodeURIComponent(route.siteId)}`} onClick={(event) => {
          event.preventDefault()
          navigate(`/${encodeURIComponent(route.siteId)}`)
        }}>← {siteName}</a>
        <p className="eyebrow">{siteName} · Previews</p>
        <h1>{route.groupId ? 'Preview link' : 'Previews'}</h1>
        <p className="preview-page-lede">Review changed documents from a specific source revision.</p>
      </header>

      {state.status === 'loading' ? <p role="status">Loading previews…</p> : null}
      {state.status === 'error' ? <p className="preview-empty" role="alert">The preview list could not be loaded.</p> : null}
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
          <a className="preview-return-link" href={siteHomeHref} onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            navigate(siteHomeHref)
          }}>Back to site home</a>
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
                  <p className="preview-group-meta mono">{group.headSha.slice(0, 12)} · {formatDate(group.updatedAt)}</p>
                </div>
                {group.prUrl ? <a className="preview-external-link" href={group.prUrl} target="_blank" rel="noreferrer noopener">Open PR ↗</a> : null}
              </div>
              {availability === 'unknown' ? <p className="preview-availability" role="status">Availability could not be checked. Direct document links may still work.</p> : null}
              <ul className="preview-document-list">
                {group.documents.map((document) => (
                  <li key={document.path}>
                    <a href={previewRouteHref(route.siteId, group.headSha, document.path, group.id)} onClick={(event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                      event.preventDefault()
                      navigate(previewRouteHref(route.siteId, group.headSha, document.path, group.id))
                    }}>
                      <span>{document.title}</span>
                      <code>{document.path}</code>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </main>
  )
}

function sameDocuments(left: PreviewGroup['documents'], right: PreviewGroup['documents']) {
  return left.length === right.length && left.every((document, index) => (
    document.path === right[index]?.path && document.title === right[index]?.title && document.format === right[index]?.format
  ))
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
