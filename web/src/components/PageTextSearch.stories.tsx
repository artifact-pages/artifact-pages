import { useEffect, useMemo, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ArtifactWorkspace } from './ArtifactWorkspace'
import { RANKING_MAX_HITS_STORAGE_KEY } from './usePageTextSearch'
import { parseRoute, type AppRoute } from '../routing'
import { deepExpandedPaths, deepSreIndex, storyIndexes } from '../stories/fixtures'
import { createStoryFullTextSearch, type StoryFullTextBehavior } from '../stories/fake-fulltext'
import { resolveTheme, type ThemeMode } from '../domain/theme'

const sites = storyIndexes.map((index) => ({
  schemaVersion: index.schemaVersion,
  site: index.site,
  generatedAt: index.generatedAt,
  artifactCount: index.artifacts.length,
  artifactIndexUrl: `/_indexes/${index.site.id}/index.json`,
  fullTextUrl: index.site.id === deepSreIndex.site.id ? `/_indexes/${index.site.id}/search/manifest.json` : undefined,
}))

type PageTextSearchStoryArgs = {
  search: StoryFullTextBehavior | 'unavailable'
  /** 'paged' lowers the ranking threshold so the path-ordered fallback shows. */
  ranking: 'ranked' | 'paged'
  startAt: 'site-home' | 'html' | 'markdown'
  query: string
  initialSidebarOpen: boolean
  theme: ThemeMode
}

const startPaths = {
  'site-home': undefined,
  html: 'incidents/checkout-latency/index.html',
  markdown: 'reports/latency-retrospective.md',
}

function PageTextSearchStory({ search: behavior, ranking, startAt, query, initialSidebarOpen, theme }: PageTextSearchStoryArgs) {
  const index = deepSreIndex
  const [route, setRoute] = useState<Extract<AppRoute, { kind: 'site' }>>({ kind: 'site', siteId: index.site.id, artifactPath: startPaths[startAt] })
  const [location, setLocation] = useState({ search: query ? `?q=${encodeURIComponent(query)}` : '', hash: '' })
  const [themeMode, setThemeMode] = useState(theme)
  const fullTextSearch = useMemo(
    () => {
      try {
        if (ranking === 'paged') window.localStorage.setItem(RANKING_MAX_HITS_STORAGE_KEY, '20')
        else window.localStorage.removeItem(RANKING_MAX_HITS_STORAGE_KEY)
      } catch {
        // Without storage the default threshold applies.
      }
      return behavior === 'unavailable' ? undefined : createStoryFullTextSearch(index, behavior)
    },
    [behavior, index, ranking],
  )

  useEffect(() => {
    setRoute({ kind: 'site', siteId: index.site.id, artifactPath: startPaths[startAt] })
    setLocation({ search: query ? `?q=${encodeURIComponent(query)}` : '', hash: '' })
  }, [index.site.id, startAt, query])
  useEffect(() => setThemeMode(theme), [theme])

  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  const activeTheme = resolveTheme(themeMode, systemTheme)
  useEffect(() => {
    document.documentElement.dataset.theme = activeTheme
  }, [activeTheme])

  function navigate(href: string) {
    const destination = new URL(href, window.location.origin)
    const nextRoute = parseRoute(destination.pathname)
    if (nextRoute.kind === 'site' && nextRoute.siteId === index.site.id) setRoute(nextRoute)
    setLocation({ search: destination.search, hash: destination.hash })
  }

  const pathname = `/${route.siteId}${route.artifactPath ? `/${route.artifactPath}` : ''}`
  return (
    <ArtifactWorkspace
      route={route}
      pathname={pathname}
      search={location.search}
      hash={location.hash}
      sites={sites}
      sitesLoading={false}
      navigate={navigate}
      themeMode={themeMode}
      theme={activeTheme}
      onSetThemeMode={setThemeMode}
      index={index}
      fullTextSearch={fullTextSearch}
      initialExpandedPaths={deepExpandedPaths}
      initialSidebarOpen={initialSidebarOpen}
    />
  )
}

const meta = {
  title: 'Product/Page text search',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Find pages by name with ⌘ K; search their text from the sidebar with ⌘ ⇧ F. A query runs only when it is committed with Enter, its results replace Pinned and Browse until it is cleared (ranked as title, heading, then text matches with a reason line, or in path order above the ranking threshold), and the committed terms are highlighted in the open page. This story searches the fixture pages in the browser instead of loading a generated search projection.',
      },
    },
  },
  args: {
    search: 'ready',
    ranking: 'ranked',
    startAt: 'html',
    query: '',
    initialSidebarOpen: true,
    theme: 'system',
  },
  argTypes: {
    search: {
      control: 'radio',
      options: ['ready', 'slow', 'network-error', 'invalid-data', 'many-results', 'unavailable'],
      description: 'How the site\'s search data behaves.',
    },
    ranking: { control: 'radio', options: ['ranked', 'paged'], description: 'Ranked list when every hit can be loaded, or the path-ordered fallback above the threshold.' },
    startAt: { control: 'radio', options: ['site-home', 'html', 'markdown'] },
    query: { control: 'text', description: 'The committed query in the URL (?q=).' },
    initialSidebarOpen: { control: 'boolean' },
    theme: { control: 'radio', options: ['system', 'light', 'dark'] },
  },
  render: (args: PageTextSearchStoryArgs) => <PageTextSearchStory {...args} />,
} satisfies Meta<PageTextSearchStoryArgs>

export default meta
type Story = StoryObj<typeof meta>

export const StartSearching: Story = {
  name: 'Start · type a query and press Enter',
}

export const ReadingResults: Story = {
  name: 'Reading results · HTML page highlighted',
  args: { query: 'latency' },
}

export const ReadingMarkdownResults: Story = {
  name: 'Reading results · Markdown page highlighted',
  args: { query: 'retry', startAt: 'markdown' },
}

export const SiteHomeWithResults: Story = {
  name: 'Site home with results',
  args: { query: 'latency', startAt: 'site-home' },
}

export const Searching: Story = {
  name: 'Searching',
  args: { query: 'latency', search: 'slow' },
}

export const NoResults: Story = {
  name: 'No results',
  args: { query: 'latency kubernetes' },
}

export const NetworkError: Story = {
  name: 'Search data could not be loaded',
  args: { query: 'latency', search: 'network-error' },
}

export const InvalidData: Story = {
  name: 'Search data is invalid',
  args: { query: 'latency', search: 'invalid-data' },
}

export const Unavailable: Story = {
  name: 'Site without page text search',
  args: { search: 'unavailable' },
}

export const CollapsedSidebar: Story = {
  name: 'Sidebar collapsed · results chip',
  args: { query: 'latency', initialSidebarOpen: false },
}

export const RankedResults: Story = {
  name: 'Ranked results · Title / Heading / Text reasons',
  args: { query: 'latency', startAt: 'site-home' },
}

export const RankedWithFolderScopeOffer: Story = {
  name: 'Ranked · folder scope offered for the open page',
  args: { query: 'latency', startAt: 'html' },
}

export const PathOrderedFallback: Story = {
  name: 'Fallback · too many hits to rank (path order, 20 per page)',
  args: { query: 'latency', search: 'many-results', ranking: 'paged', startAt: 'html' },
}
