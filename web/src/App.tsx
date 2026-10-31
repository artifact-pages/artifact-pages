import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArtifactWorkspace } from './components/ArtifactWorkspace'
import { PreviewListPage } from './components/PreviewListPage'
import { SitePicker } from './components/SitePicker'
import { UnsupportedSchemaError } from './data/schema'
import { defaultSiteIndexUrl, discoverSites, IndexLoadError, invalidateSiteIndexCache, isValidSiteId, loadSiteIndex } from './data/indexes'
import { createSiteFullTextSearch, type SiteFullTextSearch } from './data/fulltext'
import { resetPreviewList } from './data/preview-list'
import { hasSiteDiscoveryMetadata, type SiteCatalogEntry, type SiteIndex } from './domain/index'
import { isThemeMode, resolveTheme } from './domain/theme'
import type { ResolvedTheme, ThemeMode } from './domain/theme'
import { canonicalPathname, parseRoute, type AppRoute } from './routing'
import { APP_NAME, pageTitle, usePageTitle } from './components/usePageTitle'
import { usePageNoindex } from './components/usePageNoindex'
import { useDelayedVisible } from './components/useDelayedVisible'

type LoadingState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error }

function useLocation() {
  const [url, setUrl] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  }))

  useEffect(() => {
    const sync = () => setUrl({ pathname: window.location.pathname, search: window.location.search, hash: window.location.hash })
    window.addEventListener('popstate', sync)
    window.addEventListener('hashchange', sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener('hashchange', sync)
    }
  }, [])

  // A non-canonical path (`/guide//en//x.html`, `/guide/`) shows the same route; the
  // address bar is corrected in place, without a history entry.
  useEffect(() => {
    const canonical = canonicalPathname(url.pathname)
    if (canonical === url.pathname) return
    window.history.replaceState(window.history.state, '', `${canonical}${url.search}${url.hash}`)
    setUrl({ pathname: window.location.pathname, search: window.location.search, hash: window.location.hash })
  }, [url])

  const navigate = useCallback((href: string, options: { replace?: boolean } = {}) => {
    if (options.replace) window.history.replaceState(window.history.state, '', href)
    else window.history.pushState({}, '', href)
    setUrl({ pathname: window.location.pathname, search: window.location.search, hash: window.location.hash })
  }, [])

  return { ...url, route: parseRoute(url.pathname, url.search), navigate }
}

function useTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      const storedMode = window.localStorage.getItem('git-artifact-pages-theme')
      return isThemeMode(storedMode) ? storedMode : 'system'
    } catch {
      return 'system'
    }
  })
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => (
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  ))

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const syncSystemTheme = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? 'dark' : 'light')
    }
    mediaQuery.addEventListener('change', syncSystemTheme)
    return () => mediaQuery.removeEventListener('change', syncSystemTheme)
  }, [])

  const theme = resolveTheme(themeMode, systemTheme)
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      window.localStorage.setItem('git-artifact-pages-theme', themeMode)
    } catch {
      // The selected theme still applies for this session when storage is unavailable.
    }
  }, [theme, themeMode])

  return { themeMode, theme, setThemeMode }
}

function App() {
  const { route, pathname, search, hash, navigate } = useLocation()
  const { themeMode, theme, setThemeMode } = useTheme()
  const [sites, setSites] = useState<LoadingState<SiteCatalogEntry[]>>({ status: 'loading' })
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0)
  const [bridgeEpoch, setBridgeEpoch] = useState(0)
  const [bridgeFocusHref, setBridgeFocusHref] = useState<string | null>(null)
  const bridgeInFlight = useRef(false)
  const activeSiteId = route.kind === 'sites' ? undefined : route.siteId
  const [searchTarget, setSearchTarget] = useState<{ siteId: string; url: string } | null>(null)
  // A bridge refresh remounts SitePage, but stays within the same site visit.
  useEffect(() => {
    if (!activeSiteId) return
    return () => resetPreviewList(activeSiteId)
  }, [activeSiteId])
  // Keep the site's search client while discovery reloads, but expose it only
  // after current metadata confirms the same URL. Construction is network-free.
  useEffect(() => {
    if (!activeSiteId) { setSearchTarget(null); return }
    if (sites.status !== 'success') return
    const entry = sites.data.find(({ site }) => site.id === activeSiteId)
    const url = entry && hasSiteDiscoveryMetadata(entry) ? entry.fullTextUrl : undefined
    setSearchTarget((current) => {
      if (current?.siteId === activeSiteId && current.url === url) return current
      return url ? { siteId: activeSiteId, url } : null
    })
  }, [activeSiteId, sites])
  const visitFullTextSearch = useMemo((): SiteFullTextSearch | undefined => {
    if (!searchTarget || searchTarget.siteId !== activeSiteId) return undefined
    try {
      return createSiteFullTextSearch({ site: { id: searchTarget.siteId, title: searchTarget.siteId }, fullTextUrl: searchTarget.url })
    } catch { return undefined }
  }, [searchTarget, activeSiteId])
  useEffect(() => () => visitFullTextSearch?.clear(), [visitFullTextSearch])
  const retryDiscovery = () => {
    setSites({ status: 'loading' })
    setDiscoveryAttempt((n) => n + 1)
  }

  // A trusted HTML document can request normal reader navigation without reloading the app.
  // Reload discovery and the site index just as a full page navigation would; the app's own
  // code is updated on the next full reload, as with any other SPA navigation.
  const navigateFromDocument = useCallback((href: string) => {
    if (route.kind !== 'site' || bridgeInFlight.current) return false
    try {
      const target = new URL(href, window.location.href)
      navigate(`${target.pathname}${target.search}${target.hash}`)
      bridgeInFlight.current = true
      invalidateSiteIndexCache(route.siteId)
      setBridgeFocusHref(`${target.pathname}${target.search}${target.hash}`)
      setSites({ status: 'loading' })
      setDiscoveryAttempt((n) => n + 1)
      setBridgeEpoch((n) => n + 1)
      return true
    } catch {
      bridgeInFlight.current = false
      return false
    }
  }, [navigate, route])
  useEffect(() => { bridgeInFlight.current = false }, [bridgeEpoch, pathname, search, hash])
  useEffect(() => {
    if (bridgeFocusHref && `${pathname}${search}${hash}` !== bridgeFocusHref) setBridgeFocusHref(null)
  }, [bridgeFocusHref, pathname, search, hash])
  useLayoutEffect(() => {
    if (!bridgeFocusHref) return
    const cancel = () => setBridgeFocusHref(null)
    window.addEventListener('pointerdown', cancel, true)
    window.addEventListener('keydown', cancel, true)
    window.addEventListener('wheel', cancel, true)
    window.addEventListener('touchstart', cancel, true)
    window.addEventListener('blur', cancel)
    const visibility = () => { if (document.hidden) cancel() }
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('pointerdown', cancel, true)
      window.removeEventListener('keydown', cancel, true)
      window.removeEventListener('wheel', cancel, true)
      window.removeEventListener('touchstart', cancel, true)
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [bridgeFocusHref])

  useEffect(() => {
    const controller = new AbortController()
    discoverSites(fetch, { signal: controller.signal }).then(
      (metadata) => {
        if (!controller.signal.aborted) setSites({ status: 'success', data: metadata })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setSites({ status: 'error', error: toError(error) })
      },
    )

    return () => controller.abort()
  }, [discoveryAttempt])

  if (route.kind === 'sites') {
    if (sites.status === 'loading') return <StatusPage title="Sites" message="Loading sites…" />
    if (sites.status === 'error' && sites.error instanceof UnsupportedSchemaError) {
      return <RepublishPage scope="registry" title="Sites" onBack={() => navigate('/')} />
    }
    if (sites.status === 'error') {
      return <ErrorPage title="Sites" scope="catalog" error={sites.error} onRetry={retryDiscovery} focusRetry={discoveryAttempt > 0} />
    }
    return (
      <SitePicker
        sites={sites.data}
        onNavigate={navigate}
        themeMode={themeMode}
        onSetThemeMode={setThemeMode}
      />
    )
  }

  if (route.kind === 'preview-list' || route.kind === 'preview-document') {
    // Previews belong to a registered site. Only a loaded registry can confirm
    // absence; while it loads or after it fails, the preview page decides.
    if (!isValidSiteId(route.siteId) || (
      sites.status === 'success' && !sites.data.some(({ site }) => site.id === route.siteId)
    )) {
      return <PageNotFoundPage onBack={() => navigate('/')} />
    }
  }

  return (
    <SitePage
      key={`${route.siteId}:${bridgeEpoch}`}
      route={route}
      pathname={pathname}
      search={search}
      hash={hash}
      sites={sites.status === 'success' ? sites.data : []}
      sitesLoading={sites.status === 'loading'}
      siteDiscoveryStatus={sites.status}
      siteDiscoveryError={sites.status === 'error' ? sites.error : undefined}
      retryDiscovery={retryDiscovery}
      navigate={navigate}
      navigateFromDocument={navigateFromDocument}
      bridgeFocusHref={bridgeFocusHref}
      onBridgeFocusConsumed={() => setBridgeFocusHref(null)}
      visitFullTextSearch={visitFullTextSearch}
      visitSearchTarget={searchTarget}
      themeMode={themeMode}
      theme={theme}
      onSetThemeMode={setThemeMode}
    />
  )
}

const NO_PUBLISHED_ARTIFACTS: SiteIndex['artifacts'] = []

function SitePage({
  route,
  sites,
  sitesLoading,
  siteDiscoveryStatus,
  siteDiscoveryError,
  retryDiscovery,
  pathname,
  search,
  hash,
  navigate,
  navigateFromDocument,
  bridgeFocusHref,
  onBridgeFocusConsumed,
  visitFullTextSearch,
  visitSearchTarget,
  themeMode,
  theme,
  onSetThemeMode,
}: {
  route: Extract<AppRoute, { kind: 'site' | 'search' | 'preview-list' | 'preview-document' }>
  sites: SiteCatalogEntry[]
  sitesLoading: boolean
  siteDiscoveryStatus: LoadingState<SiteCatalogEntry[]>['status']
  siteDiscoveryError?: Error
  retryDiscovery: () => void
  pathname: string
  search: string
  hash: string
  navigate: (href: string, options?: { replace?: boolean }) => void
  navigateFromDocument: (href: string) => boolean
  bridgeFocusHref: string | null
  onBridgeFocusConsumed: () => void
  visitFullTextSearch?: SiteFullTextSearch
  visitSearchTarget: { siteId: string; url: string } | null
  themeMode: ThemeMode
  theme: ResolvedTheme
  onSetThemeMode: (mode: ThemeMode) => void
}) {
  const [indexState, setIndexState] = useState<LoadingState<SiteIndex>>({ status: 'loading' })
  const [indexAttempt, setIndexAttempt] = useState(0)
  const retryIndex = () => {
    setIndexState({ status: 'loading' })
    setIndexAttempt((n) => n + 1)
  }
  const registeredSite = sites.find(({ site }) => site.id === route.siteId)
  const artifactIndexUrl = registeredSite && hasSiteDiscoveryMetadata(registeredSite)
    ? registeredSite.artifactIndexUrl
    : defaultSiteIndexUrl(route.siteId)
  const fullTextUrl = registeredSite && hasSiteDiscoveryMetadata(registeredSite) ? registeredSite.fullTextUrl : undefined
  // Construction is network-free; search data loads only when a query is committed.
  const fullTextSearch = fullTextUrl && visitSearchTarget?.siteId === route.siteId && visitSearchTarget.url === fullTextUrl
    ? visitFullTextSearch : undefined
  useEffect(() => {
    const controller = new AbortController()
    setIndexState({ status: 'loading' })
    loadSiteIndex(route.siteId, fetch, artifactIndexUrl, { signal: controller.signal }).then(
      (index) => {
        if (!controller.signal.aborted) setIndexState({ status: 'success', data: index })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setIndexState({ status: 'error', error: toError(error) })
      },
    )

    return () => controller.abort()
  }, [route.siteId, artifactIndexUrl, indexAttempt])

  if (indexState.status === 'loading' && route.kind === 'preview-list' && isValidSiteId(route.siteId)) {
    // Previews do not wait for the site index: the list starts loading now and the page moves into the
    // workspace when the index arrives (the load and the scroll offset carry over).
    return <PreviewListPage route={route} navigate={navigate} siteTitle={registeredSite?.site.title} />
  }
  if (indexState.status === 'loading' && route.kind !== 'preview-document') {
    return <StatusPage title={route.siteId} message="Loading site index…" />
  }
  if (indexState.status === 'error' && route.kind === 'preview-list' && isValidSiteId(route.siteId)) {
    // The Previews list does not depend on the published site: without an index it stands alone.
    return <PreviewListPage route={route} navigate={navigate} siteTitle={registeredSite?.site.title} />
  }
  if (indexState.status === 'error' && route.kind !== 'preview-document') {
    const invalidSiteId = !isValidSiteId(route.siteId)
    const missingIndex = indexState.error instanceof IndexLoadError && indexState.error.status === 404
    if (missingIndex && siteDiscoveryStatus === 'loading') {
      return <StatusPage title={route.siteId} message="Checking whether this site is available…" />
    }
    if (
      invalidSiteId || (
        missingIndex &&
        siteDiscoveryStatus === 'success' &&
        !registeredSite
      )
    ) {
      return <PageNotFoundPage onBack={() => navigate('/')} />
    }
    if (indexState.error instanceof UnsupportedSchemaError || registeredSite?.status === 'needs-republish') {
      return <RepublishPage scope="site" title={registeredSite?.site.title ?? route.siteId} onBack={() => navigate('/')} />
    }
    if (missingIndex && registeredSite?.status === 'not-published') {
      return <RegisteredSiteStatusPage
        title={registeredSite.site.title}
        heading="Site registered, but not published yet"
        message="This site is registered and will appear here after its first publish."
        onBack={() => navigate('/')}
      />
    }
    if (missingIndex && registeredSite?.status === 'metadata-unavailable') {
      return <RegisteredSiteStatusPage
        title={registeredSite.site.title}
        heading="Site registered, but details are unavailable"
        message="This site's metadata and artifact index could not be loaded. Please try again in a moment."
        onRetry={() => { retryDiscovery(); retryIndex() }}
        focusRetry={indexAttempt > 0}
        onBack={() => navigate('/')}
      />
    }
    return <ErrorPage title={route.siteId} error={indexState.error} onRetry={retryIndex} focusRetry={indexAttempt > 0} onBack={() => navigate('/')} bridgeFocus={Boolean(bridgeFocusHref)} onBridgeFocusConsumed={onBridgeFocusConsumed} />
  }

  // A preview document does not wait for, or depend on, the published site: until its index arrives (or when it
  // cannot be read) the shell is built on an empty one, and the reader moves onto the real one without reloading.
  const publishedIndex: SiteIndex = indexState.status === 'success'
    ? indexState.data
    : { schemaVersion: 1, site: { id: route.siteId, title: route.siteId }, generatedAt: new Date(0).toISOString(), artifacts: NO_PUBLISHED_ARTIFACTS }
  const index = registeredSite
    ? {
        ...publishedIndex,
        site: {
          ...publishedIndex.site,
          title: registeredSite.site.title,
          description: registeredSite.site.description,
        },
      }
    : publishedIndex

  return (
    <ArtifactWorkspace
      route={route}
      sites={sites}
      sitesLoading={sitesLoading}
      pathname={pathname}
      search={search}
      hash={hash}
      navigate={navigate}
      navigateFromDocument={navigateFromDocument}
      bridgeFocusHref={bridgeFocusHref}
      onBridgeFocusConsumed={onBridgeFocusConsumed}
      themeMode={themeMode}
      theme={theme}
      onSetThemeMode={onSetThemeMode}
      index={index}
      publishedIndexStatus={indexState.status}
      fullTextSearch={fullTextSearch}
      siteDiscoveryStatus={fullTextUrl && (visitSearchTarget?.siteId !== route.siteId || visitSearchTarget.url !== fullTextUrl) ? 'loading' : siteDiscoveryStatus}
      siteDiscoveryError={siteDiscoveryError}
      onRetryDiscovery={retryDiscovery}
    />
  )
}

function StatusPage({ title, message }: { title: string; message: string }) {
  usePageTitle(pageTitle(title === 'Sites' ? undefined : title, APP_NAME))
  const visible = useDelayedVisible()
  if (!visible) return <main className="status-page" aria-busy="true" />
  return (
    <main className="status-page">
      <div className="status-content">
        <p className="brand-label"><span className="brand-mark">A</span> Artifact Pages</p>
        <p className="eyebrow">{title}</p>
        <p role="status">{message}</p>
      </div>
    </main>
  )
}

function ErrorPage({
  title,
  scope = 'site',
  error,
  onBack,
  onRetry,
  focusRetry = false,
  bridgeFocus = false,
  onBridgeFocusConsumed,
}: {
  title: string
  bridgeFocus?: boolean
  onBridgeFocusConsumed?: () => void
  scope?: 'catalog' | 'site'
  error: Error
  onBack?: () => void
  onRetry?: () => void
  focusRetry?: boolean
}) {
  usePageTitle(pageTitle(scope === 'catalog' ? undefined : title, APP_NAME))
  const containerRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!bridgeFocus) return
    if (document.activeElement === document.body || document.activeElement === document.documentElement) {
      (containerRef.current?.querySelector<HTMLElement>('button') ?? containerRef.current?.querySelector<HTMLElement>('h1'))?.focus({ preventScroll: true })
    }
    onBridgeFocusConsumed?.()
  }, [bridgeFocus, onBridgeFocusConsumed])
  const invalidData = error instanceof IndexLoadError && error.invalidData
  const timedOut = error instanceof IndexLoadError && error.timedOut
  return (
    <main ref={containerRef} className="status-page">
      <div className="status-content">
        <p className="brand-label"><span className="brand-mark">A</span> Artifact Pages</p>
        <p className="eyebrow">{title}</p>
        <h1 tabIndex={-1}>{scope === 'catalog' ? 'Unable to load sites' : 'Unable to load this site'}</h1>
        <p className="error-message" role="alert">
          {invalidData
            ? scope === 'catalog'
              ? 'The site catalog is damaged or was written by an incompatible version. Ask the administrator to run the registry sync again.'
              : "This site's index is damaged or was written by an incompatible publisher. Ask the site's publisher to republish it."
            : timedOut
            ? scope === 'catalog'
              ? 'The site catalog is taking too long to load. Try again in a moment.'
              : 'This site is taking too long to load. Try again in a moment.'
            : error instanceof IndexLoadError && error.status
            ? scope === 'catalog'
              ? `The site catalog could not be loaded (HTTP ${error.status}). Please try again in a moment.`
              : `The site could not be loaded (HTTP ${error.status}). Please try again in a moment.`
            : scope === 'catalog'
              ? 'We could not load the site catalog. Check your connection and try again.'
              : 'We could not load this page. Check your connection and try again.'}
        </p>
        {onRetry && !invalidData ? <RetryButton onRetry={onRetry} autoFocus={focusRetry} /> : null}
        {onBack ? <button className="text-action" onClick={onBack}>← All sites</button> : null}
      </div>
    </main>
  )
}

function RetryButton({ onRetry, autoFocus }: { onRetry: () => void; autoFocus: boolean }) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  return <button ref={ref} className="text-action" type="button" onClick={onRetry}>Try again</button>
}

function RegisteredSiteStatusPage({
  title,
  heading,
  message,
  onBack,
  onRetry,
  focusRetry = false,
}: {
  title: string
  heading: string
  message: string
  onBack: () => void
  onRetry?: () => void
  focusRetry?: boolean
}) {
  usePageTitle(pageTitle(title, APP_NAME))
  return (
    <main className="status-page">
      <div className="status-content">
        <p className="brand-label"><span className="brand-mark">A</span> Artifact Pages</p>
        <p className="eyebrow">{title}</p>
        <h1>{heading}</h1>
        <p role="status">{message}</p>
        {onRetry ? <RetryButton onRetry={onRetry} autoFocus={focusRetry} /> : null}
        <button className="text-action" onClick={onBack}>← All sites</button>
      </div>
    </main>
  )
}

/**
 * A confirmed but unreadable format: the data was written by a different major
 * product version. Distinct from a network or invalid-data error, which stay on
 * ErrorPage.
 */
function RepublishPage({ scope, title, onBack }: { scope: 'site' | 'registry'; title: string; onBack: () => void }) {
  const heading = scope === 'site' ? 'This site needs to be republished' : 'This library needs to be updated'
  usePageTitle(pageTitle(scope === 'registry' ? undefined : title, APP_NAME))
  return (
    <main className="status-page">
      <div className="status-content" data-state="needs-republish">
        <p className="brand-label"><span className="brand-mark">A</span> Artifact Pages</p>
        <p className="eyebrow">{title}</p>
        <h1>{heading}</h1>
        <p role="status">
          {scope === 'site'
            ? 'Its published data uses a format this version of Artifact Pages cannot read. Ask the site owner to publish it again; it will appear here afterwards.'
            : 'The list of sites uses a format this version of Artifact Pages cannot read. Ask the administrator to register the sites again and republish each one.'}
        </p>
        {scope === 'site' ? <button className="text-action" onClick={onBack}>← All sites</button> : null}
      </div>
    </main>
  )
}

function PageNotFoundPage({ onBack }: { onBack: () => void }) {
  usePageTitle(pageTitle('Page not found', APP_NAME))
  usePageNoindex()
  return (
    <main className="status-page">
      <div className="status-content">
        <p className="brand-label"><span className="brand-mark">A</span> Artifact Pages</p>
        <p className="eyebrow">404</p>
        <h1>Page not found</h1>
        <p role="alert">The page you requested does not exist or is no longer available.</p>
        <button className="text-action" onClick={onBack}>← All sites</button>
      </div>
    </main>
  )
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export default App
