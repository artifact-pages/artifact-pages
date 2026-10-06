import { useState } from 'react'
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

type PaletteHistory = 'default' | 'none' | 'only-current' | 'current-pinned'
type PaletteStoryArgs = { seed: string; context: PaletteContext; history?: PaletteHistory; overlappingHeading?: boolean }

function historyFor(history: PaletteHistory) {
  if (history === 'none') return { reads: [], pinned: [] as string[] }
  if (history === 'only-current') return { reads: [{ artifactId: currentArtifact.id, viewedAt: now }], pinned: [] as string[] }
  if (history === 'current-pinned') return { reads: recentReads, pinned: [currentArtifact.id] }
  return { reads: [{ artifactId: currentArtifact.id, viewedAt: now }, ...recentReads], pinned: pinnedArtifactIds }
}

const phone390 = { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' as const }

function PaletteStory({ seed, context, history = 'default', overlappingHeading = false }: PaletteStoryArgs) {
  const { reads, pinned } = historyFor(history)
  const openArtifact = overlappingHeading ? currentWithOverlappingHeading : currentArtifact
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
      currentIndex={currentIndex}
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
