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

const { buildSections, defaultSelectionIndex, getEmptyMessage, nextSelectionIndex, resolveSelectedIndex } = await import('../web/src/domain/palette-sections.ts')

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
  assert.deepEqual(result.sections.map((section) => section.title), ['Pages', 'Full text'])
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
  assert.deepEqual(result.sections.map((section) => section.title), ['Full text', 'Headings in this page', 'Commands'])
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

test('arrow from no selection skips the current page', () => {
  const entries = [{ kind: 'artifact', current: true }, { kind: 'artifact' }, { kind: 'artifact' }, { kind: 'artifact', current: true }]
  assert.equal(nextSelectionIndex(entries, -1, 1), 1)
  assert.equal(nextSelectionIndex(entries, -1, -1), 2)
})

test('arrow from no selection with only the current page keeps nothing selected', () => {
  const entries = [{ kind: 'artifact', current: true }]
  assert.equal(nextSelectionIndex(entries, -1, 1), -1)
  assert.equal(nextSelectionIndex(entries, -1, -1), -1)
  assert.equal(nextSelectionIndex([], -1, 1), -1)
})

test('arrow from a valid index keeps clamped movement', () => {
  const entries = [{ kind: 'artifact' }, { kind: 'artifact', current: true }, { kind: 'artifact' }]
  assert.equal(nextSelectionIndex(entries, 0, 1), 1)
  assert.equal(nextSelectionIndex(entries, 2, 1), 2)
  assert.equal(nextSelectionIndex(entries, 0, -1), 0)
  assert.equal(nextSelectionIndex(entries, 2, -1), 1)
})

test('stored selection from another key falls back to the default', () => {
  assert.equal(resolveSelectedIndex({ key: 'a', index: 3 }, 'b', 1, 5), 1)
  assert.equal(resolveSelectedIndex({ key: 'a', index: 0 }, 'b', -1, 5), -1)
})

test('stored selection beyond the entries falls back to the default', () => {
  assert.equal(resolveSelectedIndex({ key: 'a', index: 4 }, 'a', 0, 2), 0)
  assert.equal(resolveSelectedIndex({ key: 'a', index: 2 }, 'a', 5, 2), -1)
  assert.equal(resolveSelectedIndex({ key: 'a', index: 0 }, 'a', -1, 0), -1)
})

test('stored selection within the entries is kept', () => {
  assert.equal(resolveSelectedIndex({ key: 'a', index: 1 }, 'a', 0, 3), 1)
  assert.equal(resolveSelectedIndex({ key: 'a', index: -1 }, 'a', 0, 3), -1)
})

// ISSUE-079: headings of other pages and the Folders group.
const docsIndex = {
  schemaVersion: 1,
  site: { id: 'guide', title: 'Guide' },
  generatedAt: '2026-01-01T00:00:00Z',
  artifacts: [
    { ...artifact('start', 'Getting started', { path: 'en/getting-started.md' }), toc: [
      { id: 'start-with-cloudflare', text: 'Start with Cloudflare', level: 2 },
      { id: 'start-with-aws', text: 'Start with AWS', level: 2 },
      { id: 'examples', text: 'Examples', level: 2 },
      { id: 'examples-1', text: 'Examples', level: 2 },
    ] },
    { ...artifact('config', 'Configuration', { path: 'en/reference/configuration.md' }), toc: [
      { id: 'cloudflare-r2', text: 'Cloudflare R2 settings', level: 2 },
      { id: 'examples', text: 'Examples', level: 3 },
    ] },
    { ...artifact('ja', 'はじめに', { path: 'ja/start.md' }), toc: [{ id: 'cf', text: 'Cloudflare で始める', level: 2 }] },
    artifact('top', 'Top level page', { path: 'top.md' }),
  ],
}
const docsSites = [{ schemaVersion: 1, site: docsIndex.site, generatedAt: docsIndex.generatedAt, artifactCount: 4, artifactIndexUrl: '/x' }]

function buildDocs({ mode = 'search', term = '', currentArtifact, navigated = [], jumped = [] } = {}) {
  return buildSections({
    mode,
    context: currentArtifact ? 'artifact' : 'site',
    term,
    sites: docsSites,
    currentIndex: docsIndex,
    currentArtifact,
    recentReads: [],
    pinnedArtifactIds: [],
    commands,
    onNavigate: (href) => navigated.push(href),
    onJumpToHeading: (id) => jumped.push(id),
    onSearchPageText: () => {},
  })
}
const section = (result, title) => result.sections.find((candidate) => candidate.title === title)

test('a heading of another page is listed below page matches with its page and folder', () => {
  const navigated = []
  const result = buildDocs({ term: 'cloudflare', currentArtifact: docsIndex.artifacts[3], navigated })
  assert.deepEqual(result.sections.map((s) => s.title), ['Full text', 'Headings in other pages'])
  const headings = section(result, 'Headings in other pages').entries
  assert.deepEqual(headings.map((entry) => entry.title), ['Start with Cloudflare', 'Cloudflare R2 settings', 'Cloudflare で始める'])
  assert.deepEqual(headings.map((entry) => entry.subtitle), ['Getting started · en', 'Configuration · en/reference', 'はじめに · ja'])
  // IMP-42: the page-text search stays the default Enter target when no page name matches.
  assert.equal(entriesOf(result)[0].kind, 'page-text')
  assert.equal(selection(result, 'cloudflare', docsIndex.artifacts[3]), 0)
  headings[0].onSelect()
  assert.deepEqual(navigated, ['/guide/en/getting-started.md#start-with-cloudflare'])
})

test('pages keep priority: matched pages come first and headings follow, matched pages included', () => {
  const result = buildDocs({ term: 'start', currentArtifact: docsIndex.artifacts[3] })
  const titles = result.sections.map((s) => s.title)
  assert.deepEqual(titles.slice(0, 1), ['Pages'])
  assert.ok(titles.indexOf('Headings in other pages') > titles.indexOf('Pages'))
  assert.equal(entriesOf(result)[0].kind, 'artifact')
  // "Getting started" matched by title, and its own heading is still a separate target.
  assert.ok(section(result, 'Headings in other pages').entries.some((entry) => entry.title === 'Start with AWS'))
})

test('the open page is left out of other-page headings and keeps its fallback group', () => {
  const current = docsIndex.artifacts[1]
  const result = buildDocs({ term: 'cloudflare', currentArtifact: current })
  assert.deepEqual(result.sections.map((s) => s.title), ['Full text', 'Headings in this page', 'Headings in other pages'])
  assert.deepEqual(section(result, 'Headings in other pages').entries.map((entry) => entry.title), ['Start with Cloudflare', 'Cloudflare で始める'])
})

test('duplicate headings: same text on one page is listed once, across pages each is listed with its page', () => {
  const result = buildDocs({ term: 'examples', currentArtifact: docsIndex.artifacts[3] })
  const entries = section(result, 'Headings in other pages').entries
  assert.deepEqual(entries.map((entry) => [entry.title, entry.subtitle]), [
    ['Examples', 'Getting started · en'],
    ['Examples', 'Configuration · en/reference'],
  ])
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 2)
})

test('other-page headings are capped per page and in total', () => {
  const crowded = {
    ...docsIndex,
    artifacts: Array.from({ length: 5 }, (_, page) => ({
      ...artifact(`p${page}`, `Page ${page}`, { path: `d/p${page}.md` }),
      toc: Array.from({ length: 5 }, (_, heading) => ({ id: `h${heading}`, text: `Topic ${page} ${heading}`, level: 2 })),
    })),
  }
  const result = buildSections({ mode: 'search', context: 'site', term: 'topic', sites: docsSites, currentIndex: crowded, recentReads: [], pinnedArtifactIds: [], commands, onNavigate() {}, onJumpToHeading() {} })
  const entries = section(result, 'Headings in other pages').entries
  assert.equal(entries.length, 6)
  const perPage = Object.values(Object.groupBy(entries, (entry) => entry.id.split(':')[2])).map((group) => group.length)
  assert.ok(perPage.every((count) => count <= 3))
})

test('folders matching the query are listed below pages with page counts and a folder route', () => {
  const navigated = []
  const result = buildDocs({ term: 'en', navigated })
  const folders = section(result, 'Folders')
  assert.ok(folders)
  assert.deepEqual(folders.entries.map((entry) => [entry.title, entry.subtitle, entry.badge]).slice(0, 1), [['en', 'en', '2 pages']])
  folders.entries[0].onSelect()
  assert.deepEqual(navigated, ['/guide/en'])
  const titles = result.sections.map((s) => s.title)
  assert.ok(titles.indexOf('Full text') < titles.indexOf('Folders'))
})

test('a wrapper folder whose single page is already listed is not echoed, and folder hrefs are percent-encoded', () => {
  const nested = { ...docsIndex, artifacts: [artifact('z', 'Zeta page', { path: 'docs/zeta/page.md' })] }
  const wrapped = buildSections({ mode: 'search', context: 'site', term: 'docs', sites: docsSites, currentIndex: nested, recentReads: [], pinnedArtifactIds: [], commands, onNavigate() {}, onJumpToHeading() {} })
  // "docs/zeta" matches only through its parent's name and holds the one listed page: hidden.
  assert.deepEqual(section(wrapped, 'Folders').entries.map((entry) => entry.subtitle), ['docs'])
  const navigated = []
  const encoded = {
    ...docsIndex,
    artifacts: [
      artifact('a', 'Alpha', { path: 'my notes/日本語/a.md' }),
      artifact('b', 'Beta', { path: 'my notes/日本語/b.md' }),
    ],
  }
  const result = buildSections({ mode: 'search', context: 'site', term: 'notes', sites: docsSites, currentIndex: encoded, recentReads: [], pinnedArtifactIds: [], commands, onNavigate: (href) => navigated.push(href), onJumpToHeading() {} })
  const folders = section(result, 'Folders').entries
  assert.deepEqual(folders.map((entry) => entry.badge), ['2 pages', '2 pages'])
  folders[0].onSelect()
  assert.deepEqual(navigated, ['/guide/my%20notes'])
})

test('title-level headings of a page already listed are skipped, deeper ones stay', () => {
  const withTitleHeading = {
    ...docsIndex,
    artifacts: [{
      ...artifact('topo', 'Platform topology', { path: 'arch/topology.md' }),
      toc: [
        { id: 'platform-topology', text: 'Platform topology', level: 2 },
        { id: 'topology', text: 'Topology', level: 1 },
        { id: 'topology-details', text: 'Topology details', level: 2 },
      ],
    }],
  }
  const result = buildSections({ mode: 'search', context: 'site', term: 'topology', sites: docsSites, currentIndex: withTitleHeading, recentReads: [], pinnedArtifactIds: [], commands, onNavigate() {}, onJumpToHeading() {} })
  assert.deepEqual(section(result, 'Headings in other pages').entries.map((entry) => entry.title), ['Topology details'])
})

test('folders sit below page matches and are absent for blank queries and the site picker', () => {
  const withPages = buildDocs({ term: 'en' })
  const titles = withPages.sections.map((s) => s.title)
  assert.ok(titles.indexOf('Pages') >= 0 && titles.indexOf('Pages') < titles.indexOf('Folders'))
  assert.equal(section(buildDocs({ term: '' }), 'Folders'), undefined)
  const picker = buildSections({ mode: 'search', context: 'sites', term: 'en', sites: docsSites, recentReads: [], pinnedArtifactIds: [], commands, onNavigate() {}, onJumpToHeading() {} })
  assert.equal(picker.sections.some((s) => s.title === 'Folders' || s.title === 'Headings in other pages'), false)
})

test('# searches every page with the open page first', () => {
  const navigated = []
  const jumped = []
  const result = buildDocs({ mode: 'heading', term: 'examples', currentArtifact: docsIndex.artifacts[1], navigated, jumped })
  assert.deepEqual(result.sections.map((s) => s.title), ['In Configuration', 'In other pages'])
  entriesOf(result)[0].onSelect()
  assert.deepEqual(jumped, ['examples'])
  entriesOf(result)[1].onSelect()
  assert.deepEqual(navigated, ['/guide/en/getting-started.md#examples'])
})

test('# with no open page searches all pages, and blank # lists only the open page', () => {
  const noPage = buildDocs({ mode: 'heading', term: 'cloudflare' })
  assert.deepEqual(noPage.sections.map((s) => s.title), ['In other pages'])
  assert.equal(entriesOf(noPage).length, 3)
  assert.equal(buildDocs({ mode: 'heading', term: '' }).sections.length, 0)
  const blankOpen = buildDocs({ mode: 'heading', term: '', currentArtifact: docsIndex.artifacts[0] })
  assert.deepEqual(blankOpen.sections.map((s) => s.title), ['In Getting started'])
  assert.equal(entriesOf(blankOpen).length, 4)
})

test('heading mode empty states', () => {
  const base = { mode: 'heading', context: 'site', siteCount: 1 }
  assert.equal(getEmptyMessage({ ...base, blank: true }), 'Type to search headings in all pages.')
  assert.equal(getEmptyMessage({ ...base, context: 'artifact', currentArtifact: docsIndex.artifacts[3], blank: true }),
    'This page has no indexed headings. Type to search the headings of other pages.')
  assert.equal(getEmptyMessage({ ...base, context: 'artifact', currentArtifact: docsIndex.artifacts[0], blank: false }),
    'No headings match. Change or clear your search.')
  assert.equal(getEmptyMessage({ ...base, context: 'sites' }), 'Headings are searched after you choose a site.')
  assert.equal(buildDocs({ mode: 'heading', term: 'zzzz', currentArtifact: docsIndex.artifacts[0] }).sections.length, 0)
})

test('a wrapper folder whose own name matched is still listed', () => {
  const wrapper = {
    ...docsIndex,
    artifacts: [artifact('c', 'Checkout review', { path: 'checkout/index.md' })],
  }
  const result = buildSections({ mode: 'search', context: 'site', term: 'checkout', sites: docsSites, currentIndex: wrapper, recentReads: [], pinnedArtifactIds: [], commands, onNavigate() {}, onJumpToHeading() {} })
  assert.deepEqual(section(result, 'Folders').entries.map((entry) => entry.title), ['checkout'])
})

test('# fills its row limit across pages: the per-page cap does not starve the list', () => {
  const many = {
    ...docsIndex,
    artifacts: Array.from({ length: 30 }, (_, page) => ({
      ...artifact(`p${page}`, `Page ${page}`, { path: `d/p${page}.md` }),
      toc: Array.from({ length: 10 }, (_, heading) => ({ id: `h${heading}`, text: `Topic ${heading}`, level: 2 })),
    })),
  }
  const result = buildSections({ mode: 'heading', context: 'site', term: 'topic', sites: docsSites, currentIndex: many, recentReads: [], pinnedArtifactIds: [], commands, onNavigate() {}, onJumpToHeading() {} })
  const entries = section(result, 'In other pages').entries
  assert.equal(entries.length, 20)
  const perPage = Object.values(Object.groupBy(entries, (entry) => entry.id.split(':')[2])).map((group) => group.length)
  assert.ok(perPage.every((count) => count <= 5))
})

test('narrowing then widening the query gives the same headings as a fresh search', () => {
  const run = (term) => section(buildDocs({ term, currentArtifact: docsIndex.artifacts[3] }), 'Headings in other pages')?.entries.map((entry) => entry.id)
  const widened = (run('cloud'), run('cloudf'), run('cloudflare'))
  const fresh = run('cloudflare')
  assert.deepEqual(widened, fresh)
  assert.deepEqual(run('cloud'), run('cloud'))
})

test('other-page heading search stays fast on a large heading-rich site', () => {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet']
  const large = {
    ...docsIndex,
    artifacts: Array.from({ length: 5000 }, (_, page) => ({
      ...artifact(`p${page}`, `Page ${page}`, { path: `d${page % 50}/p${page}.md` }),
      toc: Array.from({ length: 12 }, (_, heading) => ({ id: `h${heading}`, text: `${words[(page + heading) % 10]} ${words[(page * 3 + heading) % 10]} ${heading}`, level: 2 })),
    })),
  }
  const run = (term) => buildSections({ mode: 'search', context: 'site', term, sites: docsSites, currentIndex: large, recentReads: [], pinnedArtifactIds: [], commands, onNavigate() {}, onJumpToHeading() {}, onSearchPageText: () => {} })
  run('zq') // warm the per-heading caches
  const started = performance.now()
  run('zqx')
  run('hotel')
  run('hotelx')
  const perQuery = (performance.now() - started) / 3
  // Generous bound (CI machines vary); the measured cost is a few ms.
  assert.ok(perQuery < 150, `palette query took ${perQuery.toFixed(1)} ms for 5000 pages`)
})
