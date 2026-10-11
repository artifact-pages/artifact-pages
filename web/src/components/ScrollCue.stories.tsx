import { useEffect } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { MarkdownArtifact } from './MarkdownArtifact'
import { storyIndexes } from '../stories/fixtures'

const markdown = `# Configuration

The registry file lists sites, folders and the environments they publish to.

| Key | Type | Default | Description | Since |
| --- | --- | --- | --- | --- |
| registry | path | .artifact-pages/registry.yaml | Where the registry file lives | 0.1 |
| sites[].id | string | required | Stable site id used in URLs | 0.1 |
| sites[].publish-on | list | [main] | Branches or events that publish | 0.1 |
| environments | map | {} | Named bucket and CDN targets | 0.1 |

Publish with the command below.

\`\`\`sh
artifact-pages publish --site guide --environment production --registry .artifact-pages/registry.yaml --fulltext
\`\`\`

\`\`\`sh
short
\`\`\`
`

const template = storyIndexes[0].artifacts.find((artifact) => artifact.format === 'markdown') ?? storyIndexes[0].artifacts[0]
const artifact = {
  ...template,
  id: 'scroll-cue.md',
  path: 'scroll-cue.md',
  title: 'Configuration',
  format: 'markdown' as const,
  artifactUrl: `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`,
}

function ScrollCueStory({ theme }: { theme: 'light' | 'dark' }) {
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  return (
    <div style={{ height: '100vh', overflow: 'auto', background: 'var(--surface)' }}>
      <MarkdownArtifact artifact={artifact} siteId="sre" hash="" navigate={() => undefined} />
    </div>
  )
}

const meta = {
  title: 'Product/Markdown scroll cues',
  args: { theme: 'light' as 'light' | 'dark' },
  argTypes: { theme: { control: 'radio', options: ['light', 'dark'] } },
  globals: { viewport: { value: 'mobile1' } },
  render: (args: { theme: 'light' | 'dark' }) => <ScrollCueStory {...args} />,
} satisfies Meta<{ theme: 'light' | 'dark' }>

export default meta
type Story = StoryObj<typeof meta>

/** A wide table and a long code block show a shadow on the side with more content; the short block shows none. */
export const Light: Story = {}
export const Dark: Story = { args: { theme: 'dark' } }
