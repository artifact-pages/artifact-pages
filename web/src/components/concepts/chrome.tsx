import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../Icon'
import { countPages, type DirNode } from './data'

/** Mock reader chrome shared by several concepts. Uses production classes from styles.css. */

export function MockSidebar({
  siteTitle,
  root,
  activeDir,
  activePage,
  expanded,
  children,
  splitFolderRow = true,
  query,
  scopeChip,
}: {
  siteTitle: string
  root: DirNode
  activeDir?: string
  activePage?: string
  expanded: string[]
  children?: ReactNode
  /** ISSUE-075: the folder label is a link and only the chevron toggles. */
  splitFolderRow?: boolean
  /** ISSUE-077: committed page text query. */
  query?: string
  scopeChip?: ReactNode
}) {
  return (
    <aside className="sidebar-panel sidebar-panel--refined tree-style-branch-guides rux-sidebar" aria-label={`${siteTitle} navigation`}>
      <div className="sidebar-top">
        <div className="sidebar-top-row">
          <button type="button" className="site-switcher">
            <span className="site-mark site-mark-small" aria-hidden="true">{siteTitle.slice(0, 1)}</span>
            <span className="site-switcher-name">{siteTitle}</span>
            <Icon name="chevron" size={12} />
          </button>
          <button type="button" className="icon-button" aria-label="Collapse sidebar"><Icon name="sidebar" size={16} /></button>
        </div>
        <div className="sidebar-filter page-text-search-bar">
          <Icon name="search" size={14} />
          <input readOnly value={query ?? ''} placeholder="Search page text…" aria-label="Search page text" />
        </div>
        {scopeChip}
      </div>
      <nav className="sidebar-body" aria-label="Artifacts">
        {children ?? (
          <div className="sidebar-section browse-tree">
            <div className="sidebar-section-title"><span className="sidebar-section-label"><Icon name="tree" size={12} />Browse</span></div>
            <div className="artifact-tree tree-view-tree tree-style-branch-guides">
              <TreeNodes node={root} depth={0} expanded={expanded} activeDir={activeDir} activePage={activePage} split={splitFolderRow} />
            </div>
          </div>
        )}
      </nav>
    </aside>
  )
}

function TreeNodes({
  node,
  depth,
  expanded,
  activeDir,
  activePage,
  split,
}: {
  node: DirNode
  depth: number
  expanded: string[]
  activeDir?: string
  activePage?: string
  split: boolean
}) {
  return (
    <>
      {node.dirs.map((dir) => {
        const open = expanded.includes(dir.path)
        const active = dir.path === activeDir
        return (
          <div className="tree-directory" key={dir.path}>
            {split ? (
              <div className={`rux-dir-row${active ? ' is-active' : ''}`} style={{ paddingInlineStart: 3 + depth * 14 }}>
                <button type="button" className="rux-dir-chevron" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${dir.name}`}>
                  <Icon name="chevron" size={11} />
                </button>
                <a href="#dir" className="rux-dir-label" aria-current={active ? 'page' : undefined} onClick={(e) => e.preventDefault()}>
                  <span className="tree-label">{dir.name}</span>
                  <span className="tree-count">{countPages(dir)}</span>
                </a>
              </div>
            ) : (
              <button type="button" className="tree-directory-button" aria-expanded={open} style={{ paddingInlineStart: 9 + depth * 14 }}>
                <Icon name="chevron" size={11} />
                <span className="tree-label">{dir.name}</span>
                <span className="tree-count">{countPages(dir)}</span>
              </button>
            )}
            {open ? (
              <div className="tree-children tree-children-branch-guides">
                <TreeNodes node={dir} depth={depth + 1} expanded={expanded} activeDir={activeDir} activePage={activePage} split={split} />
              </div>
            ) : null}
          </div>
        )
      })}
      {node.pages.map((p) => (
        <div className="tree-artifact-row" key={p.path}>
          <a
            href="#page"
            className={`tree-artifact${p.path === activePage ? ' is-active' : ''}`}
            style={{ paddingInlineStart: 10 + depth * 14 }}
            onClick={(e) => e.preventDefault()}
          >
            <span className="tree-label">{p.title}</span>
          </a>
        </div>
      ))}
    </>
  )
}

export type Crumb = { label: string; link?: boolean }

/** Breadcrumb with clickable folder segments; the old sibling menu survives as the small chevron. */
export function MockBreadcrumbs({ crumbs, clickableFolders = true }: { crumbs: Crumb[]; clickableFolders?: boolean }) {
  return (
    <nav className="breadcrumbs rux-crumbs" aria-label="Path">
      {crumbs.map((crumb, i) => {
        const last = i === crumbs.length - 1
        return (
          <Fragment key={`${crumb.label}-${i}`}>
            <span className="breadcrumb-part">
              {i > 0 ? <span className="breadcrumb-separator" aria-hidden="true">/</span> : null}
              {last ? (
                <span className="breadcrumb-current">{crumb.label}</span>
              ) : clickableFolders ? (
                <>
                  <a href="#crumb" className="rux-crumb-link" onClick={(e) => e.preventDefault()}>{crumb.label}</a>
                  <button type="button" className="rux-crumb-menu" aria-label={`Siblings of ${crumb.label}`}><Icon name="chevron" size={10} /></button>
                </>
              ) : (
                <button type="button" className="breadcrumb-trigger"><span className="breadcrumb-trigger-label">{crumb.label}</span><Icon name="chevron" size={10} /></button>
              )}
            </span>
          </Fragment>
        )
      })}
    </nav>
  )
}

export function MockContextBar({ crumbs, clickableFolders = true }: { crumbs: Crumb[]; clickableFolders?: boolean }) {
  return (
    <header className="context-bar rux-context-bar">
      <MockBreadcrumbs crumbs={crumbs} clickableFolders={clickableFolders} />
      <div className="context-actions">
        <button type="button" className="context-button"><Icon name="library" size={14} /><span>All sites</span></button>
        <button type="button" className="context-button"><Icon name="pin" size={14} /><span>Pin</span></button>
      </div>
    </header>
  )
}

/** Desktop frame: sidebar + workspace panel. */
export function ReaderFrame({ sidebar, bar, children }: { sidebar?: ReactNode; bar: ReactNode; children: ReactNode }) {
  return (
    <div className="rux-reader" data-has-sidebar={sidebar ? 'true' : 'false'}>
      {sidebar}
      <div className="rux-workspace">
        {bar}
        <div className="rux-pane">{children}</div>
      </div>
    </div>
  )
}
