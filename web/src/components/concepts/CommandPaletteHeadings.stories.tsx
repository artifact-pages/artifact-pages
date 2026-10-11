import { useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Icon } from '../Icon'
import { ConceptShell, Variant, VariantGrid, Note, conceptArgTypes, conceptDefaults, type ConceptArgs } from './parts'

type Entry = { id: string; kind: 'page' | 'heading' | 'text'; title: string; subtitle?: string; badge?: string }
type Section = { title: string; entries: Entry[] }
type QueryName = 'start' | 'cloudflare'

function highlight(text: string, query: string): ReactNode {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (at < 0) return text
  return <>{text.slice(0, at)}<mark className="palette-match">{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>
}

const textRow = (query: string): Entry => ({ id: 'text', kind: 'text', title: `Search page text for "${query}"`, subtitle: 'Guide' })

function sectionsA(query: QueryName): Section[] {
  if (query === 'start') {
    return [
      { title: 'Pages', entries: [{ id: 'p1', kind: 'page', title: 'Getting started', subtitle: 'en/getting-started' }] },
      {
        title: 'Headings in other pages',
        entries: [
          { id: 'h1', kind: 'heading', title: 'Start with Cloudflare', subtitle: 'Getting started · en' },
          { id: 'h2', kind: 'heading', title: 'Start with AWS', subtitle: 'Getting started · en' },
        ],
      },
      { title: 'Search', entries: [textRow('start')] },
    ]
  }
  return [
    {
      title: 'Headings in other pages',
      entries: [
        { id: 'h1', kind: 'heading', title: 'Start with Cloudflare', subtitle: 'Getting started · en' },
        { id: 'h2', kind: 'heading', title: 'Cloudflare R2 settings', subtitle: 'Configuration · en' },
        { id: 'h3', kind: 'heading', title: 'Cloudflare で始める', subtitle: 'はじめに · ja' },
        { id: 'h4', kind: 'heading', title: 'Cloudflare R2 の設定', subtitle: '設定 · ja' },
      ],
    },
    { title: 'Search', entries: [textRow('cloudflare')] },
  ]
}

function sectionsB(query: QueryName): Section[] {
  if (query === 'start') {
    return [
      {
        title: 'Results',
        entries: [
          { id: 'h1', kind: 'heading', title: 'Start with Cloudflare', subtitle: 'Getting started · en', badge: 'Heading' },
          { id: 'h2', kind: 'heading', title: 'Start with AWS', subtitle: 'Getting started · en', badge: 'Heading' },
          { id: 'p1', kind: 'page', title: 'Getting started', subtitle: 'en/getting-started' },
          textRow('start'),
        ],
      },
    ]
  }
  return [
    {
      title: 'Results',
      entries: [
        { id: 'h1', kind: 'heading', title: 'Start with Cloudflare', subtitle: 'Getting started · en', badge: 'Heading' },
        { id: 'h2', kind: 'heading', title: 'Cloudflare R2 settings', subtitle: 'Configuration · en', badge: 'Heading' },
        { id: 'h3', kind: 'heading', title: 'Cloudflare で始める', subtitle: 'はじめに · ja', badge: 'Heading' },
        { id: 'h4', kind: 'heading', title: 'Cloudflare R2 の設定', subtitle: '設定 · ja', badge: 'Heading' },
        textRow('cloudflare'),
      ],
    },
  ]
}

function sectionsC(): Section[] {
  return [
    {
      title: 'Headings in this page · Publishing',
      entries: [
        { id: 'h1', kind: 'heading', title: 'Publish on push', subtitle: 'this page' },
        { id: 'h2', kind: 'heading', title: 'Publish-on rules', subtitle: 'this page' },
      ],
    },
    { title: 'Headings in other pages', entries: [{ id: 'h3', kind: 'heading', title: 'Verify the first publish', subtitle: 'Getting started · en' }] },
  ]
}

function PaletteMock({
  query,
  scope,
  sections,
  initialSelected,
  hint,
}: {
  query: string
  scope?: string
  sections: Section[]
  initialSelected: number
  hint?: ReactNode
}) {
  const total = sections.reduce((n, s) => n + s.entries.length, 0)
  const [selected, setSelected] = useState(Math.min(initialSelected, total - 1))

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
      event.preventDefault()
      setSelected((s) => (s + 1) % total)
    } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
      event.preventDefault()
      setSelected((s) => (s - 1 + total) % total)
    }
  }

  let index = 0
  return (
    <div className="rux-palette-static">
      <section className="command-palette rux-palette-card" aria-label="Command palette">
        <div className="palette-input-row">
          <Icon name="search" size={16} />
          <input key={query} defaultValue={query} placeholder="Search…" onKeyDown={onKeyDown} aria-label="Palette query (use arrow keys)" />
          {scope ? <span className="palette-scope">{scope}</span> : null}
          <kbd>esc</kbd>
        </div>
        <div className="palette-results" role="listbox" aria-label="Search results">
          {sections.map((section) => (
            <div className="palette-section" key={section.title}>
              <div className="palette-section-title">{section.title}</div>
              {section.entries.map((entry) => {
                const mine = index++
                const isSelected = mine === selected
                return (
                  <button
                    type="button"
                    key={entry.id}
                    role="option"
                    aria-selected={isSelected}
                    className={`palette-entry${entry.kind === 'text' ? ' palette-entry--page-text' : ''}${isSelected ? ' is-selected' : ''}`}
                    onMouseMove={() => setSelected(mine)}
                  >
                    <span className="palette-entry-icon"><Icon name={entry.kind === 'heading' ? 'contents' : entry.kind === 'text' ? 'search' : 'file'} size={14} /></span>
                    <span className="palette-entry-title">{entry.kind === 'text' ? entry.title : highlight(entry.title, query)}</span>
                    {entry.subtitle ? <span className="palette-entry-subtitle">{entry.subtitle}</span> : null}
                    {entry.badge ? <span className="palette-entry-badge">{entry.badge}</span> : null}
                    {isSelected ? <kbd className="palette-entry-enter" aria-hidden="true">↵</kbd> : null}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        {hint ? <p className="palette-hint">{hint}</p> : null}
        <footer className="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open at heading</span>
          <span><code>#</code> headings</span>
        </footer>
      </section>
    </div>
  )
}

type PaletteArgs = ConceptArgs & { query: QueryName; selectedRow: number }

function Concept({ theme, layout, query, selectedRow }: PaletteArgs) {
  return (
    <ConceptShell
      theme={theme}
      layout={layout}
      eyebrow="ISSUE-079 · Command palette"
      title="Find headings of other pages"
      intro="Headings come from the site index already loaded in the browser, so no extra request. Each row names its page and folder. Use the arrow keys inside a palette (focus the input) to move the selection; the Enter hint follows it."
    >
      <VariantGrid wideColumns={2}>
        <Variant id="A" name="Separate section: Headings in other pages" caption="Page-title results keep priority and the section label explains the rows; the section sits below the fold when many pages match.">
          <PaletteMock query={query} sections={sectionsA(query)} initialSelected={selectedRow} />
        </Variant>
        <Variant id="B" name="Mixed into one ranked list (heading icon + badge)" caption="Shortest path to a strong heading match, but a heading can outrank the page the reader meant, and the rows look similar apart from the icon and badge.">
          <PaletteMock query={query} sections={sectionsB(query)} initialSelected={selectedRow} />
        </Variant>
        <Variant id="C" name="# mode: all pages, open page first" caption="Explicit heading search across the site with the open page first; needs the reader to know the # prefix (footer hint updated from open-page-only wording).">
          <PaletteMock query="publish" scope="# Headings" sections={sectionsC()} initialSelected={selectedRow} />
        </Variant>
      </VariantGrid>
      <Note>Rule shown in A: page-title matches first, then headings of other pages; a page that already matches by title also lists its own matching headings (decision needed: dedupe or keep). Selecting a heading opens the page at the heading. Not represented: fuzzy-match scoring and the folder column on very narrow screens.</Note>
    </ConceptShell>
  )
}

const meta = {
  title: 'Concepts/Reader UX 2026-10/ISSUE-079 Palette headings',
  args: { ...conceptDefaults, query: 'start' as QueryName, selectedRow: 1 },
  argTypes: {
    ...conceptArgTypes,
    query: { control: 'radio', options: ['start', 'cloudflare'] },
    selectedRow: { control: { type: 'number', min: 0, max: 4 } },
  },
  parameters: { layout: 'fullscreen' },
  render: (args: PaletteArgs) => <Concept {...args} />,
} satisfies Meta<PaletteArgs>

export default meta
type Story = StoryObj<typeof meta>

export const Light: Story = {}
export const Dark: Story = { args: { theme: 'dark' } }
export const Narrow390: Story = { args: { layout: 'narrow' } }
export const Narrow390Dark: Story = { args: { layout: 'narrow', theme: 'dark' } }
export const QueryCloudflareNoPageMatch: Story = { args: { query: 'cloudflare', selectedRow: 0 } }
