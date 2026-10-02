import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ArtifactWorkspace } from './ArtifactWorkspace'
import { parseRoute, type AppRoute } from '../routing'
import { deepExpandedPaths, deepSreIndex, storyIndexes } from '../stories/fixtures'
import { resolveTheme } from '../domain/theme'
import { createStoryFullTextSearch } from '../stories/fake-fulltext'
import type { ThemeMode } from '../domain/theme'

const indexes = storyIndexes
const sites = indexes.map((index) => ({
  schemaVersion: index.schemaVersion,
  site: index.site,
  generatedAt: index.generatedAt,
  artifactCount: index.artifacts.length,
  artifactIndexUrl: `/_indexes/${index.site.id}/index.json`,
  fullTextUrl: index.site.id === deepSreIndex.site.id ? `/_indexes/${index.site.id}/search/manifest.json` : undefined,
}))
const sreFullTextSearch = createStoryFullTextSearch(deepSreIndex)

type WorkspaceStoryArgs = {
  view: 'site-home' | 'artifact' | 'markdown'
  theme: ThemeMode
  initialSidebarOpen: boolean
}

function WorkspaceStory({ view, theme, initialSidebarOpen }: WorkspaceStoryArgs) {
  const [route, setRoute] = useState<Extract<AppRoute, { kind: 'site' }>>(() => ({
    kind: 'site',
    siteId: deepSreIndex.site.id,
    artifactPath: view === 'site-home'
      ? undefined
      : view === 'markdown'
        ? 'runbooks/service-recovery.md'
        : 'incidents/checkout-latency/index.html',
  }))
  const [location, setLocation] = useState({ search: '', hash: '' })
  const [activeThemeMode, setActiveThemeMode] = useState(theme)
  const index = indexes.find(({ site }) => site.id === route.siteId) ?? deepSreIndex

  useEffect(() => {
    setRoute({
      kind: 'site',
      siteId: deepSreIndex.site.id,
      artifactPath: view === 'site-home'
        ? undefined
        : view === 'markdown'
          ? 'runbooks/service-recovery.md'
          : 'incidents/checkout-latency/index.html',
    })
    setLocation({ search: '', hash: '' })
  }, [view])

  useEffect(() => {
    setActiveThemeMode(theme)
  }, [theme])

  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  const activeTheme = resolveTheme(activeThemeMode, systemTheme)
  useEffect(() => {
    document.documentElement.dataset.theme = activeTheme
  }, [activeTheme])

  function navigate(href: string) {
    const destination = new URL(href, window.location.origin)
    const nextRoute = parseRoute(destination.pathname)
    if (nextRoute.kind === 'site') setRoute(nextRoute)
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
      themeMode={activeThemeMode}
      theme={activeTheme}
      onSetThemeMode={setActiveThemeMode}
      index={index}
      fullTextSearch={index.site.id === deepSreIndex.site.id ? sreFullTextSearch : undefined}
      initialExpandedPaths={deepExpandedPaths}
      initialSidebarOpen={initialSidebarOpen}
    />
  )
}

const meta = {
  title: 'Product/Workspace',
  args: {
    view: 'artifact',
    theme: 'system',
    initialSidebarOpen: true,
  },
  argTypes: {
    view: {
      control: 'radio',
      options: ['site-home', 'artifact', 'markdown'],
      description: 'Choose the main workspace state.',
    },
    theme: {
      control: 'radio',
      options: ['system', 'light', 'dark'],
    },
    initialSidebarOpen: {
      control: 'boolean',
      description: 'Show the workspace with its navigation sidebar open or collapsed.',
    },
  },
  render: (args: WorkspaceStoryArgs) => <WorkspaceStory {...args} />,
} satisfies Meta<WorkspaceStoryArgs>

export default meta
type Story = StoryObj<typeof meta>

export const ArtifactView: Story = {
  name: 'Artifact viewer',
}

export const MarkdownView: Story = {
  name: 'Markdown reader',
  args: { view: 'markdown' },
}

export const SiteHome: Story = {
  name: 'Site home',
  args: { view: 'site-home' },
}

export const DarkArtifactView: Story = {
  name: 'Artifact viewer · dark',
  args: { theme: 'dark' },
}

export const SidebarCollapsed: Story = {
  name: 'Artifact viewer · sidebar collapsed',
  args: { initialSidebarOpen: false },
}
