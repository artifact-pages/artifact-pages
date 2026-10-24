import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

/** A temporary Contents panel. The native modal keeps even iframe content out of the Tab order. */
export function ContentsDialog({ host, onDismiss, children }: {
  host: RefObject<HTMLElement | null>
  onDismiss: () => void
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    const dialog = dialogRef.current
    const stage = host.current
    if (!dialog || !stage) return
    function position() {
      const rect = stage!.getBoundingClientRect()
      dialog!.style.top = `${rect.top + 9}px`
      dialog!.style.right = `${Math.max(12, window.innerWidth - rect.right + 12)}px`
      dialog!.style.maxHeight = `${Math.max(80, rect.height - 18)}px`
    }
    position()
    dialog.showModal()
    // A More-menu choice restores its trigger synchronously. Take focus after that hand-off,
    // including when another effect has just dismissed the command palette.
    const focus = window.requestAnimationFrame(() => {
      if (!dialog.contains(document.activeElement)) dialog.querySelector<HTMLButtonElement>('button')?.focus()
    })
    const observer = new ResizeObserver(position)
    observer.observe(stage)
    window.addEventListener('resize', position)
    return () => {
      window.cancelAnimationFrame(focus)
      observer.disconnect()
      window.removeEventListener('resize', position)
      dialog.close()
    }
  }, [host])

  return (
    <dialog
      ref={dialogRef}
      className="context-panel contents-dialog"
      aria-label="Contents"
      aria-modal="true"
      onCancel={(event) => { event.preventDefault(); dismissRef.current() }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
        if (event.key !== 'Tab') return
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]')]
          .filter((item) => item.getClientRects().length > 0)
        const first = items[0], last = items.at(-1)
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
          dismissRef.current()
        }
      }}
    >{children}</dialog>
  )
}
