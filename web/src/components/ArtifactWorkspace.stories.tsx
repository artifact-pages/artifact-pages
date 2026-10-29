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

/** A path that matches no page but sits next to real ones, so the not-found view offers similar pages. */
const MISSING_PAGE_PATH = 'incidents/2026/q3/checkout/latency-summary'

function viewArtifactPath(view: WorkspaceStoryArgs['view']) {
  switch (view) {
    case 'site-home': return undefined
    case 'markdown': return 'runbooks/service-recovery.md'
    case 'retrospective': return 'reports/latency-retrospective.md'
    case 'not-found': return MISSING_PAGE_PATH
    default: return 'incidents/checkout-latency/index.html'
  }
}

type WorkspaceStoryArgs = {
  view: 'site-home' | 'artifact' | 'markdown' | 'retrospective' | 'not-found'
  theme: ThemeMode
  initialSidebarOpen: boolean
}

function WorkspaceStory({ view, theme, initialSidebarOpen }: WorkspaceStoryArgs) {
  const [route, setRoute] = useState<Extract<AppRoute, { kind: 'site' }>>(() => ({
    kind: 'site',
    siteId: deepSreIndex.site.id,
    artifactPath: viewArtifactPath(view),
  }))
  const [location, setLocation] = useState({ search: '', hash: '' })
  const [activeThemeMode, setActiveThemeMode] = useState(theme)
  const index = indexes.find(({ site }) => site.id === route.siteId) ?? deepSreIndex

  useEffect(() => {
    setRoute({
      kind: 'site',
      siteId: deepSreIndex.site.id,
      artifactPath: viewArtifactPath(view),
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
    const nextRoute = parseRoute(destination.pathname, destination.search)
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
      options: ['site-home', 'artifact', 'markdown', 'retrospective', 'not-found'],
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

// The site home (ISSUE-107, ISSUE-129): compact header, Overview / Files / Previews links in the top bar and its search. The story
// site has no root README, so it opens on Files and shows no Overview link; Previews needs the preview
// catalog, so inside Storybook it shows its retryable error state.
export const SiteHome: Story = {
  name: 'Site home',
  args: { view: 'site-home' },
}

export const SiteHomeDark: Story = {
  name: 'Site home · dark',
  args: { view: 'site-home', theme: 'dark' },
}

export const SiteHomeNarrow: Story = {
  name: 'Site home · narrow',
  args: { view: 'site-home', initialSidebarOpen: false },
  globals: { viewport: { value: 'mobile1' } },
}

export const DarkArtifactView: Story = {
  name: 'Artifact viewer · dark',
  args: { theme: 'dark' },
}

export const SidebarCollapsed: Story = {
  name: 'Artifact viewer · sidebar collapsed',
  args: { initialSidebarOpen: false },
}

export const PageNotFound: Story = {
  name: 'Page not found',
  args: { view: 'not-found' },
}

// Wide reader (ISSUE-108): from 1200 px a document page has the persistent Details and Contents column;
// the 'desktop' viewport is 1280 px wide. Scroll the Markdown story to see Details leave and Contents stay.
const wideViewport = { viewport: { value: 'desktop' } }

export const WideReaderMarkdown: Story = {
  name: 'Wide reader · Markdown column',
  args: { view: 'retrospective', theme: 'light', initialSidebarOpen: true },
  globals: wideViewport,
}

export const WideReaderMarkdownDark: Story = {
  name: 'Wide reader · Markdown column · dark',
  args: { view: 'retrospective', theme: 'dark', initialSidebarOpen: true },
  globals: wideViewport,
}

export const WideReaderHtml: Story = {
  name: 'Wide reader · HTML column',
  args: { view: 'artifact', theme: 'light', initialSidebarOpen: false },
  globals: wideViewport,
}

// Narrow reader chrome (ISSUE-080): the viewport is 390 px wide, so the 620 px media rules apply.
const narrowViewport = { viewport: { value: 'mobile1' } }

function openMoreMenu({ canvasElement }: { canvasElement: HTMLElement }) {
  window.requestAnimationFrame(() => {
    canvasElement.ownerDocument.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')?.click()
  })
}

export const NarrowArtifact: Story = {
  name: 'Narrow · More menu closed',
  args: { view: 'retrospective', initialSidebarOpen: false, theme: 'light' },
  globals: narrowViewport,
}

export const NarrowMoreMenuOpen: Story = {
  name: 'Narrow · More menu open',
  args: { view: 'retrospective', initialSidebarOpen: false, theme: 'light' },
  globals: narrowViewport,
  play: openMoreMenu,
}

export const NarrowMoreMenuOpenDark: Story = {
  name: 'Narrow · More menu open · dark',
  args: { view: 'retrospective', initialSidebarOpen: false, theme: 'dark' },
  globals: narrowViewport,
  play: openMoreMenu,
}

export const NarrowDrawerOpen: Story = {
  name: 'Narrow · drawer open',
  args: { view: 'retrospective', initialSidebarOpen: true, theme: 'light' },
  globals: narrowViewport,
}

export const NarrowNotFound: Story = {
  name: 'Narrow · page not found',
  args: { view: 'not-found', initialSidebarOpen: false },
  globals: narrowViewport,
}
