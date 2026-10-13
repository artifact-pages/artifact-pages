import { Component, type ReactNode } from 'react'

type State = { error: Error | undefined }

/** Last-resort recovery screen for any exception thrown while rendering (ISSUE-091). */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: undefined }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('Unhandled render error', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="status-page">
        <div className="status-content">
          <p className="brand-label"><span className="brand-mark">G</span> Git Artifact Pages</p>
          <h1>Something went wrong</h1>
          <p className="error-message" role="alert">
            This page stopped working. Reload to try again. If it keeps happening on one site, ask the site's publisher to republish it.
          </p>
          <button className="text-action" onClick={() => window.location.reload()}>Reload</button>
          <a className="text-action" href="/">← All sites</a>
        </div>
      </main>
    )
  }
}
