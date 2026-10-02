import { FullTextSearchError, type FullTextResult, type SiteFullTextSearch } from '../data/fulltext'
import type { SiteIndex } from '../domain/index'
import { searchTerms } from '../domain/text-highlight'

export type StoryFullTextBehavior = 'ready' | 'slow' | 'network-error' | 'invalid-data'

/**
 * Stands in for the generated search projection in Storybook: it searches the
 * fixture pages' title and static text with the core's AND-substring rule.
 */
export function createStoryFullTextSearch(index: SiteIndex, behavior: StoryFullTextBehavior = 'ready'): SiteFullTextSearch {
  let documents: Promise<{ path: string; text: string }[]> | undefined
  const sortedArtifacts = [...index.artifacts].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)

  function load() {
    documents ??= Promise.all(sortedArtifacts.map(async (artifact) => {
      let body = ''
      try {
        const response = await fetch(artifact.artifactUrl)
        if (response.ok) {
          const source = await response.text()
          body = artifact.format === 'markdown'
            ? source
            : new DOMParser().parseFromString(source, 'text/html').body?.textContent ?? ''
        }
      } catch {
        // Synthetic fixture entries have no file; their title is still searchable.
      }
      return { path: artifact.path, text: `${artifact.title} ${body}`.normalize('NFKC').toLowerCase() }
    }))
    return documents
  }

  async function search(query: string, { signal, offset = 0, limit = 20 }: { signal?: AbortSignal; offset?: number; limit?: number } = {}): Promise<FullTextResult> {
    signal?.throwIfAborted()
    await wait(behavior === 'slow' ? 2400 : 350, signal)
    if (behavior === 'network-error') throw new FullTextSearchError('network', 'Story network failure', 503)
    if (behavior === 'invalid-data') throw new FullTextSearchError('invalid-data', 'Story invalid data')
    const terms = searchTerms(query)
    const matches = (await load()).filter(({ text }) => terms.length > 0 && terms.every((term) => text.includes(term)))
    signal?.throwIfAborted()
    const hits = matches.slice(offset, offset + limit).map(({ path }) => ({
      id: path,
      path,
      href: `/${index.site.id}/${path.split('/').map(encodeURIComponent).join('/')}`,
    }))
    return { siteId: index.site.id, query, generation: 'story', total: matches.length, hits, hasMore: offset + hits.length < matches.length }
  }

  return { available: true, search, clear: () => { documents = undefined } }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}
