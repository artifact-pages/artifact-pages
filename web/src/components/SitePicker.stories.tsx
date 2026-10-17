import { useEffect } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import sreIndex from '../../../fixtures/storage/_indexes/sre/index.json'
import frontendIndex from '../../../fixtures/storage/_indexes/frontend/index.json'
import type { SiteCatalogEntry, SiteDiscoveryMetadata, SiteIndex } from '../domain/index'
import { SitePicker } from './SitePicker'

const sites = [sreIndex, frontendIndex].map((value) => {
  const index = value as SiteIndex
  return {
    schemaVersion: index.schemaVersion,
    site: {
      ...index.site,
      ...(index.site.id === 'sre'
        ? { description: 'Incident response runbooks, service ownership guidance, reliability reviews, deployment health reports, and recovery procedures for production teams.' }
        : {}),
    },
    generatedAt: index.generatedAt,
    artifactCount: index.artifacts.length,
    artifactIndexUrl: `/_indexes/${index.site.id}/index.json`,
    fullTextUrl: index.site.id === 'sre' ? '/_indexes/sre/search/manifest.json' : undefined,
    contentUpdatedAt: index.generatedAt,
    ...(index.site.id === 'sre'
      ? {
        rootArtifactCount: 0,
        topLevelFolderCount: 6,
        topLevelFolders: ['architecture', 'diagrams', 'guides', 'incidents', 'reports', 'runbooks'].map((name) => ({ name, artifactCount: 1 })),
      }
      : {}),
  }
}) as SiteDiscoveryMetadata[]

function site(
  id: string,
  title: string,
  description: string,
  artifactCount: number,
  extra: Partial<SiteDiscoveryMetadata> = {},
): SiteDiscoveryMetadata {
  return {
    schemaVersion: 1,
    site: { id, title, description },
    generatedAt: '2026-10-09T00:00:00Z',
    artifactCount,
    artifactIndexUrl: `/_indexes/${id}/index.json`,
    ...extra,
  }
}

const guide = site('guide', 'Guide', 'Start here: set up the registry, publish your first artifact, and read it.', 14, {
  contentUpdatedAt: '2026-10-11T06:18:49Z',
  rootArtifactCount: 0,
  topLevelFolderCount: 2,
  topLevelFolders: [{ name: 'en', artifactCount: 7 }, { name: 'ja', artifactCount: 7 }],
})
const architecture = site('architecture', 'Architecture', 'How storage, indexes, delivery and the trust model fit together.', 12, {
  contentUpdatedAt: '2026-10-10T09:00:00Z',
  rootArtifactCount: 0,
  topLevelFolderCount: 2,
  topLevelFolders: [{ name: 'en', artifactCount: 6 }, { name: 'ja', artifactCount: 6 }],
})
const handbook = site('handbook', 'Handbook', 'Team handbook with a few top-level pages and no folders.', 5, {
  contentUpdatedAt: '2026-10-08T09:00:00Z',
  rootArtifactCount: 5,
  topLevelFolderCount: 0,
  topLevelFolders: [],
})
// Published by a CLI that predates the freshness and folder fields: count only.
const legacy = site('legacy', 'Legacy', 'Published before discovery metadata carried freshness and folders.', 9)

const statusSites: SiteCatalogEntry[] = [
  guide,
  { site: { id: 'drafts', title: 'Drafts', description: 'Registered, first publish pending.' }, status: 'not-published' },
  { site: { id: 'flaky', title: 'Flaky', description: 'Metadata could not be read.' }, status: 'metadata-unavailable' },
  { site: { id: 'old', title: 'Old', description: 'Published with an older format.' }, status: 'needs-republish' },
]

function Themed({ theme, children }: { theme: 'light' | 'dark'; children: React.ReactNode }) {
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  return <>{children}</>
}

const phone390 = { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' as const }

const meta = {
  title: 'Navigation/Site picker',
  component: SitePicker,
  args: {
    sites,
    onNavigate: () => undefined,
  },
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [(Story, context) => (
    <Themed theme={(context.parameters.siteTheme as 'light' | 'dark' | undefined) ?? 'light'}><Story /></Themed>
  )],
} satisfies Meta<typeof SitePicker>

export default meta
type Story = StoryObj<typeof meta>

// Two-folder counts, total-only card (single group), and the many-folders summary.
export const AvailableSites: Story = {
  args: { sites: [...sites, guide, architecture, handbook].filter((entry, i, all) => all.findIndex((other) => other.site.id === entry.site.id) === i) },
}

export const GuideAndArchitecture: Story = {
  args: { sites: [architecture, guide] },
}

export const Dark: Story = {
  args: { sites: [architecture, guide, handbook] },
  parameters: { siteTheme: 'dark' },
}

export const Narrow390: Story = {
  args: { sites: [architecture, guide, handbook] },
  parameters: { viewport: { options: { phone390 } } },
  globals: { viewport: { value: 'phone390', isRotated: false } },
}

export const Narrow390Dark: Story = {
  args: { sites: [architecture, guide, handbook] },
  parameters: { viewport: { options: { phone390 } }, siteTheme: 'dark' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
}

// Old metadata without freshness or folder fields: cards show only the count.
export const OldMetadata: Story = {
  args: { sites: [architecture, guide, legacy] },
}

export const Statuses: Story = {
  args: { sites: statusSites },
}

export const Empty: Story = {
  args: { sites: [] },
}
