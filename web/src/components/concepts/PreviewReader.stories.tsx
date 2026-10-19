import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Icon } from '../Icon'
import { formatPreviewTime } from '../../domain/preview-time'
import { ConceptShell, Variant, Note, conceptArgTypes, conceptDefaults, type ConceptArgs } from './parts'
import { MockSidebar } from './chrome'
import { buildTree } from './data'

/* ISSUE-109 design concepts: the preview document opened inside the normal reader shell
   (left sidebar, context bar, the ISSUE-108 column) with its identity and review metadata
   placed three different ways. Frames have a fixed pixel width; the 1200 px column breakpoint
   is evaluated against the frame width, as in the ISSUE-108 concepts. Only the shell around the
   document is mocked: the document, column and context-panel CSS are the product's. */

type VariantKey = 'A' | 'B' | 'C'
type StateKey = 'pr-current' | 'manual' | 'superseded' | 'missing' | 'catalog-failed'

type DocInfo = {
  title: string
  path: string
  format: 'Markdown' | 'HTML'
  reason: 'changed' | 'dependency'
  changedResources?: string[]
}

type Scenario = {
  key: StateKey
  label: string
  /** Shown once per state in the page. */
  caption: string
  kind: 'pull-request' | 'manual'
  /** The revision in the URL. Always known, even when the preview is gone. */
  headSha: string
  /** Present only when the catalog verifies this revision as the group's current head. */
  pr?: { number: number; url: string }
  builtAt?: string
  defaultHead?: string
  mergeBase?: string
  /** For a superseded revision: what the group points to now. */
  currentHead?: string
  currentGroupId?: string
  catalog: 'ok' | 'failed'
  available: boolean
  doc: DocInfo
}

const PR_URL = 'https://github.com/artifact-pages/docs/pull/142'
const DEFAULT_HEAD = '8b1e0d7a94c2'
const MERGE_BASE = 'c41d9e6f0a37'

const publishing: DocInfo = { title: 'Publishing', path: 'en/publishing.md', format: 'Markdown', reason: 'changed' }
const gettingStarted: DocInfo = {
  title: 'Getting started',
  path: 'en/getting-started.md',
  format: 'Markdown',
  reason: 'dependency',
  changedResources: ['assets/site.css'],
}

const scenarios: Scenario[] = [
  {
    key: 'pr-current',
    label: 'PR preview, current head',
    caption: 'Catalog group pr:142 has this revision as its head, so the PR link is verified.',
    kind: 'pull-request',
    headSha: '3f9a2c1d4e5b',
    pr: { number: 142, url: PR_URL },
    builtAt: '2026-10-16T15:03:00Z',
    defaultHead: DEFAULT_HEAD,
    mergeBase: MERGE_BASE,
    catalog: 'ok',
    available: true,
    doc: publishing,
  },
  {
    key: 'manual',
    label: 'Manual preview',
    caption: 'Group head:a7d2e48b90c1. No PR exists, so none is shown or implied. This page is here because a resource it uses changed.',
    kind: 'manual',
    headSha: 'a7d2e48b90c1',
    builtAt: '2026-10-15T11:20:00Z',
    defaultHead: DEFAULT_HEAD,
    mergeBase: MERGE_BASE,
    catalog: 'ok',
    available: true,
    doc: gettingStarted,
  },
  {
    key: 'superseded',
    label: 'Older revision from a fixed link',
    caption: 'Opened from /guide/_previews/3f9a2c1d4e5b/en/publishing.md?group=pr%3A142 after a newer push. The manifest still loads; the catalog now says pr:142 points to 9e5c7b3a1d08, so no PR link is shown for this revision.',
    kind: 'pull-request',
    headSha: '3f9a2c1d4e5b',
    builtAt: '2026-10-14T09:41:00Z',
    defaultHead: DEFAULT_HEAD,
    mergeBase: MERGE_BASE,
    currentHead: '9e5c7b3a1d08',
    currentGroupId: 'pr:142',
    catalog: 'ok',
    available: true,
    doc: publishing,
  },
  {
    key: 'missing',
    label: 'Expired or missing preview',
    caption: 'The manifest request returns 404. Only the revision from the URL is known, so no build time, PR or document title is claimed.',
    kind: 'pull-request',
    headSha: '3f9a2c1d4e5b',
    catalog: 'ok',
    available: false,
    doc: publishing,
  },
  {
    key: 'catalog-failed',
    label: 'Catalog failure, revision still shown',
    caption: 'The manifest loads but the catalog request failed. The document reads normally; the PR and whether this is the latest revision are explicitly unknown.',
    kind: 'pull-request',
    headSha: '3f9a2c1d4e5b',
    builtAt: '2026-10-16T15:03:00Z',
    defaultHead: DEFAULT_HEAD,
    mergeBase: MERGE_BASE,
    catalog: 'failed',
    available: true,
    doc: publishing,
  },
]

const byKey = (key: StateKey) => scenarios.find((s) => s.key === key)!

const headings = [
  { id: 'push', level: 2, text: 'Publish on push' },
  { id: 'rules', level: 2, text: 'Publish-on rules' },
  { id: 'previews', level: 2, text: 'Previews for pull requests' },
  { id: 'trust', level: 3, text: 'Who can publish a preview' },
  { id: 'rollback', level: 2, text: 'Rolling back' },
]
const filler = [
  'Every change reaches the published site through the same path: a pull request, a green check and a publish.',
  'A preview is a review copy of the changed pages. It is built from one revision and never changes after it is built.',
  'When a newer commit is pushed, the pull request gets a new preview and this one stays reachable by its link.',
]

const shortSha = (sha: string) => sha.slice(0, 7)
const time = (value: string) => formatPreviewTime(value, 'UTC')

function Sha({ value }: { value: string }) {
  return <code className="pv-sha mono">{value}</code>
}

function Time({ value }: { value: string }) {
  const t = time(value)
  return t.dateTime ? <time dateTime={t.dateTime} title={t.title}>{t.label}</time> : <>{t.label}</>
}

/** What the identity says about the PR. Only a catalog-verified current head links to a PR. */
function prValue(s: Scenario): ReactNode {
  if (s.pr) {
    return (
      <a className="pv-link" href={s.pr.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.preventDefault()}>
        #{s.pr.number} on GitHub<Icon name="external" size={11} />
      </a>
    )
  }
  if (s.key === 'manual') return <span className="pv-muted">None (manual preview)</span>
  if (s.key === 'superseded') return <span className="pv-muted">Not linked: not a PR&apos;s current preview</span>
  if (s.key === 'catalog-failed') return <span className="pv-muted">Unknown: the catalog did not load</span>
  return <span className="pv-muted">Unavailable</span>
}

function PrimaryFacts({ s }: { s: Scenario }) {
  return (
    <dl className="pv-facts">
      <div className="pv-fact"><dt>Pull request</dt><dd>{prValue(s)}</dd></div>
      <div className="pv-fact">
        <dt>Revision</dt>
        <dd>
          <Sha value={s.headSha} />
          {s.key === 'superseded' ? <span className="pv-pill">older</span> : null}
        </dd>
      </div>
      <div className="pv-fact">
        <dt>Built</dt>
        <dd>
          {s.builtAt ? <Time value={s.builtAt} /> : <span className="pv-muted">Unavailable</span>}
          <span className="pv-hint">When this preview was built. Not when the page was edited.</span>
        </dd>
      </div>
    </dl>
  )
}

function ExpandedFacts({ s }: { s: Scenario }) {
  if (!s.available) return null
  return (
    <dl className="pv-facts pv-facts-more">
      <div className="pv-fact"><dt>Default head</dt><dd><Sha value={s.defaultHead!} /></dd></div>
      <div className="pv-fact"><dt>Merge base</dt><dd><Sha value={s.mergeBase!} /></dd></div>
      <div className="pv-fact">
        <dt>Included as</dt>
        <dd>
          {s.doc.reason === 'changed' ? 'Changed page' : 'Resource dependency'}
          {s.doc.reason === 'dependency' && s.doc.changedResources ? (
            <span className="pv-hint">The page is unchanged; it uses changed <code className="mono">{s.doc.changedResources.join(', ')}</code></span>
          ) : null}
        </dd>
      </div>
    </dl>
  )
}

function groupListHref(s: Scenario) {
  return s.kind === 'manual' ? '#manual-list' : '#pr-list'
}

function NavLinks({ s }: { s: Scenario }) {
  return (
    <span className="pv-links">
      <a href={groupListHref(s)} onClick={(e) => e.preventDefault()}>Preview list</a>
      <a href="#site" onClick={(e) => e.preventDefault()}>Published site</a>
    </span>
  )
}

/** The exceptional-state message. Normal PR and manual previews have none. */
function NoticeText({ s }: { s: Scenario }) {
  if (s.key === 'superseded') {
    return (
      <>
        <strong>Older revision.</strong> You opened <Sha value={s.headSha} /> from a saved link. The current preview for {s.currentGroupId === 'pr:142' ? 'PR #142' : 'this group'} is <Sha value={s.currentHead!} />.{' '}
        <a href="#pr-list" onClick={(e) => e.preventDefault()}>Open the current preview</a>
      </>
    )
  }
  if (s.key === 'catalog-failed') {
    return (
      <>
        <strong>Pull request details unavailable.</strong> The preview list could not be loaded, so the PR and whether this is the latest revision are not shown.{' '}
        <button type="button" className="pv-inline-button">Retry</button>
      </>
    )
  }
  return null
}

function Notice({ s }: { s: Scenario }) {
  if (s.key !== 'superseded' && s.key !== 'catalog-failed') return null
  return <p className="pv-notice" role="status"><NoticeText s={s} /></p>
}

function badgeText(s: Scenario) {
  if (s.key === 'pr-current') return `PR #${s.pr!.number}`
  if (s.key === 'manual') return 'Manual'
  if (s.key === 'superseded') return 'Older revision'
  if (s.key === 'missing') return 'Unavailable'
  return 'PR not verified'
}

// ---- shell pieces ---------------------------------------------------------

function PreviewCrumbs({ s, phone }: { s: Scenario; phone: boolean }) {
  const group = s.key === 'pr-current' ? `PR #${s.pr!.number}` : s.key === 'manual' ? `Manual ${shortSha(s.headSha)}` : null
  const last = s.available ? s.doc.title : 'Unavailable preview'
  const trail: Array<{ label: string; link: boolean }> = phone
    ? [{ label: 'Previews', link: true }, { label: last, link: false }]
    : [
        { label: 'Guide', link: true },
        { label: 'Previews', link: true },
        ...(group ? [{ label: group, link: true }] : []),
        { label: last, link: false },
      ]
  return (
    <nav className="breadcrumbs rux-crumbs pv-crumbs" aria-label="Path">
      {trail.map((crumb, i) => (
        <span className="breadcrumb-part" key={`${crumb.label}-${i}`}>
          {i > 0 ? <span className="breadcrumb-separator" aria-hidden="true">/</span> : null}
          {crumb.link ? (
            <a href="#crumb" className="rux-crumb-link" onClick={(e) => e.preventDefault()}>{crumb.label}</a>
          ) : (
            <span className="breadcrumb-current">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}

function PreviewSidebar({ s }: { s: Scenario }) {
  const item = (title: string, active?: boolean) => (
    <div className="tree-artifact-row" key={title}>
      <a href="#page" className={`tree-artifact${active ? ' is-active' : ''}`} style={{ paddingInlineStart: 10 }} onClick={(e) => e.preventDefault()}>
        <span className="tree-label">{title}</span>
      </a>
    </div>
  )
  const publishedLink = (
    <div className="sidebar-section pv-side-site">
      <a href="#site" onClick={(e) => e.preventDefault()}><Icon name="library" size={13} />Browse the published Guide</a>
      <span>The published site is separate from this preview.</span>
    </div>
  )
  const title = s.key === 'pr-current' ? `PR #${s.pr!.number} · ${shortSha(s.headSha)}` : s.key === 'manual' ? `Manual · ${shortSha(s.headSha)}` : `Revision ${shortSha(s.headSha)}`
  return (
    <MockSidebar siteTitle="Guide" root={buildTree([])} expanded={[]}>
      {s.available ? (
        <>
          <div className="sidebar-section">
            <div className="sidebar-section-title"><span className="sidebar-section-label"><Icon name="tree" size={12} />This preview</span></div>
            <p className="pv-side-id">{title}</p>
            <p className="pv-side-group">Changed pages</p>
            {s.key === 'manual' ? null : item('Previews')}
            {item(s.key === 'manual' ? 'Reading' : 'Publishing', s.key !== 'manual')}
            <p className="pv-side-group">Affected by a resource change</p>
            {item('Getting started', s.key === 'manual')}
            {item('Configuration')}
          </div>
          {publishedLink}
        </>
      ) : (
        <>
          <div className="sidebar-section">
            <div className="sidebar-section-title"><span className="sidebar-section-label"><Icon name="tree" size={12} />This preview</span></div>
            <p className="pv-side-id">Revision {shortSha(s.headSha)}</p>
            <p className="pv-side-empty">Its pages cannot be listed because the preview is not available.</p>
          </div>
          {publishedLink}
        </>
      )}
    </MockSidebar>
  )
}

function Article({ doc }: { doc: DocInfo }) {
  return (
    <article className="markdown-article">
      <h1>{doc.title}</h1>
      <p>{filler[0]}</p>
      {headings.map((h) => {
        const Tag = h.level === 2 ? 'h2' : 'h3'
        return (
          <div key={h.id}>
            <Tag id={h.id}>{h.text}</Tag>
            <p>{filler[h.text.length % 3]}</p>
            {h.level === 2 ? <p>{filler[(h.text.length + 1) % 3]}</p> : null}
          </div>
        )
      })}
    </article>
  )
}

function Gone({ s }: { s: Scenario }) {
  return (
    <div className="pv-gone" role="status">
      <p className="rux-eyebrow">Guide · Preview</p>
      <h1>This preview is no longer available</h1>
      <p>Revision <Sha value={s.headSha} /> could not be found. It may have expired or been removed. The published site is not affected.</p>
      <p className="pv-gone-actions">
        <a className="context-button" href="#pr-list" onClick={(e) => e.preventDefault()}><Icon name="arrow" size={13} /><span>Preview list</span></a>
        <a className="context-button" href="#site" onClick={(e) => e.preventDefault()}><Icon name="library" size={13} /><span>Published site</span></a>
      </p>
    </div>
  )
}

function TocList({ activeId }: { activeId: string }) {
  return (
    <nav className="toc-list" aria-label="Artifact headings">
      {headings.map((h) => (
        <button
          key={h.id}
          type="button"
          className={`toc-link${h.level === 3 ? ' toc-level-3' : ''}`}
          aria-current={activeId === h.id ? 'location' : undefined}
          title={h.text}
        >
          {h.text}
        </button>
      ))}
    </nav>
  )
}

/** Details of a preview document. It never shows an edit date or authorship: a preview has neither. */
function PreviewDocDetails({ doc }: { doc: DocInfo }) {
  return (
    <div className="artifact-details">
      <dl className="details-facts pv-doc-facts">
        <div className="pv-fact"><dt>Path</dt><dd className="mono pv-path">{doc.path}</dd></div>
        <div className="pv-fact"><dt>Format</dt><dd>{doc.format}</dd></div>
      </dl>
      <p className="pv-note">Last edit and source details belong to the published page and are not shown for a preview.</p>
    </div>
  )
}

function PreviewMore({ s, open, onToggle }: { s: Scenario; open: boolean; onToggle: () => void }) {
  return (
    <>
      <button type="button" className="pv-more" aria-expanded={open} onClick={onToggle}>
        <Icon name="chevron" size={10} />{open ? 'Fewer details' : 'More details'}
      </button>
      {open ? <ExpandedFacts s={s} /> : null}
    </>
  )
}

/** Variant B: a Preview section at the top of the column, above Details. */
function PreviewSection({ s, open, onToggle }: { s: Scenario; open: boolean; onToggle: () => void }) {
  return (
    <section className="pv-section" aria-labelledby="pv-section-heading">
      <h2 id="pv-section-heading" className="reader-column-heading">Preview</h2>
      <PrimaryFacts s={s} />
      <NavLinks s={s} />
      <PreviewMore s={s} open={open} onToggle={onToggle} />
    </section>
  )
}

// ---- the frame --------------------------------------------------------------

function Frame({ variant, s, width, open: initialOpen, shot }: { variant: VariantKey; s: Scenario; width: number; open: boolean; shot: string }) {
  const wide = width >= 1200
  const phone = width <= 620
  const [open, setOpen] = useState(initialOpen)
  const [panel, setPanel] = useState<'contents' | 'details' | null>(!wide && variant === 'B' && initialOpen && s.available ? 'details' : null)
  const toggle = (p: 'contents' | 'details') => setPanel((cur) => (cur === p ? null : p))
  const showColumn = wide && s.available
  const showOverlay = !wide && s.available
  const tag = (
    <span className="pv-tag" title={`Preview ${s.headSha}`}>
      <span className="pv-tag-dot" aria-hidden="true" />Preview{!phone ? ` · ${s.key === 'pr-current' ? `PR #${s.pr!.number}` : shortSha(s.headSha)}` : ''}
    </span>
  )
  const chip = (
    <button type="button" className="pv-chip" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((v) => !v)}>
      <span className="pv-tag-dot" aria-hidden="true" />
      <span className="pv-chip-label">Preview</span>
      <span className="pv-chip-sep" aria-hidden="true">·</span>
      <span>{s.key === 'pr-current' ? `PR #${s.pr!.number}` : s.key === 'manual' ? 'Manual' : s.key === 'superseded' ? 'Older' : s.key === 'missing' ? 'Unavailable' : 'PR unknown'}</span>
      <span className="pv-chip-sep" aria-hidden="true">·</span>
      <span className="mono">{shortSha(s.headSha)}</span>
      <Icon name="chevron" size={10} />
    </button>
  )
  const label = `${width} px · ${wide ? 'right column' : 'no right column'}${phone ? ' · one-row chrome' : ''}`

  return (
    <div className="rc-frame-wrap">
      <p className="rc-frame-label">{label}</p>
      <div className={`rux-reader pv-frame${phone ? ' pv-frame-phone' : ''}`} style={{ width }} data-shot={shot} data-testid={shot}>
        {phone ? null : <PreviewSidebar s={s} />}
        <div className="rux-workspace">
          <header className="context-bar rux-context-bar">
            {phone ? <button type="button" className="icon-button" aria-label="Open navigation"><Icon name="sidebar" size={17} /></button> : null}
            <PreviewCrumbs s={s} phone={phone} />
            {variant === 'B' ? tag : null}
            {variant === 'C' && !phone ? chip : null}
            <div className="context-actions">
              {showOverlay ? (
                <button type="button" className={`context-button${panel === 'contents' ? ' is-active' : ''}`} aria-label="Contents" aria-expanded={panel === 'contents'} onClick={() => toggle('contents')}>
                  <Icon name="contents" size={14} />
                </button>
              ) : null}
              {showOverlay ? (
                <button type="button" className={`context-button${panel === 'details' ? ' is-active' : ''}`} aria-label="Details" aria-expanded={panel === 'details'} onClick={() => toggle('details')}>
                  <Icon name="info" size={14} />
                </button>
              ) : null}
              {phone ? (
                <button type="button" className="context-button" aria-label="More"><Icon name="more" size={14} /></button>
              ) : (
                <button type="button" className="context-button" aria-label="Copy link"><Icon name="copy" size={14} /><span>Copy link</span></button>
              )}
            </div>
          </header>

          {variant === 'A' ? (
            <section className="pv-banner" aria-label="Preview identity">
              <div className="pv-banner-line">
                <span className="pv-badge">Preview</span>
                <span className="pv-banner-id">
                  {s.key === 'pr-current' ? <>Pull request #{s.pr!.number}</> : s.key === 'manual' ? <>Manual preview</> : s.key === 'superseded' ? <>Older revision</> : s.key === 'missing' ? <>Unavailable</> : <>PR not verified</>}
                  <span className="pv-banner-sep" aria-hidden="true">·</span>
                  {s.key === 'superseded' ? null : 'revision '}<Sha value={s.headSha} />
                  {s.builtAt ? (
                    <>
                      <span className="pv-banner-sep" aria-hidden="true">·</span>
                      built <Time value={s.builtAt} /> <span className="pv-hint-inline">(preview build time)</span>
                    </>
                  ) : null}
                </span>
                <span className="pv-banner-actions">
                  {s.pr ? (
                    <a className="pv-link" href={s.pr.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.preventDefault()}>
                      Open PR #{s.pr.number}<Icon name="external" size={11} />
                    </a>
                  ) : null}
                  <NavLinks s={s} />
                  {s.available ? (
                    <button type="button" className="pv-more pv-more-banner" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                      <Icon name="chevron" size={10} />Details
                    </button>
                  ) : null}
                </span>
              </div>
              {s.key === 'superseded' || s.key === 'catalog-failed' ? <p className="pv-notice pv-notice-in" role="status"><NoticeText s={s} /></p> : null}
              {open && s.available ? (
                <div className="pv-banner-more">
                  <ExpandedFacts s={s} />
                            </div>
              ) : null}
            </section>
          ) : null}

          {variant === 'C' && phone ? <div className="pv-chip-row">{chip}</div> : null}
          {variant !== 'A' ? <Notice s={s} /> : null}

          <div className="pv-stage">
            {!s.available ? (
              <div className="markdown-scroll"><Gone s={s} /></div>
            ) : showColumn ? (
              <div className="markdown-scroll has-aside" data-scroll-pane>
                <div className="markdown-split">
                  <div className="markdown-split-main"><Article doc={s.doc} /></div>
                  <aside className="reader-column" aria-label="Reading context" lang="en">
                    {variant === 'B' ? <PreviewSection s={s} open={open} onToggle={() => setOpen((v) => !v)} /> : null}
                    <section className={variant === 'B' ? 'reader-column-details pv-details-after' : 'reader-column-details'} aria-label="Details">
                      <h2 className="reader-column-heading">Details</h2>
                      <PreviewDocDetails doc={s.doc} />
                    </section>
                    <section className="reader-column-contents" aria-label="Contents">
                      <h2 className="reader-column-heading">Contents</h2>
                      <TocList activeId="previews" />
                    </section>
                  </aside>
                </div>
              </div>
            ) : (
              <div className="markdown-scroll" data-scroll-pane><Article doc={s.doc} /></div>
            )}

            {showOverlay && panel === 'contents' ? (
              <aside className="context-panel" aria-label="Contents">
                <div className="context-panel-header">
                  <span>Contents</span>
                  <button type="button" className="context-panel-close" aria-label="Close Contents" onClick={() => setPanel(null)}><Icon name="close" size={14} /></button>
                </div>
                <TocList activeId="previews" />
              </aside>
            ) : null}
            {showOverlay && panel === 'details' ? (
              <aside className="context-panel pv-panel-details" aria-label="Details">
                <div className="context-panel-header">
                  <span>Details</span>
                  <button type="button" className="context-panel-close" aria-label="Close Details" onClick={() => setPanel(null)}><Icon name="close" size={14} /></button>
                </div>
                <div className="pv-panel-body">
                  {variant === 'B' ? <PreviewSection s={s} open={open} onToggle={() => setOpen((v) => !v)} /> : null}
                  <PreviewDocDetails doc={s.doc} />
                </div>
              </aside>
            ) : null}

            {variant === 'C' && open ? (
              <aside className="context-panel pv-pop" aria-label="Preview details">
                <div className="context-panel-header">
                  <span>Preview</span>
                  <button type="button" className="context-panel-close" aria-label="Close Preview details" onClick={() => setOpen(false)}><Icon name="close" size={14} /></button>
                </div>
                <div className="pv-panel-body">
                  <PrimaryFacts s={s} />
                  <NavLinks s={s} />
                  <ExpandedFacts s={s} />
                </div>
              </aside>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- page -----------------------------------------------------------------

type FrameSpec = { s: Scenario; open: boolean; suffix: string; label: string }

function framesFor(dark: boolean): FrameSpec[] {
  if (dark) {
    return [
      { s: byKey('pr-current'), open: false, suffix: 'pr-current', label: 'PR preview, current head' },
      { s: byKey('pr-current'), open: true, suffix: 'pr-expanded', label: 'PR preview, metadata expanded' },
    ]
  }
  return [
    { s: byKey('pr-current'), open: false, suffix: 'pr-current', label: 'PR preview, current head' },
    { s: byKey('pr-current'), open: true, suffix: 'pr-expanded', label: 'PR preview, metadata expanded' },
    ...scenarios.slice(1).map((s) => ({ s, open: false, suffix: s.key, label: s.label })),
  ]
}

function VariantFrames({ variant, dark }: { variant: VariantKey; dark: boolean }) {
  const widths = [1440, 390]
  return (
    <div className="rc-frames">
      {framesFor(dark).map((f) => (
        <div className="pv-state" key={f.suffix}>
          <h3 className="pv-state-title">{f.label}</h3>
          <p className="pv-state-caption">{f.suffix === 'pr-expanded' ? 'Same revision as the first state with the extra fields opened: default head, merge base and why the page is included.' : f.s.caption}</p>
          {widths.map((w) => (
            <Frame key={w} variant={variant} s={f.s} width={w} open={f.open} shot={`${variant}-${f.suffix}-${w}${dark ? '-dark' : ''}`} />
          ))}
        </div>
      ))}
    </div>
  )
}

function Concept({ theme, layout }: ConceptArgs) {
  const dark = theme === 'dark'
  return (
    <ConceptShell
      theme={theme}
      layout={layout}
      eyebrow="ISSUE-109 · Preview reader"
      title="A preview opened inside the normal reader"
      intro="Every frame uses the reader shell: left sidebar (scoped to the preview, with a link to the published site), context bar and the ISSUE-108 column at 1200 px and wider. Below that the Contents and Details buttons open the existing panels (click them). Only the placement of preview identity and review metadata differs between the variants. The same five states are shown at 1440 px and 390 px."
    >
      <Variant id="A" name="Banner under the context bar" caption="One full-width strip names the preview, the revision and the build time, and carries the PR, list and site links. A Details toggle opens default head, merge base, why the page is included and the raw link. Older-revision and catalog notices share the strip.">
        <VariantFrames variant="A" dark={dark} />
      </Variant>
      <Variant id="B" name="Preview section at the top of the column" caption="The column gets a Preview section above Details. A small Preview tag stays in the context bar at every width. Below 1200 px the section moves into the top of the Details panel.">
        <VariantFrames variant="B" dark={dark} />
      </Variant>
      <Variant id="C" name="Compact identity chip with a panel" caption="A single chip (Preview, PR or kind, short revision) sits in the context bar, or in a row under it on a phone. It opens a panel with the full primary and expanded fields. The column keeps only document Details and Contents.">
        <VariantFrames variant="C" dark={dark} />
      </Variant>
      <Note>All dates are illustrative. Build times are shown in the reader&apos;s zone with the zone named, using the product&apos;s preview time formatter (UTC here so the pictures are reproducible). Details never shows an Updated date, a source repository or a last committer for a preview document. The PR link appears only when the catalog verifies the revision as the group&apos;s current head.</Note>
      <Note>HTML preview documents use the same shell: the frame fills the stage and the column scrolls beside it, as in ISSUE-108. They are not drawn separately here.</Note>
    </ConceptShell>
  )
}

const meta = {
  title: 'Concepts/Reader UX 2026-10/ISSUE-109 Preview reader',
  args: conceptDefaults,
  argTypes: conceptArgTypes,
  parameters: { layout: 'fullscreen' },
  render: (args: ConceptArgs) => <Concept {...args} />,
} satisfies Meta<ConceptArgs>

export default meta
type Story = StoryObj<typeof meta>

export const Light: Story = {}
export const Dark: Story = { args: { theme: 'dark' } }
