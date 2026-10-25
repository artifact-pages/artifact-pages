import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { storyIndexes } from '../stories/fixtures'
import type { ArtifactIndexEntry, SiteDiscoveryMetadata, SiteIndex } from '../domain/index'
import { CommandPalette, type PaletteCommand, type PaletteContext } from './CommandPalette'

const indexes = storyIndexes as SiteIndex[]
const sites: SiteDiscoveryMetadata[] = indexes.map((index) => ({
  schemaVersion: index.schemaVersion,
  site: index.site,
  generatedAt: index.generatedAt,
  artifactCount: index.artifacts.length,
  artifactIndexUrl: `/_indexes/${index.site.id}/index.json`,
}))
const currentIndex = indexes[0]
const currentArtifact = currentIndex.artifacts[0] as ArtifactIndexEntry

const now = Date.now()
const recentReads = currentIndex.artifacts.slice(1, 4).map((artifact, order) => ({
  artifactId: artifact.id,
  viewedAt: now - (order + 1) * 37 * 60_000,
}))
const pinnedArtifactIds = currentIndex.artifacts.slice(4, 5).map(({ id }) => id)

// The current page with an extra heading that also names another page, so a typed query can match both.
const currentWithOverlappingHeading: ArtifactIndexEntry = {
  ...currentArtifact,
  toc: [...(currentArtifact.toc ?? []), { id: 'gateway-timeout-notes', text: 'Gateway timeout notes', level: 2 }],
}

// Long, unbreakable titles and deep paths on the current, pinned and recently read pages (390px wrap check).
const longTitle = (label: string) => `${label}CapacityPlanningAndIncidentReviewForTheCheckoutPlatformMigrationWithoutBreaks`
const longTitleIds = new Set([currentArtifact.id, ...pinnedArtifactIds, ...recentReads.slice(0, 1).map(({ artifactId }) => artifactId)])
const longTitleIndex: SiteIndex = {
  ...currentIndex,
  artifacts: currentIndex.artifacts.map((artifact, order) =>
    longTitleIds.has(artifact.id)
      ? {
          ...artifact,
          title: longTitle(`Page${order}`),
          path: `docs/platform/operations/runbooks/2026/long-path-segment-for-wrapping-check/${artifact.path}`,
        }
      : artifact,
  ),
}

type PaletteHistory = 'default' | 'none' | 'only-current' | 'current-pinned'
type PaletteStoryArgs = { seed: string; context: PaletteContext; history?: PaletteHistory; overlappingHeading?: boolean; longTitles?: boolean; theme?: 'light' | 'dark' }

function historyFor(history: PaletteHistory) {
  if (history === 'none') return { reads: [], pinned: [] as string[] }
  if (history === 'only-current') return { reads: [{ artifactId: currentArtifact.id, viewedAt: now }], pinned: [] as string[] }
  if (history === 'current-pinned') return { reads: recentReads, pinned: [currentArtifact.id] }
  return { reads: [{ artifactId: currentArtifact.id, viewedAt: now }, ...recentReads], pinned: pinnedArtifactIds }
}

const phone390 = { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' as const }

function PaletteStory({ seed, context, history = 'default', overlappingHeading = false, longTitles = false, theme }: PaletteStoryArgs) {
  useEffect(() => {
    if (!theme) return undefined
    const previous = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = theme
    return () => {
      if (previous === undefined) delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = previous
    }
  }, [theme])
  const storyIndex = longTitles ? longTitleIndex : currentIndex
  const { reads, pinned } = historyFor(history)
  const baseArtifact = storyIndex.artifacts.find(({ id }) => id === currentArtifact.id) ?? currentArtifact
  const openArtifact = overlappingHeading ? { ...currentWithOverlappingHeading, title: baseArtifact.title, path: baseArtifact.path } : baseArtifact
  const [isOpen, setIsOpen] = useState(true)
  const commands: PaletteCommand[] = [
    { title: 'Toggle sidebar', shortcut: '⌘ B', onSelect: () => undefined },
    { title: 'Toggle contents', shortcut: '⌘ ⇧ O', onSelect: () => undefined },
    { title: 'Go to site home', onSelect: () => undefined },
    { title: 'Use light theme', onSelect: () => undefined },
    { title: 'Use dark theme', onSelect: () => undefined },
    { title: 'Use system theme', subtitle: 'Current', onSelect: () => undefined },
  ]

  return isOpen ? (
    <CommandPalette
      seed={seed}
      context={context}
      sites={sites}
      currentIndex={storyIndex}
      currentArtifact={openArtifact}
      recentReads={reads}
      pinnedArtifactIds={pinned}
      commands={commands}
      loading={false}
      onClose={() => setIsOpen(false)}
      onNavigate={() => setIsOpen(false)}
      onJumpToHeading={() => setIsOpen(false)}
      onSearchPageText={context === 'sites' ? undefined : () => setIsOpen(false)}
    />
  ) : (
    <div style={{ padding: 24 }}>
      <button className="text-action" onClick={() => setIsOpen(true)}>Open command palette</button>
    </div>
  )
}

const meta = {
  title: 'Navigation/Command palette',
  args: { seed: '', context: 'site' },
  argTypes: {
    seed: {
      control: 'radio',
      options: ['', 'checkout', 'pltf', 'chk lat', 'idempotency', '@', '>', '#'],
      description: 'Try fuzzy terms or prefix with @, >, or # to explicitly scope results.',
    },
    context: {
      control: 'radio',
      options: ['sites', 'site', 'artifact'],
      description: 'Set the route context that determines result priority.',
    },
  },
  render: (args: PaletteStoryArgs) => <PaletteStory key={args.seed} {...args} />,
} satisfies Meta<PaletteStoryArgs>

export default meta
type Story = StoryObj<typeof meta>

export const RecentReads: Story = {}

export const RootSiteSelection: Story = {
  args: { context: 'sites' },
}

export const SiteHomePages: Story = {
  args: { context: 'site' },
}

export const SearchArtifacts: Story = {
  args: { context: 'artifact', seed: 'checkout' },
}

export const NoNameMatchOffersPageText: Story = {
  name: 'No name match · search page text',
  args: { seed: 'idempotency' },
}

export const FuzzySearchInlineTrace: Story = {
  args: { seed: 'chk lat' },
}

export const SwitchSites: Story = {
  args: { seed: '@' },
}

export const Commands: Story = {
  args: { seed: '>' },
}

export const Headings: Story = {
  args: { context: 'artifact', seed: '#' },
}

// Blank palette states: the open page is marked and never preselected.
export const BlankNoHistory: Story = {
  args: { context: 'artifact', history: 'none' },
}

export const BlankOnlyCurrent: Story = {
  args: { context: 'artifact', history: 'only-current' },
}

export const BlankWithCurrentPinned: Story = {
  args: { context: 'artifact', history: 'current-pinned' },
}

// Typed queries: documents lead; headings and commands appear only when no page matches.
export const TypedWithHeadingMatches: Story = {
  args: { context: 'artifact', seed: 'timeout', overlappingHeading: true },
}

export const TypedNoPageMatchFallback: Story = {
  args: { context: 'artifact', seed: 'root cause' },
}

export const Phone390Blank: Story = {
  args: { context: 'artifact' },
  parameters: { viewport: { options: { phone390 } } },
  globals: { viewport: { value: 'phone390', isRotated: false } },
}

export const Phone390LongTitle: Story = {
  args: { context: 'artifact', longTitles: true },
  parameters: { viewport: { options: { phone390 } } },
  globals: { viewport: { value: 'phone390', isRotated: false } },
}

// ISSUE-079: other pages' headings below the page matches, a Folders group, and `#` over all pages.
// The headings come from the fixture pages' tables of contents; the deep fixture repeats them across
// pages, so these stories also show duplicate headings told apart by their page and folder.
export const OtherPageHeadings: Story = {
  name: 'Headings in other pages',
  args: { context: 'artifact', seed: 'follow' },
}

export const OtherPageHeadingsBelowPages: Story = {
  name: 'Headings in other pages · below page matches',
  args: { context: 'artifact', seed: 'topology' },
}

export const FoldersGroup: Story = {
  name: 'Folders group',
  args: { context: 'artifact', seed: 'incidents' },
}

export const HeadingsAllPages: Story = {
  name: 'Headings (#) · all pages, open page first',
  args: { context: 'artifact', seed: '#follow' },
}

export const HeadingsAllPagesNoOpenPage: Story = {
  name: 'Headings (#) · site home',
  args: { context: 'site', seed: '#root cause' },
}

export const HeadingsAllPagesEmpty: Story = {
  name: 'Headings (#) · no match',
  args: { context: 'artifact', seed: '#zzzz' },
}

export const OtherPageHeadingsDark: Story = {
  name: 'Headings in other pages · dark',
  args: { context: 'artifact', seed: 'follow', theme: 'dark' },
}

export const FoldersGroupDark: Story = {
  name: 'Folders group · dark',
  args: { context: 'artifact', seed: 'incidents', theme: 'dark' },
}

export const OtherPageHeadingsPhone390: Story = {
  name: 'Headings in other pages · phone 390',
  args: { context: 'artifact', seed: 'follow' },
  parameters: { viewport: { options: { phone390 } } },
  globals: { viewport: { value: 'phone390', isRotated: false } },
}

export const FoldersGroupPhone390: Story = {
  name: 'Folders group · phone 390',
  args: { context: 'artifact', seed: 'incidents', longTitles: true },
  parameters: { viewport: { options: { phone390 } } },
  globals: { viewport: { value: 'phone390', isRotated: false } },
}


export const ModeDiscovery: Story = { args: { context: 'artifact', seed: '' } }
export const HeadingsWithoutCurrentPage: Story = { args: { context: 'site', seed: '#' } }
