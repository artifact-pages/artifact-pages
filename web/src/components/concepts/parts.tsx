import { createContext, useContext, useEffect } from 'react'
import type { ReactNode } from 'react'
import './concepts.css'

export type ConceptTheme = 'light' | 'dark'
export type ConceptLayout = 'wide' | 'narrow'

export const LayoutContext = createContext<ConceptLayout>('wide')
export const useConceptLayout = () => useContext(LayoutContext)

export type ConceptArgs = { theme: ConceptTheme; layout: ConceptLayout }

export const conceptArgTypes = {
  theme: { control: 'radio', options: ['light', 'dark'] },
  layout: { control: 'radio', options: ['wide', 'narrow'] },
} as const

/** Page wrapper: sets the real theme attribute used by styles.css and lays variants out. */
export function ConceptShell({
  theme,
  layout,
  eyebrow,
  title,
  intro,
  children,
}: ConceptArgs & { eyebrow: string; title: string; intro: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const previous = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = theme
    return () => {
      if (previous === undefined) delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = previous
    }
  }, [theme])
  return (
    <LayoutContext.Provider value={layout}>
      <main className="rux" data-layout={layout}>
        <header className="rux-intro">
          <p className="rux-eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{intro}</p>
        </header>
        {children}
      </main>
    </LayoutContext.Provider>
  )
}

export function VariantGrid({ children, wideColumns = 2 }: { children: ReactNode; wideColumns?: 1 | 2 | 3 }) {
  return <div className={`rux-grid rux-grid--${wideColumns}`}>{children}</div>
}

/** One labeled variant with its one-line trade-off caption. */
export function Variant({
  id,
  name,
  caption,
  tag,
  children,
}: {
  id: string
  name: string
  caption: ReactNode
  tag?: string
  children: ReactNode
}) {
  return (
    <section className="rux-variant" aria-label={`Variant ${id}: ${name}`}>
      <header className="rux-variant-head">
        <span className="rux-variant-id">{id}</span>
        <h2>{name}</h2>
        {tag ? <span className="rux-needs">{tag}</span> : null}
      </header>
      <p className="rux-caption">{caption}</p>
      <div className="rux-variant-body">{children}</div>
    </section>
  )
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="rux-note">{children}</p>
}

export function Needs({ children }: { children: ReactNode }) {
  return <span className="rux-needs">{children}</span>
}

export function SiteMark({ title }: { title: string }) {
  return <span className="site-mark" aria-hidden="true">{title.slice(0, 1).toUpperCase()}</span>
}

/** Story helper: standard meta args. */
export const conceptDefaults: ConceptArgs = { theme: 'light', layout: 'wide' }
