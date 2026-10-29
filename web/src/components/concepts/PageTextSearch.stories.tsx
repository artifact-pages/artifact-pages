import type { Meta, StoryObj } from '@storybook/react-vite'
import { Icon } from '../Icon'
import { ConceptShell, Variant, VariantGrid, Note, conceptArgTypes, conceptDefaults, type ConceptArgs } from './parts'
import { MockSidebar } from './chrome'
import { buildTree, guideEn, guideJa } from './data'

type Tier = 'title' | 'heading' | 'text'
type Hit = { path: string; title: string; tier: Tier; heading?: string }
type QueryName = 'cloudflare' | 'preview'

const hitsByQuery: Record<QueryName, Hit[]> = {
  cloudflare: [
    { path: 'en/configuration.html', title: 'Configuration', tier: 'heading', heading: 'Cloudflare R2 settings' },
    { path: 'en/getting-started.html', title: 'Getting started', tier: 'heading', heading: 'Start with Cloudflare' },
    { path: 'en/previews.html', title: 'Previews', tier: 'text' },
    { path: 'en/publishing.html', title: 'Publishing', tier: 'text' },
    { path: 'en/what-is-git-artifact-pages.html', title: 'What is Artifact Pages', tier: 'text' },
    { path: 'ja/configuration.html', title: '設定', tier: 'heading', heading: 'Cloudflare R2 の設定' },
    { path: 'ja/getting-started.html', title: 'はじめに', tier: 'heading', heading: 'Cloudflare で始める' },
    { path: 'ja/previews.html', title: 'プレビュー', tier: 'text' },
    { path: 'ja/publishing.html', title: '公開', tier: 'text' },
    { path: 'ja/what-is-git-artifact-pages.html', title: 'Artifact Pages とは', tier: 'text' },
  ],
  preview: [
    { path: 'en/configuration.html', title: 'Configuration', tier: 'text' },
    { path: 'en/getting-started.html', title: 'Getting started', tier: 'text' },
    { path: 'en/previews.html', title: 'Previews', tier: 'title' },
    { path: 'en/publishing.html', title: 'Publishing', tier: 'heading', heading: 'Previews for pull requests' },
    { path: 'ja/configuration.html', title: '設定', tier: 'text' },
    { path: 'ja/getting-started.html', title: 'はじめに', tier: 'text' },
    { path: 'ja/previews.html', title: 'プレビュー', tier: 'text' },
    { path: 'ja/publishing.html', title: '公開', tier: 'text' },
  ],
}

const tierLabel: Record<Tier, string> = { title: 'In titles', heading: 'In headings', text: 'In text' }
const tierOrder: Tier[] = ['title', 'heading', 'text']
const root = buildTree([...guideEn, ...guideJa])

type SearchArgs = ConceptArgs & { query: QueryName; scoped: boolean }

function folderOf(path: string) {
  return path.split('/')[0]
}

function scopeFilter(hits: Hit[], scoped: boolean) {
  return scoped ? hits.filter((h) => folderOf(h.path) === 'en') : hits
}

function Header({ query, shown, total, scoped }: { query: string; shown: number; total: number; scoped?: boolean }) {
  return (
    <div className="sidebar-section-title page-text-results-title">
      <span className="sidebar-section-label"><Icon name="search" size={12} />{shown} {shown === 1 ? 'page' : 'pages'}{scoped ? ' in en/' : ''} contain "{query}"</span>
      <span className="mono">1 / {total}</span>
    </div>
  )
}

function ScopeChip({ scoped }: { scoped: boolean }) {
  return (
    <div className="sr-scope-row">
      {scoped ? (
        <span className="sr-chip">Only en/ <button type="button" className="icon-button" style={{ width: 20, height: 20 }} aria-label="Search all folders"><Icon name="close" size={11} /></button></span>
      ) : (
        <span className="sr-chip sr-chip--offer">Search only in en/</span>
      )}
      <span className="sr-scope-hint">scope follows the open page</span>
    </div>
  )
}

function Row({ hit, reason, showPath }: { hit: Hit; reason?: React.ReactNode; showPath?: boolean }) {
  return (
    <a href="#hit" className="page-text-result" onClick={(e) => e.preventDefault()}>
      <span className="sr-title-line">
        <span className="page-text-result-title">{hit.title}</span>
        {showPath ? <span className="sr-flat-path">{hit.path.replace('.html', '')}</span> : null}
      </span>
      {reason ? <span className="sr-reason">{reason}</span> : <span className="page-text-result-path">{hit.path.split('/').pop()}</span>}
    </a>
  )
}

function reasonFor(hit: Hit) {
  if (hit.tier === 'title') return <b>Title</b>
  if (hit.tier === 'heading') return <><b>Heading:</b> <span className="sr-hit">{hit.heading}</span></>
  return <b>Text</b>
}

function Frame({ query, children, scoped, chip }: { query: string; children: React.ReactNode; scoped?: boolean; chip?: boolean }) {
  return (
    <div className="sr-frame">
      <MockSidebar
        siteTitle="Guide"
        root={root}
        expanded={[]}
        query={query}
        scopeChip={chip ? <ScopeChip scoped={Boolean(scoped)} /> : undefined}
      >
        {children}
      </MockSidebar>
    </div>
  )
}

function VariantA({ query, hits }: { query: string; hits: Hit[] }) {
  const folders = ['en', 'ja']
  return (
    <Frame query={query}>
      <div className="sidebar-section page-text-results">
        <Header query={query} shown={hits.length} total={hits.length} />
        <div className="page-text-result-list">
          {folders.map((folder) => {
            const group = hits.filter((h) => folderOf(h.path) === folder)
            return (
              <div className="page-text-result-group" key={folder}>
                <button type="button" className="page-text-result-folder" aria-expanded="true">
                  <Icon name="chevron" size={11} />
                  <span className="page-text-result-folder-name">{folder}/</span>
                  <span className="page-text-result-folder-count">{group.length}</span>
                </button>
                {group.map((h) => <Row key={h.path} hit={h} />)}
              </div>
            )
          })}
        </div>
      </div>
    </Frame>
  )
}

function VariantB({ query, hits, scoped }: { query: string; hits: Hit[]; scoped: boolean }) {
  const ranked = [...scopeFilter(hits, scoped)].sort((a, b) => tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier) || a.path.localeCompare(b.path))
  return (
    <Frame query={query} scoped={scoped} chip>
      <div className="sidebar-section page-text-results">
        <Header query={query} shown={ranked.length} total={hits.length} scoped={scoped} />
        <div className="page-text-result-list sr-flat">
          {ranked.map((h) => <Row key={h.path} hit={h} reason={reasonFor(h)} showPath={!scoped} />)}
        </div>
        {scoped ? <p className="rux-note" style={{ padding: '0 8px' }}>{hits.length - ranked.length} more matches in ja/</p> : null}
      </div>
    </Frame>
  )
}

function VariantC({ query, hits, scoped }: { query: string; hits: Hit[]; scoped: boolean }) {
  const visible = scopeFilter(hits, scoped)
  return (
    <Frame query={query} scoped={scoped} chip>
      <div className="sidebar-section page-text-results">
        <Header query={query} shown={visible.length} total={hits.length} scoped={scoped} />
        <div className="page-text-result-list">
          {tierOrder.map((tier) => {
            const group = visible.filter((h) => h.tier === tier)
            if (group.length === 0) return null
            return (
              <div key={tier}>
                <div className="sr-tier"><span>{tierLabel[tier]}</span><span>{group.length}</span></div>
                {group.map((h) => <Row key={h.path} hit={h} reason={tier === 'heading' ? <><b>Heading:</b> <span className="sr-hit">{h.heading}</span></> : undefined} showPath={!scoped} />)}
              </div>
            )
          })}
        </div>
        {scoped ? <p className="rux-note" style={{ padding: '0 8px' }}>{hits.length - visible.length} more matches in ja/</p> : null}
      </div>
    </Frame>
  )
}

function Concept({ theme, layout, query, scoped }: SearchArgs) {
  const hits = hitsByQuery[query]
  return (
    <ConceptShell
      theme={theme}
      layout={layout}
      eyebrow="ISSUE-077 · Page text search results"
      title={`Results for "${query}" in the Guide sidebar`}
      intro="Ranking uses only what the client has today: page titles and H2 headings from the site index, then body-only matches, path order within a tier. Snippets are not shown because the search format stores no excerpts or positions. Tier order is shown by position and reason line, never as a score."
    >
      <VariantGrid wideColumns={3}>
        <Variant id="A" name="Current: path-ordered folder groups" caption="Predictable and matches the agreed IMP-42 interaction, but the best page can sit third and every match is a bare title and filename.">
          <VariantA query={query} hits={hits} />
        </Variant>
        <Variant id="B" name="Ranked flat list with match reason" caption="Fastest to the best page and explains each match; mixes languages unless the folder scope chip is on, and needs every hit page loaded before ordering.">
          <VariantB query={query} hits={hits} scoped={scoped} />
        </Variant>
        <Variant id="C" name="Tier groups: titles / headings / text" caption="Keeps grouping familiar and makes the ranking rule legible; empty tiers disappear, but a short list spreads across headers.">
          <VariantC query={query} hits={hits} scoped={scoped} />
        </Variant>
      </VariantGrid>
      <Note>The scope chip (Only en/) is folder-based, a convention not a language model. Toggle it with the scoped control.</Note>
    </ConceptShell>
  )
}

const meta = {
  title: 'Concepts/Reader UX 2026-10/ISSUE-077 Page text search results',
  args: { ...conceptDefaults, query: 'cloudflare' as QueryName, scoped: true },
  argTypes: {
    ...conceptArgTypes,
    query: { control: 'radio', options: ['cloudflare', 'preview'] },
    scoped: { control: 'boolean', description: 'Folder scope chip "Only en/" active' },
  },
  parameters: { layout: 'fullscreen' },
  render: (args: SearchArgs) => <Concept {...args} />,
} satisfies Meta<SearchArgs>

export default meta
type Story = StoryObj<typeof meta>

export const Light: Story = {}
export const Dark: Story = { args: { theme: 'dark' } }
export const Narrow390: Story = { args: { layout: 'narrow' } }
export const Narrow390Dark: Story = { args: { layout: 'narrow', theme: 'dark' } }
export const UnscopedAllFolders: Story = { args: { scoped: false } }
export const TitleTierQueryPreview: Story = { args: { query: 'preview', scoped: false } }
