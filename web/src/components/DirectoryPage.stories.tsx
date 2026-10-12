import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ArtifactWorkspace } from './ArtifactWorkspace'
import { parseRoute, type AppRoute } from '../routing'
import { resolveTheme } from '../domain/theme'
import type { ThemeMode } from '../domain/theme'
import type { ArtifactIndexEntry, SiteIndex } from '../domain/index'
import { deepSreIndex } from '../stories/fixtures'

// A documentation-shaped site on top of the SRE fixture: guide/en with nested reference folders, a
// one-page folder, and a docs folder whose README.md becomes the page body (the markdown content
// itself is the fixture runbook).
const markdownUrl = '/_artifacts/sre/runbooks/service-recovery.md'

function page(path: string, title: string, updatedAt: string, headings: string[] = [], committer = 'Ada Writer'): ArtifactIndexEntry {
  return {
    id: path,
    path,
    title,
    format: 'markdown',
    filename: path.split('/').at(-1),
    artifactUrl: markdownUrl,
    updatedAt,
    lastCommitter: { name: committer },
    toc: headings.map((text, index) => ({ level: 2, text, id: `section-${index + 1}` })),
  }
}

const documentationPages = [
  page('guide/en/getting-started.md', 'Getting started', '2026-10-02T09:00:00Z', ['Choose a provider', 'Install the CLI', 'Register a site']),
  page('guide/en/publishing.md', 'Publishing', '2026-10-03T09:00:00Z', ['Publish on', 'Dry runs', 'Credentials', 'Cache purge', 'Rollback']),
  page('guide/en/previews.md', 'Previews', '2026-10-04T09:00:00Z', ['Pull requests'], 'Grace Reviewer'),
  page('guide/en/reference/config.md', 'Configuration schema', '2026-10-06T09:00:00Z', ['Sites', 'Providers']),
  page('guide/en/reference/cli/publish.md', 'artifact-pages publish', '2026-10-09T09:00:00Z'),
  page('guide/en/reference/cli/preview.md', 'artifact-pages preview', '2026-10-05T09:00:00Z'),
  page('guide/ja/publishing.md', '公開する', '2026-10-02T09:00:00Z', ['公開の条件', 'ドライラン']),
  page('docs/README.md', 'Documentation home', '2026-10-01T09:00:00Z', ['Where to start']),
  page('docs/changelog.md', 'Changelog', '2026-10-07T09:00:00Z', ['0.4', '0.3']),
  page('docs/contributing/review.md', 'Review checklist', '2026-10-08T09:00:00Z'),
  page('solo/only-page.md', 'The only page', '2026-10-08T09:00:00Z', ['Overview']),
  // A folder with a README and more than 12 children: the list shows 10 rows and a "Show all" control.
  page('handbook/README.md', 'Handbook home', '2026-10-01T09:00:00Z', ['Welcome']),
  ...Array.from({ length: 14 }, (_, position) => page(`handbook/topic-${String(position + 1).padStart(2, '0')}.md`, `Topic ${position + 1}`, '2026-10-05T09:00:00Z')),
]

const directoryIndex: SiteIndex = {
  ...deepSreIndex,
  artifacts: [...deepSreIndex.artifacts, ...documentationPages],
}

const VIEWS = {
  list: 'guide/en',
  'folders-only': 'guide',
  nested: 'guide/en/reference/cli',
  'one-page': 'solo',
  readme: 'docs',
  'readme-many': 'handbook',
  'site-root': undefined,
  'html-index': 'incidents/checkout-latency',
} as const

type DirectoryStoryArgs = {
  view: keyof typeof VIEWS
  theme: ThemeMode
}

function DirectoryStory({ view, theme }: DirectoryStoryArgs) {
  const [route, setRoute] = useState<Extract<AppRoute, { kind: 'site' }>>(() => ({
    kind: 'site',
    siteId: directoryIndex.site.id,
    artifactPath: VIEWS[view],
  }))
  const [hash, setHash] = useState('')
  const [themeMode, setThemeMode] = useState(theme)
  useEffect(() => { setRoute({ kind: 'site', siteId: directoryIndex.site.id, artifactPath: VIEWS[view] }) }, [view])
  useEffect(() => { setThemeMode(theme) }, [theme])

  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  const activeTheme = resolveTheme(themeMode, systemTheme)
  useEffect(() => { document.documentElement.dataset.theme = activeTheme }, [activeTheme])

  function navigate(href: string) {
    const destination = new URL(href, window.location.origin)
    const next = parseRoute(destination.pathname)
    if (next.kind === 'site') setRoute(next)
    setHash(destination.hash)
  }

  return (
    <ArtifactWorkspace
      route={route}
      pathname={`/${route.siteId}${route.artifactPath ? `/${route.artifactPath}` : ''}`}
      hash={hash}
      sites={[]}
      sitesLoading={false}
      navigate={navigate}
      themeMode={themeMode}
      theme={activeTheme}
      onSetThemeMode={setThemeMode}
      index={directoryIndex}
      initialSidebarOpen
    />
  )
}

const phone390 = { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' as const }

const meta = {
  title: 'Product/Directory page',
  args: { view: 'list', theme: 'light' },
  argTypes: {
    view: { control: 'radio', options: Object.keys(VIEWS) },
    theme: { control: 'radio', options: ['system', 'light', 'dark'] },
  },
  parameters: { layout: 'fullscreen' },
  render: (args: DirectoryStoryArgs) => <DirectoryStory {...args} />,
} satisfies Meta<DirectoryStoryArgs>

export default meta
type Story = StoryObj<typeof meta>

export const FoldersAndPages: Story = { name: 'Folders then pages (variant A)' }
export const FoldersAndPagesDark: Story = { args: { theme: 'dark' } }
export const FoldersAndPagesNarrow: Story = {
  name: 'Folders then pages · 390px',
  parameters: { viewport: { options: { phone390 } } },
  globals: { viewport: { value: 'phone390', isRotated: false } },
}
export const FoldersOnly: Story = { args: { view: 'folders-only' } }
export const NestedFolder: Story = { args: { view: 'nested' } }
export const OnePageFolder: Story = { args: { view: 'one-page' } }
export const ReadmeBody: Story = { name: 'Children then README body', args: { view: 'readme' } }
export const ReadmeBodyDark: Story = { args: { view: 'readme', theme: 'dark' } }
export const ReadmeBodyNarrow: Story = {
  name: 'README body · 390px',
  args: { view: 'readme' },
  parameters: { viewport: { options: { phone390 } } },
  globals: { viewport: { value: 'phone390', isRotated: false } },
}
export const ReadmeManyChildren: Story = { name: 'README with more than 12 children', args: { view: 'readme-many' } }
export const SiteRoot: Story = { name: 'Site root', args: { view: 'site-root' } }
export const SiteRootDark: Story = { args: { view: 'site-root', theme: 'dark' } }
export const HtmlIndexBody: Story = { name: 'index.html body', args: { view: 'html-index' } }
