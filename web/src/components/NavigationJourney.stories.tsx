import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ArtifactWorkspace } from './ArtifactWorkspace'
import type { RecentArtifactRead } from '../domain/recent-reads'
import { deepExpandedPaths, deepSreIndex, storyIndexes } from '../stories/fixtures'
import { parseRoute, type AppRoute } from '../routing'
import { resolveTheme } from '../domain/theme'
import { createStoryFullTextSearch } from '../stories/fake-fulltext'

const index = deepSreIndex
const sites = storyIndexes.map((siteIndex) => ({
  schemaVersion: siteIndex.schemaVersion,
  site: siteIndex.site,
  generatedAt: siteIndex.generatedAt,
  artifactCount: siteIndex.artifacts.length,
  artifactIndexUrl: `/_indexes/${siteIndex.site.id}/index.json`,
  fullTextUrl: siteIndex.site.id === index.site.id ? `/_indexes/${siteIndex.site.id}/search/manifest.json` : undefined,
}))
const fullTextSearch = createStoryFullTextSearch(index)
const initialRoute: Extract<AppRoute, { kind: 'site' }> = {
  kind: 'site',
  siteId: index.site.id,
  artifactPath: 'incidents/checkout-latency/index.html',
}

function NavigationJourney() {
  const [route, setRoute] = useState(initialRoute)
  const [location, setLocation] = useState({ search: '', hash: '' })
  const [recentReads, setRecentReads] = useState<RecentArtifactRead[]>(() => {
    const now = Date.now()
    return [
      { artifactId: 'reports/latency-retrospective.md', viewedAt: now - 2 * 60_000 },
      { artifactId: 'architecture/platform-topology/index.html', viewedAt: now - 19 * 60_000 },
      { artifactId: 'diagrams/mermaid-catalog.md', viewedAt: now - 3 * 60 * 60_000 },
      { artifactId: 'incidents/checkout-latency/index.html', viewedAt: now - 2 * 24 * 60 * 60_000 },
    ]
  })
  const [themeMode, setThemeMode] = useState<'system' | 'light' | 'dark'>('system')
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  const theme = resolveTheme(themeMode, systemTheme)

  function navigate(href: string) {
    const destination = new URL(href, window.location.origin)
    const nextRoute = parseRoute(destination.pathname)
    if (nextRoute.kind === 'site') {
      setRoute(nextRoute)
      if (nextRoute.artifactPath && nextRoute.artifactPath !== route.artifactPath) {
        const artifact = index.artifacts.find(({ path, id }) => (
          path === nextRoute.artifactPath || id === nextRoute.artifactPath
        ))
        if (artifact) {
          setRecentReads((current) => [
            { artifactId: artifact.id, viewedAt: Date.now() },
            ...current.filter(({ artifactId }) => artifactId !== artifact.id),
          ].slice(0, 12))
        }
      }
    }
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
      theme={theme}
      onSetThemeMode={setThemeMode}
      index={index}
      fullTextSearch={fullTextSearch}
      initialExpandedPaths={deepExpandedPaths}
      initialSidebarOpen={false}
      recentReads={recentReads}
    />
  )
}

const meta = {
  title: 'Product/Navigation journey',
  parameters: {
    docs: {
      description: {
        story: 'Uses the real ArtifactWorkspace, collapsed navigation rail, artifact iframe, and CommandPalette. Open the palette with ⌘/Ctrl K or the search icon: before typing it lists pinned pages and recently read pages; typing ranks pages by fuzzy query match, proximity to the open artifact, reading history, pins, and update freshness. Pin a page from the expanded sidebar to see it affect ranking. When no page name matches, the palette offers to search page text instead (⌘ ↵), which opens the results in the sidebar.',
      },
    },
  },
  render: () => <NavigationJourney />,
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const PaletteFirstWithRecentReads: Story = {
  name: 'Palette first · recent reads and ranking',
}
