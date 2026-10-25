import { forwardRef, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { followInApp } from './spa-link'
import { Icon } from './Icon'

type IconName = Parameters<typeof Icon>[0]['name']

export type ReaderMoreMenuItem = {
  id: string
  label: string
  icon: IconName
  onSelect: () => void
  disabled?: boolean
  href?: string
  /** A toggle (Contents, Details, Pin): exposed as a pressed state through `menuitemcheckbox`. */
  checked?: boolean
  /** A radio choice among the items sharing `group`. */
  radio?: boolean
  /** A rule before this item. */
  separatorBefore?: boolean
  title?: string
}

/**
 * The narrow-screen "More" menu (ISSUE-080): a menu button whose popup holds the toolbar's secondary
 * actions. Focus moves to the first item that is not aria-disabled on open; arrows, Home and End move between items;
 * Escape closes and returns focus to the button; Tab and a click or tap outside close it.
 */
export const ReaderMoreMenu = forwardRef<HTMLButtonElement, {
  items: ReaderMoreMenuItem[]
  label?: string
  /** Tooltip of the trigger; defaults to `label`. */
  title?: string
  /** Opens the menu on mount (stories only). */
  defaultOpen?: boolean
  triggerContent?: ReactNode
  triggerClassName?: string
  triggerId?: string
  className?: string
  dismissKey?: string
  /** Called when a pointer press outside dismisses the menu (focus is not restored then). */
  onDismiss?: () => void
}>(function ReaderMoreMenu({ items, label = 'More actions', title, defaultOpen = false, onDismiss, triggerContent, triggerClassName, triggerId, className, dismissKey }, forwardedRef) {
  const [open, setOpen] = useState(defaultOpen)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()
  const previousDismissKey = useRef(dismissKey)
  useEffect(() => {
    if (previousDismissKey.current !== dismissKey) setOpen(false)
    previousDismissKey.current = dismissKey
  }, [dismissKey])

  function setTrigger(node: HTMLButtonElement | null) {
    triggerRef.current = node
    if (typeof forwardedRef === 'function') forwardedRef(node)
    else if (forwardedRef) forwardedRef.current = node
  }

  function navigableItems() {
    return [...(rootRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
  }

  function initialFocusItem() {
    const all = navigableItems()
    return all.find((node) => node.getAttribute('aria-disabled') !== 'true') ?? all[0]
  }

  useEffect(() => {
    if (!open) return
    if (!defaultOpen) initialFocusItem()?.focus()
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
      onDismiss?.()
    }
    const closeOnNavigation = () => setOpen(false)
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('popstate', closeOnNavigation)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('popstate', closeOnNavigation)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function close(restoreFocus: boolean) {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'Tab') {
      // Focus the button first (no preventDefault) so Tab continues from it, not from the page start.
      triggerRef.current?.focus()
      setOpen(false)
      return
    }
    if (event.key === ' ' && event.target instanceof HTMLAnchorElement) {
      event.preventDefault()
      event.target.click()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const list = navigableItems()
    if (list.length === 0) return
    const current = list.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? list.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length
    list[next]?.focus()
  }

  return (
    <div className={`reader-more ${className ?? ''}`} ref={rootRef}>
      <button
        ref={setTrigger}
        id={triggerId}
        type="button"
        className={`${triggerClassName ?? 'icon-button reader-more-trigger'}${open ? ' is-active' : ''}`}
        aria-label={label}
        title={title ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {triggerContent ?? <Icon name="more" size={17} />}
      </button>
      {open ? (
        <div id={menuId} className="reader-more-menu" role="menu" aria-label={label} onKeyDown={handleKeyDown}>
          {items.map((item) => (
            <div key={item.id} className="reader-more-entry" role="none">
              {item.separatorBefore ? <div className="reader-more-separator" role="separator" /> : null}
              {item.href ? <a href={item.href} className="reader-more-item" role="menuitem" tabIndex={-1} title={item.title}
                onClick={(event) => followInApp(event, () => { item.onSelect(); close(true) })}>
                <Icon name={item.icon} size={15} /><span>{item.label}</span>
              </a> : (
              <button
                type="button"
                className="reader-more-item"
                role={item.radio ? 'menuitemradio' : item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.radio || item.checked !== undefined ? Boolean(item.checked) : undefined}
                aria-disabled={item.disabled ? true : undefined}
                title={item.title}
                tabIndex={-1}
                onClick={() => {
                  if (item.disabled) return
                  item.onSelect()
                  close(true)
                }}
              >
                <Icon name={item.icon} size={15} />
                <span>{item.label}</span>
                {item.checked ? <span className="reader-more-check" aria-hidden="true">{'✓'}</span> : null}
              </button>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
})
