import { useCallback, useEffect, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Icon } from '../Icon'
import { relatedPages, type RelatedPage } from '../../domain/related-pages'
import type { ArtifactIndexEntry } from '../../domain/index'
import { ConceptShell, Variant, VariantGrid, Note, conceptArgTypes, conceptDefaults, type ConceptArgs } from './parts'
import { MockContextBar, ReaderFrame } from './chrome'
import { guideEn, guideJa, guideReference, type ConceptPage } from './data'

// Same entries and real selector as RelatedPages.stories.tsx.
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
type ArtifactStyle = 'colorful-light' | 'colorful-dark'
type Args = ConceptArgs & { current: Current; artifactStyle: ArtifactStyle }
type Mode = 'collapsed' | 'open' | 'at-end'

const reasonLabel = { sibling: 'Same folder', similar: 'Similar topic' } as const
const crumbsFor = (path: string) => ['Guide', ...path.split('/').slice(0, -1), entries.find((e) => e.path === path)!.title].map((label) => ({ label }))

// ---- sample artifact -------------------------------------------------------

const lightCss = `
:root{--bg:#fff;--fg:#1b1f3b;--muted:#5b6182;--card:#fff;--line:#e4e7f5;--a:#6d28d9;--b:#ec4899;--c:#f59e0b;--d:#10b981;--e:#0ea5e9;--callout:#fff7e6;--calloutline:#f5c26b}
body{background:var(--bg)}
.hero{background:linear-gradient(120deg,#6d28d9 0%,#ec4899 55%,#f59e0b 100%);color:#fff}
th{background:#f3efff;color:#4c1d95}
`
const darkCss = `
:root{--bg:#0b1030;--fg:#dfe6ff;--muted:#8d97c9;--card:#141a45;--line:#27307a;--a:#22d3ee;--b:#f472b6;--c:#a3e635;--d:#34d399;--e:#818cf8;--callout:#1b1450;--calloutline:#7c3aed}
body{background:radial-gradient(circle at 20% 0,#1a1f66 0,#0b1030 45%)}
.hero{background:linear-gradient(120deg,#0e7490 0%,#6d28d9 50%,#be185d 100%);color:#fff;box-shadow:0 0 40px #22d3ee33 inset}
th{background:#1d2570;color:#67e8f9}
`

function artifactHtml(style: ArtifactStyle, title: string): string {
  const bars = [
    ['Mon', 62, 'a'],
    ['Tue', 88, 'b'],
    ['Wed', 45, 'c'],
    ['Thu', 120, 'd'],
    ['Fri', 96, 'e'],
    ['Sat', 30, 'a'],
    ['Sun', 74, 'b'],
  ] as const
  const svg = `<svg viewBox="0 0 420 170" role="img" aria-label="Publishes per weekday" width="100%">${bars
    .map(([d, v, c], i) => `<rect x="${24 + i * 56}" y="${150 - v}" width="38" height="${v}" rx="6" fill="var(--${c})"/><text x="${43 + i * 56}" y="166" text-anchor="middle" font-size="11" fill="var(--muted)">${d}</text>`)
    .join('')}</svg>`
  const rows = [
    ['site-main', '412', '3.2 s', 'ok'],
    ['preview/pr-88', '97', '1.9 s', 'ok'],
    ['docs-ja', '233', '4.8 s', 'slow'],
    ['reference', '1,204', '7.5 s', 'ok'],
    ['blog', '58', '1.1 s', 'ok'],
  ]
    .map(([n, f, t, s]) => `<tr><td>${n}</td><td>${f}</td><td>${t}</td><td><span class="pill ${s}">${s}</span></td></tr>`)
    .join('')
  const section = (h: string, p: string) => `<h2>${h}</h2><p>${p}</p>`
  const lorem = 'Every publish builds the index, uploads only changed files and swaps the site atomically. Readers never see a half-published state, and rollbacks are a single revert away.'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
*{box-sizing:border-box}
body{margin:0;font:15px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg)}
.wrap{max-width:760px;margin:0 auto;padding:0 20px 40px}
.hero{padding:44px 28px 36px;border-radius:0 0 22px 22px;margin:0 -20px 24px}
.hero h1{margin:0 0 8px;font-size:34px;letter-spacing:-.03em;line-height:1.15}
.hero p{margin:0;opacity:.92}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:0 0 28px}
.stat{border-radius:14px;padding:14px 16px;color:#fff;font-weight:600}
.stat b{display:block;font-size:28px;line-height:1.1}
.stat:nth-child(1){background:linear-gradient(135deg,var(--a),var(--e))}
.stat:nth-child(2){background:linear-gradient(135deg,var(--b),var(--c))}
.stat:nth-child(3){background:linear-gradient(135deg,var(--d),var(--e))}
.stat:nth-child(4){background:linear-gradient(135deg,var(--c),var(--b))}
.stat:nth-child(1),.stat:nth-child(3){color:#04121f}
h2{margin:30px 0 8px;font-size:22px;letter-spacing:-.02em;border-left:6px solid var(--b);padding-left:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
table{width:100%;border-collapse:collapse;background:var(--card);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}
.pill{padding:2px 9px;border-radius:99px;font-size:12px;font-weight:700}
.pill.ok{background:var(--d);color:#04221a}.pill.slow{background:var(--c);color:#2b1a00}
.callout{background:var(--callout);border:1px solid var(--calloutline);border-left:6px solid var(--c);border-radius:10px;padding:12px 14px;margin:16px 0}
.callout.info{border-left-color:var(--e)}
.tag{display:inline-block;margin:2px 4px 2px 0;padding:2px 10px;border-radius:99px;background:var(--a);color:#fff;font-size:12px}
footer{margin-top:36px;padding:18px;text-align:center;border-radius:14px;background:linear-gradient(90deg,var(--a),var(--b));color:#fff;font-weight:600}
${style === 'colorful-dark' ? darkCss : lightCss}
</style></head><body><div class="wrap">
<header class="hero"><h1>${title}: release report</h1><p>Week 41 · 1,904 files published across 5 sites</p></header>
<div class="stats"><div class="stat"><b>1,904</b>files</div><div class="stat"><b>99.2%</b>success</div><div class="stat"><b>3.2 s</b>median</div><div class="stat"><b>12</b>previews</div></div>
${section('Highlights', lorem)}
<div class="card"><span class="tag">atomic</span><span class="tag">incremental</span><span class="tag">rollback</span><p>${lorem}</p></div>
<h2>Publishes per weekday</h2><div class="card">${svg}</div>
<div class="callout"><b>Heads up.</b> The docs-ja site exceeded its 4 s budget on three runs.</div>
<h2>Sites</h2><table><thead><tr><th>Site</th><th>Files</th><th>Time</th><th>State</th></tr></thead><tbody>${rows}</tbody></table>
${section('What changed', lorem + ' ' + lorem)}
<div class="callout info"><b>Note.</b> Previews for pull requests are removed seven days after the PR closes.</div>
${section('Details', lorem + ' ' + lorem + ' ' + lorem)}
<div class="card"><p>${lorem}</p><p>${lorem}</p></div>
${section('Next steps', lorem)}
<div class="card"><p>${lorem}</p></div>
<footer>End of report · generated by the artifact author</footer>
</div></body></html>`
}

// ---- strip -----------------------------------------------------------------

function Chip({ item }: { item: RelatedPage }) {
  return <span className={`rp-chip rp-chip--${item.reason}`}>{reasonLabel[item.reason]}</span>
}

function StripList({ items }: { items: RelatedPage[] }) {
  return (
    <section className="rp-next" aria-label="Read next">
      <ul>
        {items.map((item) => (
          <li key={item.entry.path}>
            <a href="#related" className="rp-next-row" onClick={(e) => e.preventDefault()}>
              <Icon name="file" size={15} />
              <span className="rp-next-title">{item.entry.title}</span>
              <span className="rp-next-meta">
                {item.folderLabel ? <span className="rp-folder">{item.folderLabel}/</span> : null}
                <Chip item={item} />
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

const NEAR_END_PX = 24

/** Reader stage: a real same-origin iframe that scrolls inside itself, plus the shell-owned strip. */
function HtmlStage({ mode, current, artifactStyle, items }: { mode: Mode; current: Current; artifactStyle: ArtifactStyle; items: RelatedPage[] }) {
  const title = entries.find((e) => e.path === current)!.title
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [open, setOpen] = useState(mode === 'open')
  const [auto, setAuto] = useState(false)
  const openRef = useRef(open)
  openRef.current = open
  const dismissed = useRef(false)
  const cleanup = useRef<(() => void) | null>(null)

  const check = useCallback(() => {
    const doc = frameRef.current?.contentDocument
    const el = doc?.scrollingElement
    // Ignore the initial about:blank document that exists before the srcDoc has loaded.
    if (!el || !doc?.querySelector('.wrap') || dismissed.current) return
    const remaining = el.scrollHeight - el.clientHeight - el.scrollTop
    if (remaining <= NEAR_END_PX) {
      if (!openRef.current) setAuto(true)
      setOpen(true)
    }
  }, [])

  const attach = useCallback(() => {
    cleanup.current?.()
    const win = frameRef.current?.contentWindow
    if (!win || mode !== 'at-end') return
    win.addEventListener('scroll', check, { passive: true })
    win.addEventListener('resize', check)
    cleanup.current = () => {
      win.removeEventListener('scroll', check)
      win.removeEventListener('resize', check)
    }
    check()
  }, [check, mode])

  useEffect(() => {
    // The srcDoc load can finish before React attaches onLoad, so also attach once mounted.
    if (frameRef.current?.contentDocument?.readyState === 'complete') attach()
    return () => cleanup.current?.()
  }, [attach])

  return (
    <div className="rp-html-stage rh-stage">
      <iframe
        ref={frameRef}
        className="rh-iframe"
        title={`${title} (HTML artifact)`}
        srcDoc={artifactHtml(artifactStyle, title)}
        onLoad={attach}
      />
      <details
        className={`rp-strip${auto ? ' rp-strip--auto' : ''}`}
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary
          onClick={() => {
            // A manual close ends auto-opening until the page (or artifact style) changes.
            if (open) dismissed.current = true
            setAuto(false)
          }}
        >
          <Icon name="chevron" size={11} />Read next · {items.length}
        </summary>
        <StripList items={items} />
      </details>
    </div>
  )
}

function Placement({ mode, current, artifactStyle }: { mode: Mode; current: Current; artifactStyle: ArtifactStyle }) {
  const items = relatedPages(entries, current)
  const bar = <MockContextBar crumbs={crumbsFor(current)} clickableFolders={false} />
  if (items.length === 0) return <Note>No related pages: the strip is not rendered.</Note>
  return (
    <div className="rp-frame">
      <ReaderFrame bar={bar}>
        <div className="rp-stage">
          {/* key: a new page or artifact style resets the open state and the dismissal. */}
          <HtmlStage key={`${current}|${artifactStyle}`} mode={mode} current={current} artifactStyle={artifactStyle} items={items} />
        </div>
      </ReaderFrame>
    </div>
  )
}

function Concept({ theme, layout, current, artifactStyle }: Args) {
  return (
    <ConceptShell
      theme={theme}
      layout={layout}
      eyebrow="Concept · ISSUE-086 related pages, HTML artifacts"
      title="The shell strip under a real, colourful HTML artifact"
      intro="Variant A for HTML artifacts: the iframe fills the stage and scrolls inside itself, and the shell owns a strip under it. Each frame below is a real same-origin iframe with a self-contained artifact. Compare the three open/closed rules, in both shell themes and over a light and a dark artifact."
    >
      <VariantGrid wideColumns={3}>
        <Variant id="1" name="Collapsed" caption="Closed by default: costs one line of stage (about 36px) and never covers the artifact. The list is one click away.">
          <Placement mode="collapsed" current={current} artifactStyle={artifactStyle} />
          <Note>Always discoverable as a line, but easy to overlook, and readers who finish the page may not look at the bottom edge.</Note>
        </Variant>
        <Variant id="2" name="Open from the start" caption="Open by default with the list capped at 220px: shows how much stage the list takes before the reader has read anything.">
          <Placement mode="open" current={current} artifactStyle={artifactStyle} />
          <Note>The strip takes roughly a quarter to a third of this stage for the whole read; the artifact gets less room on every page.</Note>
        </Variant>
        <Variant id="3" name="Opens at the end" caption="Collapsed while reading; opens by itself when the artifact is scrolled to within 24px of its bottom.">
          <Placement mode="at-end" current={current} artifactStyle={artifactStyle} />
          <Note>
            Rule: opens when the frame is within 24px of its bottom, or the document is no taller than the frame. Focus is never moved. Closing it by hand stops auto-opening until the page changes. The opening is a short fade (off with reduced motion). Scroll the artifact to the bottom to try it.
          </Note>
        </Variant>
      </VariantGrid>
    </ConceptShell>
  )
}

const meta = {
  title: 'Concepts/Reader UX 2026-10/ISSUE-086 HTML strip',
  args: { ...conceptDefaults, current: 'en/publishing.html' as Current, artifactStyle: 'colorful-light' as ArtifactStyle },
  argTypes: {
    ...conceptArgTypes,
    current: { control: 'radio', options: ['en/publishing.html', 'ja/publishing.html', 'en/reference/cli/publish.html'] },
    artifactStyle: { control: 'radio', options: ['colorful-light', 'colorful-dark'] },
  },
  parameters: { layout: 'fullscreen' },
  render: (args: Args) => <Concept {...args} />,
} satisfies Meta<Args>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const DarkShell: Story = { args: { theme: 'dark' } }
export const DarkArtifact: Story = { args: { artifactStyle: 'colorful-dark' } }
export const DarkArtifactDarkShell: Story = { args: { artifactStyle: 'colorful-dark', theme: 'dark' } }
export const Narrow390: Story = { args: { layout: 'narrow' } }
export const Narrow390DarkArtifact: Story = { args: { layout: 'narrow', artifactStyle: 'colorful-dark' } }
