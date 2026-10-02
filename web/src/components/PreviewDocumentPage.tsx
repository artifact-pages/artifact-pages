import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { artifactRouteHref } from '../routing'
import { defaultSiteIndexUrl, loadSiteIndex } from '../data/indexes'
import { loadPreviewCatalog, loadPreviewManifest, previewFileUrl, previewRouteHref } from '../data/previews'
import type { PreviewGroup, PreviewManifest } from '../domain/preview'
import type { ArtifactIndexEntry, SiteIndex } from '../domain/index'
import { MarkdownArtifact } from './MarkdownArtifact'
import type { AppRoute } from '../routing'
import { pageTitle, usePageTitle } from './usePageTitle'

type PreviewDocumentRoute = Extract<AppRoute, { kind: 'preview-document' }>

export function PreviewDocumentPage({ route, hash, navigate, siteTitle }: {
  route: PreviewDocumentRoute
  /** The registered site's title once the registry is loaded; the site ID until then. */
  siteTitle?: string
  hash: string
  navigate: (href: string) => void
}) {
  const [manifestState, setManifestState] = useState<
    | { status: 'loading' }
    | { status: 'success'; manifest: PreviewManifest }
    | { status: 'error' }
  >({ status: 'loading' })
  const [prGroup, setPrGroup] = useState<PreviewGroup | null>(null)
  const [productionIndex, setProductionIndex] = useState<SiteIndex | null>(null)

  useEffect(() => {
    let cancelled = false
    setManifestState({ status: 'loading' })
    loadPreviewManifest(route.siteId, route.headSha).then(
      (manifest) => { if (!cancelled) setManifestState({ status: 'success', manifest }) },
      () => { if (!cancelled) setManifestState({ status: 'error' }) },
    )
    return () => { cancelled = true }
  }, [route.siteId, route.headSha])

  useEffect(() => {
    if (!route.groupId) {
      setPrGroup(null)
      return
    }
    let cancelled = false
    setPrGroup(null)
    loadPreviewCatalog(route.siteId).then((catalog) => {
      if (cancelled) return
      const matchingGroup = catalog.groups.find((group) => (
        group.id === route.groupId && group.kind === 'pull-request' && group.headSha === route.headSha
      ))
      setPrGroup(matchingGroup ?? null)
    }).catch(() => {
      if (!cancelled) setPrGroup(null)
    })
    return () => { cancelled = true }
  }, [route.siteId, route.headSha, route.groupId])

  useEffect(() => {
    let cancelled = false
    loadSiteIndex(route.siteId, fetch, defaultSiteIndexUrl(route.siteId)).then(
      (index) => { if (!cancelled) setProductionIndex(index) },
      () => { if (!cancelled) setProductionIndex(null) },
    )
    return () => { cancelled = true }
  }, [route.siteId])

  const siteName = siteTitle ?? route.siteId
  const documentTitle = manifestState.status === 'success'
    ? manifestState.manifest.documents.find(({ path }) => path === route.artifactPath)?.title
    : undefined
  usePageTitle(pageTitle(documentTitle ?? 'Preview', 'Previews', siteName))
  const siteHref = `/${encodeURIComponent(route.siteId)}`
  const previewsHref = `/${encodeURIComponent(route.siteId)}/_previews`
  const returnHref = route.groupId ? `${previewsHref}?group=${encodeURIComponent(route.groupId)}` : previewsHref

  if (manifestState.status === 'loading') {
    return <PreviewStatusPage siteName={siteName} message="Loading preview…" />
  }
  if (manifestState.status === 'error') {
    return <PreviewUnavailable siteName={siteName} returnHref={returnHref} navigate={navigate} />
  }
  const { manifest } = manifestState
  const document = manifest.documents.find(({ path }) => path === route.artifactPath)
  if (!document) return <PreviewUnavailable siteName={siteName} returnHref={returnHref} navigate={navigate} />

  const artifactUrl = previewFileUrl(route.siteId, route.headSha, document.path)
  const artifact: ArtifactIndexEntry = {
    id: `${route.siteId}:${route.headSha}:${document.path}`,
    title: document.title,
    path: document.path,
    format: document.format,
    artifactUrl,
    updatedAt: manifest.createdAt,
  }
  const resolveDocumentLink = (url: URL) => resolveLogicalDocumentLink({
    url,
    route,
    manifest,
    productionIndex,
  })

  return (
    <main className="preview-reader">
      <header className="preview-reader-header">
        <div className="preview-reader-context">
          <a className="preview-back-link" href={returnHref} onClick={handleNavigate(returnHref, navigate)}>← Previews</a>
          <span className="preview-reader-revision">Preview · {route.headSha.slice(0, 12)}</span>
          {prGroup?.prUrl ? (
            <a className="preview-external-link" href={prGroup.prUrl} target="_blank" rel="noreferrer noopener">
              Return to PR #{prGroup.id.slice(3)} ↗
            </a>
          ) : null}
        </div>
        <h1>{document.title}</h1>
        <p className="preview-reader-path mono">{document.path}</p>
      </header>
      <section className="preview-reader-stage" aria-label={document.title}>
        {document.format === 'markdown' ? (
          <MarkdownArtifact
            key={artifactUrl}
            artifact={artifact}
            siteId={route.siteId}
            hash={hash}
            navigate={navigate}
            resolveHref={resolveDocumentLink}
          />
        ) : (
          <PreviewHtmlDocument
            key={artifactUrl}
            artifactUrl={artifactUrl}
            hash={hash}
            title={document.title}
            route={route}
            manifest={manifest}
            productionIndex={productionIndex}
            navigate={navigate}
          />
        )}
      </section>
      <a className="preview-site-link" href={siteHref} onClick={handleNavigate(siteHref, navigate)}>Back to {siteName}</a>
    </main>
  )
}

function PreviewHtmlDocument({
  artifactUrl,
  hash,
  title,
  route,
  manifest,
  productionIndex,
  navigate,
}: {
  artifactUrl: string
  hash: string
  title: string
  route: PreviewDocumentRoute
  manifest: PreviewManifest
  productionIndex: SiteIndex | null
  navigate: (href: string) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const loadCheckRef = useRef<AbortController | null>(null)
  const [loadState, setLoadState] = useState<'checking' | 'loaded' | 'failed'>('checking')

  useEffect(() => {
    return () => loadCheckRef.current?.abort()
  }, [])

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

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      const frame = iframeRef.current
      if (!frame) return
      const expectedDocumentOrigin = new URL(artifactUrl, window.location.origin).origin
      const expectedFrameOrigin = window.location.origin
      if (event.source !== frame.contentWindow || event.origin !== expectedFrameOrigin || !isPreviewNavigationMessage(event.data)) return
      let frameDestination: URL
      try {
        frameDestination = new URL(event.data.href)
      } catch {
        return
      }
      if (frameDestination.origin !== expectedDocumentOrigin) return
      const destination = new URL(`${frameDestination.pathname}${frameDestination.search}${frameDestination.hash}`, window.location.origin)
      const logicalRoute = resolveLogicalDocumentLink({ url: destination, route, manifest, productionIndex })
      if (logicalRoute) navigate(logicalRoute)
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [artifactUrl, manifest, navigate, productionIndex, route])

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
          if (!isCurrentPreviewDocument(iframeRef.current, artifactUrl)) return
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

function resolveLogicalDocumentLink({
  url,
  route,
  manifest,
  productionIndex,
}: {
  url: URL
  route: PreviewDocumentRoute
  manifest: PreviewManifest
  productionIndex: SiteIndex | null
}) {
  if (url.origin !== window.location.origin) return undefined
  const rawFilesPrefix = previewFileUrl(route.siteId, route.headSha, '').replace(/\/$/u, '/')
  if (!url.pathname.startsWith(rawFilesPrefix)) return undefined
  const encodedPath = url.pathname.slice(rawFilesPrefix.length)
  const sourcePath = decodeSourcePath(encodedPath)
  if (!sourcePath || !/\.(?:html?|md)$/iu.test(sourcePath)) return undefined

  const changedDocument = manifest.documents.find(({ path }) => path === sourcePath)
  if (changedDocument) {
    return addUrlSuffix(previewRouteHref(route.siteId, route.headSha, sourcePath, route.groupId), url)
  }
  const publishedDocument = productionIndex?.artifacts.find((artifact) => artifact.path === sourcePath && isDocument(artifact))
  if (publishedDocument) return `${artifactRouteHref(route.siteId, sourcePath)}${url.search}${url.hash}`
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

function handleNavigate(href: string, navigate: (href: string) => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(href)
  }
}

function PreviewUnavailable({ siteName, returnHref, navigate }: {
  siteName: string
  returnHref: string
  navigate: (href: string) => void
}) {
  return (
    <main className="preview-page preview-unavailable">
      <a className="preview-back-link" href={returnHref} onClick={handleNavigate(returnHref, navigate)}>← Back to previews</a>
      <p className="eyebrow">{siteName} · Preview</p>
      <h1>Preview unavailable</h1>
      <p role="status">This preview document is no longer available.</p>
    </main>
  )
}

function PreviewStatusPage({ siteName, message }: { siteName: string; message: string }) {
  return <main className="status-page"><div className="status-content"><p className="eyebrow">{siteName} · Preview</p><p role="status">{message}</p></div></main>
}
