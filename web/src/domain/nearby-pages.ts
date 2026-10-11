import type { ArtifactIndexEntry } from './index'

const EXTENSION = /\.(?:html?|md|markdown)$/i
const WEAK_WORDS = new Set(['index', 'readme', 'html', 'md'])

function words(value: string) {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2 && !WEAK_WORDS.has(word))
}

/**
 * Existing pages close to a path that matched nothing, best first: pages whose
 * path or title share words with the requested path, with a bonus for each leading
 * folder they share (so `guide/en/nope.html` offers the pages under `guide/en/`
 * first). Pages with nothing in common are never offered.
 */
export function nearbyArtifacts(
  artifacts: readonly ArtifactIndexEntry[],
  requestedPath: string,
  limit = 5,
): ArtifactIndexEntry[] {
  const segments = requestedPath.split('/').filter(Boolean)
  if (segments.length === 0) return []
  const requestedWords = [...new Set(words(segments.map((segment) => segment.replace(EXTENSION, '')).join(' ')))]
  const scored: Array<{ artifact: ArtifactIndexEntry; score: number }> = []

  for (const artifact of artifacts) {
    const pathSegments = artifact.path.split('/').filter(Boolean)
    const folders = pathSegments.slice(0, -1)
    let shared = 0
    while (shared < folders.length && shared < segments.length && folders[shared].toLowerCase() === segments[shared].toLowerCase()) shared += 1

    const artifactWords = new Set(words(`${artifact.path.replace(EXTENSION, '')} ${artifact.title}`))
    const haystack = `${artifact.path} ${artifact.title}`.toLowerCase()
    let score = shared * 2
    for (const word of requestedWords) {
      if (artifactWords.has(word)) score += 3
      else if (word.length >= 4 && haystack.includes(word)) score += 1
    }
    if (score > 0) scored.push({ artifact, score })
  }

  return scored
    .sort((left, right) => right.score - left.score || (left.artifact.path < right.artifact.path ? -1 : 1))
    .slice(0, limit)
    .map(({ artifact }) => artifact)
}
