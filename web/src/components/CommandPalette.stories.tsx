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

type PaletteStoryArgs = { seed: string; context: PaletteContext }

function PaletteStory({ seed, context }: PaletteStoryArgs) {
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
      currentArtifact={currentArtifact}
      recentReads={recentReads}
      pinnedArtifactIds={pinnedArtifactIds}
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

export const RecentAndCommands: Story = {}

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
