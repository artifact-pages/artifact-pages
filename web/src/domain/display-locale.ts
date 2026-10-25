/** Display formatting only: artifact text, timestamps and numeric data stay unchanged. */
export type DisplayLocales = string | readonly string[]

const numbers = new Map<string, Intl.NumberFormat>()
const dates = new Map<string, Intl.DateTimeFormat>()

function browserLocales(): DisplayLocales {
  return typeof navigator === 'undefined' ? 'en-US' : navigator.languages?.length ? navigator.languages : navigator.language || 'en-US'
}

function numberFormatter(locales: DisplayLocales = browserLocales()) {
  const key = JSON.stringify(locales)
  let formatter = numbers.get(key)
  if (!formatter) {
    try { formatter = new Intl.NumberFormat(typeof locales === 'string' ? locales : [...locales]) }
    catch { formatter = new Intl.NumberFormat('en-US') }
    numbers.set(key, formatter)
  }
  return formatter
}

export function displayLocale(locales?: DisplayLocales) {
  return numberFormatter(locales).resolvedOptions().locale
}

export function formatNumber(value: number, locales?: DisplayLocales) {
  return numberFormatter(locales).format(value)
}

function dateLabel(value: string, long: boolean, locales?: DisplayLocales) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  const locale = displayLocale(locales)
  const key = `${locale}:${long}`
  let formatter = dates.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...(long ? { year: 'numeric' as const } : {}), month: 'short', day: 'numeric' })
    dates.set(key, formatter)
  }
  return formatter.format(date)
}

export function formatDate(value: string, locales?: DisplayLocales) { return dateLabel(value, false, locales) }
export function formatLongDate(value: string, locales?: DisplayLocales) { return dateLabel(value, true, locales) }

export function formatCount(count: number, unit: 'page' | 'site' | 'artifact' | 'folder', locales?: DisplayLocales) {
  const number = formatNumber(count, locales)
  if (displayLocale(locales).split('-')[0] === 'ja') {
    return `${number}${{ page: 'ページ', site: 'サイト', artifact: 'アーティファクト', folder: 'フォルダー' }[unit]}`
  }
  return `${number} ${unit}${count === 1 ? '' : 's'}`
}
