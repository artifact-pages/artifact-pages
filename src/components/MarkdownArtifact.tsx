import { isValidElement, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import Markdown, { defaultUrlTransform, type Options as MarkdownOptions } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'
import { artifactRouteHref } from '../routing'
import type { ArtifactIndexEntry } from '../domain/index'
import { MermaidDiagram } from './MermaidDiagram'

const markdownSanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: 'md-',
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'data'],
  },
}
const safeDataImageUrl = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i
const markdownRemarkPlugins: NonNullable<MarkdownOptions['remarkPlugins']> = [remarkGfm]
const markdownRehypePlugins: NonNullable<MarkdownOptions['rehypePlugins']> = [
  rehypeRaw,
  [rehypeSlug, { prefix: '' }],
  [rehypeSanitize, markdownSanitizeSchema],
]

export function MarkdownArtifact({
  artifact,
  siteId,
  hash,
  navigate,
  resolveHref,
}: {
  artifact: ArtifactIndexEntry
  siteId: string
  hash: string
  navigate: (href: string) => void
  resolveHref?: (url: URL) => string | undefined
}) {
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setSource(null)
    setError(null)

    fetch(artifact.artifactUrl, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
      return response.text()
    }).then(
      (text) => setSource(text),
      (reason: unknown) => {
        if (controller.signal.aborted) return
        setError(reason instanceof Error ? reason.message : 'Could not load this Markdown document.')
      },
    )

    return () => controller.abort()
  }, [artifact.artifactUrl])

  useEffect(() => {
    if (!hash || source === null) return
    const id = decodeHash(hash)
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' })
    })
  }, [hash, source])

  if (error) {
    return (
      <div className="markdown-state" role="alert">
        <h1>Markdown unavailable</h1>
        <p>{error}</p>
      </div>
    )
  }

  if (source === null) {
    return <div className="markdown-state" role="status">Loading document…</div>
  }

  return (
    <div className="markdown-scroll" data-testid="markdown-document">
      <article className="markdown-article">
        <Markdown
          remarkPlugins={markdownRemarkPlugins}
          rehypePlugins={markdownRehypePlugins}
          urlTransform={(url, key) => transformMarkdownUrl(url, key, artifact, siteId, resolveHref)}
          components={{
            table: ({ children, ...props }) => (
              <MarkdownTableScroll>
                <table {...props}>{children}</table>
              </MarkdownTableScroll>
            ),
            pre: ({ children, ...props }) => {
              const nodes = Array.isArray(children) ? children : [children]
              const mermaidCode = nodes.find((node) => (
                isValidElement<{ className?: string }>(node)
                && node.props.className?.split(/\s+/).includes('language-mermaid')
              ))
              if (isValidElement<{ children?: ReactNode }>(mermaidCode)) {
                return <MermaidDiagram source={String(mermaidCode.props.children).replace(/\n$/, '')} />
              }
              return <pre {...props}>{children}</pre>
            },
            source: ({ srcSet, ...props }) => (
              <source
                {...props}
                srcSet={typeof srcSet === 'string'
                  ? transformMarkdownSrcSet(srcSet, artifact, siteId, resolveHref)
                  : srcSet}
              />
            ),
            a: ({ href, children, ...props }) => {
              const isAppRoute = Boolean(href?.startsWith(`/${encodeURIComponent(siteId)}/`))
              const isSamePage = Boolean(href?.startsWith('#'))
              const openInNewTab = !isAppRoute && !isSamePage && Boolean(href)
              return (
                <a
                  {...props}
                  href={href}
                  target={openInNewTab ? '_blank' : undefined}
                  rel={openInNewTab ? 'noreferrer noopener' : undefined}
                  onClick={(event) => {
                    if (!isAppRoute || !href || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                    event.preventDefault()
                    navigate(href)
                  }}
                >
                  {children}
                </a>
              )
            },
            code: ({ className, children, ...props }) => {
              if (className?.split(/\s+/).includes('language-mermaid')) {
                return <MermaidDiagram source={String(children).replace(/\n$/, '')} />
              }
              return <code {...props} className={className}>{children}</code>
            },
          }}
        >
          {source}
        </Markdown>
      </article>
    </div>
  )
}

function MarkdownTableScroll({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const hintId = useId()
  const [scrollState, setScrollState] = useState({
    overflows: false,
    canScrollLeft: false,
    canScrollRight: false,
  })

  useEffect(() => {
    const scrollport = scrollRef.current
    if (!scrollport) return

    const updateScrollState = () => {
      const maxScrollLeft = Math.max(0, scrollport.scrollWidth - scrollport.clientWidth)
      const nextState = {
        overflows: maxScrollLeft > 1,
        canScrollLeft: scrollport.scrollLeft > 1,
        canScrollRight: scrollport.scrollLeft < maxScrollLeft - 1,
      }
      setScrollState((currentState) => (
        currentState.overflows === nextState.overflows
        && currentState.canScrollLeft === nextState.canScrollLeft
        && currentState.canScrollRight === nextState.canScrollRight
          ? currentState
          : nextState
      ))
    }

    const observer = new ResizeObserver(updateScrollState)
    observer.observe(scrollport)
    if (scrollport.firstElementChild) observer.observe(scrollport.firstElementChild)
    scrollport.addEventListener('scroll', updateScrollState, { passive: true })
    updateScrollState()

    return () => {
      observer.disconnect()
      scrollport.removeEventListener('scroll', updateScrollState)
    }
  }, [children])

  return (
    <>
      <div
        ref={scrollRef}
        className="markdown-table-scroll"
        role={scrollState.overflows ? 'region' : undefined}
        aria-label={scrollState.overflows ? 'Scrollable table' : undefined}
        aria-describedby={scrollState.overflows ? hintId : undefined}
        tabIndex={scrollState.overflows ? 0 : undefined}
      >
        {children}
      </div>
      {scrollState.overflows ? (
        <p id={hintId} className="markdown-table-hint">
          {scrollState.canScrollRight
            ? 'Scroll to see more columns →'
            : scrollState.canScrollLeft
              ? '← Scroll left to see earlier columns'
              : null}
        </p>
      ) : null}
    </>
  )
}

function transformMarkdownUrl(
  value: string,
  key: string,
  artifact: ArtifactIndexEntry,
  siteId: string,
  resolveHref?: (url: URL) => string | undefined,
) {
  if (/^data:/i.test(value)) return key === 'src' && safeDataImageUrl.test(value) ? value : ''
  const safeValue = defaultUrlTransform(value)
  if (!safeValue) return ''
  if (safeValue.startsWith('#')) return safeValue.startsWith('#md-') ? safeValue : `#md-${safeValue.slice(1)}`

  let resolved: URL
  try {
    resolved = new URL(safeValue, new URL(artifact.artifactUrl, window.location.origin))
  } catch {
    return ''
  }

  if (resolved.protocol === 'mailto:') return resolved.href
  if (resolved.protocol === 'https:' && resolved.origin !== window.location.origin) return resolved.href
  if (
    resolved.origin === window.location.origin &&
    resolved.pathname.startsWith('/_artifacts/') &&
    !resolved.pathname.startsWith(`/_artifacts/${encodeURIComponent(siteId)}/`)
  ) return ''
  if (resolved.protocol !== 'https:' && resolved.origin !== window.location.origin) return ''
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return ''

  if (key === 'href') {
    const logicalHref = resolveHref?.(resolved)
    if (logicalHref) return logicalHref
  }

  const artifactPrefix = `/_artifacts/${encodeURIComponent(siteId)}/`
  if (key === 'href' && resolved.origin === window.location.origin && resolved.pathname.startsWith(artifactPrefix)) {
    const relativePath = resolved.pathname.slice(artifactPrefix.length)
    if (/\.(?:html?|md)$/i.test(relativePath)) {
      const decodedPath = relativePath.split('/').map(decodePathSegment).join('/')
      const suffix = `${resolved.search}${resolved.hash}`
      return `${artifactRouteHref(siteId, decodedPath)}${suffix}`
    }
  }

  return resolved.href
}

function transformMarkdownSrcSet(
  value: string,
  artifact: ArtifactIndexEntry,
  siteId: string,
  resolveHref?: (url: URL) => string | undefined,
) {
  return parseMarkdownSrcSet(value).flatMap(({ url, descriptor }) => {
    const transformed = transformMarkdownUrl(url, 'src', artifact, siteId, resolveHref)
    return transformed ? [`${transformed}${descriptor ? ` ${descriptor}` : ''}`] : []
  }).join(', ')
}

function parseMarkdownSrcSet(value: string) {
  const candidates: Array<{ url: string; descriptor: string }> = []
  let index = 0
  while (index < value.length) {
    while (index < value.length && (isMarkdownHtmlSpace(value[index]) || value[index] === ',')) index++
    if (index >= value.length) break

    const start = index
    while (index < value.length && !isMarkdownHtmlSpace(value[index])) index++
    const token = value.slice(start, index)
    const url = token.replace(/,+$/, '')
    if (!url) continue
    if (url !== token) {
      candidates.push({ url, descriptor: '' })
      continue
    }

    while (index < value.length && isMarkdownHtmlSpace(value[index])) index++
    const descriptorStart = index
    while (index < value.length && value[index] !== ',') index++
    const descriptor = value.slice(descriptorStart, index).trim()
    candidates.push({ url, descriptor })
    if (index < value.length) index++
  }
  return candidates
}

function isMarkdownHtmlSpace(value: string) {
  return value === '\t' || value === '\n' || value === '\f' || value === '\r' || value === ' '
}

function decodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function decodeHash(hash: string) {
  try {
    return decodeURIComponent(hash.slice(1))
  } catch {
    return hash.slice(1)
  }
}
