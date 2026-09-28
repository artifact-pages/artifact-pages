import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { artifactRouteHref } from '../routing'
import { defaultSiteIndexUrl, loadSiteIndex } from '../data/indexes'
import { loadPreviewCatalog, loadPreviewManifest, previewFileUrl, previewFrameFileUrl, previewFrameOrigin, previewRouteHref } from '../data/previews'
import type { PreviewGroup, PreviewManifest } from '../domain/preview'
import type { ArtifactIndexEntry, SiteIndex } from '../domain/index'
import { MarkdownArtifact } from './MarkdownArtifact'
import type { AppRoute } from '../routing'

type PreviewDocumentRoute = Extract<AppRoute, { kind: 'preview-document' }>

export function PreviewDocumentPage({ route, hash, navigate }: {
  route: PreviewDocumentRoute
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

  const siteHref = `/${encodeURIComponent(route.siteId)}`
  const previewsHref = `/${encodeURIComponent(route.siteId)}/_previews`
  const returnHref = route.groupId ? `${previewsHref}?group=${encodeURIComponent(route.groupId)}` : previewsHref

  if (manifestState.status === 'loading') {
    return <PreviewStatusPage siteId={route.siteId} message="Loading preview…" />
  }
  if (manifestState.status === 'error') {
    return <PreviewUnavailable siteId={route.siteId} returnHref={returnHref} navigate={navigate} />
  }
  const { manifest } = manifestState
  const document = manifest.documents.find(({ path }) => path === route.artifactPath)
  if (!document) return <PreviewUnavailable siteId={route.siteId} returnHref={returnHref} navigate={navigate} />

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
            artifactUrl={artifactUrl}
            title={document.title}
            route={route}
            manifest={manifest}
            productionIndex={productionIndex}
            navigate={navigate}
          />
        )}
      </section>
      <a className="preview-site-link" href={siteHref} onClick={handleNavigate(siteHref, navigate)}>Back to {route.siteId}</a>
    </main>
  )
}

function PreviewHtmlDocument({
  artifactUrl,
  title,
  route,
  manifest,
  productionIndex,
  navigate,
}: {
  artifactUrl: string
  title: string
  route: PreviewDocumentRoute
  manifest: PreviewManifest
  productionIndex: SiteIndex | null
  navigate: (href: string) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [srcDoc, setSrcDoc] = useState<string>()
  const frameUrl = previewFrameFileUrl(route.siteId, route.headSha, route.artifactPath)
  const isolatedOrigin = new URL(frameUrl).origin !== window.location.origin

  useEffect(() => {
    const controller = new AbortController()
    setLoaded(false)
    setFailed(false)
    setSrcDoc(undefined)
    fetch(artifactUrl, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
      if (isolatedOrigin) return undefined
      return response.text()
    }).then(
      (html) => {
        if (!controller.signal.aborted) {
          if (typeof html === 'string') setSrcDoc(createSandboxedPreviewDocument(html, artifactUrl))
          setLoaded(true)
        }
      },
      () => { if (!controller.signal.aborted) setFailed(true) },
    )
    return () => controller.abort()
  }, [artifactUrl, isolatedOrigin])

  useEffect(() => {
    if (!loaded) return
    const frame = iframeRef.current
    if (!frame) return
    const handleMessage = (event: MessageEvent<unknown>) => {
      const expectedFrameOrigin = isolatedOrigin ? previewFrameOrigin(route.siteId, route.headSha) : 'null'
      const expectedDocumentOrigin = isolatedOrigin ? expectedFrameOrigin : new URL(artifactUrl, window.location.origin).origin
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
  }, [artifactUrl, isolatedOrigin, loaded, manifest, navigate, productionIndex, route])

  if (failed) return <div className="preview-frame-state" role="alert">This HTML preview document could not be loaded.</div>
  if (!loaded) return <div className="preview-frame-state" role="status">Loading HTML preview…</div>
  return (
    <iframe
      ref={iframeRef}
      className="artifact-frame preview-html-frame"
      {...(isolatedOrigin ? { src: frameUrl } : { srcDoc })}
      title={title}
      referrerPolicy="strict-origin"
      sandbox={isolatedOrigin ? 'allow-scripts allow-same-origin' : 'allow-scripts'}
    />
  )
}

function createSandboxedPreviewDocument(html: string, artifactUrl: string) {
  const origin = new URL(artifactUrl, window.location.origin).origin
  const policy = [
    `default-src ${origin} data: blob:`,
    `script-src ${origin} 'unsafe-inline' 'unsafe-eval' blob:`,
    `style-src ${origin} 'unsafe-inline' data:`,
    `img-src ${origin} data: blob:`,
    `font-src ${origin} data:`,
    `media-src ${origin} data: blob:`,
    "connect-src 'none'",
    "object-src 'none'",
    `base-uri ${origin}`,
    "form-action 'none'",
    "frame-src 'none'",
  ].join('; ')
  const bridgeParentOrigin = JSON.stringify(window.location.origin)
  const headContent = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"><base href="${escapeAttribute(new URL(artifactUrl, window.location.origin).href)}"><script>window.__gitArtifactPreviewParentOrigin=${bridgeParentOrigin}</script><script src="${escapeAttribute(new URL('/preview-bridge.js', window.location.origin).href)}" defer></script>`
  // Establish the enforced policy before parsing any preview-controlled bytes.
  // Inserting this into a matched <head> is unsafe: malformed HTML can cause
  // the parser to implicitly create the body first and ignore that later head.
  return `<!doctype html><html><head>${headContent}</head><body>${html}</body></html>`
}

function escapeAttribute(value: string) {
  return value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
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

function PreviewUnavailable({ siteId, returnHref, navigate }: {
  siteId: string
  returnHref: string
  navigate: (href: string) => void
}) {
  return (
    <main className="preview-page preview-unavailable">
      <a className="preview-back-link" href={returnHref} onClick={handleNavigate(returnHref, navigate)}>← Back to previews</a>
      <p className="eyebrow">{siteId} · Preview</p>
      <h1>Preview unavailable</h1>
      <p role="status">This preview document is no longer available.</p>
    </main>
  )
}

function PreviewStatusPage({ siteId, message }: { siteId: string; message: string }) {
  return <main className="status-page"><div className="status-content"><p className="eyebrow">{siteId} · Preview</p><p role="status">{message}</p></div></main>
}
