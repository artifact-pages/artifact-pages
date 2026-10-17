import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { artifactRouteHref, siteHomeHref as siteHomeRoute, sitePreviewsHref, type AppRoute } from '../routing'
import { loadPreviewManifest, previewFileUrl, previewRouteHref } from '../data/previews'
import { loadSharedPreviewCatalog, peekPreviewCatalog, resetPreviewList } from '../data/preview-list'
import { UnsupportedSchemaError } from '../data/schema'
import type { PreviewCatalog, PreviewDocument, PreviewGroup, PreviewManifest } from '../domain/preview'
import type { ArtifactIndexEntry } from '../domain/index'
import {
  findPreviewGroup,
  isSupersededRevision,
  previewGroupLabel,
  previewTagLabel,
  splitPreviewDocuments,
  verifiedIdentity,
  verifiedPullRequest,
  type PreviewIdentity,
} from '../domain/preview-reader'
import { formatPreviewTime } from '../domain/preview-time'
import { Icon } from './Icon'
import { MarkdownArtifact } from './MarkdownArtifact'
import { followInApp } from './spa-link'

export type PreviewDocumentRoute = Extract<AppRoute, { kind: 'preview-document' }>

type ManifestState =
  | { status: 'loading' }
  | { status: 'ready'; manifest: PreviewManifest; document: PreviewDocument }
  | { status: 'unavailable'; needsRepublish: boolean }

type CatalogState = { status: 'loading' } | { status: 'ready'; catalog: PreviewCatalog } | { status: 'failed' }

/** Everything the reader shell needs to show one preview document (ISSUE-109). */
export type PreviewReader = {
  route: PreviewDocumentRoute
  manifest: ManifestState
  /** The document as a reader entry: its URL is the raw file of this revision, which only the frame and the raw action use. */
  artifact?: ArtifactIndexEntry
  catalog: CatalogState
  /** The catalog group this link belongs to, if the catalog has one. */
  group?: PreviewGroup
  identity: PreviewIdentity
  pullRequest?: { number: string; url: string }
  /** Another revision is the group's current head. `href` is where the current preview opens, once known. */
  superseded?: { href?: string }
  outside: boolean
  setOutside: (outside: boolean) => void
  retryCatalog: () => void
  siteHref: string
  /** The group's list when the group is known, else the whole list. */
  listHref: string
  documentHref: (path: string) => string
}

export function usePreviewReader(route: PreviewDocumentRoute | undefined): PreviewReader | undefined {
  const siteId = route?.siteId
  const headSha = route?.headSha
  const artifactPath = route?.artifactPath

  const manifestKey = `${siteId}@${headSha}`
  const [manifestStored, setManifestStored] = useState<{ key: string; manifest?: PreviewManifest; error?: unknown } | null>(null)
  useEffect(() => {
    if (!siteId || !headSha) return
    let cancelled = false
    const key = `${siteId}@${headSha}`
    loadPreviewManifest(siteId, headSha).then(
      (manifest) => { if (!cancelled) setManifestStored({ key, manifest }) },
      (error: unknown) => { if (!cancelled) setManifestStored({ key, error }) },
    )
    return () => { cancelled = true }
    // The manifest belongs to the revision, so moving between its documents keeps it.
  }, [siteId, headSha])

  const [catalogAttempt, setCatalogAttempt] = useState(0)
  // Every navigation asks for the catalog again: a fresh one (under 30 s old) is reused, an older one is reloaded.
  // Until then nothing is said about whether this revision is current or verified.
  const catalogKey = `${siteId}\n${catalogAttempt}\n${headSha}\n${artifactPath}`
  const [catalogStored, setCatalogStored] = useState<{ key: string; state: CatalogState } | null>(null)
  const cachedCatalog = siteId ? peekPreviewCatalog(siteId) : undefined
  const catalog: CatalogState = catalogStored?.key === catalogKey
    ? catalogStored.state
    : cachedCatalog?.fresh ? { status: 'ready', catalog: cachedCatalog.catalog } : { status: 'loading' }
  useEffect(() => {
    if (!siteId) return
    let cancelled = false
    const key = `${siteId}\n${catalogAttempt}\n${headSha}\n${artifactPath}`
    loadSharedPreviewCatalog(siteId).then(
      (loaded) => { if (!cancelled) setCatalogStored({ key, state: { status: 'ready', catalog: loaded } }) },
      () => { if (!cancelled) setCatalogStored({ key, state: { status: 'failed' } }) },
    )
    return () => { cancelled = true }
  }, [siteId, catalogAttempt, headSha, artifactPath])
  const retryCatalog = useCallback(() => {
    if (siteId) resetPreviewList(siteId)
    setCatalogAttempt((attempt) => attempt + 1)
  }, [siteId])

  const group = useMemo(
    () => catalog.status === 'ready' && headSha ? findPreviewGroup(catalog.catalog, headSha, route?.groupId) : undefined,
    [catalog, headSha, route?.groupId],
  )
  const superseded = Boolean(headSha) && isSupersededRevision(group, headSha!)

  // Where "Open the current preview" goes: the same document at the group's current head when that head's manifest has it.
  const currentHead = superseded ? group?.headSha : undefined
  const [currentCheck, setCurrentCheck] = useState<{ key: string; hasDocument: boolean } | null>(null)
  const currentKey = `${siteId}@${currentHead}@${artifactPath}`
  useEffect(() => {
    if (!siteId || !currentHead || !artifactPath) return
    let cancelled = false
    loadPreviewManifest(siteId, currentHead).then(
      (manifest) => { if (!cancelled) setCurrentCheck({ key: currentKey, hasDocument: manifest.documents.some(({ path }) => path === artifactPath) }) },
      () => { if (!cancelled) setCurrentCheck({ key: currentKey, hasDocument: false }) },
    )
    return () => { cancelled = true }
  }, [siteId, currentHead, artifactPath, currentKey])

  const artifact = useMemo<ArtifactIndexEntry | undefined>(() => {
    if (!siteId || !headSha || manifestStored?.key !== manifestKey || !manifestStored.manifest) return undefined
    const document = manifestStored.manifest.documents.find(({ path }) => path === artifactPath)
    if (!document) return undefined
    return {
      id: `${siteId}:${headSha}:${document.path}`,
      title: document.title,
      path: document.path,
      format: document.format,
      artifactUrl: previewFileUrl(siteId, headSha, document.path),
      updatedAt: manifestStored.manifest.createdAt,
    }
  }, [siteId, headSha, artifactPath, manifestStored, manifestKey])

  const [outsideFor, setOutsideFor] = useState<string | null>(null)
  const outsideKey = `${siteId}@${headSha}@${artifactPath}`
  const setOutside = useCallback((outside: boolean) => setOutsideFor(outside ? outsideKey : null), [outsideKey])

  if (!route || !siteId || !headSha || !artifactPath) return undefined

  const manifestState: ManifestState = manifestStored?.key !== manifestKey
    ? { status: 'loading' }
    : manifestStored.manifest
      ? documentState(manifestStored.manifest, artifactPath)
      : { status: 'unavailable', needsRepublish: manifestStored.error instanceof UnsupportedSchemaError }

  const identity = verifiedIdentity(group, headSha, route.groupId)
  const groupId = group?.id ?? route.groupId
  const siteHref = siteHomeRoute(siteId)
  const listHref = groupId && (group || catalog.status !== 'ready')
    ? `${sitePreviewsHref(siteId)}?group=${encodeURIComponent(groupId)}`
    : sitePreviewsHref(siteId)

  let supersededState: PreviewReader['superseded']
  if (superseded && group) {
    supersededState = {
      href: currentCheck?.key === currentKey
        ? currentCheck.hasDocument
          ? previewRouteHref(siteId, group.headSha, artifactPath, group.id)
          : `${sitePreviewsHref(siteId)}?group=${encodeURIComponent(group.id)}`
        : undefined,
    }
  }

  return {
    route,
    manifest: manifestState,
    artifact,
    catalog,
    group,
    identity,
    pullRequest: verifiedPullRequest(group, headSha),
    superseded: supersededState,
    outside: outsideFor === outsideKey,
    setOutside,
    retryCatalog,
    siteHref,
    listHref,
    documentHref: (path) => previewRouteHref(siteId, headSha, path, groupId),
  }
}

function documentState(manifest: PreviewManifest, artifactPath: string): ManifestState {
  const document = manifest.documents.find(({ path }) => path === artifactPath)
  return document ? { status: 'ready', manifest, document } : { status: 'unavailable', needsRepublish: false }
}

// ---- context bar ----------------------------------------------------------

/** The small tag that names the preview at every width; the identity is never inferred beyond the link and the catalog. */
export function PreviewTag({ reader }: { reader: PreviewReader }) {
  const label = previewTagLabel(reader.identity, reader.route.headSha)
  return (
    <span className="preview-tag" title={`Preview of revision ${reader.route.headSha}`} data-preview-tag="">
      <span className="preview-tag-dot" aria-hidden="true" />{label}
    </span>
  )
}

export function PreviewBreadcrumbs({ reader, siteTitle, navigate }: {
  reader: PreviewReader
  siteTitle: string
  navigate: (href: string) => void
}) {
  const { route, identity } = reader
  const groupHref = reader.listHref
  const documentLabel = reader.manifest.status === 'ready'
    ? reader.manifest.document.title
    : route.artifactPath.split('/').at(-1) ?? route.artifactPath
  const trail = [
    { label: siteTitle, href: reader.siteHref },
    { label: 'Previews', href: sitePreviewsHref(route.siteId) },
    { label: previewGroupLabel(identity, route.headSha), href: groupHref },
  ]
  return (
    <nav className="breadcrumbs preview-crumbs" aria-label="Preview path">
      {trail.map((crumb, position) => (
        <span className="breadcrumb-part" key={crumb.label + position}>
          {position > 0 ? <span className="breadcrumb-separator" aria-hidden="true">/</span> : null}
          <a className="breadcrumb-link" href={crumb.href} onClick={(event) => followInApp(event, () => navigate(crumb.href))}>{crumb.label}</a>
        </span>
      ))}
      <span className="breadcrumb-part">
        <span className="breadcrumb-separator" aria-hidden="true">/</span>
        <span className="breadcrumb-current" aria-current="page" title={route.artifactPath}>
          <span className="breadcrumb-trigger-label">{documentLabel}</span>
        </span>
      </span>
    </nav>
  )
}

// ---- sidebar ----------------------------------------------------------------

export function PreviewSidebarSection({ reader, siteTitle, onOpenDocument, onOpenPublished }: {
  reader: PreviewReader
  siteTitle: string
  onOpenDocument: (href: string) => void
  onOpenPublished: () => void
}) {
  const documents = reader.manifest.status === 'ready' ? reader.manifest.manifest.documents : []
  const { changed, affected } = splitPreviewDocuments(documents)
  const { route, identity } = reader
  const label = identity.kind === 'pull-request'
    ? `PR #${identity.number}`
    : identity.kind === 'manual' ? 'Manual preview' : 'Preview'
  const item = (document: PreviewDocument) => {
    const href = reader.documentHref(document.path)
    const active = document.path === route.artifactPath
    return (
      <div className="tree-artifact-row" key={document.path}>
        <a
          href={href}
          className={`tree-artifact${active ? ' is-active' : ''}`}
          style={{ paddingInlineStart: '8px' }}
          title={document.path}
          aria-current={active ? 'page' : undefined}
          onClick={(event) => followInApp(event, () => onOpenDocument(href))}
        >
          <span className="tree-label">{document.title}</span>
          {document.format === 'markdown' ? <span className="tree-format-tag" title="Markdown document">MD</span> : null}
        </a>
      </div>
    )
  }
  return (
    <>
      {documents.length > 0 ? (
        <div className="sidebar-section preview-sidebar-documents">
          <div className="sidebar-section-title">
            <span className="sidebar-section-label"><Icon name="tree" size={12} />This preview</span>
          </div>
          <p className="preview-side-id">{label} <span className="mono">{route.headSha.slice(0, 12)}</span></p>
          {changed.length > 0 ? (
            <div role="group" aria-label="Changed pages">
              <p className="preview-side-group">Changed pages</p>
              {changed.map(item)}
            </div>
          ) : null}
          {affected.length > 0 ? (
            <div role="group" aria-label="Affected by a resource change">
              <p className="preview-side-group">Affected by a resource change</p>
              {affected.map(item)}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="sidebar-section preview-sidebar-site">
        <a href={reader.siteHref} onClick={(event) => followInApp(event, onOpenPublished)}>
          <Icon name="library" size={13} />Browse the published {siteTitle}
        </a>
      </div>
    </>
  )
}

// ---- details ----------------------------------------------------------------

/**
 * The right column's Details for a preview document. Build time and revision describe the preview; there is
 * no edit date, source or committer here, because a preview has none of its own.
 */
export function PreviewDetails({ reader, navigate }: { reader: PreviewReader; navigate: (href: string) => void }) {
  if (reader.manifest.status !== 'ready' || !reader.artifact) return null
  const { manifest, document } = reader.manifest
  const { route, pullRequest } = reader
  const built = formatPreviewTime(manifest.createdAt)
  return (
    <div className="artifact-details preview-details">
      <dl className="preview-facts">
        {pullRequest ? (
          <div className="preview-fact">
            <dt>Pull request</dt>
            <dd>
              <a className="preview-link" href={pullRequest.url} target="_blank" rel="noreferrer noopener">
                #{pullRequest.number} on GitHub<Icon name="external" size={11} />
              </a>
            </dd>
          </div>
        ) : null}
        <div className="preview-fact">
          <dt>Revision</dt>
          <dd><Sha value={route.headSha} /></dd>
        </div>
        <div className="preview-fact">
          <dt>Built</dt>
          <dd>
            {built.dateTime ? <time dateTime={built.dateTime} title={built.title}>{built.label}</time> : built.label}
            <span className="preview-hint">When this preview was built, not when the page was edited.</span>
          </dd>
        </div>
      </dl>
      <p className="preview-links">
        <a href={reader.listHref} onClick={(event) => followInApp(event, () => navigate(reader.listHref))}>Preview list</a>
        <a href={reader.siteHref} onClick={(event) => followInApp(event, () => navigate(reader.siteHref))}>Published site</a>
      </p>
      <details className="preview-more">
        <summary><Icon name="chevron" size={10} />More details</summary>
        <dl className="preview-facts preview-facts-more">
          <div className="preview-fact"><dt>Default head</dt><dd><Sha value={manifest.defaultHeadSha} /></dd></div>
          <div className="preview-fact"><dt>Merge base</dt><dd><Sha value={manifest.mergeBaseSha} /></dd></div>
          {document.reason ? (
            <div className="preview-fact">
              <dt>Included as</dt>
              <dd>
                {document.reason === 'dependency' ? 'Resource dependency' : 'Changed page'}
                {document.reason === 'dependency' && document.changedResources?.length ? (
                  <span className="preview-hint">Uses changed {document.changedResources.join(', ')}</span>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>
      </details>
      <dl className="preview-facts preview-facts-document">
        <div className="preview-fact"><dt>Path</dt><dd className="mono preview-path">{document.path}</dd></div>
        <div className="preview-fact"><dt>Format</dt><dd>{document.format === 'markdown' ? 'Markdown' : 'HTML'}</dd></div>
      </dl>
      <p className="preview-raw">
        <a href={reader.artifact.artifactUrl} target="_blank" rel="noreferrer noopener">
          Open the raw file<Icon name="external" size={11} />
        </a>
        <span>Opens this revision&apos;s file on its own, outside the reader.</span>
      </p>
    </div>
  )
}

/** A revision: the short form on screen, the full revision as its accessible name and tooltip. */
function Sha({ value }: { value: string }) {
  return (
    <code className="preview-sha mono" title={value}>
      <span aria-hidden="true">{value.slice(0, 12)}</span>
      <span className="page-text-visually-hidden">{value}</span>
    </code>
  )
}

// ---- notices ----------------------------------------------------------------

/** Always-visible strip above the document for states that change how the revision should be read. */
export function PreviewNotices({ reader, navigate }: { reader: PreviewReader; navigate: (href: string) => void }) {
  const ready = reader.manifest.status === 'ready'
  const notices: ReactNode[] = []
  if (ready && reader.catalog.status === 'failed') {
    notices.push(
      <p className="preview-notice" role="status" key="catalog">
        Preview details could not be loaded; this revision is shown as published.{' '}
        <button type="button" className="text-action" onClick={reader.retryCatalog}>Try again</button>
      </p>,
    )
  }
  if (ready && reader.superseded) {
    const href = reader.superseded.href
    notices.push(
      <p className="preview-notice" role="status" key="superseded">
        This is an older revision of this preview.{' '}
        {href ? <a href={href} onClick={(event) => followInApp(event, () => navigate(href))}>Open the current preview</a> : null}
      </p>,
    )
  }
  if (ready && reader.outside) {
    notices.push(<p className="preview-notice" role="status" key="outside">This page is outside the preview.</p>)
  }
  if (notices.length === 0) return null
  return <div className="preview-notices">{notices}</div>
}

// ---- document ---------------------------------------------------------------

export function PreviewUnavailable({ reader, siteTitle, navigate }: {
  reader: PreviewReader
  siteTitle: string
  navigate: (href: string) => void
}) {
  const needsRepublish = reader.manifest.status === 'unavailable' && reader.manifest.needsRepublish
  return (
    <div className="stage-message preview-unavailable">
      <p className="eyebrow">{siteTitle} · Preview</p>
      <h1>{needsRepublish ? 'This preview needs to be republished' : 'Preview unavailable'}</h1>
      <p role="status">{needsRepublish
        ? 'It uses a format this version of Git Artifact Pages cannot read. Ask the site owner to publish the preview again.'
        : 'This preview document is no longer available.'}</p>
      <p className="preview-unavailable-links">
        <a className="context-button" href={reader.listHref} onClick={(event) => followInApp(event, () => navigate(reader.listHref))}>
          <Icon name="arrow" size={13} /><span>Preview list</span>
        </a>
        <a className="context-button" href={reader.siteHref} onClick={(event) => followInApp(event, () => navigate(reader.siteHref))}>
          <Icon name="library" size={13} /><span>Published site</span>
        </a>
      </p>
    </div>
  )
}

/** The document itself: Markdown rendered by the reader, HTML in the isolated frame. */
export function PreviewDocumentView({ reader, hash, navigate, productionArtifacts, aside, onFailedChange, siteTitle }: {
  reader: PreviewReader
  hash: string
  navigate: (href: string) => void
  productionArtifacts: readonly ArtifactIndexEntry[]
  /** The ISSUE-108 column, rendered inside the scrolling Markdown region. */
  aside?: ReactNode
  onFailedChange: (failed: boolean) => void
  siteTitle: string
}) {
  const { route } = reader
  const manifest = reader.manifest.status === 'ready' ? reader.manifest.manifest : undefined
  const groupId = reader.group?.id ?? route.groupId
  const resolve = useCallback(
    (url: URL) => manifest
      ? resolveLogicalDocumentLink({ url, siteId: route.siteId, headSha: route.headSha, manifest, productionArtifacts, groupId })
      : undefined,
    [manifest, route.siteId, route.headSha, productionArtifacts, groupId],
  )
  if (reader.manifest.status === 'loading') {
    return <div className="stage-message" role="status">Loading preview…</div>
  }
  if (reader.manifest.status === 'unavailable' || !reader.artifact) {
    return <PreviewUnavailable reader={reader} siteTitle={siteTitle} navigate={navigate} />
  }
  const { document } = reader.manifest
  const artifact = reader.artifact
  if (document.format === 'markdown') {
    return (
      <MarkdownArtifact
        key={artifact.artifactUrl}
        artifact={artifact}
        siteId={route.siteId}
        hash={hash}
        navigate={navigate}
        resolveHref={resolve}
        aside={aside}
        onFailedChange={onFailedChange}
      />
    )
  }
  return (
    <PreviewHtmlDocument
      key={artifact.artifactUrl}
      artifactUrl={artifact.artifactUrl}
      hash={hash}
      title={document.title}
      resolve={resolve}
      navigate={navigate}
      onOutside={reader.setOutside}
      onFailedChange={onFailedChange}
    />
  )
}

function PreviewHtmlDocument({
  artifactUrl,
  hash,
  title,
  resolve,
  navigate,
  onOutside,
  onFailedChange,
}: {
  artifactUrl: string
  hash: string
  title: string
  resolve: (url: URL) => string | undefined
  navigate: (href: string) => void
  onOutside: (outside: boolean) => void
  onFailedChange: (failed: boolean) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const loadCheckRef = useRef<AbortController | null>(null)
  const [loadState, setLoadState] = useState<'checking' | 'loaded' | 'failed'>('checking')

  useEffect(() => {
    return () => loadCheckRef.current?.abort()
  }, [])

  const onFailedChangeRef = useRef(onFailedChange)
  onFailedChangeRef.current = onFailedChange
  useEffect(() => {
    if (loadState !== 'failed') return
    onFailedChangeRef.current(true)
    return () => onFailedChangeRef.current(false)
  }, [loadState])

  const syncFrameHash = useCallback(() => {
    const frameWindow = iframeRef.current?.contentWindow
    if (!frameWindow) return
    try {
      const expected = new URL(artifactUrl, window.location.origin)
      const current = new URL(frameWindow.location.href)
      if (current.origin !== expected.origin || current.pathname !== expected.pathname || current.search !== expected.search || current.hash === hash) return
      current.hash = hash
      frameWindow.location.replace(current.href)
    } catch {
      // Cross-origin redirects remain isolated; same-origin preview documents receive the logical fragment.
    }
  }, [artifactUrl, hash])

  useEffect(() => {
    syncFrameHash()
  }, [syncFrameHash])

  // Shared by the bridge message and the early-click safety net: both end as a reader navigation (history push).
  const resolveFrameDestination = useCallback((href: string) => {
    let frameDestination: URL
    try {
      frameDestination = new URL(href)
    } catch {
      return null
    }
    if (frameDestination.origin !== new URL(artifactUrl, window.location.origin).origin) return null
    const destination = new URL(`${frameDestination.pathname}${frameDestination.search}${frameDestination.hash}`, window.location.origin)
    return resolve(destination) ?? null
  }, [artifactUrl, resolve])

  const followFrameDestination = useCallback((href: string) => {
    const logicalRoute = resolveFrameDestination(href)
    if (!logicalRoute) return false
    navigate(logicalRoute)
    return true
  }, [navigate, resolveFrameDestination])

  // Joint history length as of the last reader render; a longer history at onLoad means the frame's own navigation added an entry.
  const knownHistoryLengthRef = useRef(window.history.length)
  const pendingRouteRef = useRef<string | null>(null)
  useEffect(() => {
    knownHistoryLengthRef.current = window.history.length
  })

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      const frame = iframeRef.current
      if (!frame) return
      const expectedFrameOrigin = window.location.origin
      if (event.source !== frame.contentWindow || event.origin !== expectedFrameOrigin || !isPreviewNavigationMessage(event.data)) return
      followFrameDestination(event.data.href)
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [artifactUrl, followFrameDestination])

  if (loadState === 'failed') return <div className="preview-frame-state" role="alert">This HTML preview document could not be loaded.</div>

  return (
    <>
      {loadState !== 'loaded' ? <div className="preview-frame-state" role="status">Loading HTML preview…</div> : null}
      <iframe
        ref={iframeRef}
        className="artifact-frame preview-html-frame"
        src={artifactUrl}
        title={title}
        referrerPolicy="strict-origin"
        onError={() => {
          if (isCurrentPreviewDocument(iframeRef.current, artifactUrl)) setLoadState('failed')
        }}
        onLoad={() => {
          if (!isCurrentPreviewDocument(iframeRef.current, artifactUrl)) {
            // A click before the bridge ran moved the frame itself to another raw file; follow it as a reader navigation.
            const frameHref = readFrameHref(iframeRef.current)
            const logicalRoute = frameHref ? resolveFrameDestination(frameHref) : null
            if (!logicalRoute) {
              // Neither a preview document nor a published one: the frame shows it as it is, and the reader says so.
              onOutside(true)
              return
            }
            if (window.history.length > knownHistoryLengthRef.current) {
              // The frame's navigation added a joint-history entry. Undo it first so the reader push below leaves a single Back step.
              pendingRouteRef.current = logicalRoute
              window.history.go(-1)
            } else {
              navigate(logicalRoute)
            }
            return
          }
          onOutside(false)
          if (pendingRouteRef.current) {
            const pendingRoute = pendingRouteRef.current
            pendingRouteRef.current = null
            navigate(pendingRoute)
            return
          }
          syncFrameHash()
          loadCheckRef.current?.abort()
          const controller = new AbortController()
          loadCheckRef.current = controller
          setLoadState('checking')
          fetch(artifactUrl, { method: 'HEAD', signal: controller.signal }).then((response) => {
            if (!response.ok) throw new Error(`Preview request failed with status ${response.status}`)
            if (controller.signal.aborted) return
            setLoadState('loaded')
            const frameDocument = iframeRef.current?.contentDocument
            if (!frameDocument || frameDocument.querySelector('script[data-preview-reader-bridge]')) return
            const bridge = frameDocument.createElement('script')
            bridge.src = new URL('/preview-bridge.js', window.location.origin).href
            bridge.dataset.previewReaderBridge = 'true'
            bridge.referrerPolicy = 'strict-origin'
            bridge.addEventListener('load', () => { bridge.dataset.previewReaderBridge = 'ready' })
            frameDocument.body?.append(bridge)
          }).catch(() => {
            if (!controller.signal.aborted) setLoadState('failed')
          })
        }}
      />
    </>
  )
}

function readFrameHref(frame: HTMLIFrameElement | null) {
  try {
    return frame?.contentWindow?.location.href
  } catch {
    return undefined
  }
}

function isCurrentPreviewDocument(frame: HTMLIFrameElement | null, artifactUrl: string) {
  if (!frame?.contentWindow) return false
  let currentHref: string
  try {
    currentHref = frame.contentWindow.location.href
  } catch {
    return false
  }
  if (currentHref === 'about:blank') return true
  try {
    const current = new URL(currentHref)
    const expected = new URL(artifactUrl, window.location.origin)
    return current.origin === expected.origin && current.pathname === expected.pathname
  } catch {
    return false
  }
}

function isPreviewNavigationMessage(value: unknown): value is { type: string; href: string } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { type?: unknown; href?: unknown }
  return candidate.type === 'git-artifact-preview-navigation' && typeof candidate.href === 'string'
}

/**
 * A link inside a preview document that points into this revision's raw files: a changed document stays in the
 * preview (same revision and group), a published document opens in the normal reader, anything else is left as is.
 */
function resolveLogicalDocumentLink({
  url,
  siteId,
  headSha,
  manifest,
  productionArtifacts,
  groupId,
}: {
  url: URL
  siteId: string
  headSha: string
  manifest: PreviewManifest
  productionArtifacts: readonly ArtifactIndexEntry[]
  groupId?: string
}) {
  if (url.origin !== window.location.origin) return undefined
  const rawFilesPrefix = previewFileUrl(siteId, headSha, '').replace(/\/$/u, '/')
  if (!url.pathname.startsWith(rawFilesPrefix)) return undefined
  const encodedPath = url.pathname.slice(rawFilesPrefix.length)
  const sourcePath = decodeSourcePath(encodedPath)
  if (!sourcePath || !/\.(?:html?|md)$/iu.test(sourcePath)) return undefined

  const changedDocument = manifest.documents.find(({ path }) => path === sourcePath)
  if (changedDocument) {
    return addUrlSuffix(previewRouteHref(siteId, headSha, sourcePath, groupId), url)
  }
  const publishedDocument = productionArtifacts.find((artifact) => artifact.path === sourcePath && isDocument(artifact))
  if (publishedDocument) return `${artifactRouteHref(siteId, sourcePath)}${url.search}${url.hash}`
  return undefined
}

function decodeSourcePath(value: string) {
  try {
    return value.split('/').map((segment) => decodeURIComponent(segment)).join('/')
  } catch {
    return ''
  }
}

function addUrlSuffix(href: string, source: URL) {
  const target = new URL(href, window.location.origin)
  source.searchParams.forEach((value, key) => {
    if (key !== 'group') target.searchParams.append(key, value)
  })
  target.hash = source.hash
  return `${target.pathname}${target.search}${target.hash}`
}

function isDocument(artifact: ArtifactIndexEntry) {
  return artifact.format === 'html' || artifact.format === 'markdown'
}
