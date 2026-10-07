import { actionNames } from './build-action-repos.mjs'

const exactVersion = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)'
export function releaseSeries(tag) {
  const match = new RegExp(`^(?:(web|${actionNames.map((name) => `${name}-action`).join('|')})/)?v(${exactVersion})$`).exec(tag)
  if (!match) throw new Error(`unsupported release tag ${tag}; use vX.Y.Z, web/vX.Y.Z or <name>-action/vX.Y.Z`)
  const component = match[1] ?? 'cli'
  const prerelease = match[2].startsWith('0.')
  return { component, version: match[2], prefix: component === 'cli' ? '' : `${component}/`, action: component.endsWith('-action') ? component.slice(0, -7) : undefined, prerelease, makeLatest: component === 'cli' && !prerelease }
}
export function previousRelease(tags, tag) {
  const current = releaseSeries(tag)
  const compare = (a, b) => {
    const left = a.split('.').map(Number), right = b.split('.').map(Number)
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
  }
  return tags.flatMap((candidate) => {
    try { const series = releaseSeries(candidate); return series.component === current.component && compare(series.version, current.version) < 0 ? [{ tag: candidate, version: series.version }] : [] } catch { return [] }
  }).sort((a, b) => compare(b.version, a.version))[0]?.tag
}
