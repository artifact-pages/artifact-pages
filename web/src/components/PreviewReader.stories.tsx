import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ArtifactWorkspace } from './ArtifactWorkspace'
import { resetPreviewList } from '../data/preview-list'
import { parseRoute, type AppRoute } from '../routing'
import { deepSreIndex, storyIndexes } from '../stories/fixtures'
import { resolveTheme, type ThemeMode } from '../domain/theme'

/* A preview document in the reader shell (ISSUE-109). The preview data is served by a fetch stub for the story's
   own `/_previews/sre/...` requests, so every state of the reader is reachable inside Storybook. */

type Scenario = 'pr' | 'pr-dependency' | 'manual' | 'manual-no-group' | 'superseded' | 'superseded-gone' | 'catalog-failed' | 'missing' | 'unsupported'

const HEAD = '3f9a2c1d4e5b6a7988c0d1e2f3a4b5c6d7e8f901'
const NEWER = '9e5c7b3a1d08f2e4a6c8b0d2f4a6c8e0b2d4f6a8'
const MANUAL_HEAD = 'a7d2e48b90c1f3e5a7b9d1c3e5f7a9b1c3d5e7f9'
const PR_URL = 'https://github.com/acme/sre-docs/pull/142'
const DOCUMENT = { path: 'runbooks/publishing.md', title: 'Publishing', format: 'markdown' as const }
const OTHER = { path: 'runbooks/service-recovery.md', title: 'Service recovery', format: 'markdown' as const }
const AFFECTED = { path: 'runbooks/getting-started.md', title: 'Getting started', format: 'markdown' as const, reason: 'dependency' as const, changedResources: ['assets/site.css'] }

const MARKDOWN = `# Publishing

Every change reaches the published site through the same path: a pull request, a green check and a publish.

## Publish on push

A preview is a review copy of the changed pages. It is built from one revision and never changes after it is built.

## Previews for pull requests

When a newer commit is pushed, the pull request gets a new preview and this one stays reachable by its link.
`

function manifestFor(head: string, documents: unknown[]) {
  return {
    schemaVersion: 1, site: 'sre', headSha: head,
    defaultHeadSha: '8b1e0d7a94c2f3e5a7b9d1c3e5f7a9b1c3d5e7f9', mergeBaseSha: 'c41d9e6f0a37b2d4f6a8c0e2b4d6f8a0c2e4b6d8',
    createdAt: head === NEWER ? '2026-10-16T15:03:00Z' : '2026-10-14T09:41:00Z',
    bundleDigest: `sha256:${'0'.repeat(64)}`,
    files: (documents as Array<{ path: string }>).map(({ path }) => ({ path, sha256: 'a'.repeat(64), contentType: 'text/markdown; charset=utf-8' })),
    documents,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Serves the story's preview objects; every other request goes to the real fetch. Returns the restore function. */
function installPreviewFetch(scenario: Scenario) {
  const original = window.fetch
  const prHead = scenario === 'superseded' || scenario === 'superseded-gone' ? NEWER : HEAD
  const documents = scenario === 'pr-dependency' ? [DOCUMENT, OTHER, AFFECTED] : [DOCUMENT, OTHER]
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    if (!url.pathname.startsWith('/_previews/sre/')) return original(input, init)
    if (url.pathname.endsWith('/catalog.json')) {
      if (scenario === 'catalog-failed') return new Response('unavailable', { status: 503 })
      return json({
        schemaVersion: 1, site: 'sre',
        groups: [
          { id: 'pr:142', kind: 'pull-request', headSha: prHead, prUrl: PR_URL, updatedAt: '2026-10-16T15:03:00Z', documents: scenario === 'superseded-gone' ? [OTHER] : documents },
          { id: `head:${MANUAL_HEAD}`, kind: 'manual', headSha: MANUAL_HEAD, updatedAt: '2026-10-15T11:20:00Z', documents: [DOCUMENT, AFFECTED] },
        ],
      })
    }
    const manifest = /\/revisions\/([0-9a-f]{40})\/manifest\.json$/u.exec(url.pathname)
    if (manifest) {
      const head = manifest[1]
      if (scenario === 'missing' && head === HEAD) return new Response('missing', { status: 404 })
      if (scenario === 'unsupported' && head === HEAD) return json({ schemaVersion: 99, site: 'sre', headSha: head })
      if (head === MANUAL_HEAD) return json(manifestFor(head, [DOCUMENT, AFFECTED]))
      if (head === NEWER) return json(manifestFor(head, scenario === 'superseded-gone' ? [OTHER] : documents))
      return json(manifestFor(head, documents))
    }
    if (url.pathname.includes('/files/')) return new Response(MARKDOWN, { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
    return new Response('not found', { status: 404 })
  }
  return () => { window.fetch = original }
}

const sites = storyIndexes.map((index) => ({
  schemaVersion: index.schemaVersion,
  site: index.site,
  generatedAt: index.generatedAt,
  artifactCount: index.artifacts.length,
  artifactIndexUrl: `/_indexes/${index.site.id}/index.json`,
}))

function previewHref(scenario: Scenario) {
  const head = scenario === 'manual' || scenario === 'manual-no-group' ? MANUAL_HEAD : HEAD
  const group = scenario === 'manual' ? `?group=head%3A${MANUAL_HEAD}` : scenario === 'manual-no-group' ? '' : '?group=pr%3A142'
  return `/sre/_previews/${head}/${DOCUMENT.path}${group}`
}

type StoryArgs = { scenario: Scenario; theme: ThemeMode }

function PreviewStory({ scenario, theme }: StoryArgs) {
  // Each state starts from an empty catalog cache and its own stub, installed before the workspace mounts.
  const [ready, setReady] = useState(false)
  const [location, setLocation] = useState(() => new URL(previewHref(scenario), window.location.origin))
  useEffect(() => {
    resetPreviewList('sre')
    const restore = installPreviewFetch(scenario)
    setLocation(new URL(previewHref(scenario), window.location.origin))
    setReady(true)
    return () => { restore(); setReady(false); resetPreviewList('sre') }
  }, [scenario])
  const [activeThemeMode, setActiveThemeMode] = useState(theme)
  useEffect(() => setActiveThemeMode(theme), [theme])
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  const activeTheme = resolveTheme(activeThemeMode, systemTheme)
  useEffect(() => { document.documentElement.dataset.theme = activeTheme }, [activeTheme])
  if (!ready) return null
  const route = parseRoute(location.pathname, location.search) as AppRoute
  if (route.kind !== 'preview-document' && route.kind !== 'preview-list') return null
  return (
    <ArtifactWorkspace
      route={route}
      pathname={location.pathname}
      search={location.search}
      hash={location.hash}
      sites={sites}
      sitesLoading={false}
      navigate={(href) => setLocation(new URL(href, window.location.origin))}
      themeMode={activeThemeMode}
      theme={activeTheme}
      onSetThemeMode={setActiveThemeMode}
      index={deepSreIndex}
      initialSidebarOpen
    />
  )
}

const meta = {
  title: 'Product/Preview reader',
  args: { scenario: 'pr', theme: 'system' },
  argTypes: {
    scenario: {
      control: 'select',
      options: ['pr', 'pr-dependency', 'manual', 'manual-no-group', 'superseded', 'superseded-gone', 'catalog-failed', 'missing', 'unsupported'],
      description: 'The state of the preview the reader opens.',
    },
    theme: { control: 'radio', options: ['system', 'light', 'dark'] },
  },
  parameters: { layout: 'fullscreen' },
  render: (args: StoryArgs) => <PreviewStory {...args} />,
} satisfies Meta<StoryArgs>

export default meta
type Story = StoryObj<typeof meta>

const wide = { viewport: { value: 'desktop' } }
const narrow = { viewport: { value: 'mobile1' } }

export const PullRequest: Story = { name: 'PR preview, current head', globals: wide }
export const PullRequestDark: Story = { name: 'PR preview · dark', args: { theme: 'dark' }, globals: wide }
export const PullRequestAffected: Story = { name: 'PR preview · pages affected by a resource change', args: { scenario: 'pr-dependency' }, globals: wide }
export const Manual: Story = { name: 'Manual preview', args: { scenario: 'manual' }, globals: wide }
export const ManualWithoutGroup: Story = { name: 'Manual preview · link without a group', args: { scenario: 'manual-no-group' }, globals: wide }
export const OlderRevision: Story = { name: 'Older revision · current preview has the page', args: { scenario: 'superseded' }, globals: wide }
export const OlderRevisionGone: Story = { name: 'Older revision · current preview lacks the page', args: { scenario: 'superseded-gone' }, globals: wide }
export const CatalogUnavailable: Story = { name: 'Catalog unavailable', args: { scenario: 'catalog-failed' }, globals: wide }
export const Unavailable: Story = { name: 'Missing or expired preview', args: { scenario: 'missing' }, globals: wide }
export const NeedsRepublish: Story = { name: 'Unsupported format', args: { scenario: 'unsupported' }, globals: wide }
export const NarrowPullRequest: Story = { name: 'Narrow · PR preview', globals: narrow }
export const NarrowOlderRevision: Story = { name: 'Narrow · older revision', args: { scenario: 'superseded' }, globals: narrow }
