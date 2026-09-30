import type { Meta, StoryObj } from '@storybook/react-vite'
import './site-description-concept.css'

type ConceptLayout = 'wide' | 'narrow'

type ExampleSite = {
  id: string
  name: string
  description?: string
  status: string
}

const sites: ExampleSite[] = [
  {
    id: 'sre',
    name: 'SRE & Platform',
    description: 'Incident reviews, service runbooks, and reliability guidance for production teams.',
    status: '12 artifacts · updated Sep 25',
  },
  {
    id: 'frontend',
    name: 'Frontend',
    status: '1 artifact · updated Sep 22',
  },
  {
    id: 'showcase',
    name: 'HTML Showcase',
    description: 'A collection of reports, dashboards, handbooks, and design examples that demonstrates how teams can publish and browse many kinds of engineering artifacts.',
    status: '9 artifacts · updated Sep 25',
  },
]

function SiteDescriptionConcept({ layout }: { layout: ConceptLayout }) {
  return (
    <main className="site-description-concept" data-layout={layout}>
      <header className="sd-intro">
        <p className="sd-eyebrow">Design concept · Site discovery</p>
        <h1>Choose a site</h1>
        <p>Keep the site name prominent, place an optional purpose statement beneath it, and leave the ID and publication status as quieter supporting details.</p>
      </header>

      <div className="sd-surfaces">
        <section className="sd-picker-surface" aria-label="Site picker example">
          <div className="sd-surface-heading">
            <span>Available sites</span>
            <span className="sd-heading-detail">3 registered</span>
          </div>
          <div className="sd-site-list">
            {sites.map((site) => <SiteRow key={site.id} site={site} surface="picker" />)}
          </div>
        </section>

        <section className="sd-palette-surface" aria-label="Site search example">
          <div className="sd-search-field">
            <span className="sd-search-icon" aria-hidden="true">⌕</span>
            <span>Search sites...</span>
            <kbd>esc</kbd>
          </div>
          <div className="sd-palette-results">
            <p className="sd-section-label">Sites</p>
            {sites.map((site) => <SiteRow key={site.id} site={site} surface="palette" />)}
          </div>
          <div className="sd-palette-footer"><span>↑ ↓ Navigate</span><span>↵ Open</span></div>
        </section>
      </div>

      <p className="sd-design-note">The Frontend example omits its description entirely; the metadata follows the name without an empty placeholder. Longer copy wraps in the narrow layout.</p>
    </main>
  )
}

function SiteRow({ site, surface }: { site: ExampleSite; surface: 'picker' | 'palette' }) {
  return (
    <article className={`sd-site-row sd-site-row--${surface}`}>
      <span className="sd-site-mark" aria-hidden="true">{site.name.slice(0, 1).toUpperCase()}</span>
      <span className="sd-site-copy">
        <strong className="sd-site-name">{site.name}</strong>
        {site.description ? <span className="sd-site-description">{site.description}</span> : null}
        <span className="sd-site-meta">
          <span className="sd-site-id">/{site.id}</span>
          <span className="sd-meta-separator" aria-hidden="true">·</span>
          <span>{site.status}</span>
        </span>
      </span>
      {surface === 'picker' ? <span className="sd-site-arrow" aria-hidden="true">↗</span> : null}
    </article>
  )
}

const meta = {
  title: 'Design concepts/Site description',
  args: { layout: 'wide' as const },
  argTypes: {
    layout: { control: 'radio', options: ['wide', 'narrow'] },
  },
  parameters: { layout: 'fullscreen' },
  render: (args: { layout: ConceptLayout }) => <SiteDescriptionConcept {...args} />,
} satisfies Meta<{ layout: ConceptLayout }>

export default meta
type Story = StoryObj<typeof meta>

export const WideSelectionAndSearch: Story = {}

export const NarrowSelectionAndSearch: Story = {
  args: { layout: 'narrow' },
}
