import type { Meta, StoryObj } from '@storybook/react-vite'
import { Icon } from '../Icon'
import { ConceptShell, Variant, VariantGrid, Needs, SiteMark, conceptArgTypes, conceptDefaults, type ConceptArgs } from './parts'
import { architectureSite, guideSite, type SiteInfo } from './data'

function Search() {
  return <div className="lp-search"><Icon name="search" size={14} />Search sites…<kbd>⌘ K</kbd></div>
}

function FolderCounts({ site }: { site: SiteInfo }) {
  return (
    <div className="lp-folders" aria-label="Pages per folder">
      {site.folderCounts.map(([folder, count]) => <span className="lp-folder" key={folder}><b>{folder}</b> {count}</span>)}
    </div>
  )
}

function SiteCard({ site, start }: { site: SiteInfo; start?: boolean }) {
  return (
    <article className={`lp-card${start ? ' lp-card--start' : ''}`}>
      <div className="lp-card-head"><SiteMark title={site.title} /><span className="lp-card-title">{site.title}</span></div>
      <p className="lp-card-desc">{site.description}</p>
      <FolderCounts site={site} />
      <div className="lp-card-foot">
        <span>/{site.id}</span><span>·</span><span>updated {site.updated}</span>
        {start ? <a className="lp-start" href="#start" onClick={(e) => e.preventDefault()}>Start reading <Icon name="arrow" size={12} /></a> : null}
      </div>
    </article>
  )
}

function LandingA() {
  return (
    <div className="lp">
      <p className="lp-brand"><span className="lp-brand-mark">G</span>Git Artifact Pages</p>
      <h1>Choose a site</h1>
      <p className="lp-lede">Browse published artifacts from the sites available in this environment.</p>
      <Search />
      <div className="lp-cards">
        <SiteCard site={guideSite} start />
        <SiteCard site={architectureSite} />
      </div>
    </div>
  )
}

function LandingB() {
  return (
    <div className="lp">
      <p className="lp-brand"><span className="lp-brand-mark">G</span>Git Artifact Pages</p>
      <h1>Documentation published from Git</h1>
      <p className="lp-lede">
        Read the guide to publish your first artifact, or the architecture notes for how it works.{' '}
        <Needs>needs operator-provided text</Needs>
      </p>
      <Search />
      <div className="lp-rows">
        {[guideSite, architectureSite].map((site, i) => (
          <article className="lp-row" key={site.id}>
            <SiteMark title={site.title} />
            <div className="lp-row-main">
              <span className="lp-card-title" style={{ fontSize: 15 }}>{site.title}{i === 0 ? <> <Needs>start here: needs registry flag</Needs></> : null}</span>
              <span className="lp-card-desc">{site.description}</span>
              <span className="lp-row-meta">en {site.folderCounts[0][1]} · ja {site.folderCounts[1][1]} · updated {site.updated}</span>
            </div>
            <span className="lp-row-arrow"><Icon name="arrow" size={14} /></span>
          </article>
        ))}
      </div>
    </div>
  )
}

function LandingC() {
  const rows = [architectureSite, guideSite]
  return (
    <div className="lp">
      <p className="lp-brand"><span className="lp-brand-mark">G</span>Git Artifact Pages</p>
      <h1>Choose a site</h1>
      <p className="lp-lede">Browse published artifacts from the sites available in this environment.</p>
      <Search />
      <div className="lp-rows">
        {rows.map((site) => (
          <article className="lp-row" key={site.id}>
            <SiteMark title={site.title} />
            <div className="lp-row-main">
              <span className="lp-card-title" style={{ fontSize: 15 }}>{site.title}</span>
              <span className="lp-card-desc">{site.description}</span>
              <span className="lp-row-meta">/{site.id} · {site.folderCounts[0][1]} pages in en, ja · updated {site.updated}</span>
            </div>
            <span className="lp-row-arrow"><Icon name="arrow" size={14} /></span>
          </article>
        ))}
      </div>
    </div>
  )
}

function Concept({ theme, layout }: ConceptArgs) {
  return (
    <ConceptShell
      theme={theme}
      layout={layout}
      eyebrow="ISSUE-078 · Landing page"
      title="Orientation at the deployment root"
      intro={<>Counts come from paths only: the two top-level folders are shown as <code>en 7 · ja 7</code> instead of "14 artifacts". Site descriptions come from the registry. The language rule (parallel top-level folders) is a convention; this must be decided in the issue. Items marked <em>needs</em> depend on config or TD19 and are not available today.</>}
    >
      <VariantGrid wideColumns={1}>
        <Variant id="A" name="Cards with description, folder counts and Start reading" caption="Best first impression and a clear start point; needs an explicit site order and a start flag in the registry, otherwise cards fall back to alphabetical.">
          <LandingA />
        </Variant>
        <Variant id="B" name="Short product intro above the same information" caption="Answers what this deployment is; needs operator-provided intro text (or a generic default) and takes vertical space before the first site.">
          <LandingB />
        </Variant>
        <Variant id="C" name="Minimal: current layout, fixed counts only" caption="Smallest change and no new config; fixes the double counting but still lists Architecture before Guide and gives no start point.">
          <LandingC />
        </Variant>
      </VariantGrid>
    </ConceptShell>
  )
}

const meta = {
  title: 'Concepts/Reader UX 2026-10/ISSUE-078 Landing page',
  args: conceptDefaults,
  argTypes: conceptArgTypes,
  parameters: { layout: 'fullscreen' },
  render: (args: ConceptArgs) => <Concept {...args} />,
} satisfies Meta<ConceptArgs>

export default meta
type Story = StoryObj<typeof meta>

export const Light: Story = {}
export const Dark: Story = { args: { theme: 'dark' } }
export const Narrow390: Story = { args: { layout: 'narrow' } }
export const Narrow390Dark: Story = { args: { layout: 'narrow', theme: 'dark' } }
