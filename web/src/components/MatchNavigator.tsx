import type { KeyboardEvent } from 'react'
import { matchPositionLabel } from '../domain/match-navigator'
import { Icon } from './Icon'

/** The "q  2 / 5  ↑ ↓ ×" bar over a page opened from a search. */
export function MatchNavigator({
  query,
  index,
  total,
  onStep,
  onClose,
}: {
  query: string
  /** Zero-based position of the current match. */
  index: number
  total: number
  onStep: (delta: 1 | -1) => void
  onClose: () => void
}) {
  const position = matchPositionLabel(index, total)

  // Enter steps forward and Shift+Enter back from anywhere in the bar (the
  // previous-match button reverses this); Esc closes the bar.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Enter' || (event.target as HTMLElement).closest('[data-match-nav-close]')) return
    event.preventDefault()
    const reversed = (event.target as HTMLElement).closest('[data-match-nav-previous]') !== null
    onStep(reversed === event.shiftKey ? 1 : -1)
  }

  return (
    <div className="match-nav" role="group" aria-label="Matches in this page" onKeyDown={handleKeyDown}>
      <span className="match-nav-term" tabIndex={0} title={query} aria-label={`Match ${position} for “${query}”`}>{query}</span>
      <span className="match-nav-count" aria-hidden="true">{position}</span>
      <span className="page-text-visually-hidden" role="status">{`Match ${position}`}</span>
      <button type="button" className="icon-button" data-match-nav-previous aria-label="Previous match" title="Previous match (Shift+Enter)" onClick={() => onStep(-1)}>↑</button>
      <button type="button" className="icon-button" aria-label="Next match" title="Next match (Enter)" onClick={() => onStep(1)}>↓</button>
      <button type="button" className="icon-button" data-match-nav-close aria-label="Close match navigator" title="Close (Esc)" onClick={onClose}><Icon name="close" size={13} /></button>
    </div>
  )
}
