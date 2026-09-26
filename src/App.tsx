import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { ArtifactWorkspace } from './components/ArtifactWorkspace'
import { SitePicker } from './components/SitePicker'
import { defaultSiteIndexUrl, discoverSites, IndexLoadError, isValidSiteId, loadSiteIndex } from './data/indexes'
import type { SiteDiscoveryMetadata, SiteIndex } from './domain/index'
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
    hash: window.location.hash,
  }))

  useEffect(() => {
    const sync = () => setUrl({ pathname: window.location.pathname, hash: window.location.hash })
    window.addEventListener('popstate', sync)
    window.addEventListener('hashchange', sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener('hashchange', sync)
    }
  }, [])

  const navigate = useCallback((href: string) => {
    window.history.pushState({}, '', href)
    setUrl({ pathname: window.location.pathname, hash: window.location.hash })
  }, [])

  return { ...url, route: parseRoute(url.pathname), navigate }
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
  const [sites, setSites] = useState<LoadingState<SiteDiscoveryMetadata[]>>({ status: 'loading' })

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
    if (sites.status === 'error') return <ErrorPage title="Sites" error={sites.error} />
    return (
      <SitePicker
        sites={sites.data}
        onNavigate={navigate}
        themeMode={themeMode}
        onSetThemeMode={setThemeMode}
      />
    )
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
  sites: SiteDiscoveryMetadata[]
  sitesLoading: boolean
  siteDiscoveryStatus: LoadingState<SiteDiscoveryMetadata[]>['status']
  pathname: string
  hash: string
  navigate: (href: string) => void
  themeMode: ThemeMode
  theme: ResolvedTheme
  onSetThemeMode: (mode: ThemeMode) => void
}) {
  const [indexState, setIndexState] = useState<LoadingState<SiteIndex>>({ status: 'loading' })
  const artifactIndexUrl = sites.find(({ site }) => site.id === route.siteId)?.artifactIndexUrl
    ?? defaultSiteIndexUrl(route.siteId)

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
        !sites.some(({ site }) => site.id === route.siteId)
      )
    ) {
      return <SiteNotFoundPage siteId={route.siteId} onBack={() => navigate('/')} />
    }
    return <ErrorPage title={route.siteId} error={indexState.error} onBack={() => navigate('/')} />
  }

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
      index={indexState.data}
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
  error,
  onBack,
}: {
  title: string
  error: Error
  onBack?: () => void
}) {
  return (
    <main className="status-page">
      <div className="status-content">
        <p className="brand-label"><span className="brand-mark">G</span> Git Artifact Pages</p>
        <p className="eyebrow">{title}</p>
        <h1>Unable to load this site</h1>
        <p className="error-message" role="alert">
          {error instanceof IndexLoadError && error.status
            ? `The site could not be loaded (HTTP ${error.status}). Please try again in a moment.`
            : 'We could not load this page. Check your connection and try again.'}
        </p>
        {onBack ? <button className="text-action" onClick={onBack}>← All sites</button> : null}
      </div>
    </main>
  )
}

function SiteNotFoundPage({ siteId, onBack }: { siteId: string; onBack: () => void }) {
  return (
    <main className="status-page">
      <div className="status-content">
        <p className="brand-label"><span className="brand-mark">G</span> Git Artifact Pages</p>
        <p className="eyebrow">{siteId}</p>
        <h1>Site not found</h1>
        <p role="alert">We could not find a site named “{siteId}”.</p>
        <button className="text-action" onClick={onBack}>← All sites</button>
      </div>
    </main>
  )
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export default App
