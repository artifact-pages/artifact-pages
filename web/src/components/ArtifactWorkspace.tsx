import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArtifactBreadcrumbs } from './ArtifactBreadcrumbs'
import { CommandPalette, type PaletteCommand } from './CommandPalette'
import { DirectoryPage } from './DirectoryPage'
import { Icon } from './Icon'
import { Sidebar } from './Sidebar'
import { RecentlyUpdated, SiteHome, SiteHomeHeader } from './SiteHome'
import { siteCountLabel } from '../domain/site-count-label'
import { ThemeSwitcher } from './ThemeSwitcher'
import { ReaderMoreMenu, type ReaderMoreMenuItem } from './ReaderMoreMenu'
import { NARROW_CHROME_QUERY, useMediaQuery } from './useMediaQuery'
import { MarkdownArtifact } from './MarkdownArtifact'
import { ReadNext } from './ReadNext'
import { relatedPages } from '../domain/related-pages'
import { MatchNavigator } from './MatchNavigator'
import { SEARCH_PAGE_INPUT_ID, SearchResultsPage } from './SearchResultsPage'
import { usePageTextSearch } from './usePageTextSearch'
import { pageTitle, usePageTitle } from './usePageTitle'
import { usePageNoindex } from './usePageNoindex'
import { followInApp } from './spa-link'
import { nearbyArtifacts } from '../domain/nearby-pages'
import { resolveDirectory, resolveRootDirectory } from '../domain/directory'
import { normalizeLanguageTag } from '../domain/document-language'
import type { FullTextHit, SiteFullTextSearch } from '../data/fulltext'
import { clampMatch, stepMatch } from '../domain/match-navigator'
import { rankHits } from '../domain/search-ranking'
import { clearSearchHighlight, ensureSearchHighlightStyle, keepSearchHighlighted, setCurrentSearchMatch, watchReaderScroll } from '../domain/text-highlight'
import type { TreeStyle } from './ArtifactTree'
import type { ArtifactIndexEntry, SiteCatalogEntry, SiteIndex, SiteSummary } from '../domain/index'
import { readRecentArtifactReads, recordRecentArtifactRead, type RecentArtifactRead } from '../domain/recent-reads'
import { themeModeIcon, type ResolvedTheme, type ThemeMode } from '../domain/theme'
import { artifactRouteHref, searchRouteHref, type AppRoute } from '../routing'

type SiteRoute = Extract<AppRoute, { kind: 'site' }>
type SearchRoute = Extract<AppRoute, { kind: 'search' }>
type WorkspacePanel = 'contents' | 'details' | null

export function ArtifactWorkspace({
  route,
  pathname,
  search = '',
  hash,
  sites,
  sitesLoading,
  navigate,
  themeMode,
  theme,
  onSetThemeMode,
  index,
  fullTextSearch,
  recentReads,
  sidebarTreeStyle = 'branch-guides',
  initialExpandedPaths = [],
  initialSidebarOpen,
  rankingMaxHits: rankingMaxHitsProp,
}: {
  route: SiteRoute | SearchRoute
  pathname: string
  /** The location's query string; on a page `q` is the search whose matches the page highlights. */
  search?: string
  hash: string
  sites: SiteCatalogEntry[]
  sitesLoading: boolean
  navigate: (href: string, options?: { replace?: boolean }) => void
  themeMode: ThemeMode
  theme: ResolvedTheme
  onSetThemeMode: (mode: ThemeMode) => void
  index: SiteIndex
  /** The active site's full-text client. Omit it, or pass an unavailable one, for sites without page text search. */
  fullTextSearch?: SiteFullTextSearch
  recentReads?: RecentArtifactRead[]
  sidebarTreeStyle?: TreeStyle
  initialExpandedPaths?: string[]
  initialSidebarOpen?: boolean
  /** Page text search ranks up to this many matching pages (stories and tests lower it). */
  rankingMaxHits?: number
}) {
  const [sidebarOpen, setSidebarOpen] = useState(() => initialSidebarOpen ?? window.innerWidth > 860)
  const sidebarOpenRef = useRef(sidebarOpen)
  const [activePanel, setActivePanel] = useState<WorkspacePanel>(null)
  const [paletteSeed, setPaletteSeed] = useState<string | null>(null)
  const textSearchClient = fullTextSearch?.available ? fullTextSearch : undefined
  const searchRoute = route.kind === 'search' ? route : undefined
  const routeArtifactPath = route.kind === 'site' ? route.artifactPath : undefined
  // The search whose matches the open page highlights (`?q=` on a page route).
  const pageQuery = useMemo(
    () => textSearchClient && route.kind === 'site' ? new URLSearchParams(search).get('q')?.trim() ?? '' : '',
    [search, textSearchClient, route.kind],
  )
  const hashRef = useRef(hash)
  hashRef.current = hash
  const rankingMaxHits = rankingMaxHitsProp ?? testRankingMaxHits()
  const artifactsById = useMemo(() => new Map(index.artifacts.map((artifact) => [artifact.id, artifact])), [index.artifacts])
  const rankTextHits = useCallback(
    (hits: FullTextHit[], query: string) => rankHits(hits, query, artifactsById),
    [artifactsById],
  )
  const textSearch = usePageTextSearch(textSearchClient, searchRoute?.query ?? '', { rank: rankTextHits, rankingMaxHits })
  const [pinnedArtifactsBySite, setPinnedArtifactsBySite] = useState<Record<string, string[]>>(readPinnedArtifacts)
  const pinnedArtifactIds = pinnedArtifactsBySite[index.site.id] ?? []
  const [storedRecentReads, setStoredRecentReads] = useState<RecentArtifactRead[]>(
    () => readRecentArtifactReads(index.site.id),
  )
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set([
      ...folderAncestors(routeArtifactPath),
      ...folderPaths(routeArtifactPath && !findArtifact(index, routeArtifactPath) ? routeArtifactPath : ''),
      ...initialExpandedPaths,
    ]),
  )
  const [sidebarReveal, setSidebarReveal] = useState<{ path: string; request: number } | null>(null)
  const sidebarRevealRequest = useRef(0)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const paletteReturnFocus = useRef<HTMLElement | null>(null)
  // Set when a palette choice navigates; focus then goes to the page rather than back to the trigger.
  const focusStageAfterPalette = useRef(false)
  const stageRef = useRef<HTMLElement>(null)
  const htmlFrameRef = useRef<HTMLIFrameElement>(null)
  const contentsToggleRef = useRef<HTMLButtonElement>(null)
  const detailsToggleRef = useRef<HTMLButtonElement>(null)
  const moreMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const narrowChrome = useMediaQuery(NARROW_CHROME_QUERY)
  const headingJumpRequest = useRef(0)
  const headingJumpTimer = useRef<number | null>(null)
  const [headingJump, setHeadingJump] = useState<'pending' | 'settled' | null>(null)
  const [activeHeading, setActiveHeading] = useState<{ artifactId: string, id: string } | null>(null)
  const currentArtifact = routeArtifactPath
    ? findArtifact(index, routeArtifactPath)
    : undefined
  // A path that is not a page may be a folder: every folder is a page (ISSUE-075).
  // The site root is the root folder's directory page, with an empty path.
  const currentDirectory = useMemo(
    () => route.kind !== 'site'
      ? undefined
      : routeArtifactPath
        ? (!currentArtifact ? resolveDirectory(index.artifacts, routeArtifactPath) : undefined)
        : resolveRootDirectory(index.artifacts),
    [route.kind, routeArtifactPath, currentArtifact, index.artifacts],
  )
  const isSiteRoot = Boolean(currentDirectory) && !routeArtifactPath
  // The page whose content fills the stage: the open page, or a folder's README or index page.
  const bodyArtifact = currentArtifact ?? currentDirectory?.indexArtifact
  const effectiveRecentReads = recentReads ?? storedRecentReads
  const pageNotFound = Boolean(routeArtifactPath) && !currentArtifact && !currentDirectory
  usePageNoindex(pageNotFound)
  // The language the open HTML artifact declares on its own <html>, keyed by the artifact it was read from.
  const [frameLanguage, setFrameLanguage] = useState<{ artifactUrl: string, lang: string | undefined } | null>(null)
  // A known HTML body whose response failed (ISSUE-106), keyed by the artifact it was read from.
  const [frameFailure, setFrameFailure] = useState<{ artifactUrl: string, status: number } | null>(null)
  const [frameAttempt, setFrameAttempt] = useState(0)
  const retryFrameRef = useRef<HTMLButtonElement | null>(null)
  const focusRetryRef = useRef(false)
  // Loads seen by the current iframe mount: only the first one is the artifact's own load (ISSUE-106).
  const frameLoadCount = useRef(0)
  const frameStatusAbort = useRef<AbortController | null>(null)
  const nearbyPages = useMemo(
    () => pageNotFound && routeArtifactPath ? nearbyArtifacts(index.artifacts, routeArtifactPath) : [],
    [pageNotFound, routeArtifactPath, index.artifacts],
  )
  usePageTitle(searchRoute
    ? pageTitle(searchRoute.query ? `Search “${searchRoute.query}”` : 'Search', index.site.title)
    : routeArtifactPath
      ? pageTitle(currentArtifact?.title ?? currentDirectory?.label ?? 'Page not found', index.site.title)
      : pageTitle(index.site.title))
  // The match navigator belongs to one page and query; closing it also removes the highlight.
  const navigatorKey = bodyArtifact && pageQuery ? `${bodyArtifact.id}\n${pageQuery}` : ''
  const [closedNavigatorKey, setClosedNavigatorKey] = useState<string | null>(null)
  const highlightQuery = navigatorKey && closedNavigatorKey !== navigatorKey ? pageQuery : ''
  const highlightQueryRef = useRef(highlightQuery)
  highlightQueryRef.current = highlightQuery
  // Ranges belong to the page and query they were found for: a report is filed under the key current when it
  // arrives, so a new page or query never shows the previous count or steps through its detached ranges.
  const navigatorKeyRef = useRef(navigatorKey)
  navigatorKeyRef.current = navigatorKey
  const [reportedMatches, setReportedMatches] = useState<{ key: string; ranges: Range[] }>({ key: '', ranges: [] })
  const matchRanges = reportedMatches.key === navigatorKey ? reportedMatches.ranges : NO_RANGES
  const [matchIndex, setMatchIndex] = useState(0)
  const reportMatches = useCallback((ranges: Range[]) => {
    // Captured now: the updater may run later, after the key has changed.
    const key = navigatorKeyRef.current
    setReportedMatches((current) => {
      // An empty report over an already empty one changes nothing; skipping it avoids a re-render on every page load.
      return ranges.length === 0 && current.key === key && current.ranges.length === 0 ? current : { key, ranges }
    })
  }, [])
  const currentMatch = clampMatch(matchIndex, matchRanges.length)
  const navigatorVisible = highlightQuery !== '' && matchRanges.length > 0
  useEffect(() => setMatchIndex(0), [navigatorKey])
  useEffect(() => {
    const range = matchRanges[currentMatch]
    const targetDocument = range?.startContainer.ownerDocument ?? htmlFrameRef.current?.contentDocument ?? document
    setCurrentSearchMatch(targetDocument, range)
  }, [matchRanges, currentMatch])
  const lastRecordedArtifactId = useRef<string | null>(null)
  const currentFormat = bodyArtifact?.format
  const hasContents = Boolean(bodyArtifact?.toc?.length)
  const tocOpen = activePanel === 'contents'
  const detailsOpen = activePanel === 'details'
  const panelLabel = activePanel === 'details' ? 'Details' : 'Contents'

  // Any panel change, artifact change or unmount invalidates a pending jump check.
  useEffect(() => {
    return () => {
      headingJumpRequest.current += 1
      if (headingJumpTimer.current !== null) window.clearTimeout(headingJumpTimer.current)
      headingJumpTimer.current = null
      setActiveHeading(null)
      setHeadingJump((current) => current === 'pending' ? null : current)
    }
  }, [activePanel, bodyArtifact?.id])

  const togglePanel = useCallback((panel: Exclude<WorkspacePanel, null>) => {
    setActivePanel((current) => current === panel ? null : panel)
  }, [])

  const updateExpandedPaths = useCallback((update: (current: Set<string>) => Set<string>) => {
    setExpandedPaths(update)
  }, [])

  const updateSidebarOpen = useCallback((open: boolean, restoreFocus = false) => {
    sidebarOpenRef.current = open
    setSidebarOpen(open)
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        document.getElementById(open ? 'site-switcher' : 'sidebar-toggle-trigger')?.focus()
      })
    }
  }, [])

  const toggleSidebar = useCallback((restoreFocus = false) => {
    updateSidebarOpen(!sidebarOpenRef.current, restoreFocus)
  }, [updateSidebarOpen])

  function navigateWithinWorkspace(href: string) {
    focusStageAfterPalette.current = true
    navigate(href)
    if (window.innerWidth <= 860) updateSidebarOpen(false)
  }

  // The results page. Its field is focused when the page opens; when it is
  // already open (a palette hand-off with a new query) focus is moved here.
  function openSearchResults(query: string, folder?: string) {
    setPaletteSeed(null)
    const target = searchRouteHref(index.site.id, query, folder)
    // Opening the page that is already open must not add a history entry.
    navigate(target, { replace: target === `${pathname}${search}` })
    if (window.innerWidth <= 860) updateSidebarOpen(false)
    window.requestAnimationFrame(() => document.getElementById(SEARCH_PAGE_INPUT_ID)?.focus())
  }

  // ⌘ ⇧ F: the results page, with the query of the open page's search ready to change.
  const goToSearchPage = useCallback(() => {
    if (!textSearchClient) {
      showToast('Page text search is not available for this site.')
      return
    }
    setPaletteSeed(null)
    if (route.kind === 'search') {
      const input = document.getElementById(SEARCH_PAGE_INPUT_ID)
      if (input instanceof HTMLInputElement) {
        input.focus()
        input.select()
      }
      return
    }
    navigate(searchRouteHref(index.site.id, highlightQueryRef.current))
  }, [textSearchClient, route.kind, navigate, index.site.id])

  const openPalette = useCallback((seed: string) => {
    const activeElement = document.activeElement
    paletteReturnFocus.current = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement
      : null
    focusStageAfterPalette.current = false
    setPaletteSeed(seed)
  }, [])

  const handleArtifactKeyDown = useCallback((event: KeyboardEvent) => {
    const modifier = event.metaKey || event.ctrlKey
    const key = event.key.toLocaleLowerCase()
    if (modifier && !event.shiftKey && key === 'k') {
      event.preventDefault()
      event.stopImmediatePropagation()
      openPalette('')
    } else if (modifier && event.shiftKey && key === 'f') {
      event.preventDefault()
      event.stopImmediatePropagation()
      goToSearchPage()
    } else if (modifier && !event.shiftKey && key === 'b') {
      event.preventDefault()
      event.stopImmediatePropagation()
      toggleSidebar(true)
    } else if (event.key === 'Escape' && navigatorVisibleRef.current) {
      // Pressed inside the page's frame, where the window handler below does not see it.
      closeNavigatorRef.current()
    }
  }, [openPalette, goToSearchPage, toggleSidebar])

  // The frame's window keeps the listener it got on load, so it must call the
  // latest handler (the page text search client or sidebar state may have
  // changed since) rather than the closure from that render.
  const artifactKeyDownRef = useRef(handleArtifactKeyDown)
  useEffect(() => {
    artifactKeyDownRef.current = handleArtifactKeyDown
  }, [handleArtifactKeyDown])
  const forwardArtifactKeyDown = useCallback((event: KeyboardEvent) => {
    artifactKeyDownRef.current(event)
  }, [])

  // The page itself (its frame, when it has one) is where a keyboard reader continues reading.
  const focusStage = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    const frame = stage.querySelector<HTMLElement>('.artifact-frame')
    ;(frame ?? stage).focus({ preventScroll: true })
  }, [])

  const closePalette = useCallback(() => {
    setPaletteSeed(null)
    // Runs after the choice (if any) has navigated, twice so a newly mounted page frame exists.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (focusStageAfterPalette.current) {
        focusStageAfterPalette.current = false
        focusStage()
        return
      }
      // Something else already took focus (the hand-off to page text search does).
      if (document.activeElement && document.activeElement !== document.body) return
      const target = paletteReturnFocus.current
      if (target?.isConnected && target.getClientRects().length > 0) target.focus()
      else focusStage()
    }))
  }, [focusStage])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  useEffect(() => {
    try {
      window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(pinnedArtifactsBySite))
    } catch {
      // Pinning remains available for this session if browser storage is disabled.
    }
  }, [pinnedArtifactsBySite])

  useEffect(() => {
    if (initialSidebarOpen !== undefined) updateSidebarOpen(initialSidebarOpen)
  }, [initialSidebarOpen, updateSidebarOpen])

  useEffect(() => {
    setActivePanel(null)
    if (window.innerWidth <= 860) updateSidebarOpen(false)
  }, [routeArtifactPath, route.kind, updateSidebarOpen])

  useEffect(() => {
    if (!sidebarReveal || !sidebarOpen) return

    const frame = window.requestAnimationFrame(() => {
      const browseTree = document.querySelector('.sidebar-panel .browse-tree')
      const rows = Array.from(browseTree?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? [])
      // A folded index page has no row of its own; its folder row stands for it.
      const target = rows.find((element) => element.dataset.treePath === sidebarReveal.path)
        ?? rows.find((element) => element.dataset.treePath === sidebarReveal.path.split('/').slice(0, -1).join('/'))
      target?.focus({ preventScroll: true })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [sidebarReveal, sidebarOpen])

  useEffect(() => {
    if (recentReads !== undefined || !bodyArtifact || lastRecordedArtifactId.current === bodyArtifact.id) return
    lastRecordedArtifactId.current = bodyArtifact.id
    setStoredRecentReads(recordRecentArtifactRead(index.site.id, bodyArtifact.id, storedRecentReads))
  }, [bodyArtifact?.id, index.site.id, recentReads, storedRecentReads])

  useEffect(() => {
    if (paletteSeed === null) return
    const handleKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey
      const key = event.key.toLocaleLowerCase()

      if (modifier && key === 'k') {
        event.preventDefault()
        closePalette()
      } else if (modifier && event.shiftKey && key === 'f') {
        event.preventDefault()
        goToSearchPage()
      } else if (modifier && key === 'b') {
        event.preventDefault()
        toggleSidebar()
      } else if (modifier && event.shiftKey && key === 'o') {
        event.preventDefault()
        togglePanel('contents')
      } else if (event.key === 'Escape') {
        closePalette()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [paletteSeed, closePalette, toggleSidebar, togglePanel, goToSearchPage])

  useEffect(() => {
    if (paletteSeed !== null) return
    const handleKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey
      const key = event.key.toLocaleLowerCase()

      if (modifier && key === 'k') {
        event.preventDefault()
        openPalette('')
      } else if (modifier && event.shiftKey && key === 'f') {
        event.preventDefault()
        goToSearchPage()
      } else if (modifier && key === 'b') {
        event.preventDefault()
        toggleSidebar(true)
      } else if (modifier && event.shiftKey && key === 'o' && hasContents) {
        event.preventDefault()
        togglePanel('contents')
      } else if (event.key === 'Escape' && !event.defaultPrevented && activePanel !== null) {
        setActivePanel(null)
      } else if (event.key === 'Escape' && !event.defaultPrevented && navigatorVisibleRef.current) {
        closeNavigatorRef.current()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [paletteSeed, hasContents, activePanel, openPalette, toggleSidebar, togglePanel, goToSearchPage])

  const siteSummaries: SiteSummary[] = sites.length
    ? sites.map(({ site }) => site).sort((left, right) => left.title.localeCompare(right.title))
    : [index.site]
  const paletteSites: SiteCatalogEntry[] = sites.some(({ site }) => site.id === index.site.id)
    ? sites
    : [{
        schemaVersion: index.schemaVersion,
        site: index.site,
        generatedAt: index.generatedAt,
        artifactCount: index.artifacts.length,
        artifactIndexUrl: `/_indexes/${encodeURIComponent(index.site.id)}/index.json`,
        status: 'available',
      }, ...sites]
  const countLabel = siteCountLabel(paletteSites.length)
  const commands: PaletteCommand[] = [
    { title: 'Toggle sidebar', shortcut: '⌘ B', onSelect: () => toggleSidebar() },
    {
      title: 'Toggle contents',
      shortcut: '⌘ ⇧ O',
      available: hasContents,
      onSelect: () => togglePanel('contents'),
    },
    {
      title: 'Toggle details',
      available: Boolean(bodyArtifact),
      onSelect: () => togglePanel('details'),
    },
    {
      title: bodyArtifact && pinnedArtifactIds.includes(bodyArtifact.id) ? 'Unpin artifact' : 'Pin artifact',
      available: Boolean(bodyArtifact),
      onSelect: () => {
        if (bodyArtifact) toggleArtifactPin(bodyArtifact)
      },
    },
    { title: 'Go to site home', onSelect: () => navigateWithinWorkspace(`/${encodeURIComponent(index.site.id)}`) },
    {
      title: 'Search page text',
      shortcut: '⌘ ⇧ F',
      available: Boolean(textSearchClient),
      onSelect: () => goToSearchPage(),
    },
    { title: 'Open previews', onSelect: () => navigateWithinWorkspace(`/${encodeURIComponent(index.site.id)}/_previews`) },
    {
      title: 'Use light theme',
      subtitle: themeMode === 'light' ? 'Current' : undefined,
      onSelect: () => onSetThemeMode('light'),
    },
    {
      title: 'Use dark theme',
      subtitle: themeMode === 'dark' ? 'Current' : undefined,
      onSelect: () => onSetThemeMode('dark'),
    },
    {
      title: 'Use system theme',
      subtitle: themeMode === 'system' ? 'Current' : undefined,
      onSelect: () => onSetThemeMode('system'),
    },
    {
      title: 'Copy artifact link',
      available: Boolean(currentArtifact || currentDirectory),
      onSelect: () => void copyCurrentLink(showToast),
    },
    {
      title: 'Open raw artifact',
      available: Boolean(bodyArtifact),
      onSelect: () => {
        if (bodyArtifact) window.open(bodyArtifact.artifactUrl, '_blank', 'noopener,noreferrer')
      },
    },
  ]

  function showToast(message: string) {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 1900)
  }

  function toggleArtifactPin(artifact: ArtifactIndexEntry) {
    const willPin = !pinnedArtifactIds.includes(artifact.id)
    setPinnedArtifactsBySite((current) => {
      const sitePins = current[index.site.id] ?? []
      const nextPins = willPin
        ? [...sitePins, artifact.id]
        : sitePins.filter((id) => id !== artifact.id)
      return { ...current, [index.site.id]: nextPins }
    })
    showToast(willPin ? `Pinned ${artifact.title}.` : `Unpinned ${artifact.title}.`)
  }

  function openArtifact(artifact: ArtifactIndexEntry) {
    navigateWithinWorkspace(artifactRouteHref(index.site.id, artifact.path))
    setActivePanel(null)
    setPaletteSeed(null)
  }

  function stepNavigator(delta: 1 | -1) {
    const next = stepMatch(currentMatch, matchRanges.length, delta)
    setMatchIndex(next)
    matchRanges[next]?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }

  // Closing removes the highlight and returns focus to the page the reader was reading.
  function closeNavigator() {
    setClosedNavigatorKey(navigatorKey)
    focusStage()
  }
  const closeNavigatorRef = useRef(closeNavigator)
  closeNavigatorRef.current = closeNavigator
  const navigatorVisibleRef = useRef(navigatorVisible)
  navigatorVisibleRef.current = navigatorVisible

  function openDirectory(path: string) {
    navigateWithinWorkspace(artifactRouteHref(index.site.id, path))
    setActivePanel(null)
    setPaletteSeed(null)
  }

  function revealSidebarLocation(path: string, isDirectory: boolean) {
    const folders = isDirectory ? folderPaths(path) : folderAncestors(path)
    setExpandedPaths((current) => new Set([...current, ...folders]))
    setSidebarReveal({ path, request: ++sidebarRevealRequest.current })
    updateSidebarOpen(true)
  }

  function cancelHeadingJump() {
    headingJumpRequest.current += 1
    if (headingJumpTimer.current !== null) window.clearTimeout(headingJumpTimer.current)
    headingJumpTimer.current = null
    setActiveHeading(null)
  }

  function closePanelAfterJump() {
    setHeadingJump('settled')
    setActivePanel(null)
    ;(contentsToggleRef.current ?? moreMenuTriggerRef.current)?.focus()
  }

  // Contents stays open after a jump only when the target heading is not
  // covered by the (absolutely positioned) panel. HTML artifacts always close
  // (their headings end up under the panel, and measuring would only delay the
  // close); Markdown headings are measured once the scroll settles. Unmeasurable
  // targets fall back to closing. Palette jumps always close.
  function jumpToHeading(id: string, options: { keepPanelIfClear?: boolean } = {}) {
    cancelHeadingJump()
    navigateWithinWorkspace(`${pathname}#${encodeURIComponent(id)}`)
    setPaletteSeed(null)
    if (!options.keepPanelIfClear) {
      setActivePanel(null)
      return
    }
    if (currentFormat !== 'markdown') {
      closePanelAfterJump()
      return
    }
    const request = headingJumpRequest.current
    const artifactId = bodyArtifact?.id ?? ''
    setHeadingJump('pending')
    // Wait for the scroll to settle (heading position unchanged between polls).
    let previousTop: number | null = null
    let attempts = 0
    const settle = () => {
      headingJumpTimer.current = null
      if (request !== headingJumpRequest.current) return
      const top = headingTop(id)
      attempts += 1
      if ((top === null && attempts < 5) || (top !== null && top !== previousTop && attempts < 20)) {
        previousTop = top
        headingJumpTimer.current = window.setTimeout(settle, 60)
        return
      }
      if (headingIsClearOfPanel(id)) {
        setHeadingJump('settled')
        setActiveHeading({ artifactId, id })
      } else {
        closePanelAfterJump()
      }
    }
    headingJumpTimer.current = window.setTimeout(settle, 60)
  }

  function closePanel() {
    const toggle = activePanel === 'details' ? detailsToggleRef.current : contentsToggleRef.current
    setActivePanel(null)
    ;(toggle ?? moreMenuTriggerRef.current)?.focus()
  }

  const htmlArtifactUrl = bodyArtifact && currentFormat === 'html'
    ? bodyArtifact.artifactUrl
    : undefined
  const syncHtmlFrameLocation = useCallback((iframe = htmlFrameRef.current) => {
    if (!iframe || !htmlArtifactUrl) return
    const frameWindow = iframe.contentWindow
    if (!frameWindow) return

    try {
      const expectedUrl = new URL(htmlArtifactUrl, window.location.href)
      const frameUrl = new URL(frameWindow.location.href)
      if (frameUrl.origin !== expectedUrl.origin
        || frameUrl.pathname !== expectedUrl.pathname
        || frameUrl.search !== expectedUrl.search
        || frameUrl.hash === hash) return
      frameUrl.hash = hash
      // Removing the fragment navigates to `page#` rather than `page`: an empty
      // fragment stays a same-document navigation (to the top of the page), so
      // the frame is not reloaded and does not scroll to the first match again.
      frameWindow.location.replace(hash ? frameUrl.href : `${frameUrl.href}#`)
      scrollFrameToFragment(frameWindow, hash, iframe.closest<HTMLElement>('.directory-scroll'))
    } catch {
      // Cross-origin redirects remain isolated; same-origin artifacts receive the logical fragment.
    }
  }, [hash, htmlArtifactUrl])

  useEffect(() => {
    syncHtmlFrameLocation()
  }, [syncHtmlFrameLocation])

  // Re-highlight the open HTML artifact when the query changes; loading highlights it too.
  // A newly arrived query scrolls to its first match unless the URL or the
  // frame's own location (an in-artifact link) has a fragment.
  useEffect(() => {
    if (htmlFrameRef.current) highlightFrame(htmlFrameRef.current, highlightQuery, !hashRef.current, reportMatches)
  }, [highlightQuery, reportMatches])

  // Stop observing an artifact frame's document once that frame is replaced or unmounted.
  useEffect(() => {
    const frame = htmlFrameRef.current
    if (!frame) return
    return () => {
      frameHighlightCleanup.get(frame)?.()
      frameHighlightCleanup.delete(frame)
    }
  }, [htmlArtifactUrl])

  const tocEntries = bodyArtifact?.toc ?? []

  // A folder's HTML index page is read inside the directory page, so its frame takes the height of
  // its document instead of filling the stage (the directory page scrolls).
  const [directoryFrameHeight, setDirectoryFrameHeight] = useState<number | null>(null)
  const frameHeightCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => frameHeightCleanup.current?.(), [])
  useEffect(() => { setDirectoryFrameHeight(null) }, [htmlArtifactUrl])
  // The first measured height lets the directory page scroll as far as a fragment needs.
  const settleHostScroll = useRef(false)
  useEffect(() => {
    if (!settleHostScroll.current || !directoryFrameHeight) return
    settleHostScroll.current = false
    const frame = htmlFrameRef.current
    const frameWindow = frame?.contentWindow
    if (!frame || !frameWindow) return
    window.requestAnimationFrame(() => {
      try {
        if (hashRef.current) scrollFrameToFragment(frameWindow, hashRef.current, frame.closest<HTMLElement>('.directory-scroll'))
        else hostMatchScroll.get(frame)?.()
      } catch { /* cross-origin */ }
    })
  }, [directoryFrameHeight])

  // "Read next" (ISSUE-086) ends Markdown pages only: not HTML artifacts, and not a folder's
  // README shown inside a directory page (that page is itself the list of what to read).
  const readNextItems = useMemo(
    () => currentArtifact && currentFormat === 'markdown' ? relatedPages(index.artifacts, currentArtifact.path) : [],
    [currentArtifact, currentFormat, index.artifacts],
  )
  const siteHomeHref = `/${encodeURIComponent(index.site.id)}`
  const bodyArtifactUrl = bodyArtifact?.artifactUrl
  useEffect(() => {
    setFrameFailure(null)
    setFrameAttempt(0)
    focusRetryRef.current = false
  }, [bodyArtifactUrl])
  // A new mount (another artifact or a retry) starts counting loads again and drops any pending status request.
  useEffect(() => {
    frameLoadCount.current = 0
    return () => {
      frameStatusAbort.current?.abort()
      frameStatusAbort.current = null
    }
  }, [bodyArtifactUrl, frameAttempt])
  useEffect(() => {
    if (frameFailure && focusRetryRef.current) {
      focusRetryRef.current = false
      retryFrameRef.current?.focus()
    }
  }, [frameFailure])
  const artifactView = bodyArtifact && currentFormat === 'markdown' ? (
    <MarkdownArtifact
      key={bodyArtifact.artifactUrl}
      artifact={bodyArtifact}
      siteId={index.site.id}
      hash={hash}
      navigate={(href) => navigate(href)}
      highlightQuery={highlightQuery}
      onMatches={reportMatches}
      footer={readNextItems.length > 0 ? <ReadNext items={readNextItems} siteId={index.site.id} navigate={(href) => navigateWithinWorkspace(href)} /> : undefined}
    />
  ) : bodyArtifact && htmlArtifactUrl ? (
    <>
    {frameFailure?.artifactUrl === bodyArtifact.artifactUrl ? (
      <div className="markdown-state" role="alert">
        <h1>Document unavailable</h1>
        <p>The content of “{bodyArtifact.title}” could not be loaded (HTTP {frameFailure.status}). It may have been removed or not published yet.</p>
        <button
          type="button"
          className="text-action"
          ref={retryFrameRef}
          onClick={() => {
            focusRetryRef.current = true
            setFrameFailure(null)
            setFrameAttempt((attempt) => attempt + 1)
          }}
        >
          Try again
        </button>
        {' '}
        <a
          className="text-action"
          href={siteHomeHref}
          onClick={(event) => followInApp(event, () => navigateWithinWorkspace(siteHomeHref))}
        >
          ← {index.site.title}
        </a>
      </div>
    ) : null}
    <iframe
      className="artifact-frame"
      ref={htmlFrameRef}
      key={`${bodyArtifact.artifactUrl}#${frameAttempt}`}
      hidden={frameFailure?.artifactUrl === bodyArtifact.artifactUrl}
      src={htmlArtifactUrl}
      title={bodyArtifact.title}
      lang={frameLanguage?.artifactUrl === bodyArtifact.artifactUrl ? frameLanguage.lang : undefined}
      style={{
        colorScheme: theme,
        ...(currentDirectory && directoryFrameHeight ? { ['--directory-frame-height' as string]: `${directoryFrameHeight}px` } : {}),
      }}
      onLoad={(event) => {
        const frame = event.currentTarget
        const firstLoad = frameLoadCount.current === 0
        frameLoadCount.current += 1
        const artifactUrl = bodyArtifact.artifactUrl
        const status = firstLoad ? readFrameResponseStatus(frame) : null
        if (typeof status === 'number' && status >= 400) {
          frameHeightCleanup.current?.()
          frameHeightCleanup.current = null
          setFrameFailure({ artifactUrl, status })
          return
        }
        // Without a readable status (for example Safari), one HEAD request classifies the first load.
        const needsHead = firstLoad && status === undefined
        if (needsHead) {
          const controller = new AbortController()
          frameStatusAbort.current?.abort()
          frameStatusAbort.current = controller
          fetch(artifactUrl, { method: 'HEAD', cache: 'no-store', signal: controller.signal })
            .then((response) => response.status)
            .catch(() => null)
            .then((headStatus) => {
              if (controller.signal.aborted) return
              if (headStatus !== null && headStatus >= 400) {
                frameHeightCleanup.current?.()
                frameHeightCleanup.current = null
                setFrameFailure({ artifactUrl, status: headStatus })
                return
              }
              if (focusRetryRef.current) {
                focusRetryRef.current = false
                frame.focus()
              }
            })
        } else if (focusRetryRef.current) {
          focusRetryRef.current = false
          frame.focus()
        }
        setFrameLanguage({ artifactUrl: bodyArtifact.artifactUrl, lang: readFrameLanguage(event.currentTarget) })
        event.currentTarget.contentWindow?.addEventListener('keydown', forwardArtifactKeyDown, true)
        syncHtmlFrameLocation(event.currentTarget)
        highlightFrame(event.currentTarget, highlightQueryRef.current, !hash, reportMatches)
        frameHeightCleanup.current?.()
        settleHostScroll.current = Boolean(currentDirectory)
        frameHeightCleanup.current = currentDirectory ? watchFrameHeight(event.currentTarget, setDirectoryFrameHeight) : null
      }}
    />
    </>
  ) : null
  const moreMenuItems: ReaderMoreMenuItem[] = []
  if (bodyArtifact) {
    moreMenuItems.push(
      {
        id: 'contents',
        label: 'Contents',
        icon: 'contents',
        checked: tocOpen,
        disabled: tocEntries.length === 0,
        title: tocEntries.length ? undefined : 'No indexed contents for this artifact',
        onSelect: () => togglePanel('contents'),
      },
      { id: 'details', label: 'Details', icon: 'info', checked: detailsOpen, onSelect: () => togglePanel('details') },
      {
        id: 'pin',
        label: pinnedArtifactIds.includes(bodyArtifact.id) ? 'Unpin' : 'Pin',
        icon: 'pin',
        onSelect: () => toggleArtifactPin(bodyArtifact),
      },
    )
  }
  if (currentArtifact || currentDirectory) {
    moreMenuItems.push({
      id: 'copy-link',
      label: 'Copy link',
      icon: 'copy',
      onSelect: () => void copyCurrentLink(showToast),
    })
  }
  if (bodyArtifact) {
    moreMenuItems.push({
      id: 'raw',
      label: 'Open raw artifact',
      icon: 'external',
      onSelect: () => { window.open(bodyArtifact.artifactUrl, '_blank', 'noopener,noreferrer') },
    })
  }
  if (currentArtifact || (currentDirectory && !isSiteRoot)) {
    moreMenuItems.push({
      id: 'site-home',
      label: `${index.site.title} home`,
      icon: 'home',
      separatorBefore: moreMenuItems.length > 0,
      onSelect: () => navigateWithinWorkspace(siteHomeHref),
    })
  }
  moreMenuItems.push({
    id: 'all-sites',
    label: 'All sites',
    icon: 'library',
    separatorBefore: moreMenuItems.length > 0 && !(currentArtifact || (currentDirectory && !isSiteRoot)),
    onSelect: () => navigateWithinWorkspace('/'),
  })
  moreMenuItems.push(...(['system', 'light', 'dark'] as const).map((mode, position) => ({
    id: `theme-${mode}`,
    label: `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`,
    icon: themeModeIcon(mode),
    radio: true,
    checked: themeMode === mode,
    separatorBefore: position === 0,
    onSelect: () => onSetThemeMode(mode),
  })))

  return (
    <div className={`app-shell${sidebarOpen ? '' : ' sidebar-collapsed'}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          // The URL fragment belongs to the open page, so the link moves focus instead of navigating.
          event.preventDefault()
          focusStage()
        }}
      >Skip to content</a>
      <Sidebar
        index={index}
        id="workspace-sidebar"
        sites={paletteSites.map(({ site }) => site)}
        artifactPath={currentArtifact?.path}
        directoryPath={currentDirectory?.path || undefined}
        expandedPaths={expandedPaths}
        onExpandedPathsChange={updateExpandedPaths}
        revealRequest={sidebarReveal}
        onOpenPalette={openPalette}
        onOpenArtifact={openArtifact}
        onOpenDirectory={openDirectory}
        onOpenRoot={() => {
          navigateWithinWorkspace(siteHomeHref)
          setActivePanel(null)
          setPaletteSeed(null)
        }}
        onToast={showToast}
        themeMode={themeMode}
        onSetThemeMode={onSetThemeMode}
        onCollapse={() => updateSidebarOpen(false, true)}
        pinnedArtifactIds={pinnedArtifactIds}
        onTogglePin={toggleArtifactPin}
        pageTextSearch={textSearchClient ? { onSearchFullText: openSearchResults } : undefined}
        treeStyle={sidebarTreeStyle}
      />
      {sidebarOpen ? <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => updateSidebarOpen(false, true)} /> : null}
      {!sidebarOpen && !narrowChrome ? (
        <aside className="collapsed-rail" aria-label={`${index.site.title} navigation`}>
          <div className="collapsed-rail-group">
            <button
              className="collapsed-rail-button collapsed-rail-button-primary"
              id="sidebar-toggle-trigger"
              title="Expand navigation (⌘ B)"
              aria-label="Expand navigation"
              aria-controls="workspace-sidebar"
              aria-expanded="false"
              onClick={() => updateSidebarOpen(true, true)}
            >
              <Icon name="sidebar" size={17} />
            </button>
            <button
              className="collapsed-rail-button collapsed-rail-site-button"
              title={`Switch site — ${index.site.title} (${countLabel})`}
              aria-label={`Switch site. Current site: ${index.site.title}. ${countLabel}`}
              onClick={(event) => {
                event.currentTarget.focus()
                openPalette('@')
              }}
            >
              <span className="site-mark">{index.site.title.slice(0, 1).toUpperCase()}</span>
            </button>
            <button
              className="collapsed-rail-button"
              title={`Jump to a page in ${index.site.title} (⌘ K)`}
              aria-label={`Jump to a page in ${index.site.title}`}
              aria-keyshortcuts="Meta+K Control+K"
              onClick={(event) => {
                event.currentTarget.focus()
                openPalette('')
              }}
            >
              <Icon name="search" size={17} />
            </button>
          </div>
          <div className="collapsed-rail-spacer" />
          <div className="collapsed-rail-group">
            <ThemeSwitcher
              buttonClassName="collapsed-rail-button"
              iconSize={16}
              mode={themeMode}
              onChange={onSetThemeMode}
              placement="right"
            />
          </div>
        </aside>
      ) : null}

      <div className="workspace">
        <div className="workspace-panel">
          <header className="context-bar">
            {narrowChrome ? (
              <button
                type="button"
                className="icon-button reader-menu-button"
                id={sidebarOpen ? undefined : 'sidebar-toggle-trigger'}
                title={sidebarOpen ? 'Close navigation' : 'Expand navigation'}
                aria-label={sidebarOpen ? 'Close navigation' : 'Expand navigation'}
                aria-controls="workspace-sidebar"
                aria-expanded={sidebarOpen}
                onClick={() => updateSidebarOpen(!sidebarOpen, true)}
              >
                <Icon name="sidebar" size={17} />
              </button>
            ) : null}
            {narrowChrome && !routeArtifactPath ? <span className="reader-bar-title">{index.site.title}</span> : null}
            {routeArtifactPath ? (
              <ArtifactBreadcrumbs
                artifactPath={currentArtifact?.path ?? currentDirectory?.path ?? routeArtifactPath}
                siteTitle={index.site.title}
                artifacts={index.artifacts}
                currentArtifact={currentArtifact}
                onOpenArtifact={openArtifact}
                artifactHref={(artifact) => artifactRouteHref(index.site.id, artifact.path)}
                isDirectoryPage={Boolean(currentDirectory)}
                folderHref={(path) => artifactRouteHref(index.site.id, path)}
                onOpenFolder={openDirectory}
                onRevealInSidebar={revealSidebarLocation}
              />
            ) : null}

            {narrowChrome ? (
              <div className="context-actions reader-bar-actions">
                <button
                  type="button"
                  className="icon-button"
                  title={`Jump to a page in ${index.site.title}`}
                  aria-label={`Jump to a page in ${index.site.title}`}
                  aria-keyshortcuts="Meta+K Control+K"
                  onClick={(event) => {
                    event.currentTarget.focus()
                    openPalette('')
                  }}
                >
                  <Icon name="search" size={17} />
                </button>
                <ReaderMoreMenu ref={moreMenuTriggerRef} items={moreMenuItems} />
              </div>
            ) : (
              <div className="context-actions">
                <button
                  className="context-button context-library-button"
                  type="button"
                  aria-label="Go to all sites"
                  title="All sites"
                  onClick={() => navigateWithinWorkspace('/')}
                >
                  <Icon name="library" size={14} />
                  <span>All sites</span>
                </button>
                {currentArtifact || (currentDirectory && !isSiteRoot) ? (
                  <button
                    className="context-button context-home-button"
                    type="button"
                    aria-label={`Go to ${index.site.title} home`}
                    title={`Go to ${index.site.title} home`}
                    onClick={() => navigateWithinWorkspace(`/${encodeURIComponent(index.site.id)}`)}
                  >
                    <Icon name="home" size={14} />
                    <span>{index.site.title} home</span>
                  </button>
                ) : null}
                {bodyArtifact ? (
                  <button
                    className={`context-button current-artifact-pin-button${pinnedArtifactIds.includes(bodyArtifact.id) ? ' is-active' : ''}`}
                    type="button"
                    aria-label={`${pinnedArtifactIds.includes(bodyArtifact.id) ? 'Unpin' : 'Pin'} ${bodyArtifact.title}`}
                    aria-pressed={pinnedArtifactIds.includes(bodyArtifact.id)}
                    title={pinnedArtifactIds.includes(bodyArtifact.id)
                      ? `Unpin ${bodyArtifact.title}`
                      : `Pin ${bodyArtifact.title} for later`}
                    onClick={() => toggleArtifactPin(bodyArtifact)}
                  >
                    <Icon name="pin" size={14} />
                    <span>{pinnedArtifactIds.includes(bodyArtifact.id) ? 'Pinned' : 'Pin'}</span>
                  </button>
                ) : null}
                {bodyArtifact ? (
                  <>
                    <button
                      ref={contentsToggleRef}
                      className={`context-button${tocOpen ? ' is-active' : ''}`}
                      disabled={tocEntries.length === 0}
                      aria-pressed={tocOpen}
                      title={tocEntries.length ? 'Contents (⌘ ⇧ O)' : 'No indexed contents for this artifact'}
                      onClick={() => togglePanel('contents')}
                    >
                      <Icon name="contents" size={14} />
                      <span>Contents</span>
                    </button>
                    <button
                      ref={detailsToggleRef}
                      className={`context-button${detailsOpen ? ' is-active' : ''}`}
                      aria-pressed={detailsOpen}
                      title="Artifact details"
                      onClick={() => togglePanel('details')}
                    >
                      <Icon name="info" size={14} />
                      <span>Details</span>
                    </button>
                  </>
                ) : null}
                {bodyArtifact || currentDirectory ? <span className="action-divider" /> : null}
                {currentArtifact || currentDirectory ? (
                  <button
                    className="icon-button"
                    title="Copy link"
                    aria-label={isSiteRoot ? 'Copy site link' : currentDirectory ? 'Copy folder link' : 'Copy artifact link'}
                    onClick={() => void copyCurrentLink(showToast)}
                  >
                    <Icon name="copy" size={15} />
                  </button>
                ) : null}
                {bodyArtifact ? (
                  <a
                    className="icon-button"
                    title="Open raw artifact"
                    aria-label="Open raw artifact"
                    href={bodyArtifact.artifactUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon name="external" size={15} />
                  </a>
                ) : null}
              </div>
            )}
          </header>

          <main ref={stageRef} id="main-content" tabIndex={-1} className={`stage${currentArtifact ? ' has-artifact' : ''}`} data-heading-jump={headingJump ?? undefined}>
            {searchRoute ? (
              <SearchResultsPage
                siteTitle={index.site.title}
                pageCount={index.artifacts.length}
                artifacts={index.artifacts}
                available={Boolean(textSearchClient)}
                query={searchRoute.query}
                folder={searchRoute.folder}
                state={textSearch.state}
                onQueryChange={(query) => navigate(searchRouteHref(index.site.id, query, searchRoute.folder), { replace: true })}
                onFolderChange={(folder) => navigate(searchRouteHref(index.site.id, searchRoute.query, folder))}
                onRetry={textSearch.retry}
                onLoadMore={textSearch.loadMore}
                hitHref={(hit) => withSearchQuery(hit.href, searchRoute.query)}
                onOpenHit={(hit, anchor) => navigateWithinWorkspace(`${withSearchQuery(hit.href, searchRoute.query)}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`)}
                onSearchTitles={(query) => openPalette(query)}
                loadExcerpts={textSearchClient ? (query, generation, paths, signal) => textSearchClient.excerpts(query, generation, paths, { signal }) : undefined}
              />
            ) : currentDirectory ? (
              <DirectoryPage
                key={currentDirectory.path}
                listing={currentDirectory}
                siteId={index.site.id}
                body={currentDirectory.indexArtifact ? artifactView : undefined}
                header={isSiteRoot ? (
                  <SiteHomeHeader
                    index={index}
                    pageCount={currentDirectory.pageCount}
                    latestUpdatedAt={currentDirectory.latestUpdatedAt}
                    onOpenPreviews={() => navigateWithinWorkspace(`/${encodeURIComponent(index.site.id)}/_previews`)}
                    onOpenPalette={() => openPalette('')}
                  />
                ) : undefined}
                footer={isSiteRoot ? <RecentlyUpdated index={index} onOpenArtifact={navigateWithinWorkspace} /> : undefined}
                onOpen={navigateWithinWorkspace}
              />
            ) : artifactView ?? (routeArtifactPath ? (
              <div className="stage-message">
                <p className="eyebrow">{index.site.title}</p>
                <h1>Page not found</h1>
                <p role="alert">The page you requested does not exist or is no longer available.</p>
                {nearbyPages.length > 0 ? (
                  <nav className="not-found-suggestions" aria-label="Similar pages">
                    <h2>Similar pages</h2>
                    <ul>
                      {nearbyPages.map((artifact) => {
                        const href = artifactRouteHref(index.site.id, artifact.path)
                        return (
                          <li key={artifact.id}>
                            <a href={href} onClick={(event) => followInApp(event, () => navigateWithinWorkspace(artifactRouteHref(index.site.id, artifact.path)))}>
                              <span>{artifact.title}</span>
                              <code>{artifact.path}</code>
                            </a>
                          </li>
                        )
                      })}
                    </ul>
                  </nav>
                ) : null}
                <button className="text-action" onClick={() => navigateWithinWorkspace(`/${encodeURIComponent(index.site.id)}`)}>
                  <Icon name="arrow" size={14} /> Back to site
                </button>
              </div>
            ) : (
              <SiteHome
                index={index}
                onOpenPreviews={() => navigateWithinWorkspace(`/${encodeURIComponent(index.site.id)}/_previews`)}
                onOpenPalette={() => openPalette('')}
              />
            ))}

            {navigatorVisible ? (
              <MatchNavigator
                query={highlightQuery}
                index={currentMatch}
                total={matchRanges.length}
                onStep={stepNavigator}
                onClose={closeNavigator}
              />
            ) : null}

            {activePanel && bodyArtifact ? (
              <aside
                className="context-panel"
                aria-label={panelLabel}
              >
                <div className="context-panel-header">
                  <span>{panelLabel}</span>
                  <button
                    className="context-panel-close"
                    type="button"
                    title={`Close ${panelLabel}`}
                    aria-label={`Close ${panelLabel}`}
                    onClick={closePanel}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
                {activePanel === 'contents' ? (
                  tocEntries.length === 0 ? (
                    <p className="toc-empty">This artifact does not include indexed headings.</p>
                  ) : (
                    <nav className="toc-list" aria-label="Artifact headings">
                      {tocEntries.map((entry) => (
                        <button
                          className={`toc-link${entry.level >= 3 ? ' toc-level-3' : ''}`}
                          key={`${entry.id}:${entry.text}`}
                          aria-current={activeHeading?.artifactId === bodyArtifact.id && activeHeading.id === entry.id ? 'location' : undefined}
                          onClick={() => jumpToHeading(entry.id, { keepPanelIfClear: true })}
                        >
                          {entry.text}
                        </button>
                      ))}
                    </nav>
                  )
                ) : (
                  <ArtifactDetails artifact={bodyArtifact} />
                )}
              </aside>
            ) : null}
          </main>
        </div>
      </div>

      {paletteSeed !== null ? (
        <CommandPalette
          seed={paletteSeed}
          context={routeArtifactPath ? 'artifact' : 'site'}
          sites={paletteSites}
          currentIndex={index}
          currentArtifact={currentArtifact}
          recentReads={effectiveRecentReads}
          pinnedArtifactIds={pinnedArtifactIds}
          commands={commands}
          loading={sitesLoading}
          onClose={closePalette}
          onNavigate={navigateWithinWorkspace}
          onJumpToHeading={jumpToHeading}
          onSearchPageText={textSearchClient ? (query) => openSearchResults(query) : undefined}
        />
      ) : null}

      {toast ? <div className="toast" role="status" aria-live="polite">{toast}</div> : null}
    </div>
  )
}

// A same-document fragment navigation scrolls the frame itself, but Chromium
// can skip that scroll when the navigation lands while the frame is being
// resized or restored by a history traversal, leaving the reader at the old
// position. Apply the target position explicitly so the result never depends on it.
function scrollFrameToFragment(frameWindow: Window, hash: string, host: HTMLElement | null = null) {
  const document = frameWindow.document
  if (!hash) {
    if (!host) frameWindow.scrollTo(0, 0)
    return
  }
  let id = hash.slice(1)
  try { id = decodeURIComponent(id) } catch { /* keep the raw fragment */ }
  const target = document.getElementById(id) ?? document.getElementsByName(id)[0]
  if (!target) return
  const offsetInFrame = target.getBoundingClientRect().top + frameWindow.scrollY
  if (host) {
    // A frame inside a directory page is as tall as its document, so the directory page scrolls.
    const frame = frameWindow.frameElement
    if (!frame) return
    const frameTop = frame.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop
    host.scrollTo({ top: Math.max(0, frameTop + offsetInFrame), behavior: 'instant' })
    return
  }
  // scrollTo keeps the scroll inside the frame; scrollIntoView would also move the app page.
  frameWindow.scrollTo(0, offsetInFrame)
}

/** The HTTP status of the frame's document; undefined when the browser does not expose it (or reading throws). */
function readFrameResponseStatus(iframe: HTMLIFrameElement): number | undefined {
  try {
    const entry = iframe.contentWindow?.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const status = entry?.responseStatus
    return typeof status === 'number' && status > 0 ? status : undefined
  } catch {
    return undefined
  }
}

/** The language an HTML artifact declares on its own `<html>`; undefined when it declares none or the frame is cross-origin. */
function readFrameLanguage(iframe: HTMLIFrameElement) {
  try {
    return normalizeLanguageTag(iframe.contentDocument?.documentElement.getAttribute('lang'))
  } catch {
    return undefined
  }
}

function highlightFrame(iframe: HTMLIFrameElement, query: string, scrollToFirst: boolean, onMatches: (ranges: Range[]) => void) {
  frameHighlightCleanup.get(iframe)?.()
  frameHighlightCleanup.delete(iframe)
  try {
    const document = iframe.contentDocument
    if (!document?.body) return
    if (!query) {
      clearSearchHighlight(document)
      onMatches([])
      return
    }
    ensureSearchHighlightStyle(document)
    // A fragment in the frame's own location (an in-artifact link such as
    // page.html#section, which leaves the app URL unchanged) wins as well.
    const scroll = scrollToFirst && !iframe.contentWindow?.location.hash
    // A match found after the reader started scrolling the page does not move it.
    const host = iframe.closest<HTMLElement>('.directory-scroll')
    const frameReader = document.defaultView ? watchReaderScroll(document.defaultView) : undefined
    const hostReader = host ? watchReaderScroll(host) : undefined
    const reader = frameReader ? {
      get scrolled() { return frameReader.scrolled || Boolean(hostReader?.scrolled) },
      dispose() { frameReader.dispose(); hostReader?.dispose() },
    } : undefined
    const stop = keepSearchHighlighted(document.body, query, (first) => {
      const element = first.startContainer.parentElement
      if (!scroll || reader?.scrolled || !element) return
      if (!host) {
        element.scrollIntoView({ block: 'center' })
        return
      }
      // In a directory page the frame is as tall as its document, so the page around it scrolls.
      const scrollHost = () => {
        if (reader?.scrolled) return
        const rect = element.getBoundingClientRect()
        const frameTop = iframe.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop
        const top = frameTop + rect.top + (iframe.contentWindow?.scrollY ?? 0) - host.clientHeight / 2 + rect.height / 2
        host.scrollTo({ top: Math.max(0, top), behavior: 'instant' })
      }
      hostMatchScroll.set(iframe, scrollHost)
      scrollHost()
    }, onMatches)
    frameHighlightCleanup.set(iframe, () => {
      stop()
      onMatches([])
      reader?.dispose()
    })
  } catch {
    // Cross-origin artifacts cannot be highlighted.
  }
}

const frameHighlightCleanup = new WeakMap<HTMLIFrameElement, () => void>()
/** Scrolls a directory page to the first search match in its HTML index frame; re-run once the frame has its full height. */
const hostMatchScroll = new WeakMap<HTMLIFrameElement, () => void>()

function headingTop(id: string) {
  try {
    const target = document.getElementById(id)
    return target ? Math.round(target.getBoundingClientRect().top) : null
  } catch {
    return null
  }
}

// Measures the heading's text (not its full-width block box).
function headingIsClearOfPanel(id: string) {
  const panel = document.querySelector('.context-panel')?.getBoundingClientRect()
  const target = document.getElementById(id)
  if (!panel || !target) return false
  const range = target.ownerDocument.createRange()
  range.selectNodeContents(target)
  const heading = range.getBoundingClientRect()
  if (heading.width === 0 && heading.height === 0) return false
  return heading.right <= panel.left || heading.left >= panel.right
    || heading.bottom <= panel.top || heading.top >= panel.bottom
}

/** Observes an HTML page's document height so a frame inside a scrolling page can show all of it. */
function watchFrameHeight(iframe: HTMLIFrameElement, onHeight: (height: number) => void) {
  try {
    const frameDocument = iframe.contentDocument
    const root = frameDocument?.documentElement
    const view = frameDocument?.defaultView
    if (!root || !view) return null
    const update = () => onHeight(Math.ceil(root.scrollHeight))
    update()
    const observer = new view.ResizeObserver(update)
    observer.observe(root)
    if (frameDocument.body) observer.observe(frameDocument.body)
    return () => observer.disconnect()
  } catch {
    // Cross-origin artifacts keep the default height.
    return null
  }
}

/** A page's link from the results: `?q=` makes the page highlight the search. */
function withSearchQuery(href: string, query: string) {
  return `${href}?${new URLSearchParams({ q: query })}`
}

const NO_RANGES: Range[] = []

function findArtifact(index: SiteIndex, path: string) {
  return index.artifacts.find((artifact) => artifact.path === path || artifact.id === path)
}

const PINNED_STORAGE_KEY = 'git-artifact-pages:pinned-artifacts:v1'

function readPinnedArtifacts(): Record<string, string[]> {
  try {
    const value = window.localStorage.getItem(PINNED_STORAGE_KEY)
    if (!value) return {}
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).flatMap(([siteId, ids]) => {
      if (!Array.isArray(ids)) return []
      return [[siteId, ids.filter((id): id is string => typeof id === 'string')]]
    }))
  } catch {
    return {}
  }
}

function ArtifactDetails({ artifact }: { artifact: ArtifactIndexEntry }) {
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

function folderAncestors(path?: string) {
  if (!path) return []
  const segments = path.split('/').filter(Boolean).slice(0, -1)
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

function folderPaths(path: string) {
  const segments = path.split('/').filter(Boolean)
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

// The link to the document itself: the reader's committed search (`?q=`) is
// personal context, not part of what is shared. The fragment is kept.
function documentLink(location: Pick<Location, 'href'>) {
  const url = new URL(location.href)
  url.searchParams.delete('q')
  return url.href
}

async function copyCurrentLink(showToast: (message: string) => void) {
  try {
    await navigator.clipboard.writeText(documentLink(window.location))
    showToast('Link copied to clipboard.')
  } catch {
    showToast('Clipboard access is unavailable.')
  }
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)
}

function formatLongDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}

/**
 * Test-only seam: end-to-end tests set `window.__artifactPagesTest = { rankingMaxHits }`
 * (with `page.addInitScript`) to reach the path-ordered fallback without publishing
 * more pages than the real threshold. Nothing reads or writes it in normal use.
 */
function testRankingMaxHits(): number | undefined {
  const value = (window as unknown as { __artifactPagesTest?: { rankingMaxHits?: unknown } }).__artifactPagesTest?.rankingMaxHits
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}
