import { formatPreviewTime } from '../domain/preview-time'
import { displayLocale } from '../domain/display-locale'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArtifactBreadcrumbs } from './ArtifactBreadcrumbs'
import { CommandPalette, type PaletteCommand } from './CommandPalette'
import { SiteMenu } from './SiteMenu'
import { ContentsDialog } from './ContentsDialog'
import { DirectoryPage } from './DirectoryPage'
import { Icon } from './Icon'
import { ArtifactDetails, ContentsList, focusReaderColumnPart, READER_COLUMN_QUERY, ReaderContextColumn, type ReaderColumnPart } from './ReaderContextColumn'
import { useCurrentHeading } from './useCurrentHeading'
import { useFrameReveal } from './useFrameReveal'
import { Sidebar } from './Sidebar'
import { RecentlyUpdated, SiteHome, SiteHomeFrame, SiteHomeHeader, usePreviewCount, type SiteSection } from './SiteHome'
import { PREVIEW_LEDE, PreviewListContent } from './PreviewListPage'
import {
  PreviewBreadcrumbs,
  PreviewDetails,
  PreviewDocumentView,
  PreviewNotices,
  PreviewSidebarSection,
  PreviewTag,
  usePreviewReader,
} from './PreviewReader'
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
import { describeDiscoveryError, searchAvailability, type DiscoveryStatus } from '../domain/search-availability'
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
import { artifactRouteHref, searchRouteHref, sitePreviewsHref, type AppRoute } from '../routing'

type SiteRoute = Extract<AppRoute, { kind: 'site' }>
type SearchRoute = Extract<AppRoute, { kind: 'search' }>
type PreviewListRoute = Extract<AppRoute, { kind: 'preview-list' }>
type PreviewDocumentRoute = Extract<AppRoute, { kind: 'preview-document' }>
type WorkspacePanel = 'contents' | 'details' | null

export function ArtifactWorkspace({
  route,
  pathname,
  search = '',
  hash,
  sites,
  sitesLoading,
  siteDiscoveryStatus,
  siteDiscoveryError,
  onRetryDiscovery,
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
  route: SiteRoute | SearchRoute | PreviewListRoute | PreviewDocumentRoute
  pathname: string
  /** The location's query string; on a page `q` is the search whose matches the page highlights. */
  search?: string
  hash: string
  sites: SiteCatalogEntry[]
  sitesLoading: boolean
  /** Status of the catalog load that carries each site's discovery metadata (and its `fullTextUrl`); default: derived from `sitesLoading`. */
  siteDiscoveryStatus?: DiscoveryStatus
  /** Why discovery failed; classifies the guidance on the results page. */
  siteDiscoveryError?: Error
  onRetryDiscovery?: () => void
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
  const discoveryStatus: DiscoveryStatus = siteDiscoveryStatus ?? (sitesLoading ? 'loading' : 'success')
  const searchState = searchAvailability(discoveryStatus, sites.find(({ site }) => site.id === index.site.id), Boolean(textSearchClient))
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
  const wideReader = useMediaQuery(READER_COLUMN_QUERY)
  const [frameLoads, setFrameLoads] = useState(0)
  const [headingJump, setHeadingJump] = useState<'pending' | 'settled' | null>(null)
  const [headingFocus, setHeadingFocus] = useState<{ artifactUrl: string, id: string } | null>(null)
  const currentArtifact = routeArtifactPath
    ? findArtifact(index, routeArtifactPath)
    : undefined
  // A path that is not a page may be a folder: every folder is a page (ISSUE-075).
  // The site root is the root folder's directory page, with an empty path.
  const rootListing = useMemo(() => resolveRootDirectory(index.artifacts), [index.artifacts])
  const currentDirectory = useMemo(
    () => route.kind !== 'site'
      ? undefined
      : routeArtifactPath
        ? (!currentArtifact ? resolveDirectory(index.artifacts, routeArtifactPath) : undefined)
        : rootListing,
    [route.kind, routeArtifactPath, currentArtifact, index.artifacts, rootListing],
  )
  const isSiteRoot = Boolean(currentDirectory) && !routeArtifactPath
  const folderIntroduction = !isSiteRoot ? currentDirectory?.indexArtifact : undefined
  const publishedReadingArtifact = currentArtifact ?? folderIntroduction
  const previewsRoute = route.kind === 'preview-list' ? route : undefined
  // A preview document opens in this shell (ISSUE-109): the published tree gives way to the preview's own pages.
  const preview = usePreviewReader(route.kind === 'preview-document' ? route : undefined)
  const previewArtifact = preview?.artifact
  // The site home (ISSUE-107): Overview when the site has an introduction (and Files was not asked for),
  // Files otherwise, and Previews at its own route. An introduction that is gone leaves Files in place.
  const hasIntroduction = Boolean(rootListing?.indexArtifact)
  const siteSection: SiteSection = previewsRoute
    ? 'previews'
    : route.kind === 'site' && route.section === 'files'
      ? 'files'
      : hasIntroduction ? 'overview' : 'files'
  const onSiteHome = Boolean(previewsRoute) || (route.kind === 'site' && !routeArtifactPath)
  const previewCount = usePreviewCount(index.site.id, onSiteHome)
  // The page whose content fills the stage: the open page, or a folder's README or index page. On the
  // site root only the Overview shows the introduction.
  const bodyArtifact = currentArtifact ?? previewArtifact ?? (isSiteRoot && siteSection !== 'overview' ? undefined : currentDirectory?.indexArtifact)
  const effectiveRecentReads = recentReads ?? storedRecentReads
  const pageNotFound = Boolean(routeArtifactPath) && !currentArtifact && !currentDirectory
  usePageNoindex(pageNotFound)
  // The language the open HTML artifact declares on its own <html>, keyed by the artifact it was read from.
  const [frameLanguage, setFrameLanguage] = useState<{ artifactUrl: string, lang: string | undefined } | null>(null)
  // A known HTML body whose response failed (ISSUE-106), keyed by the artifact it was read from.
  const [frameFailure, setFrameFailure] = useState<{ artifactUrl: string, status: number | null } | null>(null)
  const [frameAttempt, setFrameAttempt] = useState(0)
  const retryFrameRef = useRef<HTMLButtonElement | null>(null)
  const focusRetryRef = useRef(false)
  // Loads seen by the current iframe mount: only the first one is the artifact's own load (ISSUE-106).
  const frameLoadCount = useRef(0)
  // Advances when a navigation of the frame starts (or the frame is replaced), before its load finishes.
  const frameGeneration = useRef(0)
  const frameStatusAbort = useRef<AbortController | null>(null)
  const nearbyPages = useMemo(
    () => pageNotFound && routeArtifactPath ? nearbyArtifacts(index.artifacts, routeArtifactPath) : [],
    [pageNotFound, routeArtifactPath, index.artifacts],
  )
  usePageTitle(searchRoute
    ? pageTitle(searchRoute.query ? `Search “${searchRoute.query}”` : 'Search', index.site.title)
    : preview
      ? pageTitle(previewArtifact?.title ?? 'Preview', 'Previews', index.site.title)
    : previewsRoute
      ? pageTitle('Previews', index.site.title)
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
  // The persistent Contents and Details column (ISSUE-108): a document page at a wide viewport only.
  // Not on an error screen: a Markdown document or an HTML body that failed to load.
  const [markdownFailedUrl, setMarkdownFailedUrl] = useState<string | null>(null)
  const readingArtifact = publishedReadingArtifact ?? previewArtifact
  const loadFailed = Boolean(readingArtifact) && (
    markdownFailedUrl === readingArtifact?.artifactUrl || frameFailure?.artifactUrl === readingArtifact?.artifactUrl
  )
  const columnShown = wideReader && Boolean(readingArtifact) && (route.kind === 'site' || route.kind === 'preview-document') && !loadFailed
  const { current: currentHeading, pin: pinHeading } = useCurrentHeading({
    enabled: columnShown,
    format: currentFormat,
    entries: bodyArtifact?.toc ?? NO_ENTRIES,
    stageRef,
    frameRef: htmlFrameRef,
    frameLoads,
  })
  const hasContents = Boolean(bodyArtifact?.toc?.length)
  const tocOpen = activePanel === 'contents'
  const detailsOpen = activePanel === 'details'
  useEffect(() => {
    if (!detailsOpen) return
    const frame = window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('#reader-details-panel .context-panel-close')?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [detailsOpen])
  const panelLabel = activePanel === 'details' ? 'Details' : 'Contents'

  // A selection belongs to this document only. Cancelling/reopening a panel invalidates it.
  useEffect(() => {
    setHeadingFocus(null)
    setHeadingJump(null)
  }, [bodyArtifact?.artifactUrl])

  const panelOrigin = useRef<HTMLElement | null>(null)
  const togglePanel = useCallback((panel: Exclude<WorkspacePanel, null>, origin?: HTMLElement | null) => {
    panelOrigin.current = origin ?? (panel === 'contents' ? contentsToggleRef.current : detailsToggleRef.current) ?? moreMenuTriggerRef.current
    setHeadingFocus(null)
    if (activePanelRef.current === panel) {
      const origin = panelOrigin.current
      window.requestAnimationFrame(() => origin?.isConnected && origin.focus({ preventScroll: true }))
    }
    setActivePanel((current) => current === panel ? null : panel)
  }, [])

  useEffect(() => {
    if (!headingFocus || activePanel || columnShown || paletteSeed !== null || headingFocus.artifactUrl !== bodyArtifact?.artifactUrl) return
    let frame = 0
    let timer = 0
    let attempts = 0
    const focus = () => {
      let target: HTMLElement | null = null
      try {
        const source = currentFormat === 'html' ? htmlFrameRef.current?.contentDocument : document
        const anchor = source?.getElementById(headingFocus.id)
        // HTML TOCs may anchor a section around the heading rather than the heading itself.
        target = anchor?.closest<HTMLElement>('h1, h2, h3, h4, h5, h6')
          ?? anchor?.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6')
          ?? anchor ?? null
      } catch { /* cross-origin frames keep their existing isolation */ }
      if (target) {
        const hadTabIndex = target.hasAttribute('tabindex')
        if (!hadTabIndex) target.setAttribute('tabindex', '-1')
        target.focus({ preventScroll: true })
        if (!hadTabIndex) target.addEventListener('blur', () => target?.removeAttribute('tabindex'), { once: true })
        setHeadingJump('settled')
        setHeadingFocus(null)
      } else if (++attempts < 20) {
        timer = window.setTimeout(focus, 50)
      } else {
        focusStageAfterPalette.current = false
        ;(htmlFrameRef.current ?? stageRef.current)?.focus({ preventScroll: true })
        setHeadingJump('settled')
        setHeadingFocus(null)
      }
    }
    // Let the native modal close/restore focus and the fragment scroll finish first.
    frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(focus) })
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer) }
  }, [headingFocus, activePanel, columnShown, paletteSeed, bodyArtifact?.artifactUrl, currentFormat, frameLoads])

  // At a wide viewport Contents and Details are parts of the column: the commands move focus there.
  const activePanelRef = useRef(activePanel)
  activePanelRef.current = activePanel
  const columnShownRef = useRef(columnShown)
  columnShownRef.current = columnShown
  const openPart = useCallback((part: ReaderColumnPart) => {
    if (part === 'details') {
      setPaletteSeed(null)
      togglePanel('details')
      return
    }
    if (!columnShownRef.current) {
      togglePanel(part)
      return
    }
    setPaletteSeed(null)
    setActivePanel(null)
    // The palette still holds focus while it closes; move focus once it has gone.
    focusReaderColumnPart(part)
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => focusReaderColumnPart(part)))
  }, [togglePanel])

  // Where focus last was among the controls that appear or disappear as the viewport crosses the
  // breakpoint, so it can follow the reader across it instead of falling back to the page.
  const lastFocus = useRef<{ area: 'column' | 'panel' | 'bar' | 'more'; part: ReaderColumnPart; element: Element; wide: boolean } | null>(null)
  useEffect(() => {
    const classify = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      const column = target.closest('[data-reader-column]')
      if (column) return { area: 'column' as const, part: column.querySelector('.reader-column-details')?.contains(target) ? 'details' as const : 'contents' as const, element: target }
      const panel = target.closest('.context-panel')
      if (panel) return { area: 'panel' as const, part: panel.getAttribute('aria-label') === 'Details' ? 'details' as const : 'contents' as const, element: target }
      if (target === moreMenuTriggerRef.current || target.closest('[role="menu"]')) return { area: 'more' as const, part: 'contents' as const, element: target }
      if (target === contentsToggleRef.current) return { area: 'bar' as const, part: 'contents' as const, element: target }
      if (target === detailsToggleRef.current) return { area: 'bar' as const, part: 'details' as const, element: target }
      return null
    }
    const onFocusIn = (event: FocusEvent) => {
      const found = classify(event.target)
      lastFocus.current = found ? { ...found, wide: columnShownRef.current } : null
    }
    const onFocusOut = () => {
      // Focus displaced by the breakpoint change keeps its record; focus that left some other way
      // (a click on a blank area closing the More menu, say) does not, even if its element is gone.
      window.requestAnimationFrame(() => {
        const last = lastFocus.current
        if (!last || document.activeElement === last.element) return
        if (last.wide === columnShownRef.current || last.element.isConnected) lastFocus.current = null
      })
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  const previousColumnShown = useRef(columnShown)
  useEffect(() => {
    const before = previousColumnShown.current
    previousColumnShown.current = columnShown
    if (before === columnShown) return
    const last = lastFocus.current
    if (columnShown) {
      setHeadingFocus(null)
      setActivePanel((panel) => panel === 'contents' ? null : panel)
      if (last && activePanelRef.current === 'details' && last.area !== 'panel') {
        lastFocus.current = null
        window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('#reader-details-panel .context-panel-close')?.focus({ preventScroll: true }))
        return
      }
      if (last && last.area !== 'column' && !(last.area === 'panel' && last.part === 'details')) {
        lastFocus.current = null
        // The More trigger stands for the panel that was open (Contents when none was).
        const part = last.area === 'more' && activePanelRef.current === 'details' ? 'details' : last.part
        window.requestAnimationFrame(() => focusReaderColumnPart(part))
      }
    } else if (last?.area === 'column') {
      lastFocus.current = null
      window.requestAnimationFrame(() => {
        const toggle = last.part === 'contents' && !contentsToggleRef.current?.disabled
          ? contentsToggleRef.current
          : detailsToggleRef.current
        ;(toggle ?? moreMenuTriggerRef.current)?.focus()
      })
    }
  }, [columnShown])

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

  // A heading link keeps the page's own location; for a preview document that includes the revision's group.
  const hereHref = route.kind === 'preview-document' ? `${pathname}${search}` : pathname

  function navigateWithinWorkspace(href: string) {
    focusStageAfterPalette.current = true
    navigate(href)
    if (window.innerWidth <= 860) updateSidebarOpen(false)
  }

  // An unknown `section` value on the site root shows the default section; the address is corrected in place.
  const sectionParam = route.kind === 'site' && !routeArtifactPath ? new URLSearchParams(search).get('section') : null
  useEffect(() => {
    if (sectionParam === null || sectionParam === 'files') return
    const params = new URLSearchParams(search)
    params.delete('section')
    const rest = params.toString()
    navigate(`${pathname}${rest ? `?${rest}` : ''}${hash}`, { replace: true })
  }, [sectionParam, search, pathname, hash, navigate])

  // Switching sections replaces the section's own content (and its links), so focus follows to the chosen link.
  function openSection(href: string) {
    navigateWithinWorkspace(href)
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.site-sections [aria-current="page"]')?.focus()
    }))
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
    // Dismiss the native modal before opening the portal palette. Details keeps its existing
    // toggle state so its palette command can still close an already open Details panel.
    setActivePanel((current) => current === 'contents' ? null : current)
    setHeadingFocus(null)
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

  const previewDocumentKey = route.kind === 'preview-document' ? `${route.headSha}/${route.artifactPath}` : undefined
  useEffect(() => {
    setActivePanel(null)
    if (window.innerWidth <= 860) updateSidebarOpen(false)
  }, [routeArtifactPath, previewDocumentKey, route.kind, updateSidebarOpen])

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
    if (recentReads !== undefined || !bodyArtifact || preview || lastRecordedArtifactId.current === bodyArtifact.id) return
    lastRecordedArtifactId.current = bodyArtifact.id
    setStoredRecentReads(recordRecentArtifactRead(index.site.id, bodyArtifact.id, storedRecentReads))
  }, [bodyArtifact?.id, index.site.id, recentReads, storedRecentReads, preview])

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
        openPart('contents')
      } else if (event.key === 'Escape') {
        closePalette()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [paletteSeed, closePalette, toggleSidebar, openPart, goToSearchPage])

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
      } else if (modifier && event.shiftKey && key === 'o' && (hasContents || columnShown)) {
        event.preventDefault()
        openPart('contents')
      } else if (event.key === 'Escape' && !event.defaultPrevented && activePanel !== null) {
        closePanel()
      } else if (event.key === 'Escape' && !event.defaultPrevented && navigatorVisibleRef.current) {
        closeNavigatorRef.current()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [paletteSeed, hasContents, columnShown, activePanel, openPalette, toggleSidebar, openPart, goToSearchPage])

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
      available: hasContents || columnShown,
      onSelect: () => openPart('contents'),
    },
    {
      title: 'Toggle details',
      available: Boolean(bodyArtifact),
      onSelect: () => openPart('details'),
    },
    {
      title: bodyArtifact && pinnedArtifactIds.includes(bodyArtifact.id) ? 'Unpin artifact' : 'Pin artifact',
      available: Boolean(bodyArtifact) && !preview,
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
    { title: 'Open previews', onSelect: () => navigateWithinWorkspace(sitePreviewsHref(index.site.id)) },
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
      available: Boolean(currentArtifact || currentDirectory || previewArtifact),
      onSelect: () => void copyCurrentLink(showToast),
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
    navigateWithinWorkspace(path ? artifactRouteHref(index.site.id, path) : `/${encodeURIComponent(index.site.id)}`)
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
    setHeadingFocus(null)
    setHeadingJump(null)
  }

  // A temporary Contents panel always yields to the selected heading. The persistent column
  // uses jumpFromColumn instead, retaining its list and the focused entry.
  function jumpToHeading(id: string) {
    setHeadingJump('pending')
    if (bodyArtifact) setHeadingFocus({ artifactUrl: bodyArtifact.artifactUrl, id })
    navigateWithinWorkspace(`${hereHref}#${encodeURIComponent(id)}`)
    setPaletteSeed(null)
    setActivePanel(null)
  }

  // Activating a Contents entry in the column goes to the heading as the overlay does; the column stays open
  // and focus stays on the entry.
  function jumpFromColumn(id: string) {
    cancelHeadingJump()
    pinHeading(id)
    navigateWithinWorkspace(`${hereHref}#${encodeURIComponent(id)}`)
  }

  function closePanel() {
    const preferred = panelOrigin.current
    const toggle = preferred?.isConnected && preferred.getClientRects().length ? preferred : activePanel === 'details' ? detailsToggleRef.current : contentsToggleRef.current
    setHeadingFocus(null)
    setActivePanel(null)
    window.requestAnimationFrame(() => (toggle ?? moreMenuTriggerRef.current)?.focus({ preventScroll: true }))
  }

  const htmlArtifactUrl = bodyArtifact && currentFormat === 'html'
    ? bodyArtifact.artifactUrl
    : undefined
  // The frame stays unpainted until its document loads, so the reader surface shows instead of a light flash (ISSUE-119).
  const { revealed: frameRevealed, reveal: revealFrame } = useFrameReveal(htmlArtifactUrl ? `${htmlArtifactUrl}#${frameAttempt}` : undefined)
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

  // "Read next" (ISSUE-086) ends Markdown pages only: not HTML artifacts, and not a folder's
  // introduction shown at a folder URL.
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
    frameGeneration.current += 1
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
  const previewColumn = columnShown && previewArtifact ? (
    <ReaderContextColumn
      standalone={previewArtifact.format === 'html'}
      artifact={previewArtifact}
      entries={NO_ENTRIES}
      activeId={currentHeading}
      summary={preview?.manifest.status === 'ready' ? <PreviewBuildTime value={preview.manifest.manifest.createdAt} /> : <span>Preview</span>}
      detailsOpen={detailsOpen} detailsButtonRef={detailsToggleRef} onDetails={(trigger) => togglePanel('details', trigger)}
      onJump={jumpFromColumn}
    />
  ) : undefined
  const artifactView = preview ? (
    <PreviewDocumentView
      reader={preview}
      hash={hash}
      navigate={(href) => navigate(href)}
      productionArtifacts={index.artifacts}
      siteTitle={index.site.title}
      aside={previewArtifact?.format === 'markdown' ? previewColumn : undefined}
      onFailedChange={(failed) => setMarkdownFailedUrl(failed ? previewArtifact?.artifactUrl ?? null : null)}
    />
  ) : bodyArtifact && currentFormat === 'markdown' ? (
    <MarkdownArtifact
      key={bodyArtifact.artifactUrl}
      artifact={bodyArtifact}
      siteId={index.site.id}
      hash={hash}
      navigate={(href) => navigate(href)}
      highlightQuery={highlightQuery}
      onMatches={reportMatches}
      onFailedChange={(failed) => setMarkdownFailedUrl(failed ? bodyArtifact.artifactUrl : null)}
      aside={columnShown && publishedReadingArtifact ? (
        <ReaderContextColumn detailsOpen={detailsOpen} detailsButtonRef={detailsToggleRef} onDetails={(trigger) => togglePanel('details', trigger)} artifact={publishedReadingArtifact} entries={publishedReadingArtifact.toc ?? NO_ENTRIES} activeId={currentHeading} onJump={jumpFromColumn} />
      ) : undefined}
      footer={readNextItems.length > 0 ? <ReadNext items={readNextItems} siteId={index.site.id} navigate={(href) => navigateWithinWorkspace(href)} /> : undefined}
    />
  ) : bodyArtifact && htmlArtifactUrl ? (
    <>
    {frameFailure?.artifactUrl === bodyArtifact.artifactUrl ? (
      <div className="markdown-state" role="alert">
        <h1>Document unavailable</h1>
        <p>The content of “{bodyArtifact.title}” could not be loaded{frameFailure.status === null ? '' : ` (HTTP ${frameFailure.status})`}. It may have been removed or not published yet.</p>
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
        ...(frameRevealed ? {} : { opacity: 0 }),
      }}
      onLoad={(event) => {
        revealFrame()
        const frame = event.currentTarget
        const firstLoad = frameLoadCount.current === 0
        frameLoadCount.current += 1
        const loadNumber = frameLoadCount.current
        const generation = frameGeneration.current
        try {
          const bump = () => { frameGeneration.current += 1 }
          event.currentTarget.contentWindow?.addEventListener('beforeunload', bump)
          event.currentTarget.contentWindow?.addEventListener('pagehide', bump)
        } catch { /* a cross-origin frame is covered by the URL check */ }
        const artifactUrl = bodyArtifact.artifactUrl
        const status = firstLoad ? readFrameResponseStatus(frame) : null
        if (typeof status === 'number' && status >= 400) {
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
              // The result belongs to the load it was started for: ignore it once the frame has loaded
              // again, been replaced, or left the probed artifact.
              if (generation !== frameGeneration.current || loadNumber !== frameLoadCount.current || frame !== htmlFrameRef.current || !frameShowsArtifact(frame, artifactUrl)) return
              // A probe that fails at the network level leaves the body unverified: treat it as failed.
              if (headStatus === null || headStatus >= 400) {
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
        setFrameLoads((count) => count + 1)
        event.currentTarget.contentWindow?.addEventListener('keydown', forwardArtifactKeyDown, true)
        syncHtmlFrameLocation(event.currentTarget)
        highlightFrame(event.currentTarget, highlightQueryRef.current, !hash, reportMatches)
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
        onSelect: () => togglePanel('contents', moreMenuTriggerRef.current),
      },
      { id: 'details', label: 'Details', icon: 'info', checked: detailsOpen, onSelect: () => togglePanel('details', moreMenuTriggerRef.current) },
      ...(preview ? [] : [{
        id: 'pin',
        label: pinnedArtifactIds.includes(bodyArtifact.id) ? 'Unpin' : 'Pin',
        icon: 'pin' as const,
        onSelect: () => toggleArtifactPin(bodyArtifact),
      }]),
    )
  }
  if (currentArtifact || currentDirectory || previewArtifact) {
    moreMenuItems.push({
      id: 'copy-link',
      label: 'Copy link',
      icon: 'copy',
      onSelect: () => void copyCurrentLink(showToast),
    })
  }
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
        visible={sidebarOpen}
        navigationKey={`${pathname}${search}${hash}`}
        id="workspace-sidebar"
        sites={paletteSites.map(({ site }) => site)}
        artifactPath={currentArtifact?.path}
        directoryPath={currentDirectory?.path || undefined}
        expandedPaths={expandedPaths}
        onExpandedPathsChange={updateExpandedPaths}
        revealRequest={sidebarReveal}
        onOpenPalette={openPalette}
        onAllSites={() => navigateWithinWorkspace('/')}
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
        previewSection={preview ? (
          <PreviewSidebarSection
            reader={preview}
            siteTitle={index.site.title}
            onOpenDocument={navigateWithinWorkspace}
            onOpenPublished={() => navigateWithinWorkspace(siteHomeHref)}
          />
        ) : undefined}
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
            <SiteMenu dismissKey={`${pathname}${search}${hash}`} homeHref={siteHomeHref} collapsed title={index.site.title} count={paletteSites.length}
              onHome={() => navigateWithinWorkspace(siteHomeHref)} onSwitch={() => openPalette('@')} onAllSites={() => navigateWithinWorkspace('/')} />
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
            {!routeArtifactPath && !preview ? <span className="reader-bar-title">{index.site.title}</span> : null}
            {preview ? (
              <>
                <PreviewTag reader={preview} />
                <PreviewBreadcrumbs reader={preview} siteTitle={index.site.title} navigate={navigateWithinWorkspace} />
              </>
            ) : null}
            {routeArtifactPath ? (
              <ArtifactBreadcrumbs
                compact={narrowChrome}
                artifactPath={currentArtifact?.path ?? currentDirectory?.path ?? routeArtifactPath}
                siteTitle={index.site.title}
                artifacts={index.artifacts}
                currentArtifact={currentArtifact}
                onOpenArtifact={openArtifact}
                artifactHref={(artifact) => artifactRouteHref(index.site.id, artifact.path)}
                isDirectoryPage={Boolean(currentDirectory)}
                folderHref={(path) => path ? artifactRouteHref(index.site.id, path) : siteHomeHref}
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
                  aria-label={`Search pages in ${index.site.title}`}
                  aria-keyshortcuts="Meta+K Control+K"
                  onClick={(event) => {
                    event.currentTarget.focus()
                    openPalette('')
                  }}
                >
                  <Icon name="search" size={17} />
                </button>
                {bodyArtifact ? <button ref={contentsToggleRef} type="button" className={`icon-button${tocOpen ? ' is-active' : ''}`} aria-label="Contents" title={tocEntries.length ? 'Contents (⌘ ⇧ O)' : 'No indexed contents for this artifact'} aria-pressed={tocOpen} disabled={tocEntries.length === 0} onClick={() => togglePanel('contents')}><Icon name="contents" size={17} /></button> : null}
                <ReaderMoreMenu
                  ref={moreMenuTriggerRef}
                  dismissKey={`${pathname}${search}${hash}:${sidebarOpen}`}
                  items={moreMenuItems}
                  onDismiss={() => { if (lastFocus.current?.area === 'more') lastFocus.current = null }}
                />
              </div>
            ) : (
              <div className="context-actions">
                <button type="button" className="context-button header-search" aria-keyshortcuts="Meta+K Control+K" aria-label={`Search pages in ${index.site.title}`} title="Search (⌘ K)" onClick={(event) => { event.currentTarget.focus(); openPalette('') }}><Icon name="search" size={15} /><span>Search</span><kbd>⌘ K</kbd></button>
                {bodyArtifact && !preview ? (
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
                {bodyArtifact && !columnShown ? (
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
                {(bodyArtifact && !columnShown) || currentDirectory ? <span className="action-divider" /> : null}
                {currentArtifact || currentDirectory || previewArtifact ? (
                  <button
                    className="icon-button"
                    title="Copy link"
                    aria-label={isSiteRoot ? 'Copy site link' : currentDirectory ? 'Copy folder link' : 'Copy artifact link'}
                    onClick={() => void copyCurrentLink(showToast)}
                  >
                    <Icon name="copy" size={15} />
                  </button>
                ) : null}
              </div>
            )}
          </header>

          <main ref={stageRef} id="main-content" tabIndex={-1} className={`stage${readingArtifact ? ' has-artifact' : ''}${columnShown ? ' has-reader-column' : ''}${preview ? ' stage-preview' : ''}`} data-heading-jump={headingJump ?? undefined}>
            {preview ? <PreviewNotices reader={preview} navigate={navigateWithinWorkspace} /> : null}
            <StageBody preview={Boolean(preview)}>
            {preview ? artifactView : searchRoute ? (
              <SearchResultsPage
                siteTitle={index.site.title}
                pageCount={index.artifacts.length}
                artifacts={index.artifacts}
                availability={searchState}
                discoveryError={describeDiscoveryError(siteDiscoveryError)}
                onRetryDiscovery={onRetryDiscovery}
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
            ) : previewsRoute ? (
              <SiteHomeFrame
                key={`previews:${previewsRoute.groupId ?? ''}`}
                header={(
                  <SiteHomeHeader
                    index={index}
                    pageCount={index.artifacts.length}
                    latestUpdatedAt={rootListing?.latestUpdatedAt}
                    current="previews"
                    hasOverview={hasIntroduction}
                    previewCount={previewCount}
                    onNavigate={openSection}
                    onOpenPalette={() => openPalette('')}
                  />
                )}
              >
                <section className="site-previews" aria-labelledby="site-previews-title">
                  <h2 id="site-previews-title">{previewsRoute.groupId ? 'Preview link' : 'Previews'}</h2>
                  <p className="preview-page-lede">{PREVIEW_LEDE}</p>
                  <PreviewListContent siteId={index.site.id} groupId={previewsRoute.groupId} navigate={navigateWithinWorkspace} />
                </section>
              </SiteHomeFrame>
            ) : folderIntroduction ? artifactView : currentDirectory ? (
              <DirectoryPage
                key={isSiteRoot ? `root:${siteSection}` : currentDirectory.path}
                listing={currentDirectory}
                siteId={index.site.id}
                body={(!isSiteRoot || siteSection === 'overview') && currentDirectory.indexArtifact ? artifactView : undefined}
                hideChildren={isSiteRoot && siteSection === 'overview'}
                restoreScroll={isSiteRoot}
                header={isSiteRoot ? (
                  <SiteHomeHeader
                    index={index}
                    pageCount={currentDirectory.pageCount}
                    latestUpdatedAt={currentDirectory.latestUpdatedAt}
                    current={siteSection}
                    hasOverview={hasIntroduction}
                    previewCount={previewCount}
                    onNavigate={openSection}
                    onOpenPalette={() => openPalette('')}
                  />
                ) : undefined}
                footer={isSiteRoot && siteSection === 'files' ? (
                  <>
                    {currentDirectory.folders.length + currentDirectory.pages.length === 0 ? (
                      <p className="empty-note">No other pages have been published to this site.</p>
                    ) : null}
                    <RecentlyUpdated index={index} onOpenArtifact={navigateWithinWorkspace} />
                  </>
                ) : undefined}
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
                previewCount={previewCount}
                onNavigate={openSection}
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

            {columnShown && publishedReadingArtifact && currentFormat === 'html' ? (
              <ReaderContextColumn detailsOpen={detailsOpen} detailsButtonRef={detailsToggleRef} onDetails={(trigger) => togglePanel('details', trigger)} standalone artifact={publishedReadingArtifact} entries={publishedReadingArtifact.toc ?? NO_ENTRIES} activeId={currentHeading} onJump={jumpFromColumn} />
            ) : null}
            {previewArtifact?.format === 'html' ? previewColumn : null}

            {activePanel && bodyArtifact && (!columnShown || activePanel === 'details') ? activePanel === 'contents' ? (
              <ContentsDialog host={stageRef} onDismiss={closePanel}>
                <div className="context-panel-header">
                  <span>Contents</span>
                  <button className="context-panel-close" type="button" title="Close Contents" aria-label="Close Contents" onClick={closePanel}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
                {tocEntries.length === 0 ? (
                  <p className="toc-empty">This artifact does not include indexed headings.</p>
                ) : <ContentsList entries={tocEntries} activeId={null} onJump={jumpToHeading} />}
              </ContentsDialog>
            ) : (
              <aside id="reader-details-panel" className="context-panel" aria-label={panelLabel}>
                <div className="context-panel-header">
                  <span>{panelLabel}</span>
                  <button className="context-panel-close" type="button" title={`Close ${panelLabel}`} aria-label={`Close ${panelLabel}`} onClick={closePanel}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
                {preview ? <PreviewDetails reader={preview} navigate={navigateWithinWorkspace} /> : <ArtifactDetails artifact={bodyArtifact} />}
              </aside>
            ) : null}
            </StageBody>
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

/** A preview document sits below its notice strip; the body then fills the rest of the stage. */
function StageBody({ preview, children }: { preview: boolean; children: ReactNode }) {
  return preview ? <div className="preview-body">{children}</div> : <>{children}</>
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
/** Whether the frame is still on the artifact's own URL (an unreadable cross-origin frame is not). */
function frameShowsArtifact(iframe: HTMLIFrameElement, artifactUrl: string) {
  try {
    const expected = new URL(artifactUrl, window.location.href)
    const actual = new URL(iframe.contentWindow?.location.href ?? '')
    return actual.origin === expected.origin && actual.pathname === expected.pathname && actual.search === expected.search
  } catch {
    return false
  }
}

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
    const reader = document.defaultView ? watchReaderScroll(document.defaultView) : undefined
    const stop = keepSearchHighlighted(document.body, query, (first) => {
      const element = first.startContainer.parentElement
      if (!scroll || reader?.scrolled || !element) return
      element.scrollIntoView({ block: 'center' })
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
/** A page's link from the results: `?q=` makes the page highlight the search. */
function withSearchQuery(href: string, query: string) {
  return `${href}?${new URLSearchParams({ q: query })}`
}

const NO_RANGES: Range[] = []
const NO_ENTRIES: NonNullable<ArtifactIndexEntry['toc']> = []

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

/**
 * Test-only seam: end-to-end tests set `window.__artifactPagesTest = { rankingMaxHits }`
 * (with `page.addInitScript`) to reach the path-ordered fallback without publishing
 * more pages than the real threshold. Nothing reads or writes it in normal use.
 */
function testRankingMaxHits(): number | undefined {
  const value = (window as unknown as { __artifactPagesTest?: { rankingMaxHits?: unknown } }).__artifactPagesTest?.rankingMaxHits
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}


function PreviewBuildTime({ value }: { value: string }) {
  const time = formatPreviewTime(value)
  return <>Built {time.dateTime ? <time lang={displayLocale()} dateTime={time.dateTime} title={time.title}>{time.label}</time> : time.label}</>
}
