import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { ArtifactWorkspace } from './components/ArtifactWorkspace'
import { PreviewDocumentPage } from './components/PreviewDocumentPage'
import { PreviewListPage } from './components/PreviewListPage'
import { SitePicker } from './components/SitePicker'
import { defaultSiteIndexUrl, discoverSites, IndexLoadError, isValidSiteId, loadSiteIndex } from './data/indexes'
import { hasSiteDiscoveryMetadata, type SiteCatalogEntry, type SiteIndex } from './domain/index'
import { isThemeMode, resolveTheme } from './domain/theme'
import type { ResolvedTheme, ThemeMode } from './domain/theme'
import { parseRoute, type AppRoute } from './routing'

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

  const navigate = useCallback((href: string) => {
    window.history.pushState({}, '', href)
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
  const { route, pathname, hash, navigate } = useLocation()
  const { themeMode, theme, setThemeMode } = useTheme()
  const [sites, setSites] = useState<LoadingState<SiteCatalogEntry[]>>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    discoverSites().then(
      (metadata) => {
        if (!cancelled) setSites({ status: 'success', data: metadata })
      },
      (error: unknown) => {
        if (!cancelled) setSites({ status: 'error', error: toError(error) })
      },
    )

    return () => {
      cancelled = true
    }
  }, [])

  if (route.kind === 'sites') {
    if (sites.status === 'loading') return <StatusPage title="Sites" message="Loading sites…" />
    if (sites.status === 'error') return <ErrorPage title="Sites" scope="catalog" error={sites.error} />
    return (
      <SitePicker
        sites={sites.data}
        onNavigate={navigate}
        themeMode={themeMode}
        onSetThemeMode={setThemeMode}
      />
    )
  }

  if (route.kind === 'preview-list') {
    return <PreviewListPage route={route} navigate={navigate} />
  }

  if (route.kind === 'preview-document') {
    return <PreviewDocumentPage route={route} hash={hash} navigate={navigate} />
  }

  return (
    <SitePage
      key={route.siteId}
      route={route}
      pathname={pathname}
      hash={hash}
      sites={sites.status === 'success' ? sites.data : []}
      sitesLoading={sites.status === 'loading'}
      siteDiscoveryStatus={sites.status}
      navigate={navigate}
      themeMode={themeMode}
      theme={theme}
      onSetThemeMode={setThemeMode}
    />
  )
}

function SitePage({
  route,
  sites,
  sitesLoading,
  siteDiscoveryStatus,
  pathname,
  hash,
  navigate,
  themeMode,
  theme,
  onSetThemeMode,
}: {
  route: Extract<AppRoute, { kind: 'site' }>
  sites: SiteCatalogEntry[]
  sitesLoading: boolean
  siteDiscoveryStatus: LoadingState<SiteCatalogEntry[]>['status']
  pathname: string
  hash: string
  navigate: (href: string) => void
  themeMode: ThemeMode
  theme: ResolvedTheme
  onSetThemeMode: (mode: ThemeMode) => void
}) {
  const [indexState, setIndexState] = useState<LoadingState<SiteIndex>>({ status: 'loading' })
  const registeredSite = sites.find(({ site }) => site.id === route.siteId)
  const artifactIndexUrl = registeredSite && hasSiteDiscoveryMetadata(registeredSite)
    ? registeredSite.artifactIndexUrl
    : defaultSiteIndexUrl(route.siteId)

  useEffect(() => {
    let cancelled = false
    setIndexState({ status: 'loading' })
    loadSiteIndex(route.siteId, fetch, artifactIndexUrl).then(
      (index) => {
        if (!cancelled) setIndexState({ status: 'success', data: index })
      },
      (error: unknown) => {
        if (!cancelled) setIndexState({ status: 'error', error: toError(error) })
      },
    )

    return () => {
      cancelled = true
    }
  }, [route.siteId, artifactIndexUrl])

  if (indexState.status === 'loading') {
    return <StatusPage title={route.siteId} message="Loading site index…" />
  }
  if (indexState.status === 'error') {
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
        onBack={() => navigate('/')}
      />
    }
    return <ErrorPage title={route.siteId} error={indexState.error} onBack={() => navigate('/')} />
  }

  const index = registeredSite
    ? {
        ...indexState.data,
        site: {
          ...indexState.data.site,
          title: registeredSite.site.title,
          description: registeredSite.site.description,
        },
      }
    : indexState.data

  return (
    <ArtifactWorkspace
      route={route}
      sites={sites}
      sitesLoading={sitesLoading}
      pathname={pathname}
      hash={hash}
      navigate={navigate}
      themeMode={themeMode}
      theme={theme}
      onSetThemeMode={onSetThemeMode}
      index={index}
    />
  )
}

function StatusPage({ title, message }: { title: string; message: string }) {
  return (
    <main className="status-page">
      <div className="status-content">
        <p className="brand-label"><span className="brand-mark">G</span> Git Artifact Pages</p>
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
}: {
  title: string
  scope?: 'catalog' | 'site'
  error: Error
  onBack?: () => void
}) {
  return (
    <main className="status-page">
      <div className="status-content">
        <p className="brand-label"><span className="brand-mark">G</span> Git Artifact Pages</p>
        <p className="eyebrow">{title}</p>
        <h1>{scope === 'catalog' ? 'Unable to load sites' : 'Unable to load this site'}</h1>
        <p className="error-message" role="alert">
          {error instanceof IndexLoadError && error.status
            ? scope === 'catalog'
              ? `The site catalog could not be loaded (HTTP ${error.status}). Please try again in a moment.`
              : `The site could not be loaded (HTTP ${error.status}). Please try again in a moment.`
            : scope === 'catalog'
              ? 'We could not load the site catalog. Check your connection and try again.'
              : 'We could not load this page. Check your connection and try again.'}
        </p>
        {onBack ? <button className="text-action" onClick={onBack}>← All sites</button> : null}
      </div>
    </main>
  )
}

function RegisteredSiteStatusPage({
  title,
  heading,
  message,
  onBack,
}: {
  title: string
  heading: string
  message: string
  onBack: () => void
}) {
  return (
    <main className="status-page">
      <div className="status-content">
        <p className="brand-label"><span className="brand-mark">G</span> Git Artifact Pages</p>
        <p className="eyebrow">{title}</p>
        <h1>{heading}</h1>
        <p role="status">{message}</p>
        <button className="text-action" onClick={onBack}>← All sites</button>
      </div>
    </main>
  )
}

function PageNotFoundPage({ onBack }: { onBack: () => void }) {
  return (
    <main className="status-page">
      <div className="status-content">
        <p className="brand-label"><span className="brand-mark">G</span> Git Artifact Pages</p>
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
