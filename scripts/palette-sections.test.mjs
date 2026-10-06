// Checks which sections the command palette builds and which row starts selected.
// Run with: npm run test:palette-sections
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

// The web sources import each other without file extensions (bundler resolution); Node needs them.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context)
    } catch {
      return nextResolve(specifier + '/index.ts', context)
    }
  }
  return nextResolve(specifier, context)
}
`), import.meta.url)

const { buildSections, defaultSelectionIndex } = await import('../web/src/domain/palette-sections.ts')

const artifact = (id, title, extra = {}) => ({
  id,
  title,
  path: `${id}.html`,
  format: 'html',
  artifactUrl: `/guide/${id}.html`,
  updatedAt: '2026-01-01T00:00:00Z',
  ...extra,
})
const pages = [
  artifact('overview', 'Overview', { toc: [{ id: 'setup', text: 'Setup notes', level: 2 }] }),
  artifact('reading', 'Reading guide'),
  artifact('setup', 'Setup'),
]
const index = { schemaVersion: 1, site: { id: 'guide', title: 'Guide' }, generatedAt: '2026-01-01T00:00:00Z', artifacts: pages }
const sites = [{ schemaVersion: 1, site: index.site, generatedAt: index.generatedAt, artifactCount: 3, artifactIndexUrl: '/x' }]
const commands = [{ title: 'Toggle sidebar', onSelect() {} }, { title: 'Use dark theme', onSelect() {} }]

function build({ term = '', currentArtifact, recentReads = [], pinnedArtifactIds = [], idx = index, onSearchPageText = () => {} } = {}) {
  return buildSections({
    mode: 'search',
    context: currentArtifact ? 'artifact' : 'site',
    term,
    sites,
    currentIndex: idx,
    currentArtifact,
    recentReads,
    pinnedArtifactIds,
    commands,
    onNavigate() {},
    onJumpToHeading() {},
    onSearchPageText,
  })
}
const entriesOf = (result) => result.sections.flatMap((section) => section.entries)
const selection = (result, query, currentArtifact) =>
  defaultSelectionIndex(query, currentArtifact ? 'artifact' : 'site', index, 1, entriesOf(result))

test('blank query selects first non-current page', () => {
  const current = pages[0]
  const result = build({
    currentArtifact: current,
    recentReads: [
      { artifactId: 'overview', viewedAt: Date.now() },
      { artifactId: 'reading', viewedAt: Date.now() - 60_000 },
    ],
  })
  assert.deepEqual(result.sections.map((section) => section.title), ['Recently read'])
  const entries = entriesOf(result)
  assert.equal(entries[0].current, true)
  assert.equal(selection(result, '', current), 1)
  assert.equal(entries[1].title, 'Reading guide')
  assert.equal(result.emptyHistory, false)
})

test('blank query with only the current page selects nothing', () => {
  const current = pages[0]
  const result = build({ currentArtifact: current, recentReads: [{ artifactId: 'overview', viewedAt: Date.now() }] })
  assert.equal(entriesOf(result).length, 1)
  assert.equal(result.onlyCurrent, true)
  assert.equal(selection(result, '', current), -1)
})

test('blank query with no history yields Pages section and empty-history flag', () => {
  const result = build({ currentArtifact: pages[0] })
  assert.deepEqual(result.sections.map((section) => section.title), ['Pages'])
  assert.equal(result.emptyHistory, true)
  assert.equal(entriesOf(result).some((entry) => entry.kind === 'command'), false)
})

test('typed query with page matches omits headings and commands', () => {
  const result = build({ term: 'setup', currentArtifact: pages[0] })
  assert.deepEqual(result.sections.map((section) => section.title), ['Pages', 'Page text'])
  assert.equal(selection(result, 'setup', pages[0]), 0)
})

test('typed query without page matches keeps page-text, headings, commands in that order', () => {
  const withNotes = { ...index, artifacts: [artifact('overview', 'Overview', { toc: [{ id: 'n', text: 'Quokka notes', level: 2 }] })] }
  const commandsWithMatch = [{ title: 'Quokka mode', onSelect() {} }]
  const result = buildSections({
    mode: 'search',
    context: 'artifact',
    term: 'quokka',
    sites,
    currentIndex: withNotes,
    currentArtifact: withNotes.artifacts[0],
    recentReads: [],
    pinnedArtifactIds: [],
    commands: commandsWithMatch,
    onNavigate() {},
    onJumpToHeading() {},
    onSearchPageText: () => {},
  })
  assert.deepEqual(result.sections.map((section) => section.title), ['Page text', 'Headings in this page', 'Commands'])
  assert.equal(result.sections[1].entries[0].subtitle, 'Heading 2 · this page')
})

test('current page entry is flagged and badge text is Current page only', () => {
  const current = pages[0]
  const pinned = build({ currentArtifact: current, pinnedArtifactIds: ['overview', 'reading'], recentReads: [{ artifactId: 'overview', viewedAt: Date.now() }] })
  const [pinnedCurrent, pinnedOther] = entriesOf(pinned)
  assert.deepEqual([pinnedCurrent.current, pinnedCurrent.badge], [true, 'Current page'])
  assert.equal(pinnedOther.current, undefined)
  const typed = entriesOf(build({ term: 'overview', currentArtifact: current, pinnedArtifactIds: ['overview'], recentReads: [{ artifactId: 'overview', viewedAt: Date.now() }] }))
  const hit = typed.find((entry) => entry.kind === 'artifact')
  assert.deepEqual([hit.current, hit.badge], [true, 'Current page'])
})
