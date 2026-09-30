import { useEffect, useId, useState } from 'react'

type DiagramState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'error' }

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId()
  const diagramId = `markdown-diagram-${reactId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const diagramType = source.trim().match(/^[a-z][a-z0-9-]*/i)?.[0].toLowerCase().slice(0, 40) ?? 'unknown'
  const [state, setState] = useState<DiagramState>({ status: 'loading' })
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default'

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })

    import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme,
        flowchart: { htmlLabels: false, useMaxWidth: false },
      })
      const { svg } = await mermaid.render(diagramId, source)
      if (!cancelled) setState({ status: 'ready', svg })
    }).catch(() => {
      if (!cancelled) setState({ status: 'error' })
    })

    return () => {
      cancelled = true
    }
  }, [diagramId, source, theme])

  if (state.status === 'ready') {
    return (
      <figure className="markdown-diagram" aria-label={`${diagramType} diagram`} data-diagram-type={diagramType}>
        <div dangerouslySetInnerHTML={{ __html: state.svg }} />
      </figure>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="markdown-diagram-error" data-diagram-type={diagramType} role="status">
        <p>This diagram could not be rendered. Its source is shown below.</p>
        <pre><code>{source}</code></pre>
      </div>
    )
  }

  return <div className="markdown-diagram-loading" data-diagram-type={diagramType} role="status">Rendering diagram…</div>
}
