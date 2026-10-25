import { ReaderMoreMenu } from './ReaderMoreMenu'
import { Icon } from './Icon'
import { siteCountLabel } from '../domain/site-count-label'
import { formatNumber } from '../domain/display-locale'

export function SiteMenu({ title, count, homeHref, dismissKey, collapsed = false, onHome, onSwitch, onAllSites }: {
  title: string
  dismissKey?: string
  homeHref: string
  count: number
  collapsed?: boolean
  onHome: () => void
  onSwitch: () => void
  onAllSites: () => void
}) {
  return <ReaderMoreMenu
    dismissKey={dismissKey}
    className={`site-menu${collapsed ? ' site-menu-rail' : ''}`}
    triggerId={collapsed ? undefined : 'site-switcher'}
    label={`Site menu. Current site: ${title}. ${siteCountLabel(count)}`}
    triggerClassName={collapsed ? 'collapsed-rail-button collapsed-rail-site-button' : 'site-switcher'}
    triggerContent={<>
      <span className="site-mark site-mark-small" aria-hidden="true">{title.slice(0, 1).toUpperCase()}</span>
      {collapsed ? null : <><span className="site-switcher-name">{title}</span><span className="site-switcher-hint" aria-hidden="true">{formatNumber(count)}</span><Icon name="chevron" size={12} /></>}
    </>}
    items={[
      { id: 'home', label: 'Site home', icon: 'home', href: homeHref, onSelect: onHome },
      { id: 'switch', label: 'Switch site…', icon: 'arrow', onSelect: onSwitch },
      { id: 'all', label: 'All sites', icon: 'library', href: '/', onSelect: onAllSites },
    ]}
  />
}
