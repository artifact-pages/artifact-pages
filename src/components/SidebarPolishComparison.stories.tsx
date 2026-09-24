import { useCallback, useMemo, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import showcaseIndexData from '../../fixtures/storage/_indexes/showcase/index.json'
import type { ArtifactIndexEntry, SiteIndex, SiteSummary } from '../domain/index'
import { ArtifactTree } from './ArtifactTree'
import { Icon } from './Icon'
import './sidebar-polish-comparison.css'

const sourceIndex = showcaseIndexData as SiteIndex
const selectedPath = 'architecture/platform-topology/index.html'
function mockArtifact(path: string, title: string, format: ArtifactIndexEntry['format'], updatedAt: string) {
  return {
    ...sourceIndex.artifacts[0],
    id: path,
    path,
    filename: path.split('/').at(-1),
    title,
    format,
    artifactUrl: `/_artifacts/showcase/${path}`,
    updatedAt,
  }
}

const index: SiteIndex = {
  ...sourceIndex,
  artifacts: [
    mockArtifact('architecture/platform-topology/index.html', 'Platform topology', 'html', '2026-09-19T13:20:00Z'),
    mockArtifact('architecture/platform-topology/decision-record.md', 'Decision record', 'markdown', '2026-09-21T11:45:00Z'),
    mockArtifact('reports/cloud-spend-review/index.html', 'Cloud spend review · Q3', 'html', '2026-09-23T08:30:00Z'),
    mockArtifact('reports/cloud-spend-review/review-notes.md', 'Review notes', 'markdown', '2026-09-22T16:10:00Z'),
    mockArtifact('editorial/field-notes/index.html', 'Designing for resilience', 'html', '2026-09-20T13:20:00Z'),
  ],
}
const sites: SiteSummary[] = [
  { id: 'sre', title: 'SRE' },
  { id: 'frontend', title: 'Frontend' },
  index.site,
]
const initialExpandedPaths = [
  'editorial',
  'editorial/field-notes',
  'architecture',
  'architecture/platform-topology',
  'reports',
  'reports/cloud-spend-review',
]

type PreviewProps = {
  variant: 'before' | 'after'
  showHoverPreview: boolean
}

function SidebarPreview({ variant, showHoverPreview }: PreviewProps) {
  const [activePath, setActivePath] = useState(selectedPath)
  const [expandedPaths, setExpandedPaths] = useState(() => new Set(initialExpandedPaths))
  const updateExpandedPaths = useCallback((update: (current: Set<string>) => Set<string>) => {
    setExpandedPaths(update)
  }, [])
  const openArtifact = useCallback((artifact: ArtifactIndexEntry) => {
    setActivePath(artifact.path)
  }, [])
  const recent = useMemo(
    () => [...index.artifacts]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 4),
    [],
  )

  return (
    <aside
      className={`sidebar-panel tree-style-branch-guides${variant === 'after' ? ' sidebar-panel--refined' : ''} sidebar-polish-${variant}${showHoverPreview && variant === 'after' ? ' has-hover-preview' : ''}`}
      aria-label={`${variant === 'before' ? 'Current' : 'Refined'} sidebar preview`}
    >
      <div className="sidebar-top">
        <div className="sidebar-top-row">
          <button className="site-switcher" type="button" aria-label="HTML Showcase site selector">
            <span className="site-mark site-mark-small" aria-hidden="true">H</span>
            <span className="site-switcher-name">HTML Showcase</span>
            <span className="site-switcher-hint">3</span>
            <Icon name="chevron" size={12} />
          </button>
          <button className="icon-button sidebar-collapse-trigger" type="button" aria-label="Collapse sidebar">
            <Icon name="sidebar" size={16} />
          </button>
        </div>
        <div className="sidebar-filter">
          <Icon name="search" size={14} />
          <input aria-label="Filter this site" placeholder="Filter this site" readOnly />
          <button className="sidebar-palette-trigger" type="button" aria-label="Open command palette">
            <kbd>⌘ K</kbd>
          </button>
        </div>
      </div>

      <nav className="sidebar-body" aria-label="Artifacts">
        <div className="sidebar-section">
          <div className="sidebar-section-title">
            <span className="sidebar-section-label"><Icon name="clock" size={12} />Recently updated</span>
            <span className="mono">{recent.length}</span>
          </div>
          <ArtifactTree
            artifacts={recent}
            activePath={activePath}
            style="branch-guides"
            view="recent"
            onOpenArtifact={openArtifact}
          />
        </div>

        <div className="sidebar-section browse-tree">
          <div className="sidebar-section-title">
            <span className="sidebar-section-label"><Icon name="tree" size={12} />Browse</span>
          </div>
          <ArtifactTree
            artifacts={index.artifacts}
            activePath={activePath}
            style="branch-guides"
            view="tree"
            expandedPaths={expandedPaths}
            onExpandedPathsChange={updateExpandedPaths}
            onOpenArtifact={openArtifact}
          />
        </div>
      </nav>

      <footer className="sidebar-footer">
        <span className="index-date">Index updated <time dateTime={index.generatedAt}>Sep 23</time></span>
        <button className="icon-button theme-toggle" type="button" aria-label="Color theme: Light">
          <Icon name="sun" size={15} />
        </button>
      </footer>
    </aside>
  )
}

function Comparison() {
  const [showHoverPreview, setShowHoverPreview] = useState(true)

  return (
    <main className="sidebar-polish-review">
      <header className="sidebar-polish-review-header">
        <div>
          <p className="sidebar-polish-eyebrow">DESIGN REVIEW</p>
          <h1>Sidebar polish</h1>
          <p className="sidebar-polish-description">
            Same structure and content. The candidate gives recent items, hierarchy, and the open artifact
            slightly clearer visual roles.
          </p>
        </div>
        <button
          className={`sidebar-polish-hover-toggle${showHoverPreview ? ' is-on' : ''}`}
          type="button"
          aria-pressed={showHoverPreview}
          onClick={() => setShowHoverPreview((current) => !current)}
        >
          <span className="sidebar-polish-toggle-dot" aria-hidden="true" />
          {showHoverPreview ? 'Hide hover preview' : 'Show hover preview'}
        </button>
      </header>

      <div className="sidebar-polish-comparison">
        <section className="sidebar-polish-column" aria-labelledby="sidebar-before-title">
          <div className="sidebar-polish-column-heading">
            <div>
              <h2 id="sidebar-before-title">Before</h2>
              <p>Current sidebar</p>
            </div>
            <span>BASELINE</span>
          </div>
          <div className="sidebar-polish-surface">
            <SidebarPreview variant="before" showHoverPreview={showHoverPreview} />
          </div>
        </section>

        <section className="sidebar-polish-column" aria-labelledby="sidebar-after-title">
          <div className="sidebar-polish-column-heading">
            <div>
              <h2 id="sidebar-after-title">After</h2>
              <p>Quiet document navigation</p>
            </div>
            <span>CANDIDATE</span>
          </div>
          <div className="sidebar-polish-surface">
            <SidebarPreview variant="after" showHoverPreview={showHoverPreview} />
          </div>
        </section>
      </div>

      <p className="sidebar-polish-review-hint">
        Hover any row to compare naturally, click an artifact to move the selected state, or toggle a pinned hover sample.
      </p>
    </main>
  )
}

const meta = {
  title: 'Design Review/Sidebar',
  parameters: {
    controls: { disable: true },
  },
  render: () => <Comparison />,
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const BeforeAfter: Story = {
  name: 'Before / after',
}
