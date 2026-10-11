import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Icon } from '../Icon'
import { ConceptShell, Variant, Note, SiteMark, conceptArgTypes, conceptDefaults, type ConceptArgs } from './parts'
import { MockBreadcrumbs } from './chrome'

const tableRows = [
  ['registry', 'path', '.artifact-pages/registry.yaml', 'Where the registry file lives', '0.1'],
  ['sites[].id', 'string', 'required', 'Stable site id used in URLs', '0.1'],
  ['sites[].publish-on', 'list', '[main]', 'Branches or events that publish', '0.1'],
  ['sites[].fulltext', 'bool', 'false', 'Build the page text search index', '0.1'],
  ['environments', 'map', '{}', 'Named bucket and CDN targets', '0.1'],
]

/** Scroll container that reports clipped edges so a cue can be drawn. */
function ScrollCue({ kind, children, innerClass }: { kind: 'none' | 'fade' | 'shadow'; children: ReactNode; innerClass?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const update = useCallback(() => {
    const el = ref.current
    const host = wrap.current
    if (!el || !host) return
    host.dataset.left = String(el.scrollLeft > 2)
    host.dataset.right = String(el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
  }, [])
  useEffect(() => {
    update()
    const observer = new ResizeObserver(update)
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [update])
  return (
    <div ref={wrap} className={`nv-cue${kind === 'none' ? '' : ` nv-cue--${kind}`}`}>
      <div ref={ref} className={innerClass} onScroll={update} tabIndex={0} role="region" aria-label="Scrollable content">{children}</div>
    </div>
  )
}

function ConfigTable({ cue, hint }: { cue: 'none' | 'fade' | 'shadow'; hint?: boolean }) {
  return (
    <>
      <ScrollCue kind={cue} innerClass="markdown-table-scroll">
        <table>
          <thead><tr><th>Key</th><th>Type</th><th>Default</th><th>Description</th><th>Since</th></tr></thead>
          <tbody>{tableRows.map((r) => <tr key={r[0]}>{r.map((c) => <td key={c}>{c}</td>)}</tr>)}</tbody>
        </table>
      </ScrollCue>
      {hint ? <p className="markdown-table-hint">Scroll to see more columns →</p> : null}
    </>
  )
}

function CodeBlock({ cue }: { cue: 'none' | 'fade' | 'shadow' }) {
  return (
    <ScrollCue kind={cue} innerClass="nv-code">
      <code>{`artifact-pages publish --site guide --environment production --registry .artifact-pages/registry.yaml --fulltext`}</code>
    </ScrollCue>
  )
}

function Doc({ cue, hint }: { cue: 'none' | 'fade' | 'shadow'; hint?: boolean }) {
  return (
    <div className="nv-doc-scroll">
      <article className="markdown-article nv-doc">
        <h1>Configuration</h1>
        <p>The registry file lists sites, folders and the environments they publish to.</p>
        <h2>Sites and folders</h2>
        <ConfigTable cue={cue} hint={hint} />
        <p>Publish with the command below.</p>
        <CodeBlock cue={cue} />
      </article>
    </div>
  )
}

const crumbs = [{ label: 'Guide' }, { label: 'en' }, { label: 'Configuration' }]

function Rail() {
  return (
    <aside className="collapsed-rail" aria-label="Guide navigation">
      <div className="collapsed-rail-group">
        <button type="button" className="collapsed-rail-button collapsed-rail-button-primary" aria-label="Expand navigation"><Icon name="sidebar" size={17} /></button>
        <button type="button" className="collapsed-rail-button" aria-label="Jump to a page"><Icon name="search" size={17} /></button>
      </div>
      <div className="collapsed-rail-spacer" />
      <div className="collapsed-rail-group"><button type="button" className="collapsed-rail-button" aria-label="Theme"><Icon name="moon" size={16} /></button></div>
    </aside>
  )
}

function PhoneA() {
  return (
    <div className="nv-phone nv-a" data-pattern="rail">
      <Rail />
      <div className="nv-main">
        <header className="context-bar">
          <MockBreadcrumbs crumbs={crumbs} clickableFolders={false} />
          <div className="context-actions">
            <button type="button" className="context-button" aria-label="Contents"><Icon name="contents" size={14} /><span>Contents</span></button>
            <button type="button" className="context-button" aria-label="Details"><Icon name="info" size={14} /><span>Details</span></button>
            <button type="button" className="context-button" aria-label="Copy link"><Icon name="copy" size={14} /><span>Copy</span></button>
            <button type="button" className="context-button" aria-label="History"><Icon name="history" size={14} /><span>History</span></button>
            <button type="button" className="context-button" aria-label="All sites"><Icon name="library" size={14} /><span>All sites</span></button>
            <button type="button" className="context-button current-artifact-pin-button" aria-label="Pin"><Icon name="pin" size={14} /><span>Pin</span></button>
          </div>
        </header>
        <Doc cue="none" hint />
      </div>
    </div>
  )
}

function PhoneB({ menuOpen }: { menuOpen?: boolean }) {
  return (
    <div className="nv-phone" data-pattern="menu">
      <div className="nv-main" style={{ width: '100%' }}>
        <header className="nv-bar">
          <button type="button" className="icon-button" aria-label="Open navigation"><Icon name="sidebar" size={17} /></button>
          <span className="nv-bar-text"><span className="nv-crumb-dim">Guide / en</span><span className="nv-title">Configuration</span></span>
          <button type="button" className="icon-button" aria-label="Jump to a page"><Icon name="search" size={17} /></button>
          <button type="button" className={`icon-button${menuOpen ? ' is-active' : ''}`} aria-label="More actions" aria-expanded={menuOpen}><Icon name="more" size={17} /></button>
        </header>
        {menuOpen ? (
          <div className="nv-menu" role="menu">
            <button type="button" role="menuitem"><Icon name="contents" size={15} />Contents</button>
            <button type="button" role="menuitem"><Icon name="info" size={15} />Details</button>
            <button type="button" role="menuitem"><Icon name="pin" size={15} />Pin</button>
            <button type="button" role="menuitem"><Icon name="copy" size={15} />Copy link</button>
            <hr />
            <button type="button" role="menuitem"><Icon name="home" size={15} />Guide home</button>
            <button type="button" role="menuitem"><Icon name="library" size={15} />All sites</button>
            <button type="button" role="menuitem"><Icon name="moon" size={15} />Theme</button>
          </div>
        ) : null}
        <Doc cue="fade" />
      </div>
    </div>
  )
}

function PhoneC() {
  return (
    <div className="nv-phone" data-pattern="bottom">
      <div className="nv-main" style={{ width: '100%' }}>
        <header className="nv-bar">
          <SiteMark title="Guide" />
          <span className="nv-bar-text"><span className="nv-crumb-dim">Guide / en</span><span className="nv-title">Configuration</span></span>
          <button type="button" className="icon-button" aria-label="Pin"><Icon name="pin" size={17} /></button>
        </header>
        <Doc cue="fade" />
        <nav className="nv-bottom" aria-label="Reader">
          <button type="button" className="is-active"><Icon name="tree" size={18} />Pages</button>
          <button type="button"><Icon name="search" size={18} />Search</button>
          <button type="button"><Icon name="contents" size={18} />Contents</button>
          <button type="button"><Icon name="more" size={18} />More</button>
        </nav>
      </div>
    </div>
  )
}

function CueFrame({ label, cue, hint }: { label: string; cue: 'none' | 'fade' | 'shadow'; hint?: boolean }) {
  return (
    <div className="nv-cue-frame markdown-article">
      <p className="nv-cue-label">{label}</p>
      <ConfigTable cue={cue} hint={hint} />
      <CodeBlock cue={cue} />
    </div>
  )
}

function Concept({ theme, layout }: ConceptArgs) {
  return (
    <ConceptShell
      theme={theme}
      layout={layout}
      eyebrow="ISSUE-080 · Narrow screens (390 px)"
      title="Less chrome, visible scroll cues"
      intro="Frames are fixed 390 px wide and reproduce the real 620 px media-query rules for the baseline, so they look the same at any Storybook viewport. Scroll the tables and code blocks inside the frames."
    >
      <div className="nv-phones">
        <div className="nv-phone-wrap">
          <Variant id="A" name="Current chrome (baseline)" caption="48 px rail plus a two-row toolbar leaves ~341 px width and ~80 px less height; actions are icon-only except Pin.">
            <PhoneA />
          </Variant>
        </div>
        <div className="nv-phone-wrap">
          <Variant id="B" name="Menu button, one-row toolbar" caption="Full width and one 44 px row; secondary actions move into a More menu (right frame), one tap deeper.">
            <PhoneB />
          </Variant>
        </div>
        <div className="nv-phone-wrap">
          <Variant id="B" name="B with More menu open" caption="Overflow actions keep accessible names; Contents and Details no longer need labels in the bar.">
            <PhoneB menuOpen />
          </Variant>
        </div>
        <div className="nv-phone-wrap">
          <Variant id="C" name="Bottom bar" caption="Thumb-reachable Pages, Search, Contents, More; costs ~56 px of permanent height and a new pattern to learn.">
            <PhoneC />
          </Variant>
        </div>
      </div>

      <h2 className="rux-section-title">Scroll cues for wide Markdown tables and code blocks</h2>
      <div className="nv-phones">
        <div className="nv-phone-wrap">
          <Variant id="1" name="Existing hint only" caption="Text hint under tables only; code blocks get nothing and the hint is easy to miss.">
            <CueFrame label="hint" cue="none" hint />
          </Variant>
        </div>
        <div className="nv-phone-wrap">
          <Variant id="2" name="Edge fade" caption="Content fades into the page at a clipped edge; reads as scrollable on both tables and code, disappears at the ends.">
            <CueFrame label="edge fade" cue="fade" />
          </Variant>
        </div>
        <div className="nv-phone-wrap">
          <Variant id="3" name="Edge shadow + hint" caption="Stronger shadow cue combined with the existing hint; most explicit but visually heavier.">
            <CueFrame label="edge shadow + hint" cue="shadow" hint />
          </Variant>
        </div>
      </div>
      <p className="nv-iframe-note"><Icon name="info" size={14} />HTML artifacts render inside an iframe, so the reader cannot add these cues to their tables or code (no artifact cooperation or injection decided).</p>
      <Note>Not represented: the open drawer sidebar, safe-area insets on real devices, and touch scrolling behavior.</Note>
    </ConceptShell>
  )
}

const meta = {
  title: 'Concepts/Reader UX 2026-10/ISSUE-080 Narrow chrome and scroll cues',
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
