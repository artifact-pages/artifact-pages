import type { Meta, StoryObj } from '@storybook/react-vite'
import { ReadNext } from './ReadNext'
import type { ArtifactIndexEntry } from '../domain/index'
import { relatedPages } from '../domain/related-pages'

const entry = (path: string, title: string, headings: string[] = []): ArtifactIndexEntry => ({
  id: path,
  path,
  title,
  format: 'markdown',
  artifactUrl: `/${path}`,
  updatedAt: '2026-10-10T00:00:00Z',
  toc: headings.map((text, i) => ({ level: 2, text, id: `h${i}` })),
})

const entries = [
  entry('guide/publishing.md', 'Publishing', ['Publish on push', 'Rolling back']),
  entry('guide/previews.md', 'Pull request previews', ['Publish on push']),
  entry('guide/rollback.md', 'Rolling back a publish', ['Rolling back']),
  entry('reference/publish.md', 'Publish command reference', ['Publish on push']),
  entry('guide/install.md', 'Install the CLI'),
]

const meta = {
  title: 'Reader/Read next',
  component: ReadNext,
  args: {
    items: relatedPages(entries, 'guide/publishing.md'),
    siteId: 'guide',
    navigate: () => {},
  },
  decorators: [(Story) => <div style={{ maxWidth: 720, padding: 24 }}><Story /></div>],
} satisfies Meta<typeof ReadNext>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Empty: Story = { args: { items: [] } }
