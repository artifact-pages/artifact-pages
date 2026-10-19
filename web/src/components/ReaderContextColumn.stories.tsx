import type { Meta, StoryObj } from '@storybook/react-vite'
import { ArtifactDetails } from './ReaderContextColumn'
import type { ArtifactIndexEntry } from '../domain/index'

const base: ArtifactIndexEntry = {
  id: 'runbooks/recovery.md',
  path: 'runbooks/recovery.md',
  title: 'Service recovery',
  format: 'markdown',
  artifactUrl: '/_artifacts/sre/runbooks/recovery.md',
  updatedAt: '2026-09-22T10:00:00Z',
  source: { repository: 'example/payments', ref: 'main', repositoryUrl: 'https://github.com/example/payments', filePath: 'runbooks/recovery.md' },
}

const sha = '1'.repeat(40)

const meta = {
  title: 'Reader/Details byline',
  component: ArtifactDetails,
  decorators: [(Story) => <div style={{ width: 280, border: '1px solid var(--line-soft)' }}><Story /></div>],
} satisfies Meta<typeof ArtifactDetails>

export default meta
type Story = StoryObj<typeof meta>

/** The author's GitHub avatar (ISSUE-117); needs network access to avatars.githubusercontent.com. */
export const Avatar: Story = {
  args: {
    artifact: { ...base, lastAuthor: { name: 'Octocat', commitSha: sha, github: { login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4' } }, lastCommitter: { name: 'GitHub' } },
  },
}

/** A valid avatar URL that does not load falls back to the initial; name and date are unchanged. */
export const AvatarLoadFailure: Story = {
  args: {
    artifact: { ...base, lastAuthor: { name: 'Grace Reviewer', commitSha: sha, github: { login: 'grace', avatarUrl: 'https://avatars.githubusercontent.com/u/0?missing=1' } } },
  },
  parameters: { docs: { description: { story: 'Load failure depends on the network; offline this matches the Avatar story.' } } },
}

export const AuthorNameOnly: Story = {
  args: { artifact: { ...base, lastAuthor: { name: 'Frontend Team', commitSha: sha }, lastCommitter: { name: 'GitHub' } } },
}

export const LegacyCommitter: Story = {
  args: { artifact: { ...base, lastCommitter: { name: 'Maya Chen' } } },
}

export const NoIdentity: Story = {
  args: { artifact: base },
}
