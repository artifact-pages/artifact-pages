import { artifactRouteHref } from '../routing'
import type { RelatedPage } from '../domain/related-pages'
import { followInApp } from './spa-link'
import { Icon } from './Icon'

const REASON_LABEL = { sibling: 'Same folder', similar: 'Similar topic' } as const

/**
 * "Read next" list at the end of a Markdown page (ISSUE-086). The items come from the pure
 * selector in `domain/related-pages.ts`; nothing is rendered when there are none.
 */
export function ReadNext({ items, siteId, navigate }: {
  items: readonly RelatedPage[]
  siteId: string
  navigate: (href: string) => void
}) {
  if (items.length === 0) return null
  return (
    <nav className="read-next" aria-labelledby="read-next-title" data-testid="read-next">
      <h2 id="read-next-title">Read next</h2>
      <ul>
        {items.map((item) => {
          const href = artifactRouteHref(siteId, item.entry.path)
          return (
            <li key={item.entry.path}>
              <a href={href} className="read-next-row" onClick={(event) => followInApp(event, () => navigate(href))}>
                <Icon name="file" size={15} />
                <span className="read-next-title">{item.entry.title}</span>
                <span className="read-next-meta">
                  {item.folderLabel ? <span className="read-next-folder">{item.folderLabel}/</span> : null}
                  <span className={`read-next-chip read-next-chip--${item.reason}`}>{REASON_LABEL[item.reason]}</span>
                </span>
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
