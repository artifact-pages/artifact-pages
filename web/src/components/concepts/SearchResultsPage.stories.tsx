import type { Meta, StoryObj } from '@storybook/react-vite'
import { ConceptShell, Note, conceptArgTypes, conceptDefaults, type ConceptArgs } from './parts'
import { MatchNavigatorPage, SearchResultsPage, type SearchPageState } from './SearchResultsPageConcept'
import type { FolderFilter } from './searchResultsData'

type PageArgs = ConceptArgs & { query: string; folder: FolderFilter; state: SearchPageState }

function Concept({ theme, layout, query, folder, state }: PageArgs) {
  return (
    <ConceptShell
      theme={theme}
      layout={layout}
      eyebrow="Concept · Full-text search results page"
      title="Where on the page did it match?"
      intro="The sidebar filter searches titles and paths and ends with a row that opens this page. Results show the heading each match sits under and a short excerpt. Mock data; type in the field, pick a folder, use ↑ ↓ and Enter."
    >
      {state === 'navigator' ? (
        <MatchNavigatorPage query={query} />
      ) : (
        <SearchResultsPage key={`${query}|${folder}|${state}`} initialQuery={query} initialFolder={folder} state={state} />
      )}
      <Note>
        {state === 'navigator'
          ? 'Destination page after clicking a match. ↑ ↓ or Enter step through the marks, Shift+Enter goes back, Esc closes. Match counts come from the page itself, not the index.'
          : 'Not represented: real ranking, result paging beyond the first screen, and the open drawer sidebar on narrow screens.'}
      </Note>
    </ConceptShell>
  )
}

const meta = {
  title: 'Concepts/Reader UX 2026-10/Full-text search results page',
  args: { ...conceptDefaults, query: '種類', folder: 'all' as FolderFilter, state: 'results' as SearchPageState },
  argTypes: {
    ...conceptArgTypes,
    query: { control: 'text' },
    folder: { control: 'radio', options: ['all', 'ja', 'en'] },
    state: { control: 'radio', options: ['results', 'loading', 'no-snippets', 'navigator'] },
  },
  parameters: { layout: 'fullscreen' },
  render: (args: PageArgs) => <Concept {...args} />,
} satisfies Meta<PageArgs>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const DefaultDark: Story = { args: { theme: 'dark' } }
export const Narrow390: Story = { args: { layout: 'narrow' } }
export const Narrow390Dark: Story = { args: { layout: 'narrow', theme: 'dark' } }
export const ManyResultsFacetSelected: Story = { args: { query: 'index', folder: 'ja' } }
export const EnglishVariant: Story = { args: { query: 'index type' } }
export const NoMatches: Story = { args: { query: 'ゼロトラスト', folder: 'ja' } }
export const SnippetsUnavailable: Story = { args: { state: 'no-snippets' } }
export const Loading: Story = { args: { state: 'loading' } }
export const MatchNavigator: Story = { args: { state: 'navigator' } }
export const MatchNavigatorNarrow390: Story = { args: { state: 'navigator', layout: 'narrow' } }
