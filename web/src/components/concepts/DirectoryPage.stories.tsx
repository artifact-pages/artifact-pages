import type { Meta, StoryObj } from '@storybook/react-vite'
import { Icon } from '../Icon'
import { ConceptShell, Variant, VariantGrid, Needs, Note, conceptArgTypes, conceptDefaults, useConceptLayout, type ConceptArgs } from './parts'
import { MockContextBar, MockSidebar, ReaderFrame, type Crumb } from './chrome'
import {
  buildTree, countPages, findDir, guideEn, guideJa, guideReference, latestUpdate, sortByTitle,
  type DirNode,
} from './data'

const root = buildTree([...guideEn, ...guideReference, ...guideJa])

type ListVariantProps = { dir: DirNode; withDescription?: boolean }

function Chips({ headings, max = 3 }: { headings: string[]; max?: number }) {
  return (
    <span className="dp-chips">
      {headings.slice(0, max).map((h) => <span className="dp-chip" key={h}>{h}</span>)}
      {headings.length > max ? <span className="dp-chip dp-chip--more">+{headings.length - max}</span> : null}
    </span>
  )
}

function pluralPages(n: number) {
  return `${n} ${n === 1 ? 'page' : 'pages'}`
}

function DirHeader({ dir, withDescription }: { dir: DirNode; withDescription?: boolean }) {
  return (
    <>
      <p className="dp-eyebrow">Folder · {dir.path}/</p>
      <h1>{dir.name}</h1>
      <p className="dp-sub">{pluralPages(countPages(dir))} · updated {latestUpdate(dir)}</p>
      {withDescription ? <p className="dp-desc-slot"><span>Reader-facing guides in English.</span><Needs>needs TD19</Needs></p> : null}
    </>
  )
}

function ListVariant({ dir, withDescription }: ListVariantProps) {
  return (
    <div className="dp">
      <DirHeader dir={dir} withDescription={withDescription} />
      {dir.dirs.length > 0 ? <p className="dp-group-label">Folders</p> : null}
      <ul className="dp-list">
        {dir.dirs.map((d) => (
          <li key={d.path}>
            <a className="dp-row" href="#folder" onClick={(e) => e.preventDefault()}>
              <span className="dp-row-icon"><Icon name="folder" size={16} /></span>
              <span className="dp-row-main"><span className="dp-row-title">{d.name}</span></span>
              <span className="dp-row-meta">{pluralPages(countPages(d))} · {latestUpdate(d)}</span>
            </a>
          </li>
        ))}
      </ul>
      {dir.pages.length > 0 ? <p className="dp-group-label">Pages</p> : null}
      <ul className="dp-list">
        {sortByTitle(dir.pages).map((p) => (
          <li key={p.path}>
            <a className="dp-row" href="#page" onClick={(e) => e.preventDefault()}>
              <span className="dp-row-icon"><Icon name="file" size={16} /></span>
              <span className="dp-row-main">
                <span className="dp-row-title">{p.title}</span>
                {withDescription ? <span className="dp-desc">Short description from the front matter. <Needs>needs TD19</Needs></span> : null}
                <Chips headings={p.h2} />
              </span>
              <span className="dp-row-meta">{p.updated} · {p.by}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

function CardsVariant({ dir, withDescription }: ListVariantProps) {
  return (
    <div className="dp">
      <DirHeader dir={dir} withDescription={withDescription} />
      <div className="dp-cards" style={{ marginTop: 16 }}>
        {dir.dirs.map((d) => (
          <a key={d.path} className="dp-card dp-card--folder" href="#folder" onClick={(e) => e.preventDefault()}>
            <span className="dp-card-head"><Icon name="folder" size={15} /></span>
            <span className="dp-card-title">{d.name}</span>
            <span className="dp-card-foot">{pluralPages(countPages(d))} · {latestUpdate(d)}</span>
          </a>
        ))}
        {sortByTitle(dir.pages).map((p) => (
          <a key={p.path} className="dp-card" href="#page" onClick={(e) => e.preventDefault()}>
            <span className="dp-card-head"><Icon name="file" size={15} /></span>
            <span className="dp-card-title">{p.title}</span>
            {withDescription ? <span className="dp-desc">Short description from the front matter. <Needs>needs TD19</Needs></span> : null}
            <ul className="dp-card-heads">{p.h2.slice(0, 2).map((h) => <li key={h}>{h}</li>)}</ul>
            <span className="dp-card-foot">{p.updated} · {p.by}</span>
          </a>
        ))}
      </div>
    </div>
  )
}

function ReadmeVariant({ dir }: ListVariantProps) {
  const pages = sortByTitle(dir.pages)
  return (
    <div className="dp">
      <p className="dp-eyebrow">Folder · {dir.path}/ · rendered from <code>{dir.path}/README.md</code></p>
      <div className="dp-readme">
        <h1 style={{ margin: '0 0 10px', fontSize: 26, letterSpacing: '-.03em' }}>Guide (English)</h1>
        <p>Everything you need to publish, preview and read artifacts. New here? Start with Getting started, then skim Publishing.</p>
        <h2>Where to start</h2>
        <ul>
          <li><strong>Getting started</strong> sets up Cloudflare or AWS.</li>
          <li><strong>Publishing</strong> explains publish-on rules.</li>
        </ul>
      </div>
      <div className="dp-children">
        <h2>In this folder · {pluralPages(countPages(dir))}</h2>
        <ul className="dp-compact">
          {dir.dirs.map((d) => (
            <li key={d.path}><a href="#folder" onClick={(e) => e.preventDefault()}><Icon name="folder" size={14} />{d.name}/<span className="dp-row-meta">{pluralPages(countPages(d))}</span></a></li>
          ))}
          {pages.map((p) => (
            <li key={p.path}><a href="#page" onClick={(e) => e.preventDefault()}><Icon name="file" size={14} />{p.title}<span className="dp-row-meta">{p.updated}</span></a></li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function crumbsFor(dir: DirNode): Crumb[] {
  return [{ label: 'Guide' }, ...dir.path.split('/').map((label) => ({ label }))]
}

function expandedFor(dir: DirNode) {
  const segments = dir.path.split('/')
  return segments.map((_, i) => segments.slice(0, i + 1).join('/'))
}

function Frame({ dir, kind, withDescription }: { dir: DirNode; kind: 'list' | 'cards' | 'readme'; withDescription?: boolean }) {
  const layout = useConceptLayout()
  const body = kind === 'list' ? <ListVariant dir={dir} withDescription={withDescription} />
    : kind === 'cards' ? <CardsVariant dir={dir} withDescription={withDescription} />
      : <ReadmeVariant dir={dir} />
  return (
    <ReaderFrame
      sidebar={layout === 'wide' ? <MockSidebar siteTitle="Guide" root={root} activeDir={dir.path} expanded={expandedFor(dir)} /> : undefined}
      bar={<MockContextBar crumbs={crumbsFor(dir)} />}
    >
      {body}
    </ReaderFrame>
  )
}

function Concept({ theme, layout, withDescription }: ConceptArgs & { withDescription: boolean }) {
  const en = findDir(root, 'en')
  return (
    <ConceptShell
      theme={theme}
      layout={layout}
      eyebrow="ISSUE-075 · Directory routes"
      title="Directory page for /guide/en"
      intro="Every folder becomes a page. The sidebar folder label links to it and only the chevron toggles; breadcrumb folders are links (the sibling menu stays on the small chevron). Order is alphabetical by title until ISSUE-076 / TD19 define an explicit order. The en/reference folder is illustrative (not on the live site) so the folder-first rows can be seen."
    >
      <VariantGrid wideColumns={1}>
        <Variant id="A" name="List rows (GitHub / Outline)" caption="Densest and most scannable, with the H2 chips acting as a table of contents; costs vertical space for long folders.">
          <Frame dir={en} kind="list" withDescription={withDescription} />
          <p className="rux-annot">Sidebar: the active directory row is highlighted; clicking the label opens this page, the chevron only expands. Counts are page totals including nested folders.</p>
        </Variant>
        <Variant id="B" name="Cards (Docusaurus generated index)" caption="Friendly and visual for small folders, but shows only two headings per card and wastes width on long titles.">
          <Frame dir={en} kind="cards" withDescription={withDescription} />
        </Variant>
        <Variant id="C" name="README / index.md body first" caption="Best orientation when a team writes an index, but needs convention (README.md or index.md) and falls back to A or B otherwise.">
          <Frame dir={en} kind="readme" />
          <Note>Open question shown here: README.md itself is not repeated in the child list.</Note>
        </Variant>
      </VariantGrid>
    </ConceptShell>
  )
}

function EdgeCases({ theme, layout }: ConceptArgs) {
  const reference = findDir(root, 'en/reference')
  const cli = findDir(root, 'en/reference/cli')
  const config = findDir(root, 'en/reference/config')
  return (
    <ConceptShell
      theme={theme}
      layout={layout}
      eyebrow="ISSUE-075 · Edge cases"
      title="One-page folder, deep folder, and a folder of folders"
      intro="A folder with a single page (config) and a three-level path (Guide / en / reference / cli). Compare how A and B behave when there is little to list, and how breadcrumbs shrink at depth. Order is alphabetical until TD19."
    >
      <VariantGrid wideColumns={1}>
        <Variant id="A" name="One-page folder (en/reference/config), list" caption="A single row looks sparse; the product may redirect to the page or keep the folder page for a stable URL (decision needed).">
          <Frame dir={config} kind="list" />
        </Variant>
        <Variant id="B" name="One-page folder (en/reference/config), cards" caption="One lonely card is the weakest case for cards; the list degrades more gracefully.">
          <Frame dir={config} kind="cards" />
        </Variant>
        <Variant id="A" name="Deep folder (en/reference/cli), list" caption="Breadcrumb has four segments; every folder segment links to its own page.">
          <Frame dir={cli} kind="list" />
        </Variant>
        <Variant id="A" name="Folder of folders (en/reference), list" caption="Only subfolders: counts and last update stand in for headings.">
          <Frame dir={reference} kind="list" />
        </Variant>
      </VariantGrid>
    </ConceptShell>
  )
}

function PaletteSections({ theme, layout }: ConceptArgs) {
  return (
    <ConceptShell
      theme={theme}
      layout={layout}
      eyebrow="ISSUE-075 · Command palette"
      title="Directories as palette results"
      intro="A Sections group with counts appears next to Pages. Selecting a section opens its directory page."
    >
      <VariantGrid wideColumns={1}>
        <Variant id="A" name="Sections group" caption="Folders match by name and show the page count; they rank below page title matches.">
          <div className="rux-palette-static">
            <section className="command-palette rux-palette-card" aria-label="Command palette">
              <div className="palette-input-row">
                <Icon name="search" size={16} />
                <input readOnly value="ref" aria-label="Palette query" />
                <kbd>esc</kbd>
              </div>
              <div className="palette-results" role="listbox">
                <div className="palette-section">
                  <div className="palette-section-title">Sections</div>
                  <button type="button" className="palette-entry is-selected" role="option" aria-selected="true">
                    <span className="palette-entry-icon"><Icon name="folder" size={14} /></span>
                    <span className="palette-entry-title">reference</span>
                    <span className="palette-entry-subtitle">en · 4 pages</span>
                    <kbd className="palette-entry-enter">↵</kbd>
                  </button>
                  <button type="button" className="palette-entry" role="option" aria-selected="false">
                    <span className="palette-entry-icon"><Icon name="folder" size={14} /></span>
                    <span className="palette-entry-title">reference/cli</span>
                    <span className="palette-entry-subtitle">en · 3 pages</span>
                  </button>
                </div>
                <div className="palette-section">
                  <div className="palette-section-title">Pages</div>
                  <button type="button" className="palette-entry" role="option" aria-selected="false">
                    <span className="palette-entry-icon"><Icon name="file" size={14} /></span>
                    <span className="palette-entry-title">Configuration schema</span>
                    <span className="palette-entry-subtitle">en/reference/config</span>
                  </button>
                </div>
              </div>
            </section>
          </div>
        </Variant>
      </VariantGrid>
    </ConceptShell>
  )
}

const meta = {
  title: 'Concepts/Reader UX 2026-10/ISSUE-075 Directory page',
  args: { ...conceptDefaults, withDescription: false },
  argTypes: { ...conceptArgTypes, withDescription: { control: 'boolean', description: 'Show per-child descriptions (needs TD19)' } },
  parameters: { layout: 'fullscreen' },
  render: (args: ConceptArgs & { withDescription: boolean }) => <Concept {...args} />,
} satisfies Meta<ConceptArgs & { withDescription: boolean }>

export default meta
type Story = StoryObj<typeof meta>

export const Light: Story = {}
export const Dark: Story = { args: { theme: 'dark' } }
export const Narrow390: Story = { args: { layout: 'narrow' } }
export const Narrow390Dark: Story = { args: { layout: 'narrow', theme: 'dark' } }
export const WithDescriptionNeedsTD19: Story = { args: { withDescription: true } }

const edgeRender = (args: ConceptArgs & { withDescription: boolean }) => <EdgeCases theme={args.theme} layout={args.layout} />
export const EdgeCasesLight: Story = { render: edgeRender }
export const EdgeCasesDark: Story = { args: { theme: 'dark' }, render: edgeRender }
export const EdgeCasesNarrow390: Story = { args: { layout: 'narrow' }, render: edgeRender }

const paletteRender = (args: ConceptArgs & { withDescription: boolean }) => <PaletteSections theme={args.theme} layout={args.layout} />
export const PaletteSectionsLight: Story = { render: paletteRender }
export const PaletteSectionsDark: Story = { args: { theme: 'dark' }, render: paletteRender }
