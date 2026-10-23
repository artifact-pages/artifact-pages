import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import showcaseIndexData from '../../../fixtures/storage/_indexes/showcase/index.json'
import type { ArtifactIndexEntry, SiteIndex } from '../domain/index'
import { ArtifactTree } from './ArtifactTree'
import './tree-connectors-comparison.css'

const sourceIndex = showcaseIndexData as SiteIndex

function page(path: string, title: string): ArtifactIndexEntry {
  return {
    ...sourceIndex.artifacts[0],
    id: path,
    path,
    filename: path.split('/').at(-1),
    title,
    format: 'markdown',
    artifactUrl: `/_artifacts/showcase/${path}`,
  }
}

const artifacts: ArtifactIndexEntry[] = [
  page('overview.md', 'Overview'),
  page('guides/getting-started.md', 'Getting started'),
  page('guides/publishing.md', 'Publishing'),
  page('guides/previews.md', 'Previews'),
  page('guides/troubleshooting.md', 'Troubleshooting'),
  page('runbooks/incidents/triage.md', 'Triage'),
  page('runbooks/incidents/escalation.md', 'Escalation'),
  page('runbooks/incidents/postmortems/2026-09.md', 'September review'),
  page('runbooks/incidents/postmortems/2026-10.md', 'October review'),
  page('runbooks/on-call.md', 'On-call rotation'),
  page('runbooks/deploys.md', 'Deploys'),
  page('runbooks/rollbacks.md', 'Rollbacks'),
  page('runbooks/capacity.md', 'Capacity'),
  page('runbooks/contacts.md', 'Contacts'),
]
const expanded = ['guides', 'runbooks', 'runbooks/incidents', 'runbooks/incidents/postmortems']

function Tree({ linked }: { linked: boolean }) {
  const [expandedPaths, setExpandedPaths] = useState(() => new Set(expanded))
  return (
    <div className="sidebar-section browse-tree">
      <ArtifactTree
        artifacts={artifacts}
        activePath="runbooks/incidents/triage.md"
        style="branch-guides"
        view="tree"
        expandedPaths={expandedPaths}
        onExpandedPathsChange={setExpandedPaths}
        onOpenArtifact={() => undefined}
        artifactHref={(artifact) => `/showcase/${artifact.path}`}
        directoryHref={linked ? (directory) => `/showcase/${directory.path}/` : undefined}
      />
    </div>
  )
}

function Column({ variant, title }: { variant: 'before' | 'after', title: string }) {
  return (
    <section className="tree-connectors-column">
      <h2>{title}</h2>
      <div className="tree-connectors-sidebar">
        <aside className={`sidebar-panel tree-style-branch-guides tree-connectors-${variant}`}>
          <h3>Linked folders</h3>
          <Tree linked />
          <h3>Label-only folders</h3>
          <Tree linked={false} />
        </aside>
      </div>
    </section>
  )
}

function Comparison({ theme }: { theme: 'light' | 'dark' }) {
  useEffect(() => {
    const previous = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = theme
    return () => {
      if (previous === undefined) delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = previous
    }
  }, [theme])
  return (
    <main className="tree-connectors-review">
      <h1>Browse tree connectors (ISSUE-120)</h1>
      <p>Branch-guides style, 280px sidebar. Connectors should start at the vertical guide and run toward the row.</p>
      <div className="tree-connectors-columns">
        <Column variant="before" title="Before (0.4.3)" />
        <Column variant="after" title="After" />
      </div>
    </main>
  )
}

const meta = {
  title: 'Design Review/Tree connectors',
  parameters: { controls: { disable: true } },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Light: Story = { render: () => <Comparison theme="light" /> }
export const Dark: Story = { render: () => <Comparison theme="dark" /> }
