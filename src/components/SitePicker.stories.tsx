import type { Meta, StoryObj } from '@storybook/react-vite'
import sreIndex from '../../fixtures/storage/_indexes/sre/index.json'
import frontendIndex from '../../fixtures/storage/_indexes/frontend/index.json'
import type { SiteDiscoveryMetadata, SiteIndex } from '../domain/index'
import { SitePicker } from './SitePicker'

const sites = [sreIndex, frontendIndex].map((value) => {
  const index = value as SiteIndex
  return {
    schemaVersion: index.schemaVersion,
    site: index.site,
    generatedAt: index.generatedAt,
    artifactCount: index.artifacts.length,
    artifactIndexUrl: `/_indexes/${index.site.id}/index.json`,
  }
}) as SiteDiscoveryMetadata[]

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
} satisfies Meta<typeof SitePicker>

export default meta
type Story = StoryObj<typeof meta>

export const AvailableSites: Story = {}

export const Empty: Story = {
  args: { sites: [] },
}
