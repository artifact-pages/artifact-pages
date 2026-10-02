import { useCallback, useEffect, useRef, useState } from 'react'
import { FullTextSearchError, type FullTextHit, type SiteFullTextSearch } from '../data/fulltext'

export const PAGE_TEXT_SEARCH_PAGE_SIZE = 20
/** The full-text client rejects longer queries. */
export const PAGE_TEXT_SEARCH_MAX_QUERY_LENGTH = 4096

export type PageTextSearchState =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'error'; query: string; error: Error }
  | {
      status: 'success'
      query: string
      /** Search data generation of every listed hit; later pages must match it. */
      generation: string | null
      total: number
      hits: FullTextHit[]
      hasMore: boolean
      more: 'idle' | 'loading' | 'error'
    }

const MAX_PAGE_LIMIT = 1000

/**
 * Runs the committed query against the site's full-text client. Only the latest
 * query may update the state: changing or clearing it aborts the older search.
 */
export function usePageTextSearch(client: SiteFullTextSearch | undefined, query: string) {
  const [state, setState] = useState<PageTextSearchState>({ status: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const moreController = useRef<AbortController | null>(null)

  useEffect(() => {
    moreController.current?.abort()
    if (!client?.available || !query) {
      setState({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    setState({ status: 'loading', query })
    client.search(query, { signal: controller.signal, limit: PAGE_TEXT_SEARCH_PAGE_SIZE }).then(
      (result) => {
        if (controller.signal.aborted) return
        setState({ status: 'success', query, generation: result.generation, total: result.total, hits: result.hits, hasMore: result.hasMore, more: 'idle' })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setState({ status: 'error', query, error: error instanceof Error ? error : new Error(String(error)) })
      },
    )
    return () => controller.abort()
  }, [client, query, attempt])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  const loadMore = useCallback(() => {
    if (!client || state.status !== 'success' || !state.hasMore || state.more === 'loading') return
    moreController.current?.abort()
    const controller = new AbortController()
    moreController.current = controller
    const { query: currentQuery, hits, generation } = state
    const isCurrent = (current: PageTextSearchState): current is Extract<PageTextSearchState, { status: 'success' }> => (
      !controller.signal.aborted && current.status === 'success' && current.query === currentQuery
    )
    const fail = () => {
      if (controller.signal.aborted) return
      setState((current) => isCurrent(current) ? { ...current, more: 'error' } : current)
    }
    setState({ ...state, more: 'loading' })
    client.search(currentQuery, { signal: controller.signal, offset: hits.length, limit: PAGE_TEXT_SEARCH_PAGE_SIZE }).then(
      (result) => {
        if (controller.signal.aborted) return
        if (result.generation === generation) {
          setState((current) => isCurrent(current)
            ? { ...current, total: result.total, hits: [...current.hits, ...result.hits], hasMore: result.hasMore, more: 'idle' }
            : current)
          return
        }
        // The site was republished between pages: offsets of the old list no
        // longer line up, so list the same number of results again from the
        // start of the new generation instead of appending.
        const limit = Math.min(MAX_PAGE_LIMIT, hits.length + PAGE_TEXT_SEARCH_PAGE_SIZE)
        client.search(currentQuery, { signal: controller.signal, limit }).then(
          (fresh) => {
            if (controller.signal.aborted) return
            setState((current) => isCurrent(current)
              ? { ...current, generation: fresh.generation, total: fresh.total, hits: fresh.hits, hasMore: fresh.hasMore, more: 'idle' }
              : current)
          },
          fail,
        )
      },
      fail,
    )
  }, [client, state])

  useEffect(() => () => moreController.current?.abort(), [])

  return { state, retry, loadMore }
}

export type PageTextSearchErrorDescription = { title: string; detail: string; retryable: boolean }

export function describePageTextSearchError(error: Error): PageTextSearchErrorDescription {
  if (error instanceof FullTextSearchError && error.code === 'network') {
    return {
      title: 'Search data could not be loaded',
      detail: error.status
        ? `The server returned HTTP ${error.status}.`
        // A failed decoder chunk import stays failed in some browsers until the page is reloaded.
        : 'Check your connection. If trying again does not help, reload the page.',
      retryable: true,
    }
  }
  if (error instanceof FullTextSearchError && error.code === 'unavailable') {
    return { title: 'Page text search is not available', detail: 'This site was published without page text search.', retryable: false }
  }
  if (error instanceof FullTextSearchError && error.code === 'needs-republish') {
    return {
      title: 'Page text search needs to be republished',
      detail: 'This site\'s search data uses a format this version cannot read. Ask the site owner to publish the site again.',
      retryable: false,
    }
  }
  if (error instanceof FullTextSearchError) {
    return {
      title: 'Search data could not be read',
      detail: 'It may be out of date. Publishing the site again rebuilds it.',
      retryable: true,
    }
  }
  // The client rejects a query over its length limit (or an invalid page) with
  // a RangeError before fetching anything: retrying the same query cannot help.
  if (error instanceof RangeError) {
    return /too long/i.test(error.message)
      ? { title: 'This query is too long', detail: `Shorten it to ${PAGE_TEXT_SEARCH_MAX_QUERY_LENGTH.toLocaleString('en-US')} characters or fewer.`, retryable: false }
      : { title: 'This query could not be searched', detail: 'Try different words.', retryable: false }
  }
  // Anything else is unexpected and may be transient.
  return { title: 'Search could not run', detail: 'Something went wrong while searching.', retryable: true }
}
