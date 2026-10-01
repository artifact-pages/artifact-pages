import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ArtifactIndexEntry } from '../domain/index'
import { Icon } from './Icon'

type BreadcrumbMenuState = {
  key: string
  path: string
  isDirectory: boolean
}

const ROOT_KEY = 'root'

type MenuPosition = { top: number; left: number }

export function ArtifactBreadcrumbs({
  artifactPath,
  siteTitle,
  artifacts,
  currentArtifact,
  onOpenArtifact,
  onRevealInSidebar,
}: {
  artifactPath: string
  siteTitle: string
  artifacts: ArtifactIndexEntry[]
  currentArtifact?: ArtifactIndexEntry
  onOpenArtifact: (artifact: ArtifactIndexEntry) => void
  onRevealInSidebar: (path: string, isDirectory: boolean) => void
}) {
  const navRef = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const currentLabelRef = useRef<HTMLSpanElement>(null)
  const pendingFocusKey = useRef<string | null>(null)
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>())
  const [openMenu, setOpenMenu] = useState<BreadcrumbMenuState | null>(null)
  const [position, setPosition] = useState<MenuPosition>({ top: 0, left: 0 })
  const menuId = useId()
  const segments = artifactPath.split('/').filter(Boolean)
  const menuArtifacts = openMenu
    ? getNearbyArtifacts(artifacts, openMenu.path, openMenu.isDirectory)
    : []

  useEffect(() => {
    setOpenMenu(null)
  }, [artifactPath])

  useLayoutEffect(() => {
    if (!openMenu) return

    const updatePosition = () => {
      const trigger = triggerRefs.current.get(openMenu.key)
      const menu = menuRef.current
      if (!trigger || !menu) return

      const triggerBounds = trigger.getBoundingClientRect()
      const menuBounds = menu.getBoundingClientRect()
      const top = triggerBounds.bottom + menuBounds.height + 8 <= window.innerHeight
        ? triggerBounds.bottom + 4
        : Math.max(8, triggerBounds.top - menuBounds.height - 4)
      const left = Math.max(8, Math.min(
        triggerBounds.left,
        window.innerWidth - menuBounds.width - 8,
      ))
      setPosition((current) => current.top === top && current.left === left ? current : { top, left })
    }

    updatePosition()
    const activeItem = menuRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
      ?? menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
    activeItem?.focus()

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        triggerRefs.current.get(openMenu.key)?.contains(event.target as Node)
        || menuRef.current?.contains(event.target as Node)
      ) return
      setOpenMenu(null)
    }
    const closeOnOutsideFocus = (event: FocusEvent) => {
      if (
        triggerRefs.current.get(openMenu.key)?.contains(event.target as Node)
        || menuRef.current?.contains(event.target as Node)
      ) return
      setOpenMenu(null)
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('focusin', closeOnOutsideFocus)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('focusin', closeOnOutsideFocus)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [openMenu])

  useLayoutEffect(() => {
    navRef.current?.scrollTo({ left: navRef.current.scrollWidth, behavior: 'instant' })
  }, [artifactPath])

  useLayoutEffect(() => {
    const key = pendingFocusKey.current
    if (!key) return
    pendingFocusKey.current = null
    const target = triggerRefs.current.get(key) ?? currentLabelRef.current
    target?.focus({ preventScroll: true })
  }, [artifactPath])

  function closeMenu(restoreFocus = false) {
    const trigger = openMenu ? triggerRefs.current.get(openMenu.key) : undefined
    setOpenMenu(null)
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        if (trigger?.isConnected) trigger.focus()
      })
    }
  }

  function toggleMenu(key: string, path: string, isDirectory: boolean) {
    if (openMenu?.key === key) {
      setOpenMenu(null)
      return
    }
    setOpenMenu({ key, path, isDirectory })
  }

  function chooseArtifact(artifact: ArtifactIndexEntry) {
    const current = isCurrentArtifact(artifact, currentArtifact, artifactPath)
    if (current) {
      closeMenu(true)
      return
    }
    pendingFocusKey.current = openMenu?.key ?? null
    closeMenu()
    onOpenArtifact(artifact)
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
      return
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const currentIndex = items.indexOf(document.activeElement as HTMLElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[nextIndex]?.focus()
  }

  return (
    <>
      <nav ref={navRef} className="breadcrumbs" aria-label="Artifact path">
        {segments.length === 1 ? (
          <span className={`breadcrumb-part${openMenu?.key === ROOT_KEY ? ' is-open' : ''}`}>
            <button
              ref={(element) => {
                if (element) triggerRefs.current.set(ROOT_KEY, element)
                else triggerRefs.current.delete(ROOT_KEY)
              }}
              type="button"
              className="breadcrumb-trigger"
              aria-label={`Browse artifacts in ${siteTitle}`}
              aria-haspopup="menu"
              aria-expanded={openMenu?.key === ROOT_KEY}
              aria-controls={openMenu?.key === ROOT_KEY ? menuId : undefined}
              title={siteTitle}
              onClick={() => toggleMenu(ROOT_KEY, '', true)}
            >
              <span className="breadcrumb-trigger-label">{siteTitle}</span>
              <Icon name="chevron" size={10} />
            </button>
          </span>
        ) : null}
        {segments.map((segment, segmentIndex) => {
          const isDirectory = segmentIndex < segments.length - 1
          const path = segments.slice(0, segmentIndex + 1).join('/')
          const key = `${isDirectory ? 'folder' : 'artifact'}:${path}`
          const label = isDirectory ? segment : currentArtifact?.title ?? segment

          return (
            <span className={`breadcrumb-part${openMenu?.key === key ? ' is-open' : ''}`} key={key}>
              {segmentIndex > 0 || segments.length === 1 ? <span className="breadcrumb-separator" aria-hidden="true">/</span> : null}
              {isDirectory ? (
                <button
                  ref={(element) => {
                    if (element) triggerRefs.current.set(key, element)
                    else triggerRefs.current.delete(key)
                  }}
                  type="button"
                  className="breadcrumb-trigger"
                  aria-label={`Browse artifacts in ${path}`}
                  aria-haspopup="menu"
                  aria-expanded={openMenu?.key === key}
                  aria-controls={openMenu?.key === key ? menuId : undefined}
                  title={path}
                  onClick={() => toggleMenu(key, path, true)}
                >
                  <span className="breadcrumb-trigger-label">{label}</span>
                  <Icon name="chevron" size={10} />
                </button>
              ) : (
                <span
                  ref={currentLabelRef}
                  tabIndex={-1}
                  className="breadcrumb-trigger breadcrumb-current"
                  aria-current="page"
                  title={currentArtifact?.path ?? path}
                >
                  <span className="breadcrumb-trigger-label">{label}</span>
                </span>
              )}
            </span>
          )
        })}
      </nav>

      {openMenu ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="breadcrumb-popover"
          style={{ top: position.top, left: position.left }}
          role="menu"
          aria-label={`Artifacts in ${openMenu.path || siteTitle}`}
          onKeyDown={handleMenuKeyDown}
        >
          <div className="breadcrumb-popover-heading">
            <span>{openMenu.path || siteTitle}</span>
            <small>{menuArtifacts.length} {menuArtifacts.length === 1 ? 'artifact' : 'artifacts'}</small>
          </div>
          <div className="breadcrumb-menu-list">
            {menuArtifacts.length ? menuArtifacts.map((artifact) => {
              const current = isCurrentArtifact(artifact, currentArtifact, artifactPath)
              return (
                <button
                  key={artifact.id}
                  type="button"
                  role="menuitem"
                  className={`breadcrumb-menu-item${current ? ' is-current' : ''}`}
                  aria-current={current ? 'page' : undefined}
                  aria-label={`${artifact.title}${current ? ', current artifact' : ''}, ${artifact.path}`}
                  onClick={() => chooseArtifact(artifact)}
                >
                  <Icon name="file" size={15} />
                  <span className="breadcrumb-menu-item-copy">
                    <span className="breadcrumb-menu-item-title">{artifact.title}</span>
                    <small>{menuPathLabel(artifact, openMenu.path, openMenu.isDirectory)}</small>
                  </span>
                  {current ? <span className="breadcrumb-current-badge">Current</span> : null}
                </button>
              )
            }) : (
              <p className="breadcrumb-menu-empty">No artifacts in this location.</p>
            )}
          </div>
          <div className="breadcrumb-menu-footer">
            <button
              type="button"
              role="menuitem"
              className="breadcrumb-menu-reveal"
              onClick={() => {
                const { path, isDirectory } = openMenu
                closeMenu()
                onRevealInSidebar(path, isDirectory)
              }}
            >
              <Icon name="sidebar" size={14} />
              <span>Show in sidebar</span>
            </button>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  )
}

function getNearbyArtifacts(artifacts: ArtifactIndexEntry[], path: string, isDirectory: boolean) {
  if (isDirectory && !path) {
    // Site root: the artifacts that sit directly at the top level.
    return artifacts.filter((artifact) => !artifact.path.includes('/')).sort(compareArtifacts)
  }
  if (isDirectory) {
    const prefix = `${path}/`
    return artifacts
      .filter((artifact) => artifact.path.startsWith(prefix))
      .sort(compareArtifacts)
  }

  const directory = path.split('/').slice(0, -1).join('/')
  return artifacts
    .filter((artifact) => artifact.path.split('/').slice(0, -1).join('/') === directory)
    .sort(compareArtifacts)
}

function compareArtifacts(left: ArtifactIndexEntry, right: ArtifactIndexEntry) {
  return left.title.localeCompare(right.title) || left.path.localeCompare(right.path)
}

function isCurrentArtifact(
  artifact: ArtifactIndexEntry,
  currentArtifact: ArtifactIndexEntry | undefined,
  artifactPath: string,
) {
  return artifact.path === artifactPath || artifact.id === artifactPath || artifact.id === currentArtifact?.id
}

function menuPathLabel(artifact: ArtifactIndexEntry, menuPath: string, isDirectory: boolean) {
  if (isDirectory && menuPath) return artifact.path.slice(`${menuPath}/`.length)
  return artifact.path.split('/').at(-1) ?? artifact.filename ?? artifact.path
}
