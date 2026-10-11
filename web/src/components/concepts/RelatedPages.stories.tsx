import type { Meta, StoryObj } from '@storybook/react-vite'
import { Icon } from '../Icon'
import { relatedPages, type RelatedPage } from '../../domain/related-pages'
import type { ArtifactIndexEntry } from '../../domain/index'
import { ConceptShell, Variant, VariantGrid, Note, conceptArgTypes, conceptDefaults, useConceptLayout, type ConceptArgs } from './parts'
import { MockContextBar, ReaderFrame } from './chrome'
import { guideEn, guideJa, guideReference, type ConceptPage } from './data'

// The lists below come from the real selector (domain/related-pages.ts) run over the
// concept guide site, so the order, reasons and folder labels are what the reader would show.
const entries: ArtifactIndexEntry[] = [...guideEn, ...guideReference, ...guideJa].map((p: ConceptPage) => ({
  id: p.path,
  path: p.path,
  title: p.title,
  format: 'markdown',
  artifactUrl: `/${p.path}`,
  updatedAt: '2026-10-10T00:00:00Z',
  toc: p.h2.map((text, i) => ({ level: 2, text, id: `h${i}` })),
}))

type Current = 'en/publishing.html' | 'ja/publishing.html' | 'en/reference/cli/publish.html'
type Artifact = 'markdown' | 'html'
type Args = ConceptArgs & { current: Current; artifact: Artifact }

const reasonLabel = { sibling: 'Same folder', similar: 'Similar topic' } as const
const firstHeading = (item: RelatedPage) => entries.find((e) => e.path === item.entry.path)?.toc?.[0]?.text ?? ''
const crumbsFor = (path: string) => ['Guide', ...path.split('/').slice(0, -1), entries.find((e) => e.path === path)!.title].map((label) => ({ label }))

function Chip({ item }: { item: RelatedPage }) {
  return <span className={`rp-chip rp-chip--${item.reason}`}>{reasonLabel[item.reason]}</span>
}

function Folder({ item }: { item: RelatedPage }) {
  return item.folderLabel ? <span className="rp-folder">{item.folderLabel}/</span> : null
}

// ---- placements -----------------------------------------------------------

function ReadNextList({ items, title = 'Read next' }: { items: RelatedPage[]; title?: string }) {
  return (
    <section className="rp-next" aria-labelledby="rp-next-title">
      <h2 id="rp-next-title">{title}</h2>
      <ul>
        {items.map((item) => (
          <li key={item.entry.path}>
            <a href="#related" className="rp-next-row" onClick={(e) => e.preventDefault()}>
              <Icon name="file" size={15} />
              <span className="rp-next-title">{item.entry.title}</span>
              <span className="rp-next-meta"><Folder item={item} /><Chip item={item} /></span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function RelatedPanel({ items }: { items: RelatedPage[] }) {
  return (
    <aside className="context-panel rp-panel" aria-label="Contents">
      <div className="context-panel-header">
        <span>Contents</span>
        <button type="button" className="context-panel-close" aria-label="Close Contents"><Icon name="close" size={14} /></button>
      </div>
      <nav className="toc-list" aria-label="Artifact headings">
        {['Publish on push', 'Publish-on rules', 'Previews for pull requests', 'Rolling back'].map((h, i) => (
          <button type="button" key={h} className="toc-link" aria-current={i === 1 ? 'location' : undefined}>{h}</button>
        ))}
      </nav>
      <section className="rp-panel-related" aria-labelledby="rp-panel-title">
        <h3 id="rp-panel-title">Related</h3>
        <ul>
          {items.map((item) => (
            <li key={item.entry.path}>
              <a href="#related" onClick={(e) => e.preventDefault()}>
                <span className="rp-panel-title">{item.entry.title}</span>
                <span className="rp-panel-sub">{item.folderLabel ? `${item.folderLabel}/ · ` : ''}{reasonLabel[item.reason]}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  )
}

function CardRow({ items }: { items: RelatedPage[] }) {
  return (
    <section className="rp-cards" aria-labelledby="rp-cards-title">
      <h2 id="rp-cards-title">Related pages</h2>
      <ul>
        {items.slice(0, 3).map((item) => (
          <li key={item.entry.path}>
            <a href="#related" className="rp-card" onClick={(e) => e.preventDefault()}>
              <span className="rp-card-folder">{item.folderLabel ? `${item.folderLabel}/` : 'This folder'}</span>
              <span className="rp-card-title">{item.entry.title}</span>
              <span className="rp-card-head">{firstHeading(item)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---- mock artifact --------------------------------------------------------

function MarkdownBody({ path, children }: { path: string; children?: React.ReactNode }) {
  const title = entries.find((e) => e.path === path)!.title
  return (
    <article className="markdown-article rp-doc">
      <h1>{title}</h1>
      <p>Publishing turns the files in your repository into pages on your site. A push to a branch listed in the registry runs the workflow and replaces the site atomically.</p>
      <h2>Publish on push</h2>
      <p>The publish action reads <code>artifact-pages.yaml</code>, builds the index and uploads only changed artifacts.</p>
      <h2>Publish-on rules</h2>
      <p>Each environment says which events may publish. Pull requests from forks never do.</p>
      {children}
    </article>
  )
}

/** Stands for an HTML artifact: the frame fills the stage and scrolls inside itself. */
function HtmlFrame({ path, strip }: { path: string; strip?: React.ReactNode }) {
  const title = entries.find((e) => e.path === path)!.title
  return (
    <div className="rp-html-stage">
      <div className="rp-html-frame" tabIndex={0} aria-label={`${title} (artifact frame; scrolls inside)`}>
        <div className="rp-html-doc">
          <h1>{title}</h1>
          <p>The artifact is a full HTML document. It owns its layout and its own scrollbar.</p>
          <p className="rp-html-more">…more of the document below. The shell cannot append anything after it.</p>
        </div>
      </div>
      {strip}
    </div>
  )
}

function Placement(props: { variant: 'A' | 'B' | 'C'; current: Current; artifact: Artifact }) {
  return <div className="rp-frame"><PlacementInner {...props} /></div>
}

function PlacementInner({ variant, current, artifact }: { variant: 'A' | 'B' | 'C'; current: Current; artifact: Artifact }) {
  const items = relatedPages(entries, current)
  const bar = <MockContextBar crumbs={crumbsFor(current)} clickableFolders={false} />
  const narrow = useConceptLayout() === 'narrow'
  if (items.length === 0) return <Note>No related pages: the section is not rendered.</Note>

  if (artifact === 'html') {
    const strip =
      variant === 'B' ? null : (
        <details className="rp-strip">
          <summary><Icon name="chevron" size={11} />Read next · {items.length}</summary>
          <ReadNextList items={items.slice(0, variant === 'C' ? 3 : 5)} />
        </details>
      )
    return (
      <ReaderFrame bar={bar}>
        <div className="rp-stage">
          <HtmlFrame path={current} strip={strip} />
          {variant === 'B' ? <RelatedPanel items={items} /> : null}
        </div>
      </ReaderFrame>
    )
  }

  return (
    <ReaderFrame bar={bar}>
      <div className="rp-stage">
        <div className="rp-scroll">
          <MarkdownBody path={current}>
            {variant === 'A' ? <ReadNextList items={items} /> : null}
            {variant === 'B' && narrow ? <section className="rp-end-related"><ReadNextList items={items} title="Related" /></section> : null}
            {variant === 'C' ? <CardRow items={items} /> : null}
          </MarkdownBody>
        </div>
        {variant === 'B' && !narrow ? <RelatedPanel items={items} /> : null}
      </div>
    </ReaderFrame>
  )
}

const htmlNote =
  'HTML artifact (try the HtmlArtifact stories): the iframe is position:absolute, inset 0 and fills the whole stage, and the artifact scrolls inside it. The shell has no space after the document today, so an end-of-page block is NOT reachable without scrolling inside the iframe. It needs either a shell-owned strip under the frame (shown, collapsed by default) or sizing the frame to its document height as folder index pages already do (watchFrameHeight, same-origin only).'

function Concept({ theme, layout, current, artifact }: Args) {
  const narrow = layout === 'narrow'
  return (
    <ConceptShell
      theme={theme}
      layout={layout}
      eyebrow="Concept · ISSUE-086 related pages"
      title="Where do I go after the last paragraph?"
      intro="Three placements for the related-pages list. The pages, reasons and folder labels come from the real selector (same-folder siblings plus title/heading similarity, capped at 5, parallel en/ja counterparts dropped) over the guide site. Pick one; nothing is wired into the reader yet."
    >
      <VariantGrid wideColumns={1}>
        <Variant
          id="A"
          name="Read next list"
          caption="At the end of the reading area, below the artifact. Title, folder when it differs, and a reason chip. Biggest and most visible; mirrors a docs footer."
        >
          <Placement variant="A" current={current} artifact={artifact} />
          <Note>Markdown: part of the scrolling article, reachable by scrolling the page. {artifact === 'html' ? htmlNote : 'HTML artifacts differ, see the HtmlArtifact stories.'}</Note>
        </Variant>
        <Variant
          id="B"
          name="Related in the Contents panel"
          caption={narrow ? 'On narrow screens the same list becomes an end-of-page block, because the panel is a floating popover there.' : 'A "Related" section under the headings in the right-hand Contents popover. Quiet, but only seen when the panel is open (it is closed by default).'}
        >
          <Placement variant="B" current={current} artifact={artifact} />
          <Note>
            {artifact === 'html'
              ? 'HTML artifact: the panel is rendered by the shell above the frame, so it is reachable without scrolling inside the iframe (one click on Contents). On narrow screens the end-of-page form has the iframe problem described under A.'
              : narrow
                ? 'Narrow: end-of-page block inside the article; HTML artifacts would need the shell strip or a frame sized to its document.'
                : 'Desktop: the panel is a shell popover, independent of the artifact type.'}
          </Note>
        </Variant>
        <Variant
          id="C"
          name="Compact card row"
          caption="Two or three cards at the end of the page: title, folder and the page's first heading. Lighter than A, more graphic, shows fewer pages (3 of 5)."
        >
          <Placement variant="C" current={current} artifact={artifact} />
          <Note>Markdown: part of the article. {artifact === 'html' ? htmlNote : 'For HTML artifacts it has the same iframe limits as A.'}</Note>
        </Variant>
      </VariantGrid>
    </ConceptShell>
  )
}

const meta = {
  title: 'Concepts/Reader UX 2026-10/ISSUE-086 related pages',
  args: { ...conceptDefaults, current: 'en/publishing.html' as Current, artifact: 'markdown' as Artifact },
  argTypes: {
    ...conceptArgTypes,
    current: { control: 'radio', options: ['en/publishing.html', 'ja/publishing.html', 'en/reference/cli/publish.html'] },
    artifact: { control: 'radio', options: ['markdown', 'html'] },
  },
  parameters: { layout: 'fullscreen' },
  render: (args: Args) => <Concept {...args} />,
} satisfies Meta<Args>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const DefaultDark: Story = { args: { theme: 'dark' } }
export const Narrow390: Story = { args: { layout: 'narrow' } }
export const Narrow390Dark: Story = { args: { layout: 'narrow', theme: 'dark' } }
export const Japanese: Story = { args: { current: 'ja/publishing.html' } }
export const JapaneseNarrow390Dark: Story = { args: { current: 'ja/publishing.html', layout: 'narrow', theme: 'dark' } }
export const DeepFolderPage: Story = { args: { current: 'en/reference/cli/publish.html' } }
export const HtmlArtifact: Story = { args: { artifact: 'html' } }
export const HtmlArtifactDark: Story = { args: { artifact: 'html', theme: 'dark' } }
export const HtmlArtifactNarrow390: Story = { args: { artifact: 'html', layout: 'narrow' } }
