import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ArtifactIndexEntry } from '../domain/index'
import { Icon } from './Icon'

export function ArtifactActionsMenu({
  artifact,
  pinned,
  sourceUrl,
  historyUrl,
  rawUrl,
  onTogglePin,
  onCopyLink,
}: {
  artifact: ArtifactIndexEntry
  pinned: boolean
  sourceUrl?: string
  historyUrl?: string
  rawUrl?: string
  onTogglePin: () => void
  onCopyLink: () => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const trigger = triggerRef.current
      const menu = menuRef.current
      if (!trigger || !menu) return

      const triggerBounds = trigger.getBoundingClientRect()
      const menuBounds = menu.getBoundingClientRect()
      const top = triggerBounds.bottom + menuBounds.height + 8 <= window.innerHeight
        ? triggerBounds.bottom + 4
        : Math.max(8, triggerBounds.top - menuBounds.height - 4)
      const left = Math.max(8, Math.min(triggerBounds.right - menuBounds.width, window.innerWidth - menuBounds.width - 8))
      setPosition({ top, left })
    }

    updatePosition()
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (triggerRef.current?.contains(event.target as Node) || menuRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  function close(restoreFocus = false) {
    setOpen(false)
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        if (triggerRef.current?.isConnected) {
          triggerRef.current.focus()
          return
        }

        const browseRow = [...document.querySelectorAll<HTMLButtonElement>('.browse-tree .tree-artifact')]
          .find((row) => row.dataset.treePath === artifact.path)
        const nextTarget = browseRow
          ?? document.querySelector<HTMLButtonElement>('.browse-tree .tree-directory-button')
          ?? document.querySelector<HTMLInputElement>('.sidebar-filter input')
        nextTarget?.focus()
      })
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }

    if (event.key.toLocaleLowerCase() === 'p') {
      event.preventDefault()
      onTogglePin()
      close(true)
      return
    }

    if (event.key.toLocaleLowerCase() === 'l') {
      event.preventDefault()
      onCopyLink()
      close(true)
      return
    }

    if (event.key === ' ' && event.target instanceof HTMLElement) {
      event.preventDefault()
      event.target.click()
      return
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
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
      <button
        ref={triggerRef}
        type="button"
        className="tree-action-trigger"
        aria-label={`Actions for ${artifact.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title={`Actions for ${artifact.title}`}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((current) => !current)
        }}
      >
        <Icon name="more" size={15} />
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="artifact-action-menu"
          style={{ top: position.top, left: position.left }}
          role="menu"
          aria-label={`${artifact.title} actions`}
          onKeyDown={handleKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            className="artifact-action-menu-item"
            onClick={() => {
              onTogglePin()
              close(true)
            }}
          >
            <Icon name="pin" size={14} />
            <span>{pinned ? 'Unpin' : 'Pin'}</span>
            <kbd>P</kbd>
          </button>
          <div className="artifact-action-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="artifact-action-menu-item"
            onClick={() => {
              onCopyLink()
              close(true)
            }}
          >
            <Icon name="copy" size={14} />
            <span>Copy link</span>
            <kbd>L</kbd>
          </button>
          <MenuLink href={sourceUrl} label="Open source" icon="external" onNavigate={() => close()} />
          <MenuLink href={historyUrl} label="View history" icon="history" onNavigate={() => close()} />
          <MenuLink href={rawUrl} label="Open raw artifact" icon="external" onNavigate={() => close()} />
        </div>,
        document.body,
      ) : null}
    </>
  )
}

function MenuLink({
  href,
  label,
  icon,
  onNavigate,
}: {
  href?: string
  label: string
  icon: 'external' | 'history'
  onNavigate: () => void
}) {
  if (!href) {
    return (
      <button type="button" role="menuitem" className="artifact-action-menu-item" disabled title="Source metadata is unavailable">
        <Icon name={icon} size={14} />
        <span>{label}</span>
      </button>
    )
  }

  return (
    <a
      className="artifact-action-menu-item"
      role="menuitem"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onNavigate}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
    </a>
  )
}
