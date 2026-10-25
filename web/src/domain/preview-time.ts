import { displayLocale, type DisplayLocales } from './display-locale.ts'

/**
 * Preview times are shown in the reader's local zone, and always name that zone
 * ("Oct 11, 2026, 3:03 PM UTC") so a reviewer elsewhere can tell when a preview
 * was built. The full-precision UTC instant is exposed separately as the
 * `<time>` element's `title`.
 */
export type PreviewTime = {
  /** Local, zone-qualified text. The input itself when it is not a valid date. */
  label: string
  /** Machine-readable instant for `<time dateTime>`; absent for an invalid date. */
  dateTime?: string
  /** Full-precision UTC instant for a tooltip; absent for an invalid date. */
  title?: string
}

export function formatPreviewTime(value: string, timeZone?: string, locales?: DisplayLocales): PreviewTime {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return { label: value }
  const label = new Intl.DateTimeFormat(displayLocale(locales), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(date)
  const iso = date.toISOString()
  return { label, dateTime: iso, title: `${iso.slice(0, 19).replace('T', ' ')} UTC` }
}
