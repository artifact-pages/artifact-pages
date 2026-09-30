export type AppRoute =
  | { kind: 'sites' }
  | { kind: 'site'; siteId: string; artifactPath?: string }
  | { kind: 'preview-list'; siteId: string; groupId?: string }
  | { kind: 'preview-document'; siteId: string; headSha: string; artifactPath: string; groupId?: string }

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function parseRoute(pathname: string, search = ''): AppRoute {
  const segments = pathname.split('/').filter(Boolean).map(decodeSegment)

  if (segments.length === 0) {
    return { kind: 'sites' }
  }

  const [siteId, ...artifactSegments] = segments
  if (artifactSegments[0] === '_previews') {
    const query = new URLSearchParams(search)
    const groupId = query.get('group') || undefined
    if (artifactSegments.length === 1) return { kind: 'preview-list', siteId, groupId }
    if (artifactSegments.length >= 3) {
      return {
        kind: 'preview-document',
        siteId,
        headSha: artifactSegments[1],
        artifactPath: artifactSegments.slice(2).join('/'),
        groupId,
      }
    }
  }
  return {
    kind: 'site',
    siteId,
    artifactPath: artifactSegments.length > 0 ? artifactSegments.join('/') : undefined,
  }
}

export function artifactRouteHref(siteId: string, artifactPath: string) {
  const encodedPath = artifactPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `/${encodeURIComponent(siteId)}/${encodedPath}`
}
