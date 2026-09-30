import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ThemeMode } from '../domain/theme'
import { themeModeIcon } from '../domain/theme'
import { Icon } from './Icon'

const themeOptions: { mode: ThemeMode; label: string; description: string }[] = [
  { mode: 'system', label: 'System', description: 'Follow your device' },
  { mode: 'light', label: 'Light', description: 'Always use light appearance' },
  { mode: 'dark', label: 'Dark', description: 'Always use dark appearance' },
]

export function ThemeSwitcher({
  mode,
  onChange,
  buttonClassName,
  iconSize = 15,
  placement = 'above',
}: {
  mode: ThemeMode
  onChange: (mode: ThemeMode) => void
  buttonClassName: string
  iconSize?: number
  placement?: 'above' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return

    selectedRef.current?.focus()
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open])

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[nextIndex]?.focus()
  }

  return (
    <div className="theme-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        className={buttonClassName}
        type="button"
        title={`Color theme: ${capitalize(mode)}`}
        aria-label={`Color theme: ${capitalize(mode)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name={themeModeIcon(mode)} size={iconSize} />
      </button>
      {open ? (
        <div
          className="theme-menu"
          data-placement={placement}
          role="menu"
          aria-label="Color theme"
          onKeyDown={handleMenuKeyDown}
        >
          <div className="theme-menu-heading">Color theme</div>
          {themeOptions.map((option) => (
            <button
              key={option.mode}
              ref={option.mode === mode ? selectedRef : undefined}
              className="theme-menu-option"
              type="button"
              role="menuitemradio"
              aria-checked={option.mode === mode}
              onClick={() => {
                onChange(option.mode)
                setOpen(false)
                triggerRef.current?.focus()
              }}
            >
              <Icon name={themeModeIcon(option.mode)} size={15} />
              <span className="theme-menu-option-copy">
                <span>{option.label}</span>
                <small>{option.description}</small>
              </span>
              <span className="theme-menu-check" aria-hidden="true">{option.mode === mode ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function capitalize(value: string) {
  return `${value[0].toUpperCase()}${value.slice(1)}`
}
