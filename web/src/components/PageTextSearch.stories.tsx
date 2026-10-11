import { useEffect, useMemo, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ArtifactWorkspace } from './ArtifactWorkspace'
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
  startAt: 'site-home' | 'html' | 'markdown' | 'results'
  query: string
  /** The folder of the results page (`in` in the URL). */
  folder: string
  initialSidebarOpen: boolean
  theme: ThemeMode
}

const startPaths = {
  'site-home': '',
  html: '/incidents/checkout-latency/index.html',
  markdown: '/reports/latency-retrospective.md',
  results: '/_search',
}

function startLocation({ startAt, query, folder }: Pick<PageTextSearchStoryArgs, 'startAt' | 'query' | 'folder'>) {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (startAt === 'results' && folder) params.set('in', folder)
  const rest = params.toString()
  return { pathname: `/${deepSreIndex.site.id}${startPaths[startAt]}`, search: rest ? `?${rest}` : '', hash: '' }
}

function PageTextSearchStory({ search: behavior, ranking, startAt, query, folder, initialSidebarOpen, theme }: PageTextSearchStoryArgs) {
  const index = deepSreIndex
  const [location, setLocation] = useState(() => startLocation({ startAt, query, folder }))
  const [themeMode, setThemeMode] = useState(theme)
  const fullTextSearch = useMemo(
    () => behavior === 'unavailable' ? undefined : createStoryFullTextSearch(index, behavior),
    [behavior, index],
  )

  useEffect(() => {
    setLocation(startLocation({ startAt, query, folder }))
  }, [startAt, query, folder])
  useEffect(() => setThemeMode(theme), [theme])

  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  const activeTheme = resolveTheme(themeMode, systemTheme)
  useEffect(() => {
    document.documentElement.dataset.theme = activeTheme
  }, [activeTheme])

  function navigate(href: string) {
    const destination = new URL(href, window.location.origin)
    const nextRoute = parseRoute(destination.pathname, destination.search)
    if (nextRoute.kind === 'sites' || (nextRoute.kind !== 'preview-list' && nextRoute.kind !== 'preview-document' && nextRoute.siteId !== index.site.id)) return
    setLocation({ pathname: destination.pathname, search: destination.search, hash: destination.hash })
  }

  const route = parseRoute(location.pathname, location.search)
  if (route.kind !== 'site' && route.kind !== 'search') return null
  return (
    <ArtifactWorkspace
      route={route}
      pathname={location.pathname}
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
      rankingMaxHits={ranking === 'paged' ? 20 : undefined}
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
        component: 'Find pages by name with ⌘ K or the sidebar filter; search their text on the results page (/<site>/_search, opened with ⌘ ⇧ F or the sidebar\'s "Search full text" row). It updates as you type, shows folder facets with counts, and ranks pages as title, heading, then text matches (path order above the ranking threshold). An opened result highlights the matches and offers a match navigator. This story searches the fixture pages in the browser instead of loading a generated search projection.',
      },
    },
  },
  args: {
    search: 'ready',
    ranking: 'ranked',
    startAt: 'results',
    query: '',
    folder: '',
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
    startAt: { control: 'radio', options: ['results', 'site-home', 'html', 'markdown'] },
    query: { control: 'text', description: 'The query in the URL (?q=).' },
    folder: { control: 'text', description: 'The results page folder (in=).' },
    initialSidebarOpen: { control: 'boolean' },
    theme: { control: 'radio', options: ['system', 'light', 'dark'] },
  },
  render: (args: PageTextSearchStoryArgs) => <PageTextSearchStory {...args} />,
} satisfies Meta<PageTextSearchStoryArgs>

export default meta
type Story = StoryObj<typeof meta>

// Narrow reading area: facets become a chip row.
const narrowViewport = { viewport: { value: 'mobile1' } }

export const StartSearching: Story = {
  name: 'Results page · empty, type a query',
}

export const Results: Story = {
  name: 'Results page · ranked results with folder facets',
  args: { query: 'latency' },
}

export const ResultsInFolder: Story = {
  name: 'Results page · limited to a folder',
  args: { query: 'latency', folder: 'incidents' },
}

export const ResultsNarrow: Story = {
  name: 'Results page · narrow',
  args: { query: 'latency', initialSidebarOpen: false },
  globals: narrowViewport,
}

export const Searching: Story = {
  name: 'Results page · searching',
  args: { query: 'latency', search: 'slow' },
}

export const NoMatches: Story = {
  name: 'Results page · no matches',
  args: { query: 'latency kubernetes' },
}

export const NoMatchesInFolder: Story = {
  name: 'Results page · no matches in the folder',
  args: { query: 'retry', folder: 'architecture' },
}

export const NetworkError: Story = {
  name: 'Results page · search data could not be loaded',
  args: { query: 'latency', search: 'network-error' },
}

export const InvalidData: Story = {
  name: 'Results page · search data is invalid',
  args: { query: 'latency', search: 'invalid-data' },
}

export const PathOrderedFallback: Story = {
  name: 'Results page · too many hits to rank (path order, 20 per page)',
  args: { query: 'latency', search: 'many-results', ranking: 'paged' },
}

export const Unavailable: Story = {
  name: 'Results page · site without page text search',
  args: { search: 'unavailable' },
}

export const ReadingResults: Story = {
  name: 'Opened result · HTML page, match navigator',
  args: { query: 'latency', startAt: 'html' },
}

export const ReadingMarkdownResults: Story = {
  name: 'Opened result · Markdown page, match navigator',
  args: { query: 'retry', startAt: 'markdown' },
}
