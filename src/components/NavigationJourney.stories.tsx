import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ArtifactWorkspace } from './ArtifactWorkspace'
import type { RecentArtifactRead } from '../domain/recent-reads'
import { deepExpandedPaths, deepSreIndex, storyIndexes } from '../stories/fixtures'
import { parseRoute, type AppRoute } from '../routing'
import { resolveTheme } from '../domain/theme'

const index = deepSreIndex
const sites = storyIndexes.map((siteIndex) => ({
  schemaVersion: siteIndex.schemaVersion,
  site: siteIndex.site,
  generatedAt: siteIndex.generatedAt,
  artifactCount: siteIndex.artifacts.length,
  artifactIndexUrl: `/_indexes/${siteIndex.site.id}/index.json`,
}))
const initialRoute: Extract<AppRoute, { kind: 'site' }> = {
  kind: 'site',
  siteId: index.site.id,
  artifactPath: 'incidents/checkout-latency/index.html',
}

function NavigationJourney() {
  const [route, setRoute] = useState(initialRoute)
  const [hash, setHash] = useState('')
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
    setHash(destination.hash)
  }

  const pathname = `/${route.siteId}${route.artifactPath ? `/${route.artifactPath}` : ''}`
  return (
    <ArtifactWorkspace
      route={route}
      pathname={pathname}
      hash={hash}
      sites={sites}
      sitesLoading={false}
      navigate={navigate}
      themeMode={themeMode}
      theme={theme}
      onSetThemeMode={setThemeMode}
      index={index}
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
        story: 'Uses the real ArtifactWorkspace, collapsed navigation rail, artifact iframe, and CommandPalette. Open the palette with ⌘/Ctrl K or the search icon. All, Recent, and Pinned filter the candidate set; the same ranking combines fuzzy query matches, proximity to the open artifact, reading history, pins, and update freshness. Search “latency” and switch scopes while keeping the query. Pin a page from the expanded sidebar to see it affect ranking. Explicit links and tags are not yet present in the index metadata.',
      },
    },
  },
  render: () => <NavigationJourney />,
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const PaletteFirstWithRecentReads: Story = {
  name: 'Palette first · ranked across scopes',
}
