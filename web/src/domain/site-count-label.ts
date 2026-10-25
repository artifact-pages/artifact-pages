import { formatCount, type DisplayLocales } from './display-locale.ts'

export function siteCountLabel(count: number, locales?: DisplayLocales) {
  return `${formatCount(count, 'site', locales)} available`
}

export function artifactCountLabel(count: number, locales?: DisplayLocales) {
  return formatCount(count, 'artifact', locales)
}
