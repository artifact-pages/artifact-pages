import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

const markdownHeadingConformanceFixture = JSON.parse(
  readFileSync('cli/internal/indexer/testdata/markdown-heading-id-cases.json', 'utf8'),
) as {
  markdown: string
  headings: Array<{
    case: string
    level: number
    renderedText: string
    tocText?: string
    id: string
  }>
}

function buildPaletteScoringProfile(artifacts: Array<{ title: string; path: string }>) {
  const ignoredWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'index', 'html', 'md',
    'incidents', 'architecture', 'reports', 'guides', 'runbooks', 'diagrams', 'docs',
  ])
  const wordDictionary = new Map<string, number>()
  const folderDictionary = new Map<string, number>()
  const wordOffsets = [0]
  const wordIds: number[] = []
  const folderOffsets = [0]
  const folderIds: number[] = []
  const intern = (dictionary: Map<string, number>, value: string) => {
    let id = dictionary.get(value)
    if (id === undefined) {
      id = dictionary.size
      dictionary.set(value, id)
    }
    return id
  }
  const words = (value: string) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && !ignoredWords.has(word))

  for (const artifact of artifacts) {
    for (const word of new Set([...words(artifact.title), ...words(artifact.path)])) {
      wordIds.push(intern(wordDictionary, word))
    }
    wordOffsets.push(wordIds.length)
    for (const folder of artifact.path.split('/').filter(Boolean).slice(0, -1)) {
      folderIds.push(intern(folderDictionary, folder))
    }
    folderOffsets.push(folderIds.length)
  }

  return {
    version: 1 as const,
    wordOffsets,
    wordIds,
    wordIdWidth: wordDictionary.size <= 65_536 ? 16 as const : 32 as const,
    folderOffsets,
    folderIds,
    folderIdWidth: folderDictionary.size <= 65_536 ? 16 as const : 32 as const,
  }
}

// `npm run test:e2e` serves this generated site (see scripts/prepare-e2e-storage.mjs) next to the
// committed fixtures, but leaves it out of sites.json so fixture sites keep metadata-only behavior.
const TEXT_SEARCH_SITE = { id: 'textsearch', name: 'Text Search' }
const PLACEHOLDER_SITES = Array.from({ length: 6 }, (_, index) => ({ id: `placeholder-${index + 1}`, name: `Placeholder ${index + 1}` }))

/** Adds registry entries on top of the served sites.json; their metadata and indexes are whatever storage serves. */
async function registerExtraSites(page: Page, extraSites: Array<{ id: string; name: string }>) {
  await page.route('**/_indexes/sites.json', async (route) => {
    const response = await route.fetch()
    const registry = await response.json() as { schemaVersion: 1; sites: Array<Record<string, string>> }
    const sites = [
      ...registry.sites,
      ...extraSites.map(({ id, name }) => ({ id, name, repository: 'example/e2e', sourcePath: `sites/${id}` })),
    ].sort((left, right) => (left.id < right.id ? -1 : 1))
    await route.fulfill({ response, json: { ...registry, sites } })
  })
}

/** Registers the generated site that publishes page text search data. */
async function registerTextSearchSite(page: Page) {
  await registerExtraSites(page, [TEXT_SEARCH_SITE])
}

/** The site picker offers its own search trigger only for nine or more sites. */
async function registerManySites(page: Page) {
  await registerExtraSites(page, PLACEHOLDER_SITES)
}

/**
 * A tab opened by a modified or middle click can be reported with a stale
 * `about:blank` URL and no load event (Playwright misses the main-frame
 * navigation), so `tab.waitForURL` can hang. Read the location from the page.
 */
async function expectTabLocation(tab: Page, pathname: string, search = '') {
  await tab.waitForFunction(
    (expected) => location.pathname + location.search === expected,
    pathname + search,
  )
}

// Route handlers use route.fetch(); let in-flight ones finish before the
// fixture closes the context, which would dispose their responses.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

type ClickRecord = { type: string, button: number, modified: boolean, defaultPrevented: boolean }

/** Page text search data of any site, so a site without search cannot fetch some by mistake. */
function isSearchDataRequest(url: string) {
  return /^\/_indexes\/[^/]+\/search\//.test(new URL(url).pathname)
}

test('static sites catalog discovers sites and opens a site home without directory listing', async ({ page }) => {
  const discoveryRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname === '/_indexes/' || pathname === '/_indexes/sites.json') discoveryRequests.push(pathname)
  })
  const registryResponse = await page.request.get('/_indexes/sites.json')
  expect(registryResponse.ok()).toBeTruthy()
  const registry = await registryResponse.json()
  expect(registry).toMatchObject({
    schemaVersion: 1,
    sites: [
      { id: 'frontend', name: 'Frontend' },
      { id: 'showcase', name: 'HTML Showcase' },
      { id: 'sre', name: 'SRE' },
    ],
  })

  const metadataResponse = await page.request.get('/_indexes/sre/meta.json')
  expect(metadataResponse.ok()).toBeTruthy()
  const metadata = await metadataResponse.json()
  expect(metadata).toMatchObject({
    site: { id: 'sre', title: 'SRE' },
    artifactIndexUrl: '/_indexes/sre/index.json',
  })

  await page.goto('/')
  await expect.poll(() => discoveryRequests.includes('/_indexes/sites.json')).toBeTruthy()
  expect(discoveryRequests).not.toContain('/_indexes/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  // Three sites are easier to scan than to search; ⌘ K still opens site search.
  await expect(page.getByRole('button', { name: 'Search sites' })).toHaveCount(0)
  await expect(page.locator('.site-picker-badge')).toHaveCount(0)
  await expect(page.getByRole('link', { name: /SRE/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Frontend/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /HTML Showcase/ })).toBeVisible()

  await page.getByRole('link', { name: /SRE/ }).click()
  await expect(page).toHaveURL(/\/sre$/)
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
  await expect(page.locator('.site-home .artifact-list-section[aria-label="Recently updated"]')).toHaveCount(0)
  await expect(page.locator('.site-home .tree-artifact .tree-label')).toHaveText([
    'Checkout latency incident review',
    'Platform topology',
    'Service recovery',
    'Mermaid rendering catalog',
    'Markdown styles in the reader',
    'Latency Retrospective',
  ])
})

test('mobile search affordances describe their scope and open the matching palette', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await registerManySites(page)
  await page.goto('/')

  const siteSearchTrigger = page.getByRole('button', { name: 'Search sites' })
  await expect(siteSearchTrigger).toBeVisible()
  await expect(siteSearchTrigger.getByText('Tap to search sites')).toBeVisible()
  await expect(siteSearchTrigger.locator('kbd')).toBeHidden()
  await siteSearchTrigger.click()
  const sitePalette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(sitePalette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' }))
    .toHaveAttribute('placeholder', 'Search sites...')
  await page.keyboard.press('Escape')

  await page.getByRole('link', { name: /SRE/ }).click()
  await expect(page).toHaveURL(/\/sre$/)
  const homeJump = page.locator('.site-home').getByRole('button', { name: /Jump to a page/ })
  await expect(homeJump).toBeVisible()
  await expect(homeJump.locator('kbd')).toBeHidden()

  const collapsedSearch = page.getByRole('button', { name: 'Jump to a page in SRE' })
  await expect(collapsedSearch).toBeVisible()
  await collapsedSearch.click()
  const pagePalette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(pagePalette.locator('.palette-scope')).toHaveText('SRE only')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Expand navigation' }).click()
  const sidebarSearch = page.locator('.sidebar-panel').getByRole('button', { name: 'Jump to a page in SRE' })
  await expect(sidebarSearch).toBeVisible()
  await expect(sidebarSearch.getByText('Jump to a page…')).toBeVisible()
  await expect(sidebarSearch.locator('kbd')).toBeHidden()
  // SRE publishes no page text search, so the sidebar has no search field of its own.
  await expect(page.getByRole('searchbox', { name: 'Search page text in SRE' })).toHaveCount(0)
  await sidebarSearch.click()
  await expect(page.getByRole('dialog', { name: 'Command palette' }).locator('.palette-scope')).toHaveText('SRE only')
})

test('the command palette has a pointer close control at desktop and mobile widths', async ({ page }) => {
  await registerManySites(page)
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/')

    const siteTrigger = page.getByRole('button', { name: 'Search sites' })
    await siteTrigger.click()
    let palette = page.getByRole('dialog', { name: 'Command palette' })
    const closeButton = palette.getByRole('button', { name: 'Close command palette' })
    await expect(closeButton).toBeVisible()
    await expect(closeButton).toBeInViewport()
    await expect(palette.locator('.palette-input-row kbd')).toHaveText('esc')
    await closeButton.click()
    await expect(palette).toBeHidden()
    await expect(siteTrigger).toBeFocused()

    await page.goto('/sre')

    const trigger = page.getByRole('button', { name: 'Jump to a page in SRE' }).first()
    await trigger.click()
    palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette.getByRole('button', { name: 'Close command palette' })).toBeVisible()
    await expect(palette.locator('.palette-input-row kbd')).toHaveText('esc')

    await palette.getByRole('button', { name: 'Close command palette' }).click()
    await expect(palette).toBeHidden()
    await expect(trigger).toBeFocused()

    await trigger.press('Enter')
    palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
    await expect(trigger).toBeFocused()

    await trigger.click()
    palette = page.getByRole('dialog', { name: 'Command palette' })
    await page.locator('.palette-backdrop').click({ position: { x: 2, y: 2 } })
    await expect(palette).toBeHidden()
    await expect(trigger).toBeFocused()
  }
})

test('desktop search affordances keep keyboard shortcuts visible', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await registerManySites(page)
  await page.goto('/')

  const siteSearchTrigger = page.getByRole('button', { name: 'Search sites' })
  await expect(siteSearchTrigger.locator('kbd')).toBeVisible()
  await expect(siteSearchTrigger.getByText('Search sites...')).toBeVisible()

  await page.getByRole('link', { name: /SRE/ }).click()
  await expect(page).toHaveURL(/\/sre$/)
  // The site home has no inline filter; its ⌘ K button opens the palette.
  await expect(page.locator('.site-home').getByRole('searchbox')).toHaveCount(0)
  const homeJump = page.locator('.site-home').getByRole('button', { name: /Jump to a page/ })
  await expect(homeJump).toBeVisible()
  await expect(homeJump.locator('kbd')).toHaveText('⌘ K')
  await expect(homeJump).toHaveAttribute('aria-keyshortcuts', 'Meta+K Control+K')
  await homeJump.click()
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(homeJump).toBeFocused()
  const sidebarSearch = page.locator('.sidebar-panel').getByRole('button', { name: 'Jump to a page in SRE' })
  await expect(sidebarSearch.locator('kbd')).toBeVisible()
  await expect(sidebarSearch.getByText('Jump to a page…', { exact: true })).toBeVisible()
  await expect(sidebarSearch).toHaveAttribute('aria-keyshortcuts', 'Meta+K Control+K')
})

test('the SRE index date is labeled as generation time and follows artifact updates', async ({ page }) => {
  for (const siteId of ['sre', 'frontend', 'showcase']) {
    const [indexResponse, metadataResponse] = await Promise.all([
      page.request.get(`/_indexes/${siteId}/index.json`),
      page.request.get(`/_indexes/${siteId}/meta.json`),
    ])
    expect(indexResponse.ok()).toBeTruthy()
    expect(metadataResponse.ok()).toBeTruthy()
    const index = await indexResponse.json()
    const metadata = await metadataResponse.json()
    const latestArtifactUpdate = Math.max(...index.artifacts.map((artifact: { updatedAt: string }) => (
      Date.parse(artifact.updatedAt)
    )))

    expect(metadata.generatedAt, `${siteId} discovery metadata`).toBe(index.generatedAt)
    expect(Date.parse(index.generatedAt), `${siteId} generation timestamp`).toBeGreaterThanOrEqual(latestArtifactUpdate)
  }

  const sreIndexResponse = await page.request.get('/_indexes/sre/index.json')
  const sreIndex = await sreIndexResponse.json()

  await page.goto('/sre')
  const indexDate = page.locator('.sidebar-panel .index-date')
  await expect(indexDate).toContainText('Index generated')
  await expect(indexDate.locator('time')).toHaveAttribute('datetime', sreIndex.generatedAt)
  const generatedDate = new Date(sreIndex.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  await expect(indexDate).toHaveText(`Index generated ${generatedDate}`)
})

test('the root command palette searches sites and opens the selected site', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  await page.keyboard.press('Control+k')

  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await expect.poll(() => palette.evaluate((element) => (
    element.getAnimations().every((animation) => animation.playState === 'finished')
  ))).toBeTruthy()
  const paletteTop = async () => palette.evaluate((element) => element.getBoundingClientRect().top)
  const initialPaletteTop = await paletteTop()
  await expect(search).toHaveAttribute('placeholder', 'Search sites...')
  await expect(palette.getByRole('option', { name: /SRE/ })).toBeVisible()
  await expect(palette.getByRole('option', { name: /Frontend/ })).toBeVisible()

  await search.fill('cloud')
  await expect(palette.getByRole('option')).toHaveCount(0)
  await expect.poll(async () => Math.abs((await paletteTop()) - initialPaletteTop)).toBeLessThan(1)

  await search.fill('front')
  await expect.poll(async () => Math.abs((await paletteTop()) - initialPaletteTop)).toBeLessThan(1)
  const frontend = palette.getByRole('option', { name: /Frontend/ })
  await expect(frontend).toBeVisible()
  await search.press('Enter')

  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(/\/frontend$/)
  await expect(page.getByRole('heading', { name: 'Frontend', exact: true })).toBeVisible()
})

test('registered discovery honors sites.json, hides unregistered storage, and loads only the active full index', async ({ page }) => {
  const indexRequests: string[] = []
  const metadataRequests: string[] = []
  const directoryRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (/^\/_indexes\/[^/]+\/index\.json$/u.test(pathname)) indexRequests.push(pathname)
    if (/^\/_indexes\/[^/]+\/meta\.json$/u.test(pathname)) metadataRequests.push(pathname)
    if (pathname === '/_indexes/') directoryRequests.push(pathname)
  })
  await page.route('**/_indexes/sites.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      sites: [
        { id: 'frontend', name: 'Frontend registered', repository: 'acme/frontend', sourcePath: 'sites/frontend' },
        { id: 'sre', name: 'SRE registered', repository: 'acme/sre', sourcePath: 'sites/sre' },
      ],
    }),
  }))
  await page.route('**/_indexes/frontend/meta.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      site: { id: 'frontend', title: 'Frontend metadata' },
      generatedAt: '2026-09-25T00:00:00Z',
      artifactCount: 1,
      artifactIndexUrl: '/_indexes/frontend/index.json',
    }),
  }))
  await page.route('**/_indexes/sre/meta.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      site: { id: 'sre', title: 'SRE metadata' },
      generatedAt: '2026-09-25T00:00:00Z',
      artifactCount: 6,
      artifactIndexUrl: '/_indexes/sre/index.json',
    }),
  }))

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Frontend registered/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /SRE registered/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /HTML Showcase/ })).toHaveCount(0)
  expect(metadataRequests.sort()).toEqual(['/_indexes/frontend/meta.json', '/_indexes/sre/meta.json'])
  expect(indexRequests).toEqual([])
  expect(directoryRequests).toEqual([])

  await page.getByRole('link', { name: /SRE registered/ }).click()
  await expect(page).toHaveURL(/\/sre$/u)
  await expect(page.getByRole('heading', { name: 'SRE registered', exact: true })).toBeVisible()
  await expect.poll(() => [...indexRequests]).toEqual(['/_indexes/sre/index.json'])
  expect(indexRequests).not.toContain('/_indexes/frontend/index.json')
  expect(indexRequests).not.toContain('/_indexes/orphaned/index.json')
})

test('an empty registered site stays on its home route and does not affect a neighboring site', async ({ page }) => {
  const artifactRequests: string[] = []
  await page.route('**/_indexes/sites.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      sites: [
        { id: 'empty', name: 'Empty registered', repository: 'acme/empty', sourcePath: 'sites/empty' },
        { id: 'neighbor', name: 'Neighbor', repository: 'acme/neighbor', sourcePath: 'sites/neighbor' },
      ],
    }),
  }))
  await page.route('**/_indexes/empty/meta.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      site: { id: 'empty', title: 'Empty registered' },
      generatedAt: '2026-09-28T00:00:00Z',
      artifactCount: 0,
      artifactIndexUrl: '/_indexes/empty/index.json',
    }),
  }))
  await page.route('**/_indexes/neighbor/meta.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      site: { id: 'neighbor', title: 'Neighbor' },
      generatedAt: '2026-09-28T00:00:00Z',
      artifactCount: 1,
      artifactIndexUrl: '/_indexes/neighbor/index.json',
    }),
  }))
  await page.route('**/_indexes/empty/index.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      site: { id: 'empty', title: 'Empty registered' },
      generatedAt: '2026-09-28T00:00:00Z',
      artifacts: [],
    }),
  }))
  await page.route('**/_indexes/neighbor/index.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      site: { id: 'neighbor', title: 'Neighbor' },
      generatedAt: '2026-09-28T00:00:00Z',
      artifacts: [{
        id: 'report.html',
        title: 'Neighbor report',
        path: 'report.html',
        format: 'html',
        artifactUrl: '/_artifacts/neighbor/report.html',
        updatedAt: '2026-09-28T00:00:00Z',
      }],
    }),
  }))
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.startsWith('/_artifacts/empty/')) artifactRequests.push(pathname)
  })

  await page.goto('/')
  const emptySite = page.getByRole('link', { name: /Empty registered/ })
  await expect(emptySite).toContainText('0 artifacts')
  await emptySite.click()
  await expect(page).toHaveURL(/\/empty$/u)
  await expect(page.getByRole('heading', { name: 'Empty registered', exact: true })).toBeVisible()
  await expect(page.locator('.site-home .site-home-lede')).toContainText('0 published artifacts.')
  await expect(page.getByText('There are no artifact groups to browse yet.')).toBeVisible()
  await expect(page.locator('.site-home .tree-artifact')).toHaveCount(0)
  await expect(page.locator('.artifact-frame')).toHaveCount(0)

  await page.goto('/empty/index.html')
  await expect(page).toHaveURL(/\/empty\/index\.html$/u)
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  expect(artifactRequests).toEqual([])

  await page.goto('/neighbor')
  await expect(page.getByRole('heading', { name: 'Neighbor', exact: true })).toBeVisible()
  await expect(page.locator('.site-home .tree-artifact .tree-label')).toHaveText('Neighbor report')
  expect(artifactRequests).toEqual([])
})

test('a registered site remains discoverable before and after its first publish', async ({ page }) => {
  let frontendPublished = false
  const indexRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (/^\/_indexes\/[^/]+\/index\.json$/u.test(pathname)) indexRequests.push(pathname)
  })
  await page.route('**/_indexes/sites.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      sites: [
        { id: 'frontend', name: 'Frontend registered', repository: 'acme/frontend', sourcePath: 'sites/frontend' },
        { id: 'sre', name: 'SRE registered', repository: 'acme/sre', sourcePath: 'sites/sre' },
      ],
    }),
  }))
  await page.route('**/_indexes/frontend/meta.json', (route) => frontendPublished
    ? route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          site: { id: 'frontend', title: 'Frontend metadata' },
          generatedAt: '2026-09-28T00:00:00Z',
          artifactCount: 3,
          artifactIndexUrl: '/_indexes/frontend/index.json',
        }),
      })
    : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }))
  await page.route('**/_indexes/sre/meta.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      site: { id: 'sre', title: 'SRE metadata' },
      generatedAt: '2026-09-25T00:00:00Z',
      artifactCount: 6,
      artifactIndexUrl: '/_indexes/sre/index.json',
    }),
  }))
  await page.route('**/_indexes/frontend/index.json', (route) => frontendPublished
    ? route.continue()
    : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }))

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  const frontendBeforePublish = page.getByRole('link', { name: /Frontend registered/ })
  await expect(frontendBeforePublish).toContainText('Registered · not published yet')
  await expect(frontendBeforePublish).not.toContainText(/\d+ artifacts/u)
  await expect(page.getByRole('link', { name: /SRE registered/ })).toContainText('6 artifacts')
  expect(indexRequests).toEqual([])

  await frontendBeforePublish.click()
  await expect(page.getByRole('heading', { name: 'Site registered, but not published yet' })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('This site is registered and will appear here after its first publish.')
  expect(indexRequests).toEqual(['/_indexes/frontend/index.json'])

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  await page.keyboard.press('Control+k')
  const searchPalette = page.getByRole('dialog', { name: 'Command palette' })
  const search = searchPalette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('SRE registered')
  await expect(searchPalette.getByRole('option', { name: /SRE registered/ })).toBeVisible()
  await search.press('Enter')
  await expect(page).toHaveURL(/\/sre$/u)
  await expect(page.getByRole('heading', { name: 'SRE registered', exact: true })).toBeVisible()
  expect(indexRequests).toEqual(['/_indexes/frontend/index.json', '/_indexes/sre/index.json'])

  frontendPublished = true
  await page.goto('/')
  const frontendAfterPublish = page.getByRole('link', { name: /Frontend registered/ })
  await expect(frontendAfterPublish).toContainText('3 artifacts')
  await expect(frontendAfterPublish).not.toContainText('not published yet')
  await frontendAfterPublish.click()
  await expect(page).toHaveURL(/\/frontend$/u)
  await expect(page.getByRole('heading', { name: 'Frontend registered', exact: true })).toBeVisible()
  expect(indexRequests).toEqual([
    '/_indexes/frontend/index.json',
    '/_indexes/sre/index.json',
    '/_indexes/frontend/index.json',
  ])
})

for (const failure of ['invalid metadata', 'network failure'] as const) {
  test(`one site's ${failure} does not discard healthy discovery`, async ({ page }) => {
    const indexRequests: string[] = []
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (/^\/_indexes\/[^/]+\/index\.json$/u.test(pathname)) indexRequests.push(pathname)
    })
    await page.route('**/_indexes/sites.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        sites: [
          {
            id: 'frontend',
            name: 'Frontend registered',
            description: 'Incident response runbooks, service ownership guidance, reliability reviews, deployment health reports, and recovery procedures for production teams.',
            repository: 'acme/frontend',
            sourcePath: 'sites/frontend',
          },
          { id: 'sre', name: 'SRE registered', repository: 'acme/sre', sourcePath: 'sites/sre' },
        ],
      }),
    }))
    await page.route('**/_indexes/frontend/meta.json', (route) => failure === 'invalid metadata'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, site: { id: 'frontend' } }) })
      : route.abort())
    await page.route('**/_indexes/sre/meta.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        site: { id: 'sre', title: 'SRE metadata' },
        generatedAt: '2026-09-25T00:00:00Z',
        artifactCount: 6,
        artifactIndexUrl: '/_indexes/sre/index.json',
      }),
    }))

    await page.setViewportSize({ width: 320, height: 760 })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    const frontend = page.getByRole('link', { name: /Frontend registered/ })
    await expect(frontend).toContainText('Registered · details unavailable')
    await expect(frontend).not.toContainText(/\d+ artifacts/u)
    await expect(frontend.locator('.site-picker-description')).toHaveText('Incident response runbooks, service ownership guidance, reliability reviews, deployment health reports, and recovery procedures for production teams.')
    await expect(frontend.locator('.site-picker-meta')).toContainText('/frontend')
    const sre = page.getByRole('link', { name: /SRE registered/ })
    await expect(sre).toContainText('6 artifacts')
    await expect(sre.locator('.site-picker-description')).toHaveCount(0)
    await expect(sre.locator('.site-picker-meta')).toContainText('/sre')

    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
    await search.fill('reliability')
    const descriptionMatch = palette.getByRole('option', { name: /Frontend registered/ })
    await expect(descriptionMatch).toBeVisible()
    await expect(descriptionMatch.locator('.palette-entry-description')).toHaveText('Incident response runbooks, service ownership guidance, reliability reviews, deployment health reports, and recovery procedures for production teams.')
    await expect(descriptionMatch.locator('.palette-entry-description')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    await search.fill('SRE registered')
    const siteWithoutDescription = palette.getByRole('option', { name: /SRE registered/ })
    await expect(siteWithoutDescription.locator('.palette-entry-description')).toHaveCount(0)
    await expect(siteWithoutDescription).toBeVisible()
    await search.press('Enter')
    await expect(page).toHaveURL(/\/sre$/u)
    await expect(page.getByRole('heading', { name: 'SRE registered', exact: true })).toBeVisible()
    expect(indexRequests).toEqual(['/_indexes/sre/index.json'])
  })
}

test('registered discovery shows empty and malformed registries and refreshes renamed sites after reload', async ({ page }) => {
  let registryState: 'empty' | 'malformed' | 'first' | 'renamed' = 'empty'
  await page.route('**/_indexes/sites.json', (route) => {
    if (registryState === 'empty') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, sites: [] }) })
    }
    if (registryState === 'malformed') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, sites: [{ id: 'sre' }] }) })
    }
    const name = registryState === 'first' ? 'SRE first name' : 'SRE renamed'
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        sites: [{ id: 'sre', name, repository: 'acme/sre', sourcePath: 'sites/sre' }],
      }),
    })
  })
  await page.route('**/_indexes/sre/meta.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      site: { id: 'sre', title: 'SRE metadata' },
      generatedAt: '2026-09-25T00:00:00Z',
      artifactCount: 6,
      artifactIndexUrl: '/_indexes/sre/index.json',
    }),
  }))

  await page.goto('/')
  await expect(page.getByText('No registered sites were found.')).toBeVisible()

  registryState = 'malformed'
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Unable to load sites' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('We could not load the site catalog. Check your connection and try again.')

  registryState = 'first'
  await page.reload()
  await expect(page.getByRole('link', { name: /SRE first name/ })).toBeVisible()

  registryState = 'renamed'
  await page.reload()
  await expect(page.getByRole('link', { name: /SRE renamed/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /SRE first name/ })).toHaveCount(0)
})

test('site discovery loads lightweight metadata for all sites but detailed indexes on demand', async ({ page }) => {
  const indexRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (/^\/_indexes\/[^/]+\/index\.json$/u.test(pathname)) indexRequests.push(pathname)
  })

  await page.goto('/sre')
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
  await expect.poll(() => [...indexRequests]).toEqual(['/_indexes/sre/index.json'])

  const paletteButton = page.getByRole('button', { name: 'Jump to a page in SRE' })
  await paletteButton.click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('Button guidelines')
  await expect(palette.getByRole('option')).toHaveCount(0)
  await search.fill('@front')
  await expect(palette.getByRole('option', { name: /Frontend/ })).toBeVisible()
  await expect.poll(() => [...indexRequests]).toEqual(['/_indexes/sre/index.json'])
})

test('single-site switcher selects its only destination so Enter opens the current site home', async ({ page }) => {
  await page.route('**/_indexes/sites.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      sites: [{
        id: 'sre',
        name: 'SRE',
        repository: 'artifact-pages/artifact-pages',
        sourcePath: 'fixtures/storage/_artifacts/sre',
      }],
    }),
  }))

  await page.goto('/sre/reports/latency-retrospective.md')
  await expect(page.getByTestId('markdown-document').getByRole('heading', { level: 2, name: 'Outcome at a glance' })).toBeVisible()
  await page.getByRole('button', { name: 'Switch site. Current site: SRE' }).click()

  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  const onlySite = palette.getByRole('option', { name: /SRE/ })
  await expect(palette.getByRole('option')).toHaveCount(1)
  await expect(onlySite).toHaveAttribute('aria-selected', 'true')

  await search.press('Enter')
  await expect(page).toHaveURL(/\/sre$/)
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
})

test('site switcher names its count in the tooltip and accessible name', async ({ page }) => {
  await page.goto('/sre')
  const multi = page.getByRole('button', { name: /^Switch site\. Current site: SRE\. ([2-9]|\d{2,}) sites available$/ })
  await expect(multi).toBeVisible()
  await expect(multi).toHaveAttribute('title', /^Switch site — ([2-9]|\d{2,}) sites available$/)
  await expect(multi.locator('.site-switcher-hint')).toHaveAttribute('aria-hidden', 'true')

  await page.route('**/_indexes/sites.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      sites: [{ id: 'sre', name: 'SRE', repository: 'artifact-pages/artifact-pages', sourcePath: 'fixtures/storage/_artifacts/sre' }],
    }),
  }))
  await page.goto('/sre/reports/latency-retrospective.md')
  const single = page.getByRole('button', { name: 'Switch site. Current site: SRE. 1 site available', exact: true })
  await expect(single).toBeVisible()
  await expect(single).toHaveAttribute('title', 'Switch site — 1 site available')

  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  const rail = page.getByRole('button', { name: 'Switch site. Current site: SRE. 1 site available', exact: true })
  await expect(rail).toBeVisible()
  await expect(rail).toHaveAttribute('title', 'Switch site — SRE (1 site available)')
})

test('site switcher has no default destination, then selects matching sites by query', async ({ page }) => {
  await page.goto('/sre')
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Switch site. Current site: SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('option')).toHaveCount(3)
  await expect(palette.getByRole('option', { selected: true })).toHaveCount(0)

  await search.press('Enter')
  await expect(palette).toBeVisible()
  await expect(page).toHaveURL(/\/sre$/)

  await search.fill('@front')
  const frontend = palette.getByRole('option', { name: /Frontend/ })
  await expect(frontend).toHaveAttribute('aria-selected', 'true')
  await search.press('Enter')
  await expect(page).toHaveURL(/\/frontend$/)
  await expect(page.getByRole('heading', { name: 'Frontend', exact: true })).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(/\/sre$/)
  await page.getByRole('button', { name: 'Switch site. Current site: SRE' }).click()
  const reopenedPalette = page.getByRole('dialog', { name: 'Command palette' })
  const reopenedSearch = reopenedPalette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await reopenedSearch.fill('@front')
  const frontendByClick = reopenedPalette.getByRole('option', { name: /Frontend/ })
  await expect(frontendByClick).toHaveAttribute('aria-selected', 'true')
  await frontendByClick.click()
  await expect(page).toHaveURL(/\/frontend$/)
  await expect(page.getByRole('heading', { name: 'Frontend', exact: true })).toBeVisible()
})

test('fixture discovery never falls back to nginx directory listing', async ({ page }) => {
  const directoryRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/_indexes/') directoryRequests.push(request.url())
  })
  await page.goto('/sre')
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Switch site. Current site: SRE' })).toBeVisible()
  expect(directoryRequests).toEqual([])
})

test('small sites avoid redundant recent sections while larger sites keep them', async ({ page }) => {
  await page.goto('/sre')

  await expect(page.locator('.site-home .artifact-list-section[aria-label="Recently updated"]')).toHaveCount(0)
  await expect(page.locator('.site-home .browse-section')).toBeVisible()
  await expect(page.locator('.sidebar-panel .sidebar-section-label', { hasText: 'Recently updated' })).toHaveCount(0)
  await expect(page.locator('.sidebar-panel .browse-tree')).toBeVisible()

  await page.goto('/showcase')

  await expect(page.locator('.site-home .artifact-list-section[aria-label="Recently updated"]')).toBeVisible()
  // Recently updated lives on the site home only; the sidebar keeps Pinned and Browse.
  await expect(page.locator('.sidebar-panel .sidebar-section-label', { hasText: 'Recently updated' })).toHaveCount(0)
  await expect(page.locator('.site-home .browse-section')).toBeVisible()
  await expect(page.locator('.sidebar-panel .browse-tree')).toBeVisible()
})

test('artifact actions pin locally without changing selection or Browse, and expose source links', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/sre/architecture/platform-topology/index.html')
  const appOrigin = new URL(page.url()).origin

  const browse = page.locator('.browse-tree')
  const activeArtifact = browse.locator('.tree-artifact[data-tree-path="architecture/platform-topology/index.html"][aria-current="page"]')
  await expect(activeArtifact).toBeVisible()
  await expect(activeArtifact).toHaveCSS('font-weight', '580')
  expect(await activeArtifact.evaluate((element) => getComputedStyle(element, '::after').content)).toBe('none')
  const incidentsDirectory = browse.locator('.tree-directory-button[data-tree-path="incidents"]')
  await expect(incidentsDirectory).toHaveAttribute('aria-expanded', 'false')

  await incidentsDirectory.click()
  const checkoutFolder = browse.locator('.tree-directory-button[data-tree-path="incidents/checkout-latency"]')
  await checkoutFolder.click()
  const browseActions = browse.getByRole('button', { name: 'Actions for Checkout latency incident review' })
  await browseActions.click()
  let menu = page.getByRole('menu', { name: 'Checkout latency incident review actions' })
  await expect(menu.getByRole('menuitem', { name: 'Pin' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Open source' })).toHaveAttribute(
    'href',
    'https://github.com/example/payments/blob/main/incidents/checkout-latency/index.html',
  )
  await expect(menu.getByRole('menuitem', { name: 'View history' })).toHaveAttribute(
    'href',
    'https://github.com/example/payments/commits/main/incidents/checkout-latency/index.html',
  )
  await expect(menu.getByRole('menuitem', { name: 'Open raw artifact' })).toHaveAttribute(
    'href',
    new URL('/_artifacts/sre/incidents/checkout-latency/index.html', appOrigin).href,
  )
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(browseActions).toBeFocused()
  await browseActions.click()
  menu = page.getByRole('menu', { name: 'Checkout latency incident review actions' })
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Copy link' })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(menu.getByRole('menuitem', { name: 'Pin' })).toBeFocused()
  await page.keyboard.press('p')

  await expect(page).toHaveURL(/\/sre\/architecture\/platform-topology\/index\.html$/)
  await expect(activeArtifact).toBeVisible()
  const pinned = page.locator('.pinned-tree')
  await expect(pinned.getByText('Pinned', { exact: true })).toBeVisible()
  await expect(pinned.locator('.tree-artifact')).toContainText('Checkout latency incident review')
  await expect(browse.locator('.tree-artifact[data-tree-path="incidents/checkout-latency/index.html"]')).toHaveCount(1)
  await expect(page.locator('.sidebar-panel .tree-artifact[data-tree-path="incidents/checkout-latency/index.html"]')).toHaveCount(2)
  await expect(page.locator('.sidebar-panel .sidebar-section-label', { hasText: 'Recently updated' })).toHaveCount(0)
  await incidentsDirectory.click()
  await expect(incidentsDirectory).toHaveAttribute('aria-expanded', 'false')
  await page.reload()
  await expect(page.locator('.pinned-tree .tree-artifact')).toContainText('Checkout latency incident review')
  await expect(browse.locator('.tree-artifact[aria-current="page"]')).toHaveAttribute('data-tree-path', 'architecture/platform-topology/index.html')

  await page.locator('.pinned-tree').getByRole('button', { name: 'Actions for Checkout latency incident review' }).click()
  menu = page.getByRole('menu', { name: 'Checkout latency incident review actions' })
  await expect(menu.getByRole('menuitem', { name: 'Unpin' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Unpin' }).click()
  await expect(page.locator('.pinned-tree')).toHaveCount(0)
  await expect(incidentsDirectory).toBeFocused()
  await expect(incidentsDirectory).toHaveAttribute('aria-expanded', 'false')
  await expect(page).toHaveURL(/\/sre\/architecture\/platform-topology\/index\.html$/)

  await browse.locator('.tree-directory-button[data-tree-path="incidents"]').click()
  await browse.locator('.tree-directory-button[data-tree-path="incidents/checkout-latency"]').click()
  const browseArtifact = browse.locator('.tree-artifact[data-tree-path="incidents/checkout-latency/index.html"]')
  await expect(browseArtifact).toContainText('Checkout latency incident review')
  await browse.getByRole('button', { name: 'Actions for Checkout latency incident review' }).last().click()
  menu = page.getByRole('menu', { name: 'Checkout latency incident review actions' })
  await page.keyboard.press('l')

  await expect(page.getByRole('status')).toHaveText('Link copied to clipboard.')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    new URL('/sre/incidents/checkout-latency/index.html', appOrigin).href,
  )
  await expect(page).toHaveURL(/\/sre\/architecture\/platform-topology\/index\.html$/)
})

test('palette commands pin and unpin the current artifact and toggle Details only while an artifact is open', async ({ page }) => {
  await page.goto('/sre/architecture/platform-topology/index.html')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  const openPalette = async () => {
    await page.keyboard.press('Control+k')
    await expect(palette).toBeVisible()
  }
  const pinStorage = () => page.evaluate(() => JSON.parse(
    window.localStorage.getItem('git-artifact-pages:pinned-artifacts:v1') ?? '{}',
  ))

  await expect(page.getByRole('button', { name: /Pin Platform topology/ })).toBeVisible()
  await openPalette()
  await search.fill('>pin artifact')
  await expect(palette.getByRole('option', { name: 'Unpin artifact' })).toHaveCount(0)
  await palette.getByRole('option', { name: 'Pin artifact' }).click()
  await expect(palette).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: 'Pinned' })).toHaveText('Pinned Platform topology.')
  await expect(page.getByRole('button', { name: 'Unpin Platform topology' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(pinStorage).toEqual({ sre: ['architecture/platform-topology/index.html'] })
  await expect(page.locator('.pinned-tree .tree-artifact')).toContainText('Platform topology')

  await openPalette()
  await search.fill('>pin artifact')
  await expect(palette.getByRole('option', { name: 'Pin artifact', exact: true })).toHaveCount(0)
  await palette.getByRole('option', { name: 'Unpin artifact' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Unpinned' })).toHaveText('Unpinned Platform topology.')
  await expect(page.getByRole('button', { name: 'Pin Platform topology' })).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(pinStorage).toEqual({ sre: [] })
  await expect(page.locator('.pinned-tree')).toHaveCount(0)

  const details = page.getByRole('complementary', { name: 'Details' })
  await expect(details).toBeHidden()
  await openPalette()
  await search.fill('>Toggle details')
  await palette.getByRole('option', { name: 'Toggle details' }).click()
  await expect(details).toBeVisible()
  await openPalette()
  await search.fill('>Toggle details')
  await palette.getByRole('option', { name: 'Toggle details' }).click()
  await expect(details).toBeHidden()

  await page.goto('/sre')
  await expect(page.getByRole('button', { name: 'Jump to a page in SRE' })).toBeVisible()
  await openPalette()
  await search.fill('>Toggle')
  await expect(palette.getByRole('option', { name: 'Toggle sidebar' })).toBeVisible()
  await expect(palette.getByRole('option', { name: 'Toggle details' })).toHaveCount(0)
  await search.fill('>pin')
  await expect(palette.getByRole('option', { name: /Pin artifact|Unpin artifact/ })).toHaveCount(0)
})

test('the current page pin control stays discoverable with the sidebar closed and preserves pin state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/sre/architecture/platform-topology/index.html')

  await expect(page.locator('.sidebar-panel')).toBeHidden()
  await expect.poll(() => page.evaluate(() => {
    const value = window.localStorage.getItem('git-artifact-pages:pinned-artifacts:v1')
    return value ? JSON.parse(value) : {}
  })).toEqual({})

  const pinButton = page.getByRole('button', { name: 'Pin Platform topology' })
  await expect(pinButton).toBeVisible()
  await expect(pinButton).toContainText('Pin')
  await expect(pinButton).toHaveAttribute('aria-pressed', 'false')
  await pinButton.click()

  const unpinButton = page.getByRole('button', { name: 'Unpin Platform topology' })
  await expect(unpinButton).toBeVisible()
  await expect(unpinButton).toContainText('Pinned')
  await expect(unpinButton).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('status')).toHaveText('Pinned Platform topology.')
  await expect.poll(() => page.evaluate(() => JSON.parse(
    window.localStorage.getItem('git-artifact-pages:pinned-artifacts:v1') ?? '{}',
  ))).toEqual({ sre: ['architecture/platform-topology/index.html'] })

  await page.reload()
  await expect(page.locator('.sidebar-panel')).toBeHidden()
  const persistedUnpinButton = page.getByRole('button', { name: 'Unpin Platform topology' })
  await expect(persistedUnpinButton).toBeVisible()
  await expect(persistedUnpinButton).toHaveAttribute('aria-pressed', 'true')
  await persistedUnpinButton.click()

  const restoredPinButton = page.getByRole('button', { name: 'Pin Platform topology' })
  await expect(restoredPinButton).toBeVisible()
  await expect(restoredPinButton).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('status')).toHaveText('Unpinned Platform topology.')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Pin Platform topology' })).toHaveAttribute('aria-pressed', 'false')
})

test('the palette footer advertises headings only when an artifact is open', async ({ page }) => {
  const open = async (trigger: string) => {
    await page.getByRole('button', { name: trigger }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    return palette.locator('.palette-footer')
  }

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  let footer = page.getByRole('dialog', { name: 'Command palette' }).locator('.palette-footer')
  await expect(footer).toContainText('navigate')
  await expect(footer).toContainText('@ sites')
  await expect(footer).not.toContainText('# headings')
  await page.getByRole('dialog', { name: 'Command palette' })
    .getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' }).fill('#')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toContainText('Open an artifact first')
  await page.keyboard.press('Escape')

  await page.goto('/sre')
  footer = await open('Jump to a page in SRE')
  await expect(footer).toContainText('> commands')
  await expect(footer).not.toContainText('# headings')
  await expect(footer).not.toContainText('search page text')
  await page.keyboard.press('Escape')

  await page.goto('/sre/architecture/platform-topology/index.html')
  await expect(page.getByRole('button', { name: /Pin Platform topology/ })).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  footer = page.getByRole('dialog', { name: 'Command palette' }).locator('.palette-footer')
  await expect(footer).toContainText('# headings')
})

test('the command palette supports Ctrl+J/K navigation and opens the selected result', async ({ page }) => {
  await page.goto('/sre')
  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()

  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('latency')

  await expect(palette.locator('.palette-footer')).toHaveText(/Ctrl\+J\/K/)
  const options = palette.getByRole('option')
  expect(await options.count()).toBeGreaterThan(1)
  const selectedResult = () => palette.locator('[aria-selected="true"]').evaluate((element) => ({
    path: element.querySelector('.palette-entry-subtitle')?.textContent ?? '',
    section: element.closest('.palette-section')?.querySelector('.palette-section-title')?.textContent ?? '',
  }))
  const firstResult = await selectedResult()

  await search.press('Control+j')
  const secondResult = await selectedResult()
  expect(secondResult.path).not.toBe(firstResult.path)

  await search.press('Control+k')
  expect(await selectedResult()).toEqual(firstResult)

  await search.press('Control+j')
  const resultOpenedByEnter = await selectedResult()
  await search.press('Enter')

  await expect(palette).toBeHidden()
  const siteIdsBySection: Record<string, string> = { Pages: 'sre' }
  const siteId = siteIdsBySection[resultOpenedByEnter.section]
  expect(siteId).toBeTruthy()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/${siteId}/${resultOpenedByEnter.path}`)
  if (resultOpenedByEnter.path.endsWith('.md')) {
    await expect(page.locator('.markdown-scroll')).toBeVisible()
  } else {
    await expect(page.locator('iframe.artifact-frame')).toBeVisible()
  }
})

test('large site indexes use their compact palette scoring profile', async ({ page }) => {
  await page.route('**/_indexes/sre/index.json', async (route) => {
    const response = await route.fetch()
    const index = await response.json()
    const sourceArtifacts = index.artifacts
    const artifacts = [...sourceArtifacts]
    while (artifacts.length < 5_000) {
      const ordinal = artifacts.length - sourceArtifacts.length
      const base = sourceArtifacts[ordinal % sourceArtifacts.length]
      const path = `generated/${String(ordinal).padStart(5, '0')}/${base.id.replaceAll('/', '-')}`
      artifacts.push({
        id: path,
        title: `${base.title} generated ${ordinal}`,
        path,
        format: base.format,
        artifactUrl: `/_artifacts/sre/${path}`,
        updatedAt: base.updatedAt,
      })
    }
    artifacts.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    index.artifacts = artifacts
    index.paletteScoringProfile = buildPaletteScoringProfile(artifacts)
    await route.fulfill({ response, json: index })
  })

  await page.goto('/sre/architecture/platform-topology/index.html')
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()
  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('platform')
  await expect(palette.getByRole('option').first()).toBeVisible()
  await expect(palette.getByRole('option', { name: /Platform topology/ }).first()).toBeVisible()
})

test('a blank palette returns to recently read pages across reloads, and typing ranks by name', async ({ page }) => {
  await page.goto('/sre')

  const openPalette = async () => {
    await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
    return page.getByRole('dialog', { name: 'Command palette' })
  }

  let palette = await openPalette()
  let search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('platform topology')
  await search.press('Enter')
  await expect(page).toHaveURL(/\/sre\/architecture\/platform-topology\/index\.html$/)

  palette = await openPalette()
  search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('checkout latency')
  await search.press('Enter')
  await expect(page).toHaveURL(/\/sre\/incidents\/checkout-latency\/index\.html$/)

  // No scope tabs: the blank palette lists the reader's own recent reads; commands stay behind ">".
  palette = await openPalette()
  search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await expect(palette.getByRole('group', { name: 'Filter site results' })).toHaveCount(0)
  await expect(palette.locator('.palette-section-title')).toHaveText(['Recently read'])
  const recentOptions = palette.locator('.palette-section', { hasText: 'Recently read' }).getByRole('option')
  await expect(recentOptions).toHaveCount(2)
  const checkout = recentOptions.filter({ hasText: 'Checkout latency incident review' })
  await expect(recentOptions.first()).toContainText('Checkout latency incident review')
  await expect(checkout.locator('.palette-entry-badge')).toContainText('Current page')
  await expect(recentOptions.nth(1)).toContainText('Platform topology')
  // The open page is marked but never preselected; the first Enter goes to the next page.
  await expect(checkout).toHaveAttribute('aria-current', 'page')
  await expect(checkout).toHaveAttribute('aria-selected', 'false')
  await expect(recentOptions.nth(1)).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('Escape')
  await page.reload()
  palette = await openPalette()
  search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await expect(palette.locator('.palette-section-title')).toHaveText(['Recently read'])
  await expect(palette.getByRole('option', { name: /Platform topology/ })).toBeVisible()

  await search.fill('platform')
  await expect(palette.locator('.palette-section-title')).toHaveText(['Pages'])
  await expect(palette.getByRole('option').first()).toContainText('Platform topology')
})

test('a blank palette lists the pinned current page once, before recent reads, after reload', async ({ page }) => {
  const currentPath = 'architecture/platform-topology/index.html'
  await page.goto(`/sre/${currentPath}`)

  const currentRow = page.locator(`.browse-tree .tree-artifact[data-tree-path="${currentPath}"][aria-current="page"]`).locator('xpath=..')
  await currentRow.getByRole('button', { name: 'Actions for Platform topology' }).click()
  await page.getByRole('menu', { name: 'Platform topology actions' }).getByRole('menuitem', { name: 'Pin' }).click()
  await page.reload()
  await expect(page.locator('.pinned-tree .tree-artifact')).toContainText('Platform topology')

  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  const currentResult = palette.getByRole('option', { name: /Platform topology/ })

  // The page is both pinned and recently read; it appears once, under Pinned.
  await expect(palette.locator('.palette-section-title').first()).toHaveText('Pinned')
  await expect(currentResult).toHaveCount(1)
  await expect(palette.locator('.palette-section', { hasText: 'Pinned' }).getByRole('option')).toHaveCount(1)
  await expect(currentResult.locator('.palette-entry-badge')).toHaveText('Current page')
  // It is the only page listed and is already open, so nothing is preselected.
  await expect(currentResult).toHaveAttribute('aria-current', 'page')
  await expect(palette.locator('[aria-selected="true"]')).toHaveCount(0)
  await expect(palette.locator('.palette-hint').last()).toContainText('Open another page to build your recent list.')

  await search.fill('Platform topology')
  await expect(currentResult).toBeVisible()
  await expect(currentResult.locator('.palette-entry-badge')).toContainText('Current page')
})

test('normal page search stays on the current site while @ and > select explicit scopes', async ({ page }) => {
  await page.goto('/sre')
  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()

  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await expect(search).toHaveAttribute('placeholder', 'Search pages... (> commands, @ sites)')
  await expect(palette.locator('.palette-scope')).toHaveText('SRE only')

  await search.fill('incident')
  await expect(palette.getByRole('option', { name: /Checkout latency incident review/ })).toBeVisible()
  await expect(palette.locator('.palette-section-title')).toHaveText(['Pages'])

  await search.fill('Button guidelines')
  await expect(palette.getByRole('option')).toHaveCount(0)
  await expect(palette.getByText(/Nothing matches/)).toBeVisible()

  await search.fill('@front')
  await expect(palette.getByRole('option', { name: /Frontend/ })).toBeVisible()
  await expect(palette.getByRole('option')).toHaveCount(1)
  await expect(palette.locator('.palette-section-title')).toHaveText(['Sites'])

  await search.fill('>theme')
  await expect(palette.locator('.palette-section-title')).toHaveText(['Commands'])
  await expect(palette.getByRole('option', { name: 'Use light theme' })).toBeVisible()
  await expect(palette.getByRole('option', { name: 'Use dark theme' })).toBeVisible()
  await expect(palette.getByRole('option', { name: 'Use system theme' })).toBeVisible()
  await expect(palette.getByRole('option')).toHaveCount(3)
})

const PALETTE_SEARCH_LABEL = 'Search artifacts, sites, commands, and headings'
const TOPOLOGY_PATH = 'architecture/platform-topology/index.html'
const CHECKOUT_PATH = 'incidents/checkout-latency/index.html'
const EMPTY_HISTORY_HINT = 'Type a page title or path to find it. Pin pages or open a few and they will show up here.'

async function openPaletteWithShortcut(page: Page) {
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  return palette
}

test('blank palette: first Enter opens the most recent other page, not the current one', async ({ page }) => {
  await page.goto(`/sre/${TOPOLOGY_PATH}`)
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()
  await page.goto(`/sre/${CHECKOUT_PATH}`)
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()

  const palette = await openPaletteWithShortcut(page)
  await expect(palette.getByRole('option', { name: /Platform topology/ })).toHaveAttribute('aria-selected', 'true')
  await palette.getByRole('textbox', { name: PALETTE_SEARCH_LABEL }).press('Enter')
  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`/sre/${TOPOLOGY_PATH.replaceAll('/', '\\/')}$`))
})

test('blank palette marks the current page and does not select it', async ({ page }) => {
  await page.goto(`/sre/${TOPOLOGY_PATH}`)
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()
  await page.goto(`/sre/${CHECKOUT_PATH}`)
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()

  const palette = await openPaletteWithShortcut(page)
  const current = palette.getByRole('option', { name: /Checkout latency incident review/ })
  await expect(current).toHaveAttribute('aria-current', 'page')
  await expect(current).toHaveAttribute('aria-selected', 'false')
  await expect(current.locator('.palette-entry-badge')).toHaveText('Current page')
  const selected = palette.locator('[aria-selected="true"]')
  await expect(selected).toHaveCount(1)
  await expect(selected).not.toHaveAttribute('aria-current', 'page')
  // Only the selected row shows the Enter hint.
  await expect(selected.locator('.palette-entry-enter')).toBeVisible()
  await expect(palette.locator('.palette-entry-enter')).toHaveCount(1)
  await expect(current.locator('.palette-entry-enter')).toHaveCount(0)
})

test('blank palette with a pinned current page keeps it once under Pinned, unselected, and selects the next page', async ({ page }) => {
  await page.goto(`/sre/${CHECKOUT_PATH}`)
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()
  await page.goto(`/sre/${TOPOLOGY_PATH}`)
  const currentRow = page.locator(`.browse-tree .tree-artifact[data-tree-path="${TOPOLOGY_PATH}"][aria-current="page"]`).locator('xpath=..')
  await currentRow.getByRole('button', { name: 'Actions for Platform topology' }).click()
  await page.getByRole('menu', { name: 'Platform topology actions' }).getByRole('menuitem', { name: 'Pin' }).click()
  await page.reload()
  await expect(page.locator('.pinned-tree .tree-artifact')).toContainText('Platform topology')

  const palette = await openPaletteWithShortcut(page)
  await expect(palette.locator('.palette-section-title')).toHaveText(['Pinned', 'Recently read'])
  const pinnedCurrent = palette.getByRole('option', { name: /Platform topology/ })
  await expect(pinnedCurrent).toHaveCount(1)
  await expect(palette.locator('.palette-section', { hasText: 'Pinned' }).getByRole('option')).toHaveCount(1)
  await expect(pinnedCurrent).toHaveAttribute('aria-current', 'page')
  await expect(pinnedCurrent).toHaveAttribute('aria-selected', 'false')
  await expect(palette.getByRole('option', { name: /Checkout latency incident review/ })).toHaveAttribute('aria-selected', 'true')
})

test('typing then pressing Enter at once opens the first match even when the blank default is not the first row', async ({ page }) => {
  // The only listed page is the open (pinned) one, so the blank default selection is -1.
  await page.goto(`/sre/${TOPOLOGY_PATH}`)
  const currentRow = page.locator(`.browse-tree .tree-artifact[data-tree-path="${TOPOLOGY_PATH}"][aria-current="page"]`).locator('xpath=..')
  await currentRow.getByRole('button', { name: 'Actions for Platform topology' }).click()
  await page.getByRole('menu', { name: 'Platform topology actions' }).getByRole('menuitem', { name: 'Pin' }).click()
  await page.reload()
  await expect(page.locator('.pinned-tree .tree-artifact')).toContainText('Platform topology')

  const palette = await openPaletteWithShortcut(page)
  await expect(palette.getByRole('option', { name: /Platform topology/ })).toHaveAttribute('aria-current', 'page')
  await expect(palette.locator('[aria-selected="true"]')).toHaveCount(0)

  // No waits: the new query's entries must pair with the new query's default selection.
  const search = palette.getByRole('textbox', { name: PALETTE_SEARCH_LABEL })
  await search.fill('Checkout latency')
  await search.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/sre/${CHECKOUT_PATH.replaceAll('/', '\\/')}$`))
})

test('a resting pointer under the palette does not steal the typed match', async ({ page }) => {
  await page.goto(`/sre/${CHECKOUT_PATH}`)
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()
  await page.goto(`/sre/${TOPOLOGY_PATH}`)
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()

  // Rest the pointer on the second blank-palette row; the typed query's second row is another page.
  let palette = await openPaletteWithShortcut(page)
  const secondRow = palette.getByRole('option').nth(1)
  await expect(secondRow).toContainText('Checkout latency incident review')
  const box = await secondRow.boundingBox()
  if (!box) throw new Error('palette row has no bounding box')
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

  palette = await openPaletteWithShortcut(page)
  const search = palette.getByRole('textbox', { name: PALETTE_SEARCH_LABEL })
  await search.fill('latency')
  // Two rows match; Chromium reports the pointer as entering the row that now sits under it.
  await expect(palette.getByRole('option')).toHaveCount(2)
  await expect(palette.getByRole('option').first()).toContainText('Checkout latency incident review')
  await search.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/sre/${CHECKOUT_PATH.replaceAll('/', '\\/')}$`))
})

test('arrow keys win over a resting pointer while the list scrolls', async ({ page }) => {
  // The fixtures list at most 8 rows, so a short viewport is what makes the list scroll.
  await page.setViewportSize({ width: 1280, height: 360 })
  await page.goto('/textsearch')
  await page.getByRole('button', { name: /^Jump to a page in/ }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const options = palette.getByRole('option')
  await expect(options).toHaveCount(8)
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
  const results = palette.locator('.palette-results')
  expect(await results.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  const box = await options.nth(2).boundingBox()
  if (!box) throw new Error('palette row has no bounding box')

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let step = 1; step <= 7; step += 1) {
    await page.keyboard.press('ArrowDown')
    await expect(options.nth(step)).toHaveAttribute('aria-selected', 'true')
    await expect(palette.locator('[aria-selected="true"]')).toHaveCount(1)
  }
  expect(await results.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
})

test('blank palette with no history shows guidance and ranked pages', async ({ page }) => {
  await page.goto('/sre')
  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette.locator('.palette-hint').first()).toHaveText(EMPTY_HISTORY_HINT)
  await expect(palette.locator('.palette-section-title')).toHaveText(['Pages'])
  expect(await palette.getByRole('option').count()).toBeGreaterThan(1)
  await expect(palette.locator('.palette-entry--current')).toHaveCount(0)
})

test('blank palette lists no Commands section and hints at > # @', async ({ page }) => {
  await page.goto(`/sre/${CHECKOUT_PATH}`)
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()
  const palette = await openPaletteWithShortcut(page)
  await expect(palette.locator('.palette-section-title')).not.toContainText(['Commands'])
  await expect(palette.getByRole('option', { name: 'Toggle sidebar' })).toHaveCount(0)
  await expect(palette.locator('.palette-hint')).toContainText('Type > for commands, # for headings in this page, @ to switch sites.')
  await expect(palette.getByRole('textbox', { name: PALETTE_SEARCH_LABEL }))
    .toHaveAttribute('placeholder', 'Search pages... (> commands, # headings, @ sites)')
})

test('typing a page name lists only Pages (and Page text), not headings or commands', async ({ page }) => {
  // "recovery" is the title of the page "Service recovery" and also matches two headings on the open page.
  await page.goto('/sre/runbooks/service-recovery.md')
  await expect(page.locator('.markdown-scroll')).toBeVisible()
  const palette = await openPaletteWithShortcut(page)
  const search = palette.getByRole('textbox', { name: PALETTE_SEARCH_LABEL })
  // Precondition: the same query does find headings when asked for with "#".
  await search.fill('#recovery')
  expect(await palette.getByRole('option').count()).toBeGreaterThan(0)
  await expect(palette.getByRole('option', { name: /Recovery checks/ })).toBeVisible()

  await search.fill('recovery')
  await expect(palette.getByRole('option', { name: /Service recovery/ })).toBeVisible()
  await expect(palette.locator('.palette-section-title')).toHaveText(['Pages'])
  await expect(palette.locator('.palette-entry-subtitle', { hasText: /^Heading/ })).toHaveCount(0)
})

test('typing text that matches no page falls back to labeled Headings and Commands groups', async ({ page }) => {
  await page.goto(`/sre/${CHECKOUT_PATH}`)
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()
  const palette = await openPaletteWithShortcut(page)
  const search = palette.getByRole('textbox', { name: PALETTE_SEARCH_LABEL })

  await search.fill('root cause')
  await expect(palette.locator('.palette-section-title')).toHaveText(['Headings in this page'])
  await expect(palette.getByRole('option', { name: /Root cause/ })).toContainText('Heading 2 · this page')

  await search.fill('light theme')
  await expect(palette.locator('.palette-section-title')).toHaveText(['Commands'])
  await expect(palette.getByRole('option', { name: 'Use light theme' })).toBeVisible()
})

test('prefix modes still reach headings, commands, and sites', async ({ page }) => {
  await page.goto(`/sre/${CHECKOUT_PATH}`)
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()
  const palette = await openPaletteWithShortcut(page)
  const search = palette.getByRole('textbox', { name: PALETTE_SEARCH_LABEL })

  await search.fill('#root')
  await expect(palette.locator('.palette-section-title')).toHaveText(['In Checkout latency incident review'])
  await expect(palette.getByRole('option', { name: /Root cause/ })).toBeVisible()
  await search.fill('>theme')
  await expect(palette.locator('.palette-section-title')).toHaveText(['Commands'])
  await expect(palette.getByRole('option')).toHaveCount(3)
  await search.fill('@front')
  await expect(palette.locator('.palette-section-title')).toHaveText(['Sites'])
  await expect(palette.getByRole('option', { name: /Frontend/ })).toBeVisible()
})

test('plain search stays in the active site', async ({ page }) => {
  await page.goto('/sre')
  const palette = await (async () => {
    await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
    return page.getByRole('dialog', { name: 'Command palette' })
  })()
  const search = palette.getByRole('textbox', { name: PALETTE_SEARCH_LABEL })
  // "Button guidelines" is a Frontend page; it is only reachable by switching sites.
  await search.fill('Button guidelines')
  await expect(palette.getByRole('option', { name: /Button guidelines/ })).toHaveCount(0)
  await search.fill('platform')
  await expect(palette.getByRole('option', { name: /Platform topology/ })).toBeVisible()
  await expect(palette.locator('.palette-section-title')).toHaveText(['Pages'])
})

test.describe('mobile viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  async function visit(page: Page, paths: string[]) {
    for (const path of paths) {
      await page.goto(`/sre/${path}`)
      await expect(page.locator('iframe.artifact-frame, .markdown-scroll').first()).toBeVisible()
    }
  }

  test('palette at 390px: current badge and title do not overlap, option height >= 44px, tap opens a page', async ({ page }) => {
    await visit(page, [CHECKOUT_PATH, TOPOLOGY_PATH])
    const palette = await openPaletteWithShortcut(page)
    const current = palette.getByRole('option', { name: /Platform topology/ })
    await expect(current).toHaveAttribute('aria-current', 'page')

    const title = await current.locator('.palette-entry-title').boundingBox()
    const badge = await current.locator('.palette-entry-badge').boundingBox()
    const box = await current.boundingBox()
    expect(title && badge && box).toBeTruthy()
    expect(badge!.y).toBeGreaterThanOrEqual(title!.y + title!.height - 1)
    expect(box!.height).toBeGreaterThanOrEqual(44)
    // Select another row (hover) so the Enter hint is shown, and keep it clear of the title.
    const other = palette.getByRole('option', { name: /Checkout latency incident review/ })
    await other.hover()
    await expect(other.locator('.palette-entry-enter')).toBeVisible()
    for (const row of [other, current]) {
      const rowTitle = await row.locator('.palette-entry-title').boundingBox()
      expect(rowTitle).toBeTruthy()
      await row.hover()
      const enter = await row.locator('.palette-entry-enter').boundingBox()
      expect(enter).toBeTruthy()
      const apart = enter!.x >= rowTitle!.x + rowTitle!.width || enter!.y >= rowTitle!.y + rowTitle!.height
        || enter!.x + enter!.width <= rowTitle!.x || enter!.y + enter!.height <= rowTitle!.y
      expect(apart).toBe(true)
    }
    await current.hover()
    const overflow = await palette.locator('.palette-results').evaluate((element) => element.scrollWidth <= element.clientWidth)
    expect(overflow).toBe(true)

    await palette.getByRole('option', { name: /Checkout latency incident review/ }).click()
    await expect(palette).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`/sre/${CHECKOUT_PATH.replaceAll('/', '\\/')}$`))
  })

  test('palette at 390px opens a page by tap and by keyboard Enter after ArrowDown', async ({ page }) => {
    await visit(page, ['runbooks/service-recovery.md', CHECKOUT_PATH, TOPOLOGY_PATH])
    let palette = await openPaletteWithShortcut(page)
    const search = palette.getByRole('textbox', { name: PALETTE_SEARCH_LABEL })
    await expect(palette.getByRole('option', { name: /Checkout latency incident review/ })).toHaveAttribute('aria-selected', 'true')
    await search.press('ArrowDown')
    await expect(palette.getByRole('option', { name: /Service recovery/ })).toHaveAttribute('aria-selected', 'true')
    await search.press('Enter')
    await expect(palette).toBeHidden()
    await expect(page).toHaveURL(/\/sre\/runbooks\/service-recovery\.md$/)

    palette = await openPaletteWithShortcut(page)
    await palette.getByRole('option', { name: /Platform topology/ }).tap()
    await expect(palette).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`/sre/${TOPOLOGY_PATH.replaceAll('/', '\\/')}$`))
  })
})

test('explicit palette scopes give recovery guidance for their own results', async ({ page }) => {
  await page.goto('/sre/incidents/checkout-latency/index.html')
  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()

  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })

  await search.fill('>no-such-command')
  await expect(palette.getByText('No commands match. Change or clear your search.', { exact: true })).toBeVisible()
  await search.fill('>theme')
  await expect(palette.getByRole('option', { name: 'Use light theme' })).toBeVisible()

  await search.fill('@no-such-site')
  await expect(palette.getByText('No sites match. Change or clear your search.', { exact: true })).toBeVisible()
  await search.fill('@front')
  await expect(palette.getByRole('option', { name: /Frontend/ })).toBeVisible()

  await search.fill('#no-such-heading')
  await expect(palette.getByText('No headings match. Change or clear your search.', { exact: true })).toBeVisible()
  await search.fill('#root')
  await expect(palette.getByRole('option', { name: /Root cause/ })).toBeVisible()
})

test('site search updates correctly for sequential typing, backspace, and a new query', async ({ page }) => {
  await page.goto('/sre')
  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()

  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  for (const character of 'platform topology') {
    await search.pressSequentially(character)
  }
  await expect(palette.getByRole('option', { name: /Platform topology/ })).toBeVisible()

  await search.press('Backspace')
  await expect(palette.getByRole('option', { name: /Platform topology/ })).toBeVisible()

  await search.fill('checkout')
  await expect(palette.getByRole('option', { name: /Checkout latency incident review/ })).toBeVisible()
  await expect(palette.getByRole('option', { name: /Platform topology/ })).toHaveCount(0)
})

test('artifact-context # search opens a heading and closes the palette', async ({ page }) => {
  await page.goto('/sre/incidents/checkout-latency/index.html')
  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()

  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('#root')
  await expect(palette.getByRole('option', { name: /Root cause/ })).toBeVisible()
  await expect(palette.getByRole('option')).toHaveCount(1)
  await expect(palette.getByText('Pages in SRE')).toHaveCount(0)
  await search.press('Enter')

  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(/#root-cause$/)
})

test('Markdown heading IDs match the shared fixture and Contents and palette reach rendered headings', async ({ page }) => {
  const fixture = markdownHeadingConformanceFixture
  const artifactPath = 'guides/heading-id-conformance.md'
  const toc = fixture.headings.flatMap((heading) => (
    heading.level <= 3 && heading.tocText !== undefined
      ? [{ level: heading.level, text: heading.tocText, id: heading.id }]
      : []
  ))

  await page.route('**/_indexes/sre/index.json', async (route) => {
    const response = await route.fetch()
    const index = await response.json() as { artifacts: Array<Record<string, unknown>> }
    index.artifacts.push({
      id: artifactPath,
      title: 'Markdown heading ID conformance',
      path: artifactPath,
      format: 'markdown',
      filename: 'heading-id-conformance.md',
      artifactUrl: `/_artifacts/sre/${artifactPath}`,
      updatedAt: '2026-09-29T00:00:00Z',
      toc,
    })
    await route.fulfill({ response, body: JSON.stringify(index) })
  })
  await page.route(`**/_artifacts/sre/${artifactPath}`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/markdown; charset=utf-8',
    body: fixture.markdown,
  }))

  await page.setViewportSize({ width: 1280, height: 420 })
  await page.goto(`/sre/${artifactPath}`)
  const reader = page.locator('.markdown-article')
  const scrollport = page.locator('.markdown-scroll')
  await expect(reader).toBeVisible()
  const actualHeadings = await reader.locator('h1, h2, h3, h4, h5, h6').evaluateAll((nodes) => nodes
    .filter((node) => !(node.classList.contains('sr-only') && node.textContent === 'Footnotes'))
    .map((node) => ({
      level: Number(node.tagName.slice(1)),
      renderedText: node.textContent ?? '',
      id: node.id,
    })))
  expect(actualHeadings).toEqual(fixture.headings.map(({ level, renderedText, id }) => ({ level, renderedText, id })))
  await expect(reader.locator('#md-widget-1')).toHaveText('Widget element anchor')

  await page.getByRole('button', { name: 'Contents', exact: true }).click()
  const contents = page.getByRole('complementary', { name: 'Contents' })
  // Contents stays open only when the jumped-to heading is clear of it, so
  // let that decision settle and reopen the panel if it closed.
  const reopenContents = async () => {
    await expect(page.locator('.stage')).toHaveAttribute('data-heading-jump', 'settled')
    if (!(await contents.isVisible())) await page.getByRole('button', { name: 'Contents', exact: true }).click()
    await expect(contents).toBeVisible()
  }
  await contents.getByRole('button', { name: 'User content fn 1', exact: true }).click()
  const footnoteSlugHeading = reader.locator('h2#md-user-content-fn-1')
  await expect(page).toHaveURL(/#md-user-content-fn-1$/)
  await expect(footnoteSlugHeading).toBeInViewport()
  await expect(reader.locator('[id="md-user-content-fn-1"]')).toHaveCount(1)
  expect(await reader.evaluate((element) => (
    element.ownerDocument.getElementById('md-user-content-fn-1')
      === element.querySelector('h2#md-user-content-fn-1')
  ))).toBe(true)
  await expect(reader.locator('[data-footnote-ref]')).toHaveAttribute('href', '#md-footnote-user-content-fn-1')
  await expect(reader.locator('[data-footnote-backref]')).toHaveAttribute('href', '#md-footnote-user-content-fnref-1')
  await expect(reader.locator('[id="md-citation-1"]')).toHaveText('citation HTML anchor')

  await reopenContents()
  const citationHeadings = contents.getByRole('button', { name: 'Citation', exact: true })
  await expect(citationHeadings).toHaveCount(2)
  await citationHeadings.last().click()
  await expect(page).toHaveURL(/#md-citation-2$/)
  await expect(reader.locator('h2#md-citation-2')).toBeInViewport()

  await reopenContents()
  const collisionHeadings = contents.getByRole('button', { name: 'Collision', exact: true })
  await expect(collisionHeadings).toHaveCount(2)
  await collisionHeadings.last().click()
  const secondCollisionHeading = reader.locator('#md-collision-2')
  await expect(page).toHaveURL(/#md-collision-2$/)
  await expect(secondCollisionHeading).toBeInViewport()
  await expect.poll(() => scrollport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  await reopenContents()
  const widgetHeadings = contents.getByRole('button', { name: 'Widget', exact: true })
  await expect(widgetHeadings).toHaveCount(2)
  await widgetHeadings.last().click()
  const secondWidgetHeading = reader.locator('#md-widget-2')
  await expect(page).toHaveURL(/#md-widget-2$/)
  await expect(secondWidgetHeading).toBeInViewport()

  await reopenContents()
  await contents.getByRole('button', { name: 'before after', exact: true }).click()
  const imageHeading = reader.locator('#md-before--after')
  await expect(page).toHaveURL(/#md-before--after$/)
  await expect(imageHeading).toBeInViewport()
  await expect.poll(() => scrollport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('#repeated heading')
  const duplicateOptions = palette.getByRole('option', { name: /Repeated heading/ })
  await expect(duplicateOptions).toHaveCount(2)
  await duplicateOptions.last().click()
  const duplicateHeading = reader.locator('#md-repeated-heading-1')
  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(/#md-repeated-heading-1$/)
  await expect(duplicateHeading).toBeInViewport()
  await expect.poll(() => scrollport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
})

test('HTML heading navigation keeps the URL and iframe section in sync with one history step', async ({ page }) => {
  await page.goto('/showcase/editorial/field-notes/index.html')

  const artifact = page.frameLocator('iframe[title="Designing for resilience"]')
  const iframeHash = () => page.locator('iframe[title="Designing for resilience"]').evaluate((frame) => {
    return (frame as HTMLIFrameElement).contentWindow?.location.hash ?? null
  })
  const practiceHeading = artifact.getByRole('heading', { name: 'Practice over prediction' })
  await expect(artifact.getByRole('heading', { name: 'Designing for resilience' })).toBeVisible()
  await page.getByRole('button', { name: 'Contents', exact: true }).click()
  await page.getByRole('complementary', { name: 'Contents' })
    .getByRole('button', { name: 'Practice over prediction' }).click()

  await expect(page).toHaveURL(/#practice$/)
  await expect.poll(iframeHash).toBe('#practice')
  await expect(practiceHeading).toBeInViewport()

  await page.goBack()
  await expect(page).toHaveURL(/\/showcase\/editorial\/field-notes\/index\.html$/)
  await expect.poll(iframeHash).toBe('')
  await expect(artifact.getByRole('heading', { name: 'Designing for resilience' })).toBeInViewport()

  await page.goForward()
  await expect(page).toHaveURL(/#practice$/)
  await expect.poll(iframeHash).toBe('#practice')
  await expect(practiceHeading).toBeInViewport()

  await page.reload()
  await expect(page).toHaveURL(/#practice$/)
  await expect.poll(iframeHash).toBe('#practice')
  await expect(practiceHeading).toBeInViewport()
})

test('Contents and Details can be dismissed and reopened without losing the reading position', async ({ page }) => {
  const iframe = page.locator('iframe[title="Designing for resilience"]')
  const iframeScrollY = () => iframe.evaluate((frame) => (frame as HTMLIFrameElement).contentWindow?.scrollY ?? -1)
  const iframeHash = () => iframe.evaluate((frame) => (frame as HTMLIFrameElement).contentWindow?.location.hash ?? null)
  const contentsButton = page.locator('.context-actions .context-button[title^="Contents"]')
  const detailsButton = page.locator('.context-actions .context-button[title="Artifact details"]')

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/showcase/editorial/field-notes/index.html')
    await expect(page.frameLocator('iframe[title="Designing for resilience"]')
      .getByRole('heading', { name: 'Designing for resilience' })).toBeVisible()

    const frameWidth = await iframe.evaluate((frame) => frame.getBoundingClientRect().width)
    const readingPosition = await iframe.evaluate((frame) => {
      const frameWindow = (frame as HTMLIFrameElement).contentWindow
      frameWindow?.scrollTo({ top: 480, behavior: 'instant' })
      return frameWindow?.scrollY ?? -1
    })
    expect(readingPosition).toBeGreaterThan(0)
    const expectReadingPositionPreserved = () => expect.poll(async () => Math.abs(
      await iframeScrollY() - readingPosition,
    )).toBeLessThanOrEqual(2)

    await contentsButton.click()
    const contents = page.getByRole('complementary', { name: 'Contents' })
    const closeContents = contents.getByRole('button', { name: 'Close Contents' })
    await expect(closeContents).toBeVisible()
    await expect(closeContents).toBeInViewport()
    await expect(closeContents).toHaveAttribute('title', 'Close Contents')
    await closeContents.click()
    await expect(contents).toBeHidden()
    await expect(contentsButton).toBeFocused()
    await expectReadingPositionPreserved()

    await contentsButton.click()
    await expect(contents).toBeVisible()
    await expectReadingPositionPreserved()
    await detailsButton.click()
    const details = page.getByRole('complementary', { name: 'Details' })
    const closeDetails = details.getByRole('button', { name: 'Close Details' })
    await expect(closeDetails).toBeVisible()
    await expect(closeDetails).toHaveAttribute('title', 'Close Details')
    await closeDetails.click()
    await expect(details).toBeHidden()
    await expect(detailsButton).toBeFocused()
    await expectReadingPositionPreserved()

    await detailsButton.click()
    await expect(details).toBeVisible()
    await expectReadingPositionPreserved()
    expect(await iframe.evaluate((frame) => frame.getBoundingClientRect().width)).toBe(frameWidth)

    await contentsButton.click()
    await contents.getByRole('button', { name: 'Practice over prediction' }).click()
    await expect(page).toHaveURL(/#practice$/)
    await expect.poll(iframeHash).toBe('#practice')
    // Narrow screens always close the panel; wider outcomes are covered by the geometry test.
    if (viewport.width === 390) await expect(contents).toBeHidden()
    await expect(page.frameLocator('iframe[title="Designing for resilience"]')
      .getByRole('heading', { name: 'Practice over prediction' })).toBeInViewport()
  }
})

test('Contents stays open after a heading jump only when the heading is not covered by the panel', async ({ page }) => {
  const targets = [
    { name: 'HTML', path: '/showcase/editorial/field-notes/index.html', frameTitle: 'Designing for resilience' },
    { name: 'Markdown', path: '/sre/reports/latency-retrospective.md', frameTitle: null },
  ]
  const intersects = (a: { x: number, y: number, width: number, height: number }, b: typeof a) => (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  )
  let keptOpenCases = 0
  let keptOpenAtDesktop = false

  for (const target of targets) {
    for (const viewport of [
      { width: 1280, height: 800, sidebar: true },
      { width: 390, height: 844, sidebar: false },
      { width: 1000, height: 800, sidebar: true },
      { width: 1000, height: 800, sidebar: false },
      { width: 900, height: 800, sidebar: true },
      { width: 800, height: 800, sidebar: false },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto(target.path)
      const collapse = page.getByRole('button', { name: 'Collapse sidebar' })
      await expect(page.locator('.stage.has-artifact')).toBeVisible()
      if (await collapse.isVisible() !== viewport.sidebar) await page.keyboard.press('Control+b')
      if (viewport.sidebar) await expect(collapse).toBeVisible()
      else await expect(collapse).toBeHidden()

      await page.locator('.context-actions .context-button[title^="Contents"]').click()
      const contents = page.getByRole('complementary', { name: 'Contents' })
      await expect(contents).toBeVisible()
      const panelBox = (await contents.boundingBox())!
      const entries = contents.locator('.toc-link')
      const entry = entries.nth(Math.min(2, (await entries.count()) - 1))
      await entry.click()
      const id = await page.evaluate(() => decodeURIComponent(window.location.hash.slice(1)))
      expect(id).not.toBe('')
      await expect(page.locator('.stage')).toHaveAttribute('data-heading-jump', 'settled')

      const headingBox = await (async () => {
        if (target.frameTitle) {
          return page.locator(`iframe[title="${target.frameTitle}"]`).evaluate((frame, headingId) => {
            const heading = (frame as HTMLIFrameElement).contentDocument!.getElementById(headingId)!
            const range = heading.ownerDocument.createRange()
            range.selectNodeContents(heading)
            const rect = range.getBoundingClientRect()
            const offset = frame.getBoundingClientRect()
            return { x: rect.x + offset.x, y: rect.y + offset.y, width: rect.width, height: rect.height }
          }, id)
        }
        return page.locator(`[id="${id}"]`).evaluate((node) => {
          const range = node.ownerDocument.createRange()
          range.selectNodeContents(node)
          const rect = range.getBoundingClientRect()
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        })
      })()

      const label = `${target.name} ${viewport.width}px sidebar ${viewport.sidebar ? 'open' : 'closed'}`
      if (target.frameTitle) {
        // HTML artifacts always close, and focus moves to the Contents toggle.
        await expect(contents, label).toBeHidden()
        await expect(page.locator('.context-actions .context-button[title^="Contents"]'), label).toBeFocused()
      } else if (intersects(headingBox, panelBox)) {
        await expect(contents, label).toBeHidden()
        await expect(page.locator('.context-actions .context-button[title^="Contents"]'), label).toBeFocused()
      } else {
        expect(viewport.width, label).toBeGreaterThan(620)
        await expect(contents, label).toBeVisible()
        await expect(entry, label).toBeFocused()
        await expect(entry, label).toHaveAttribute('aria-current', 'location')
        keptOpenCases += 1
        expect(target.name, label).toBe('Markdown')
        if (viewport.width === 1280) keptOpenAtDesktop = true
      }
    }
  }
  expect(keptOpenCases).toBeGreaterThan(0)
  expect(keptOpenAtDesktop).toBe(true)
})

test('a stale heading-jump check never closes a reopened Contents panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/sre/reports/latency-retrospective.md')
  const contentsButton = page.locator('.context-actions .context-button[title^="Contents"]')
  const contents = page.getByRole('complementary', { name: 'Contents' })
  await contentsButton.click()
  await contents.locator('.toc-link').nth(2).click()
  await contents.getByRole('button', { name: 'Close Contents' }).click()
  await contentsButton.click()
  await expect(contents).toBeVisible()
  // The cancelled check would have decided within ~1.2s; the panel must stay.
  await page.waitForTimeout(1500)
  await expect(contents).toBeVisible()
  await expect(contents.locator('.toc-link[aria-current]')).toHaveCount(0)
})

test('multi-file artifacts stay in their site namespace when relative asset paths overlap', async ({ page }) => {
  const artifactResponsePaths: string[] = []
  page.on('response', (response) => {
    const pathname = new URL(response.url()).pathname
    if (pathname.startsWith('/_artifacts/')) artifactResponsePaths.push(pathname)
  })

  const sreAssetPaths = artifactAssetPaths('sre', 'incidents/checkout-latency')
  const sreAssetResponses = waitForResponses(page, sreAssetPaths)
  const sreDocumentResponse = page.waitForResponse((response) => {
    return new URL(response.url()).pathname === '/_artifacts/sre/incidents/checkout-latency/index.html'
  })
  const navigationResponse = await page.goto('/sre/incidents/checkout-latency/index.html')
  expect(navigationResponse?.status()).toBe(200)
  expect(navigationResponse?.headers()['content-type']).toContain('text/html')

  const iframe = page.locator('iframe[title="Checkout latency incident review"]')
  expect(await iframe.getAttribute('sandbox')).toBeNull()
  const artifact = page.frameLocator('iframe[title="Checkout latency incident review"]')
  await expect(artifact.getByRole('heading', { name: 'Summary' })).toBeVisible()
  await expect(artifact.getByRole('status')).toHaveText('SRE incident bundle loaded')
  await expect(artifact.locator('body')).toHaveAttribute('data-artifact-site', 'sre')
  await expect(artifact.locator('body')).toHaveCSS('color', 'rgb(31, 41, 55)')
  const sreCsp = (await sreDocumentResponse).headers()['content-security-policy']
  expect(sreCsp).toContain('/_artifacts/sre/')
  expect(sreCsp).toContain('https:')
  expect(sreCsp).not.toContain("'self'")
  expect((await Promise.all(sreAssetResponses)).every((response) => response.status() === 200)).toBeTruthy()
  expect(artifactResponsePaths.length).toBeGreaterThanOrEqual(sreAssetPaths.length)
  expect(artifactResponsePaths.every((path) => path.startsWith('/_artifacts/sre/'))).toBeTruthy()
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(17, 20, 22)')

  await expect(artifact.locator('body')).toHaveAttribute('data-artifact-site', 'sre')
  expect(artifactResponsePaths.every((path) => path.startsWith('/_artifacts/sre/'))).toBeTruthy()

  const breadcrumb = page.getByRole('navigation', { name: 'Artifact path' })
  await expect(breadcrumb).toContainText('incidents')
  await expect(breadcrumb).not.toContainText('SRE')

  const header = page.locator('.context-bar')
  await expect(header).not.toContainText('Sep 22, 2026')
  await expect(header).not.toContainText('example/payments')
  const detailsButton = page.getByRole('button', { name: 'Details', exact: true })
  await expect(detailsButton).toHaveAttribute('aria-pressed', 'false')
  await detailsButton.click()
  const details = page.getByRole('complementary', { name: 'Details' })
  await expect(details).toBeVisible()
  await expect(details.getByText('Last committed by')).toBeVisible()
  await expect(details.getByText('Maya Chen', { exact: true })).toBeVisible()
  await expect(details.getByRole('link', { name: /example\/payments/ })).toHaveAttribute(
    'href',
    'https://github.com/example/payments',
  )
  await expect(details.getByText('Sep 22, 2026')).toBeVisible()

  await page.getByRole('button', { name: 'Contents', exact: true }).click()
  await expect(details).toBeHidden()
  await expect(page.getByRole('button', { name: 'Contents', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Contents', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Contents' })).toBeHidden()
  await detailsButton.click()
  await expect(details).toBeVisible()
  await detailsButton.click()
  await expect(details).toBeHidden()

  await page.getByRole('button', { name: 'Contents', exact: true }).click()
  const contents = page.getByRole('complementary', { name: 'Contents' })
  await expect(contents).toBeVisible()
  await contents.getByRole('button', { name: 'Root cause' }).click()
  await expect(page).toHaveURL(/#root-cause$/)

  await page.reload()
  await expect(artifact.getByRole('heading', { name: 'Summary' })).toBeVisible()
  await expect(artifact.getByRole('status')).toHaveText('SRE incident bundle loaded')
  await expect(page).toHaveURL(/\/sre\/incidents\/checkout-latency\/index\.html#root-cause$/)

  const frontendPage = await page.context().newPage()
  const frontendResponsePaths: string[] = []
  frontendPage.on('response', (response) => {
    const pathname = new URL(response.url()).pathname
    if (pathname.startsWith('/_artifacts/')) frontendResponsePaths.push(pathname)
  })
  const frontendAssetPaths = artifactAssetPaths('frontend', 'design-system/button-guidelines')
  const frontendAssetResponses = waitForResponses(frontendPage, frontendAssetPaths)
  const frontendDocumentResponse = frontendPage.waitForResponse((response) => {
    return new URL(response.url()).pathname === '/_artifacts/frontend/design-system/button-guidelines/index.html'
  })
  await frontendPage.goto('/frontend/design-system/button-guidelines/index.html')

  const frontend = frontendPage.frameLocator('iframe[title="Button guidelines"]')
  await expect(frontend.getByRole('heading', { name: 'Buttons' })).toBeVisible()
  await expect(frontend.getByRole('status')).toHaveText('Frontend guideline bundle loaded')
  await expect(frontend.locator('body')).toHaveAttribute('data-artifact-site', 'frontend')
  await expect(frontend.locator('body')).toHaveCSS('color', 'rgb(76, 29, 149)')
  const frontendCsp = (await frontendDocumentResponse).headers()['content-security-policy']
  expect(frontendCsp).toContain('/_artifacts/frontend/')
  expect(frontendCsp).toContain('https:')
  expect(frontendCsp).not.toContain("'self'")
  expect((await Promise.all(frontendAssetResponses)).every((response) => response.status() === 200)).toBeTruthy()
  expect(frontendResponsePaths.length).toBeGreaterThanOrEqual(frontendAssetPaths.length)
  expect(frontendResponsePaths.every((path) => path.startsWith('/_artifacts/frontend/'))).toBeTruthy()
  await expect(frontendPage.locator('body')).toHaveCSS('color', 'rgb(17, 20, 22)')

  const externalResourcePaths = new Set<string>()
  await frontendPage.route('https://example.invalid/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    externalResourcePaths.add(pathname)
    if (pathname === '/data.json') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: '{}',
      })
    } else if (pathname === '/styles.css') {
      await route.fulfill({
        status: 200,
        contentType: 'text/css',
        body: 'body { --external-stylesheet-loaded: yes; }',
      })
    } else if (pathname === '/probe.js') {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: 'document.body.dataset.externalScript = "loaded";',
      })
    } else if (pathname === '/pixel.svg') {
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
      })
    } else {
      await route.fulfill({ status: 404 })
    }
  })
  const externalFetch = await frontend.locator('body').evaluate(async () => {
    try {
      const response = await fetch('https://example.invalid/data.json')
      return response.status
    } catch {
      return 0
    }
  })
  expect(externalFetch).toBe(200)
  const externalStylesheet = await frontend.locator('body').evaluate((body) => new Promise<string>((resolve) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'https://example.invalid/styles.css'
    link.onload = () => resolve('loaded')
    link.onerror = () => resolve('blocked')
    body.ownerDocument.head.append(link)
  }))
  expect(externalStylesheet).toBe('loaded')
  expect(await frontend.locator('body').evaluate((body) => getComputedStyle(body).getPropertyValue('--external-stylesheet-loaded').trim())).toBe('yes')
  const externalImageWidth = await frontend.locator('body').evaluate((body) => new Promise<number | string>((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image.naturalWidth)
    image.onerror = () => resolve('blocked')
    image.src = 'https://example.invalid/pixel.svg'
    body.append(image)
  }))
  expect(externalImageWidth).toBe(1)
  const externalScript = await frontend.locator('body').evaluate((body) => new Promise<string>((resolve) => {
    const script = document.createElement('script')
    script.src = 'https://example.invalid/probe.js'
    script.onload = () => resolve('loaded')
    script.onerror = () => resolve('blocked')
    body.ownerDocument.head.append(script)
  }))
  expect(externalScript).toBe('loaded')
  await expect(frontend.locator('body')).toHaveAttribute('data-external-script', 'loaded')
  expect([...externalResourcePaths].sort()).toEqual(['/data.json', '/pixel.svg', '/probe.js', '/styles.css'])

  let insecureRequestReachedServer = false
  await frontendPage.route('http://example.invalid/**', async (route) => {
    insecureRequestReachedServer = true
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  const insecureFetch = await frontend.locator('body').evaluate(async () => {
    try {
      await fetch('http://example.invalid/data.json')
      return 'loaded'
    } catch {
      return 'blocked'
    }
  })
  expect(insecureFetch).toBe('blocked')
  expect(insecureRequestReachedServer).toBeFalsy()

  const missingAsset = await frontendPage.request.get('/_artifacts/frontend/design-system/button-guidelines/assets/data/missing.json')
  expect(missingAsset.status()).toBe(404)
  await frontendPage.close()
})

test('logical artifact routes round-trip reserved and Unicode path characters through reload', async ({ page }) => {
  const siteId = 'showcase'
  const artifactPath = 'guides/url route samples/Δ status #1%+check.html'
  const encodedArtifactPath = artifactPath.split('/').map(encodeURIComponent).join('/')
  const logicalPath = `/${siteId}/${encodedArtifactPath}`
  const encodedResourceRoot = `/_artifacts/${siteId}/guides/url%20route%20samples/assets/`
  const encodedResourcePaths = [
    `${encodedResourceRoot}skin%20%23%3F%25%2B%20%E6%97%A5%E6%9C%AC.css`,
    `${encodedResourceRoot}loaded%20%23%3F%25%2B%20%E6%97%A5%E6%9C%AC.js`,
    `${encodedResourceRoot}mark%20%23%3F%25%2B%20%E6%97%A5%E6%9C%AC.svg`,
  ]
  const resourceResponses = encodedResourcePaths.map((path) => page.waitForResponse((response) => (
    new URL(response.url()).pathname === path
  )))

  await page.goto(logicalPath)

  const iframe = page.frameLocator('iframe[title="URL path round-trip fixture"]')
  expect(new URL(page.url()).pathname).toBe(logicalPath)
  await expect(iframe.getByRole('heading', { name: 'URL path round-trip fixture' })).toBeVisible()
  await expect(iframe.locator('body')).toHaveAttribute('data-route-fixture', 'loaded')
  await expect(iframe.locator('body')).toHaveCSS('background-color', 'rgb(223, 241, 230)')
  await expect(iframe.getByRole('img', { name: 'Reserved path marker' })).toBeVisible()
  expect((await Promise.all(resourceResponses)).map((response) => response.status())).toEqual([200, 200, 200])

  await page.reload()

  expect(new URL(page.url()).pathname).toBe(logicalPath)
  await expect(iframe.getByRole('heading', { name: 'URL path round-trip fixture' })).toBeVisible()
  await expect(iframe.locator('body')).toHaveAttribute('data-route-fixture', 'loaded')
})

test('Unicode artifact titles remain readable in navigation and search', async ({ page }) => {
  const artifact = {
    id: 'guides/設計-note.md',
    title: '設計 Note',
    path: 'guides/設計-note.md',
    format: 'markdown',
    filename: '設計-note.md',
    artifactUrl: '/_artifacts/sre/guides/%E8%A8%AD%E8%A8%88-note.md',
    updatedAt: '2026-09-29T00:00:00Z',
  }
  await page.route('**/_indexes/sre/index.json', async (route) => {
    const response = await route.fetch()
    const index = await response.json() as { artifacts: Array<Record<string, unknown>> }
    index.artifacts.push(artifact)
    await route.fulfill({ response, body: JSON.stringify(index) })
  })

  await page.goto('/sre')
  await page.locator('.sidebar-body .browse-tree .tree-directory-button[data-tree-path="guides"]').click()
  await expect(page.locator('.sidebar-body .tree-artifact[data-tree-path="guides/設計-note.md"] .tree-label').first()).toHaveText('設計 Note')

  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' }).fill('設計')
  await expect(palette.getByRole('option', { name: /設計 Note/ })).toBeVisible()
})

test('Markdown pages render safely with GFM, Mermaid, local assets, and extensionful links', async ({ page }) => {
  const imageResponse = page.waitForResponse((response) => {
    return new URL(response.url()).pathname === '/_artifacts/sre/runbooks/assets/request-path.svg'
  })

  await page.goto('/sre/runbooks/service-recovery.md')
  await expect(page).toHaveURL(/\/sre\/runbooks\/service-recovery\.md$/)
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.locator('.sidebar-panel .tree-artifact.is-active .tree-format-tag')).toHaveText('MD')

  const reader = page.getByTestId('markdown-document')
  await expect(reader.getByRole('heading', { level: 1, name: 'Service recovery' })).toBeVisible()
  await expect(reader.getByRole('table')).toBeVisible()
  await expect(reader.locator('input[type="checkbox"]')).toHaveCount(2)
  await expect(reader.locator('input[type="checkbox"]').nth(0)).toBeChecked()
  await expect(reader.locator('input[type="checkbox"]').nth(1)).not.toBeChecked()
  await expect(reader.locator('.markdown-diagram svg')).toBeVisible()
  await expect(reader.getByRole('img', { name: 'Request path from edge through gateway to services' })).toBeVisible()
  expect((await imageResponse).status()).toBe(200)
  expect(await page.evaluate(() => (window as Window & { __markdownScriptShouldNotRun?: boolean }).__markdownScriptShouldNotRun)).toBeUndefined()

  await page.getByRole('button', { name: 'Contents', exact: true }).click()
  const contents = page.getByRole('complementary', { name: 'Contents' })
  await contents.getByRole('button', { name: 'Request path' }).click()
  await expect(page).toHaveURL(/#md-request-path$/)
  await expect(reader.getByRole('heading', { name: 'Request path' })).toBeInViewport()

  await reader.getByRole('link', { name: 'Open the related incident review' }).click()
  await expect(page).toHaveURL(/\/sre\/incidents\/checkout-latency\/index\.html$/)
  await expect(page.locator('iframe[title="Checkout latency incident review"]')).toBeVisible()
})

test('Markdown fragments resolve across documents while HTML fragments keep their original IDs', async ({ page }) => {
  const sourcePath = 'guides/cross-links.md'
  const targetPath = 'reports/例 #1+summary.md'
  const targetEncodedPath = 'reports/%E4%BE%8B%20%231%2Bsummary.md'
  const htmlPath = 'reports/fragment-target.html'
  const sourceArtifactUrl = `/_artifacts/sre/${sourcePath}`
  const targetArtifactUrl = `/_artifacts/sre/${targetEncodedPath}`
  const htmlArtifactUrl = `/_artifacts/sre/${htmlPath}`
  const sourceRoute = '/sre/guides/cross-links.md'
  const targetRoute = `/sre/${targetEncodedPath}`
  const filler = Array.from({ length: 24 }, (_, index) => `Navigation context paragraph ${index + 1}.`).join('\n\n')
  const sourceMarkdown = [
    '# Cross-document links',
    '',
    '[Same-document heading](#local-steps)',
    '[Same-document duplicate with an existing prefix](#md-local-steps-1)',
    '[Same-document heading whose slug starts with the Markdown prefix](#md-local-deployment)',
    '[Cross-document Markdown heading](../reports/%E4%BE%8B%20%231%2Bsummary.md?view=full&from=reader#review-steps)',
    '[Cross-document Markdown duplicate](../reports/%E4%BE%8B%20%231%2Bsummary.md?view=full&from=reader#review-steps-1)',
    '[Cross-document Markdown duplicate with an existing prefix](../reports/%E4%BE%8B%20%231%2Bsummary.md?view=full&from=reader#md-review-steps-1)',
    '[Cross-document Markdown heading whose slug starts with the Markdown prefix](../reports/%E4%BE%8B%20%231%2Bsummary.md?view=full&from=reader#md-deployment)',
    '[Cross-document Markdown Unicode heading](../reports/%E4%BE%8B%20%231%2Bsummary.md?view=full&from=reader#%E9%9A%9C%E5%AE%B3%E5%AF%BE%E5%BF%9C-%E6%97%A5%E6%9C%AC%E8%AA%9E)',
    '[HTML fragment](../reports/fragment-target.html#legacy-id)',
    '',
    filler,
    '',
    '## Local steps',
    '',
    filler,
    '',
    '## MD local deployment',
    '',
    filler,
    '',
    '## Local steps',
  ].join('\n')
  const targetMarkdown = [
    '## Review steps',
    '',
    filler,
    '',
    '## Review steps',
    '',
    filler,
    '',
    '## 障害対応 日本語',
    '',
    filler,
    '',
    '## MD deployment',
    '',
    filler,
    '',
    '## Site switcher',
  ].join('\n')
  const htmlDocument = `<!doctype html><html><head><title>HTML fragment destination</title><style>body{margin:0}.spacer{height:1800px}</style></head><body><div class="spacer"></div><h1 id="legacy-id">Legacy HTML target</h1></body></html>`
  const artifactResponses = new Map([
    [sourceArtifactUrl, { contentType: 'text/markdown; charset=utf-8', body: sourceMarkdown }],
    [targetArtifactUrl, { contentType: 'text/markdown; charset=utf-8', body: targetMarkdown }],
    [htmlArtifactUrl, { contentType: 'text/html; charset=utf-8', body: htmlDocument }],
  ])
  const artifacts = [
    {
      id: sourcePath,
      title: 'Cross-document link source',
      path: sourcePath,
      format: 'markdown',
      filename: 'cross-links.md',
      artifactUrl: sourceArtifactUrl,
      updatedAt: '2026-09-29T00:00:00Z',
      toc: [
        { level: 2, text: 'Local steps', id: 'md-local-steps' },
        { level: 2, text: 'Local steps', id: 'md-local-steps-1' },
        { level: 2, text: 'MD local deployment', id: 'md-md-local-deployment' },
      ],
    },
    {
      id: targetPath,
      title: 'Encoded Markdown target',
      path: targetPath,
      format: 'markdown',
      filename: '例 #1+summary.md',
      artifactUrl: targetArtifactUrl,
      updatedAt: '2026-09-29T00:00:00Z',
      toc: [
        { level: 2, text: 'Review steps', id: 'md-review-steps' },
        { level: 2, text: 'Review steps', id: 'md-review-steps-1' },
        { level: 2, text: '障害対応 日本語', id: 'md-障害対応-日本語' },
        { level: 2, text: 'MD deployment', id: 'md-md-deployment' },
        { level: 2, text: 'Site switcher', id: 'md-site-switcher' },
      ],
    },
    {
      id: htmlPath,
      title: 'HTML fragment destination',
      path: htmlPath,
      format: 'html',
      filename: 'fragment-target.html',
      artifactUrl: htmlArtifactUrl,
      updatedAt: '2026-09-29T00:00:00Z',
      toc: [{ level: 1, text: 'Legacy HTML target', id: 'legacy-id' }],
    },
  ]

  await page.route('**/_indexes/sre/index.json', async (route) => {
    const response = await route.fetch()
    const index = await response.json() as { artifacts: Array<Record<string, unknown>> }
    index.artifacts.push(...artifacts)
    await route.fulfill({ response, body: JSON.stringify(index) })
  })
  await page.route('**/_artifacts/sre/**', async (route) => {
    const artifactResponse = artifactResponses.get(new URL(route.request().url()).pathname)
    if (!artifactResponse) {
      await route.continue()
      return
    }
    await route.fulfill({ status: 200, ...artifactResponse })
  })

  const expectMarkdownHeading = async (id: string) => {
    const heading = page.locator(`.markdown-article #${id}`)
    await expect(heading).toBeInViewport()
    await expect.poll(() => page.locator('.markdown-scroll').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  }
  const expectTargetUrl = async (hash: string) => {
    await expect.poll(() => page.evaluate(() => window.location.pathname)).toBe(targetRoute)
    expect(await page.evaluate(() => window.location.search)).toBe('?view=full&from=reader')
    expect(await page.evaluate(() => window.location.hash)).toBe(hash)
  }

  await page.setViewportSize({ width: 1280, height: 420 })
  await page.goto(sourceRoute)
  const reader = page.getByTestId('markdown-document')
  await reader.getByRole('link', { name: 'Same-document heading', exact: true }).click()
  await expect(page).toHaveURL(/#md-local-steps$/)
  await expectMarkdownHeading('md-local-steps')
  await reader.getByRole('link', { name: 'Same-document duplicate with an existing prefix' }).click()
  await expect(page).toHaveURL(/#md-local-steps-1$/)
  await expectMarkdownHeading('md-local-steps-1')
  await reader.getByRole('link', { name: 'Same-document heading whose slug starts with the Markdown prefix' }).click()
  await expect(page).toHaveURL(/#md-local-deployment$/)
  await expectMarkdownHeading('md-md-local-deployment')

  await reader.getByRole('link', { name: 'Cross-document Markdown heading', exact: true }).click()
  await expectTargetUrl('#md-review-steps')
  await expectMarkdownHeading('md-review-steps')
  await page.goBack()
  await expect(page).toHaveURL(/\/sre\/guides\/cross-links\.md#md-local-deployment$/)
  await expectMarkdownHeading('md-md-local-deployment')
  await page.goForward()
  await expectTargetUrl('#md-review-steps')
  await expectMarkdownHeading('md-review-steps')

  await page.goBack()
  await reader.getByRole('link', { name: 'Cross-document Markdown duplicate', exact: true }).click()
  await expectTargetUrl('#md-review-steps-1')
  await expectMarkdownHeading('md-review-steps-1')
  await page.goBack()
  await reader.getByRole('link', { name: 'Cross-document Markdown duplicate with an existing prefix' }).click()
  await expectTargetUrl('#md-review-steps-1')
  await expectMarkdownHeading('md-review-steps-1')

  await page.goto(sourceRoute)
  await page.getByTestId('markdown-document').getByRole('link', {
    name: 'Cross-document Markdown heading whose slug starts with the Markdown prefix',
  }).click()
  await expectTargetUrl('#md-deployment')
  await expectMarkdownHeading('md-md-deployment')

  await page.goto(`${targetRoute}?direct=1#review-steps-1`)
  await expect(page).toHaveURL(/\?direct=1#review-steps-1$/)
  await expectMarkdownHeading('md-review-steps-1')
  await page.reload()
  await expect(page).toHaveURL(/\?direct=1#review-steps-1$/)
  await expectMarkdownHeading('md-review-steps-1')
  await page.goto(`${targetRoute}?direct=2#site-switcher`)
  await expect(page).toHaveURL(/\?direct=2#site-switcher$/)
  await expectMarkdownHeading('md-site-switcher')

  await page.goto(sourceRoute)
  await page.getByTestId('markdown-document').getByRole('link', { name: 'Cross-document Markdown Unicode heading' }).click()
  await expectTargetUrl('#md-%E9%9A%9C%E5%AE%B3%E5%AF%BE%E5%BF%9C-%E6%97%A5%E6%9C%AC%E8%AA%9E')
  await expectMarkdownHeading('md-障害対応-日本語')

  await page.goto(sourceRoute)
  await page.getByTestId('markdown-document').getByRole('link', { name: 'HTML fragment' }).click()
  await expect(page).toHaveURL(/\/sre\/reports\/fragment-target\.html#legacy-id$/)
  const htmlFrame = page.locator('iframe[title="HTML fragment destination"]')
  await expect(htmlFrame).toBeVisible()
  const htmlTarget = page.frameLocator('iframe[title="HTML fragment destination"]').locator('#legacy-id')
  await expect(htmlTarget).toHaveText('Legacy HTML target')
  await expect(htmlTarget).toBeInViewport()
  await expect.poll(() => htmlFrame.evaluate((frame) => (frame as HTMLIFrameElement).contentWindow?.scrollY ?? 0)).toBeGreaterThan(0)
})

test('Markdown gallery covers typography, assets, links, safety, and fragment navigation', async ({ page }) => {
  const requestedUrls: string[] = []
  const localAssetPaths = [
    '/_artifacts/sre/guides/assets/latency-trend.svg',
    '/_artifacts/sre/guides/assets/latency%20trend.svg',
    '/_artifacts/sre/runbooks/assets/request-path.svg',
    '/_artifacts/sre/guides/assets/missing-image.svg',
  ]
  const assetResponses = localAssetPaths.map((path) => page.waitForResponse((response) => {
    return new URL(response.url()).pathname === path
  }))
  let remoteImageRequested = false
  await page.route('https://placehold.co/**', async (route) => {
    remoteImageRequested = true
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160"><rect width="480" height="160" fill="#dbeafe"/><text x="20" y="90">remote fixture image</text></svg>',
    })
  })
  page.on('request', (request) => requestedUrls.push(request.url()))

  await page.goto('/sre/guides/markdown-style-gallery.md')
  await expect(page).toHaveURL(/\/sre\/guides\/markdown-style-gallery\.md$/)
  const reader = page.getByTestId('markdown-document')
  await expect(reader).toBeVisible()
  await expect(page.locator('.sidebar-panel .tree-artifact.is-active .tree-format-tag')).toHaveText(['MD'])

  for (const level of [1, 2, 3, 4, 5, 6]) {
    await expect(reader.getByRole('heading', { level }).first()).toBeVisible()
  }
  await expect(reader.getByText('A bare URL such as', { exact: false })).toBeVisible()
  await expect(reader.getByRole('table')).toBeVisible()
  await expect(reader.getByRole('columnheader', { name: 'p95 latency' })).toHaveCSS('text-align', 'right')
  await expect(reader.getByRole('columnheader', { name: 'Change' })).toHaveCSS('text-align', 'center')
  await expect(reader.locator('.contains-task-list input[type="checkbox"]')).toHaveCount(2)
  await expect(reader.locator('details > summary')).toHaveText('Raw HTML disclosure')
  await expect(reader.locator('.footnotes')).toBeVisible()
  await reader.locator('details > summary').click()
  await expect(reader.locator('details')).toHaveAttribute('open', '')
  await expect(reader.locator('details')).toContainText('This native disclosure should remain usable')

  const headingSizes = await reader.locator('h1, h2, h3, h4, h5, h6').evaluateAll((headings) => {
    return headings.slice(0, 6).map((heading) => Number.parseFloat(getComputedStyle(heading).fontSize))
  })
  expect(headingSizes).toHaveLength(6)
  expect(headingSizes[0]).toBeGreaterThan(headingSizes[1])
  expect(headingSizes[1]).toBeGreaterThan(headingSizes[2])
  expect(headingSizes[2]).toBeGreaterThan(headingSizes[3])
  expect(headingSizes[3]).toBeGreaterThan(headingSizes[4])
  expect(headingSizes[4]).toBeGreaterThan(headingSizes[5])
  await expect(reader.locator('h2').first()).toHaveCSS('border-bottom-style', 'solid')
  await expect(reader.locator('pre').first()).toHaveCSS('overflow', 'auto')

  const images = {
    local: reader.getByRole('img', { name: 'Latency trend across three regions' }),
    encoded: reader.getByRole('img', { name: 'Encoded asset path with spaces' }),
    parent: reader.getByRole('img', { name: 'Request path from the runbook' }),
    remote: reader.getByRole('img', { name: 'Remote HTTPS fixture image' }),
    inline: reader.getByRole('img', { name: 'Inline one-pixel PNG' }),
    missing: reader.getByRole('img', { name: 'Missing local image' }),
    crossSite: reader.getByRole('img', { name: "Another site's private image" }),
    insecure: reader.getByRole('img', { name: 'Insecure HTTP image' }),
  }
  for (const [label, image] of Object.entries(images).slice(0, 5)) {
    await expect.poll(
      () => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
      { message: `${label} image should load successfully` },
    ).toBeTruthy()
  }
  await expect.poll(() => images.missing.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth === 0)).toBeTruthy()
  expect(remoteImageRequested).toBeTruthy()
  expect(requestedUrls.some((url) => url.startsWith('https://placehold.co/480x160.svg?text=Remote+HTTPS+fixture'))).toBeTruthy()
  expect((await Promise.all(assetResponses)).map((response) => response.status())).toEqual([200, 200, 200, 404])
  expect(await images.inline.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  expect(await images.crossSite.getAttribute('src')).toBeNull()
  expect(await images.insecure.getAttribute('src')).toBeNull()
  expect(requestedUrls.some((url) => url.startsWith('http://example.invalid/'))).toBeFalsy()
  expect(requestedUrls.some((url) => url.includes('/_artifacts/frontend/'))).toBeFalsy()

  await expect(reader.locator('script, iframe')).toHaveCount(0)
  await expect(reader.locator('[onerror], [onclick], [onload]')).toHaveCount(0)
  expect(await page.evaluate(() => (window as Window & {
    __markdownUnsafeHtmlExecuted?: boolean
    __markdownUnsafeHandlerExecuted?: boolean
  }).__markdownUnsafeHtmlExecuted)).toBeUndefined()
  expect(await page.evaluate(() => (window as Window & {
    __markdownUnsafeHandlerExecuted?: boolean
  }).__markdownUnsafeHandlerExecuted)).toBeUndefined()

  const relatedRunbook = reader.getByRole('link', { name: 'Open the runbook' })
  await expect(relatedRunbook).toHaveAttribute('href', '/sre/runbooks/service-recovery.md')
  const contentsButton = page.getByRole('button', { name: 'Contents', exact: true })
  await contentsButton.click()
  const contents = page.getByRole('complementary', { name: 'Contents' })
  await contents.getByRole('button', { name: '障害対応 — 日本語の見出し' }).click()
  const japaneseHeading = reader.getByRole('heading', { level: 3, name: '障害対応 — 日本語の見出し' })
  await expect(japaneseHeading).toHaveAttribute('id', 'md-障害対応--日本語の見出し')
  await expect.poll(() => page.evaluate(() => decodeURIComponent(window.location.hash))).toBe('#md-障害対応--日本語の見出し')
  await expect(japaneseHeading).toBeInViewport()
  await reader.getByRole('link', { name: 'Jump to the Japanese heading' }).click()
  await expect.poll(() => page.evaluate(() => decodeURIComponent(window.location.hash))).toBe('#md-障害対応--日本語の見出し')

  await reader.getByRole('link', { name: 'Open the runbook' }).click()
  await expect(page).toHaveURL(/\/sre\/runbooks\/service-recovery\.md$/)
  await expect(page.getByTestId('markdown-document').getByRole('heading', { level: 1, name: 'Service recovery' })).toBeVisible()
})

test('Markdown retrospective stays readable on narrow screens and supports theme styling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/sre/reports/latency-retrospective.md')

  const reader = page.getByTestId('markdown-document')
  await expect(reader.getByRole('heading', { level: 2, name: 'Outcome at a glance' })).toBeVisible()
  await expect(reader.getByRole('heading', { level: 1 })).toHaveCount(0)
  const tableScrollport = reader.getByRole('region', { name: 'Scrollable table' }).first()
  const table = tableScrollport.getByRole('table')
  const signalHeader = table.getByRole('columnheader', { name: 'Signal' })
  const recoveredHeader = table.getByRole('columnheader', { name: 'Recovered' })
  await expect(reader.locator('.markdown-table-hint').first()).toHaveText('Scroll to see more columns →')
  const dimensions = await reader.evaluate((element) => {
    const scrollport = element.querySelector<HTMLElement>('.markdown-table-scroll')!
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      tableClientWidth: scrollport.clientWidth,
      tableScrollWidth: scrollport.scrollWidth,
      readerClientWidth: element.clientWidth,
    }
  })
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth)
  expect(dimensions.tableScrollWidth).toBeGreaterThan(dimensions.tableClientWidth)
  expect(dimensions.readerClientWidth).toBeLessThanOrEqual(dimensions.viewportWidth)
  const headerFitsWithinScrollport = async (header: typeof signalHeader) => {
    const [headerBox, scrollportBox] = await Promise.all([header.boundingBox(), tableScrollport.boundingBox()])
    return Boolean(
      headerBox
      && scrollportBox
      && headerBox.x >= scrollportBox.x - 1
      && headerBox.x + headerBox.width <= scrollportBox.x + scrollportBox.width + 1,
    )
  }
  expect(await headerFitsWithinScrollport(signalHeader)).toBeTruthy()
  expect(await headerFitsWithinScrollport(recoveredHeader)).toBeFalsy()

  await tableScrollport.evaluate((element) => { element.scrollLeft = element.scrollWidth })
  await expect(reader.locator('.markdown-table-hint').first()).toHaveText('← Scroll left to see earlier columns')
  await expect.poll(() => headerFitsWithinScrollport(recoveredHeader)).toBeTruthy()
  const documentWidthAfterScroll = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(documentWidthAfterScroll).toBe(dimensions.documentWidth)

  const initialHeadingColor = await reader.locator('h2').first().evaluate((element) => getComputedStyle(element).color)
  await page.getByRole('button', { name: /Color theme:/ }).click()
  await page.getByRole('menuitemradio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const darkHeadingColor = await reader.locator('h2').first().evaluate((element) => getComputedStyle(element).color)
  expect(darkHeadingColor).not.toBe(initialHeadingColor)

  await page.setViewportSize({ width: 1280, height: 844 })
  await expect(reader.locator('.markdown-table-hint')).toHaveCount(0)
})

test('mobile navigation starts closed and closes after opening artifacts or switching sites', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/sre/reports/latency-retrospective.md')

  const sidebar = page.locator('.sidebar-panel')
  await expect(sidebar).toBeHidden()
  await expect(page.getByTestId('markdown-document').getByRole('heading', { level: 2, name: 'Outcome at a glance' })).toBeVisible()

  await page.reload()
  await expect(sidebar).toBeHidden()
  await expect(page.getByTestId('markdown-document').getByRole('heading', { level: 2, name: 'Outcome at a glance' })).toBeVisible()

  await page.getByRole('button', { name: 'Expand navigation' }).click()
  await expect(sidebar).toBeVisible()
  await page.locator('.sidebar-panel .browse-tree .tree-directory-button[data-tree-path="runbooks"]').click()
  await page.locator('.sidebar-panel .tree-artifact[data-tree-path="runbooks/service-recovery.md"]').click()
  await expect(page).toHaveURL(/\/sre\/runbooks\/service-recovery\.md$/)
  await expect(sidebar).toBeHidden()
  await expect(page.getByTestId('markdown-document').getByRole('heading', { level: 1, name: 'Service recovery' })).toBeVisible()

  await page.getByRole('button', { name: 'Expand navigation' }).click()
  await page.keyboard.press('Control+k')
  const homePalette = page.getByRole('dialog', { name: 'Command palette' })
  await homePalette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' }).fill('Go to site home')
  await homePalette.getByRole('option', { name: /Go to site home/ }).click()
  await expect(page).toHaveURL(/\/sre$/)
  await expect(sidebar).toBeHidden()

  await page.getByRole('button', { name: 'Expand navigation' }).click()
  await page.getByRole('button', { name: 'Switch site. Current site: SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('@front')
  await palette.getByRole('option', { name: /Frontend/ }).click()
  await expect(page).toHaveURL(/\/frontend$/)
  await expect(page.getByRole('heading', { name: 'Frontend', exact: true })).toBeVisible()
  await expect(page.locator('.sidebar-panel')).toBeHidden()
})

test('Mermaid catalog renders every fixture type supported by the bundled core and preserves unsupported source', async ({ page }) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(150_000)
  const supportedTypes = [
    'flowchart', 'graph', 'flowchart-elk', 'swimlane-beta', 'journey', 'gantt', 'eventmodeling',
    'pie', 'quadrantchart', 'xychart-beta', 'sankey-beta', 'radar-beta', 'treemap-beta', 'venn-beta',
    'erdiagram', 'classdiagram', 'classdiagram-v2', 'gitgraph', 'c4context', 'architecture-beta',
    'block', 'packet-beta', 'kanban', 'treeview-beta', 'sequencediagram', 'statediagram-v2',
    'statediagram', 'mindmap', 'requirementdiagram', 'timeline', 'ishikawa-beta', 'wardley-beta',
    'cynefin-beta', 'railroad-beta', 'railroad-ebnf-beta', 'railroad-abnf-beta', 'railroad-peg-beta', 'info',
  ]
  const unsupportedTypes = ['usecase-beta', 'zenuml']

  await page.goto('/sre/diagrams/mermaid-catalog.md')
  const reader = page.getByTestId('markdown-document')
  await expect(reader.getByRole('heading', { level: 1, name: 'Mermaid rendering catalog' })).toBeVisible()
  await expect(reader.locator('.markdown-diagram-loading')).toHaveCount(0, { timeout: 150_000 })
  await expect(page.locator('.sidebar-panel .tree-artifact.is-active .tree-format-tag')).toHaveText(['MD'])

  for (const type of supportedTypes) {
    const diagram = reader.locator(`figure.markdown-diagram[data-diagram-type="${type}"]`)
    await expect(diagram, `${type} should render as an SVG diagram`).toHaveCount(1)
    await expect(diagram.locator('svg').first()).toBeVisible()
    await expect(diagram.locator(':scope > div > svg')).toHaveAttribute('xmlns', 'http://www.w3.org/2000/svg')
  }
  await expect(reader.locator('.markdown-diagram-error')).toHaveCount(unsupportedTypes.length)
  for (const type of unsupportedTypes) {
    const fallback = reader.locator(`.markdown-diagram-error[data-diagram-type="${type}"]`)
    await expect(fallback).toBeVisible()
    await expect(fallback.locator('pre code')).not.toBeEmpty()
  }
  expect(await reader.locator('figure.markdown-diagram').count()).toBe(supportedTypes.length)
  expect(await reader.locator('.markdown-diagram-error').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-diagram-type')).sort())).toEqual([...unsupportedTypes].sort())

  const diagramFrame = reader.locator('figure.markdown-diagram').first()
  await expect(diagramFrame).toHaveCSS('border-top-width', '0px')
  await expect(diagramFrame).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  expect(await diagramFrame.evaluate((element) => element.closest('pre'))).toBeNull()
  const wideDiagram = reader.locator('figure.markdown-diagram[data-diagram-type="flowchart-elk"]')
  const wideDiagramSize = await wideDiagram.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(wideDiagramSize.scrollWidth).toBeGreaterThan(wideDiagramSize.clientWidth)
  await wideDiagram.evaluate((element) => { element.scrollLeft = element.scrollWidth })
  expect(await wideDiagram.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)

  const styledFlowchart = reader.locator('figure.markdown-diagram[data-diagram-type="flowchart"] svg')
  const serviceNode = styledFlowchart.locator('.node').filter({ hasText: 'Service' })
  await expect(serviceNode).toHaveClass(/healthy/)
  await expect.poll(() => serviceNode.locator('rect.label-container').evaluate((element) => getComputedStyle(element).fill)).toBe('rgb(220, 252, 231)')
  const recoveryNode = styledFlowchart.locator('.node').filter({ hasText: 'Recovery' })
  await expect(recoveryNode).toHaveClass(/warning/)
  await expect.poll(() => recoveryNode.locator('rect.label-container').evaluate((element) => getComputedStyle(element).stroke)).toBe('rgb(217, 119, 6)')
  const gatewayNode = styledFlowchart.locator('.node').filter({ hasText: 'Healthy?' })
  await expect.poll(() => gatewayNode.locator('polygon').evaluate((element) => getComputedStyle(element).fill)).toBe('rgb(219, 234, 254)')

  await page.getByRole('button', { name: /Color theme:/ }).click()
  await page.getByRole('menuitemradio', { name: 'Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const flowNode = reader.locator('figure[data-diagram-type="flowchart"] svg .node rect').first()
  const lightFlowNodeFill = await flowNode.evaluate((element) => getComputedStyle(element).fill)
  await page.getByRole('button', { name: 'Color theme: Light' }).click()
  await page.getByRole('menuitemradio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect.poll(() => flowNode.evaluate((element) => getComputedStyle(element).fill)).not.toBe(lightFlowNodeFill)
  await expect(reader.locator('.markdown-diagram-loading')).toHaveCount(0, { timeout: 150_000 })
  await expect(reader.locator('figure.markdown-diagram')).toHaveCount(supportedTypes.length)
  await expect(reader.locator('.markdown-diagram-error')).toHaveCount(unsupportedTypes.length)

  await page.setViewportSize({ width: 390, height: 844 })
  const narrowPageWidth = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }))
  expect(narrowPageWidth.document).toBeLessThanOrEqual(narrowPageWidth.viewport)
  expect(await wideDiagram.evaluate((element) => element.scrollWidth)).toBeGreaterThan(await wideDiagram.evaluate((element) => element.clientWidth))
})

test('the command palette shortcut works while the artifact iframe has focus', async ({ page }) => {
  await page.goto('/sre/incidents/checkout-latency/index.html')
  await expect(page.locator('.sidebar-panel .tree-artifact.is-active .tree-format-tag')).toHaveCount(0)
  const artifact = page.frameLocator('iframe[title="Checkout latency incident review"]')
  const summaryHeading = artifact.getByRole('heading', { name: 'Summary' })
  await expect(summaryHeading).toBeVisible()
  await summaryHeading.click()
  await summaryHeading.press('Control+k')

  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await expect(search).toBeFocused()
  await search.fill('Platform topology')
  await search.press('Enter')
  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(/\/sre\/architecture\/platform-topology\/index\.html$/)
})

test('command palette fuzzy search shows matched characters in titles and paths', async ({ page }) => {
  await page.goto('/sre/incidents/checkout-latency/index.html')
  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()

  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('pltf')

  const platform = palette.getByRole('option', { name: /Platform topology/ })
  await expect(platform).toBeVisible()
  expect(await platform.locator('.palette-entry-title .palette-match').allTextContents()).toEqual(['P', 'l', 't', 'f'])
  expect(await platform.locator('.palette-entry-subtitle .palette-match').allTextContents()).toEqual(['p', 'l', 't', 'f'])
  await expect(platform.locator('.palette-entry-title .palette-match').first()).toHaveCSS('text-decoration-line', 'none')

  await search.fill('chk lat')
  const checkout = palette.getByRole('option', { name: /Checkout latency incident review/ })
  await expect(checkout).toBeVisible()
  expect(await checkout.locator('.palette-entry-title .palette-match').allTextContents()).toEqual(['C', 'h', 'k', 'l', 'a', 't'])
  expect(await checkout.locator('.palette-entry-subtitle .palette-match').allTextContents()).toEqual(['c', 'h', 'k', 'l', 'a', 't'])
})

function artifactAssetPaths(siteId: string, artifactPath: string) {
  const root = `/_artifacts/${siteId}/${artifactPath}/assets`
  return [
    `${root}/css/styles.css`,
    `${root}/css/tokens.css`,
    `${root}/images/brand-mark.svg`,
    `${root}/js/main.js`,
    `${root}/js/modules/hydrate.js`,
    `${root}/data/details.json`,
  ]
}

function waitForResponses(page: Page, paths: string[]) {
  return paths.map((pathname) => page.waitForResponse((response) => {
    return new URL(response.url()).pathname === pathname
  }))
}

test('the selected theme is offered in the menu and reaches adaptive artifact iframes', async ({ page }) => {
  await page.goto('/showcase/tests/color-scheme-response/index.html')

  const frame = page.frameLocator('iframe[title="Color scheme response fixture"]')
  const systemTheme = await page.locator('html').getAttribute('data-theme')
  expect(systemTheme).toMatch(/^(light|dark)$/)
  const systemLabel = systemTheme === 'dark' ? 'Dark' : 'Light'
  await expect(frame.getByRole('status')).toHaveText(systemLabel)
  await expect(frame.locator('html')).toHaveAttribute('data-preferred-scheme', systemTheme!)

  await page.getByRole('button', { name: 'Color theme: System' }).click()
  const menu = page.getByRole('menu', { name: 'Color theme' })
  await expect(menu.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')
  await expect(menu.getByRole('menuitemradio', { name: 'Light' })).toBeVisible()
  await expect(menu.getByRole('menuitemradio', { name: 'Dark' })).toBeVisible()

  await menu.getByRole('menuitemradio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('iframe')).toHaveCSS('color-scheme', 'dark')

  await page.getByRole('button', { name: 'Color theme: Dark' }).click()
  await page.getByRole('menuitemradio', { name: 'Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('iframe')).toHaveCSS('color-scheme', 'light')

  await page.getByRole('button', { name: 'Color theme: Light' }).click()
  await page.getByRole('menuitemradio', { name: 'System' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', systemTheme!)
  await expect(page.locator('iframe')).toHaveCSS('color-scheme', systemTheme!)
})

test('the collapsed rail searches artifacts and switches sites', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  const frontendMetadata = page.waitForResponse((response) => {
    return new URL(response.url()).pathname === '/_indexes/frontend/meta.json'
  })
  const sreIndex = page.waitForResponse((response) => {
    return new URL(response.url()).pathname === '/_indexes/sre/index.json'
  })

  await page.goto('/sre/incidents/checkout-latency/index.html')
  await Promise.all([frontendMetadata, sreIndex])
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('git-artifact-pages-theme'))).toBe('system')

  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible()

  await page.getByRole('button', { name: 'Color theme: System' }).click()
  const themeMenu = page.getByRole('menu', { name: 'Color theme' })
  await expect(themeMenu.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')
  await themeMenu.getByRole('menuitemradio', { name: 'Dark' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('git-artifact-pages-theme'))).toBe('dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  await page.getByRole('button', { name: 'Color theme: Dark' }).click()
  await page.getByRole('menuitemradio', { name: 'Light' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('git-artifact-pages-theme'))).toBe('light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('>theme')
  await expect(palette.getByRole('option', { name: 'Use light theme' })).toContainText('Current')
  await search.fill('>Use dark theme')
  await expect(palette.getByRole('option', { name: 'Use dark theme' })).toBeVisible()
  await search.press('Enter')
  await expect(palette).toBeHidden()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('git-artifact-pages-theme'))).toBe('dark')
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()

  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
  const systemPalette = page.getByRole('dialog', { name: 'Command palette' })
  const systemSearch = systemPalette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await systemSearch.fill('>Use system theme')
  await systemSearch.press('Enter')
  await expect(systemPalette).toBeHidden()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('git-artifact-pages-theme'))).toBe('system')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
  const searchPalette = page.getByRole('dialog', { name: 'Command palette' })
  const artifactSearch = searchPalette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await artifactSearch.fill('Platform topology')
  await expect(searchPalette.getByRole('option', { name: /Platform topology/ })).toBeVisible()
  await artifactSearch.press('Enter')
  await expect(searchPalette).toBeHidden()

  await expect(page).toHaveURL(/\/sre\/architecture\/platform-topology\/index\.html$/)
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Artifact path' })).not.toContainText('SRE')

  await page.getByRole('button', { name: 'Switch site. Current site: SRE' }).click()
  const sitePalette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(sitePalette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })).toHaveValue('@')
  const frontendIndex = page.waitForResponse((response) => {
    return new URL(response.url()).pathname === '/_indexes/frontend/index.json'
  })
  await sitePalette.getByRole('option', { name: /Frontend/ }).click()

  await frontendIndex
  await expect(page).toHaveURL(/\/frontend$/)
  await expect(page.getByRole('heading', { name: 'Frontend', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Switch site. Current site: Frontend' }).click()
  const showcasePalette = page.getByRole('dialog', { name: 'Command palette' })
  const showcaseIndex = page.waitForResponse((response) => {
    return new URL(response.url()).pathname === '/_indexes/showcase/index.json'
  })
  await showcasePalette.getByRole('option', { name: /HTML Showcase/ }).click()
  await showcaseIndex
  await expect(page).toHaveURL(/\/showcase$/)
  await expect(page.getByRole('heading', { name: 'HTML Showcase', exact: true })).toBeVisible()
})

test('HTML showcase covers distinct page styles in the artifact iframe', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/css',
    body: '',
  }))

  const examples = [
    { path: 'editorial/field-notes', route: 'editorial/field-notes/index.html', heading: /Designing for resilience/ },
    { path: 'dashboards/edge-observatory', route: 'dashboards/edge-observatory/index.html', heading: 'Edge latency observatory' },
    { path: 'handbook/inclusive-components', route: 'handbook/inclusive-components/index.html', heading: 'Inclusive component handbook' },
    { path: 'reports/cloud-spend-review', route: 'reports/cloud-spend-review/index.html', heading: /Cloud spend review/ },
    { path: 'presentations/resilient-by-design', route: 'presentations/resilient-by-design/index.html', heading: /Resilient by design/ },
    { path: 'product/atlas-launch', route: 'product/atlas-launch/index.html', heading: /Make space for the work/ },
    { path: 'forms/incident-intake', route: 'forms/incident-intake/index.html', heading: 'Incident intake' },
  ]

  for (const example of examples) {
    const stylesheetResponse = page.waitForResponse((response) => {
      return new URL(response.url()).pathname === `/_artifacts/showcase/${example.path}/assets/css/styles.css`
    })
    await page.goto(`/showcase/${example.route}`)
    const artifact = page.frameLocator('iframe')
    await expect(artifact.getByRole('heading', { name: example.heading })).toBeVisible()
    expect((await stylesheetResponse).status()).toBe(200)
  }

  await page.goto('/showcase/dashboards/edge-observatory/index.html')
  const dashboard = page.frameLocator('iframe')
  await expect(dashboard.locator('body')).toHaveCSS('background-color', 'rgb(11, 17, 24)')
})

test('folder breadcrumb menus list their contents, the current page is a plain label, and sidebar reveal stays available', async ({ page }) => {
  await page.goto('/showcase/reports/cloud-spend-review/index.html')

  const breadcrumb = page.getByRole('navigation', { name: 'Artifact path' })
  const browse = page.locator('.browse-tree')
  const reports = browse.locator('[data-tree-path="reports"]')
  const reviewFolder = browse.locator('[data-tree-path="reports/cloud-spend-review"]')
  const artifact = browse.locator('[data-tree-path="reports/cloud-spend-review/index.html"]')

  await expect(reports).toHaveAttribute('aria-expanded', 'true')
  await breadcrumb.getByRole('button', { name: 'Browse artifacts in reports', exact: true }).click()
  let menu = page.getByRole('menu', { name: 'Artifacts in reports', exact: true })
  await expect(menu.getByRole('menuitem', { name: /Cloud spend review.*current artifact/ })).toHaveAttribute('aria-current', 'page')
  await menu.getByRole('menuitem', { name: 'Show in sidebar' }).click()
  await expect(menu).toHaveCount(0)
  await expect(reviewFolder).toHaveAttribute('aria-expanded', 'true')
  await expect(reports).toBeInViewport()
  await expect(artifact).toHaveAttribute('aria-current', 'page')
  await expect(artifact).toBeInViewport()

  const currentLabel = breadcrumb.locator('.breadcrumb-current')
  await expect(currentLabel).toHaveText('Cloud spend review · Q3')
  await expect(currentLabel).toHaveAttribute('aria-current', 'page')
  await expect(breadcrumb.getByRole('button', { name: /Open sibling artifacts/ })).toHaveCount(0)

  // Nested folder segments each have their own menu; Escape then one click on another opens it.
  const folderTrigger = breadcrumb.getByRole('button', { name: 'Browse artifacts in reports/cloud-spend-review', exact: true })
  const topTrigger = breadcrumb.getByRole('button', { name: 'Browse artifacts in reports', exact: true })
  await folderTrigger.click()
  menu = page.getByRole('menu', { name: 'Artifacts in reports/cloud-spend-review', exact: true })
  await expect(menu.getByRole('menuitem', { name: /Cloud spend review.*current artifact/ })).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(folderTrigger).toBeFocused()

  // Escape on one menu, then a single click on a different trigger must open it.
  await topTrigger.click()
  await expect(page.getByRole('menu', { name: 'Artifacts in reports', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await folderTrigger.click()
  await expect(page.getByRole('menu', { name: 'Artifacts in reports/cloud-spend-review', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  // Escape restores focus to the trigger in a later frame; wait so it cannot land after the next open.
  await expect(folderTrigger).toBeFocused()
  await topTrigger.focus()
  await page.keyboard.press('Enter')
  menu = page.getByRole('menu', { name: 'Artifacts in reports', exact: true })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: /Cloud spend review.*current artifact/ }).press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(topTrigger).toBeFocused()
})

async function routeShowcaseExtras(page: import('@playwright/test').Page, paths: string[]) {
  await page.route('**/_indexes/showcase/index.json', async (route) => {
    const response = await route.fetch()
    const siteIndex = await response.json()
    const base = siteIndex.artifacts.find((artifact: { path: string }) => (
      artifact.path === 'reports/cloud-spend-review/index.html'
    ))
    for (const path of paths) {
      const filename = path.split('/').at(-1)!
      siteIndex.artifacts.push({
        ...base,
        id: path,
        title: filename.replace('.html', ''),
        path,
        filename,
      })
    }
    await route.fulfill({ response, body: JSON.stringify(siteIndex) })
  })
}

test('choosing a breadcrumb menu item across subfolders keeps focus on the breadcrumb, not the body', async ({ page }) => {
  await routeShowcaseExtras(page, ['reports/cloud-spend-review/appendix/notes.html'])
  await page.goto('/showcase/reports/cloud-spend-review/index.html')
  const breadcrumb = page.getByRole('navigation', { name: 'Artifact path' })
  const trigger = breadcrumb.getByRole('button', { name: 'Browse artifacts in reports/cloud-spend-review', exact: true })
  await trigger.click()
  await page.getByRole('menu', { name: 'Artifacts in reports/cloud-spend-review', exact: true })
    .getByRole('menuitem', { name: /notes/ }).click()
  await expect(page).toHaveURL(/\/showcase\/reports\/cloud-spend-review\/appendix\/notes\.html$/)
  await expect(breadcrumb.locator('.breadcrumb-current')).toHaveText('notes')
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(false)
  await expect(breadcrumb.locator('[aria-haspopup]')).toHaveCount(3)
  await expect(breadcrumb.locator('.breadcrumb-current[aria-haspopup]')).toHaveCount(0)
  await expect(breadcrumb.locator(':focus')).toHaveCount(1)
})

test('a root-level artifact gets a site-root breadcrumb menu', async ({ page }) => {
  await routeShowcaseExtras(page, ['welcome.html', 'second.html'])
  await page.goto('/showcase/welcome.html')
  const breadcrumb = page.getByRole('navigation', { name: 'Artifact path' })
  await expect(breadcrumb.locator('.breadcrumb-current')).toHaveText('welcome')
  await expect(breadcrumb.locator('.breadcrumb-current[aria-haspopup]')).toHaveCount(0)

  const rootTrigger = breadcrumb.getByRole('button', { name: 'Browse artifacts in HTML Showcase', exact: true })
  await rootTrigger.click()
  const menu = page.getByRole('menu', { name: 'Artifacts in HTML Showcase', exact: true })
  await expect(menu.getByRole('menuitem', { name: /welcome.*current artifact/ })).toHaveAttribute('aria-current', 'page')
  await expect(menu.getByRole('menuitem', { name: /second/ })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Cloud spend review/ })).toHaveCount(0)
  await menu.getByRole('menuitem', { name: /second/ }).click()
  await expect(page).toHaveURL(/\/showcase\/second\.html$/)
  await expect(rootTrigger).toBeFocused()
})

test('breadcrumb menus close after browser history navigates to another artifact', async ({ page }) => {
  await page.goto('/showcase')

  const searchForArtifact = async (query: string) => {
    await page.getByRole('button', { name: 'Jump to a page in HTML Showcase' }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
    await search.fill(query)
    await search.press('Enter')
  }

  await searchForArtifact('Cloud spend review')
  await expect(page).toHaveURL(/\/showcase\/reports\/cloud-spend-review\/index\.html$/)
  await searchForArtifact('Edge latency observatory')
  await expect(page).toHaveURL(/\/showcase\/dashboards\/edge-observatory\/index\.html$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/showcase\/reports\/cloud-spend-review\/index\.html$/)

  const breadcrumb = page.getByRole('navigation', { name: 'Artifact path' })
  await breadcrumb.getByRole('button', { name: 'Browse artifacts in reports/cloud-spend-review', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'Artifacts in reports/cloud-spend-review', exact: true })
  await expect(menu).toBeVisible()

  await page.goForward()
  await expect(page).toHaveURL(/\/showcase\/dashboards\/edge-observatory\/index\.html$/)
  await expect(menu).toHaveCount(0)
})

test('showing a breadcrumb location on mobile moves focus into the sidebar', async ({ browser }) => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  await page.goto('/showcase/reports/cloud-spend-review/index.html')

  const breadcrumb = page.getByRole('navigation', { name: 'Artifact path' })
  await breadcrumb.getByRole('button', { name: 'Browse artifacts in reports', exact: true }).tap()
  const menu = page.getByRole('menu', { name: 'Artifacts in reports', exact: true })
  await menu.getByRole('menuitem', { name: 'Show in sidebar' }).tap()

  const reportsFolder = page.locator('.sidebar-panel .browse-tree [data-tree-path="reports"]')
  await expect(reportsFolder).toBeVisible()
  await expect(reportsFolder).toBeFocused()
  await page.close()
})

test('breadcrumb sibling menus stay within narrow screens and scroll long lists', async ({ browser }) => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  await page.route('**/_indexes/showcase/index.json', async (route) => {
    const response = await route.fetch()
    const siteIndex = await response.json()
    const currentArtifact = siteIndex.artifacts.find((artifact: { path: string }) => (
      artifact.path === 'reports/cloud-spend-review/index.html'
    ))
    siteIndex.artifacts.push(...Array.from({ length: 28 }, (_, index) => {
      const filename = `follow-up-${String(index + 1).padStart(2, '0')}.html`
      const path = `reports/cloud-spend-review/${filename}`
      return {
        id: path,
        title: `Follow-up ${String(index + 1).padStart(2, '0')}`,
        path,
        format: 'html',
        filename,
        artifactUrl: currentArtifact.artifactUrl,
        updatedAt: currentArtifact.updatedAt,
      }
    }))
    await route.fulfill({ response, body: JSON.stringify(siteIndex) })
  })

  await page.goto('/showcase/reports/cloud-spend-review/index.html')
  const breadcrumb = page.getByRole('navigation', { name: 'Artifact path' })
  const currentFile = breadcrumb.getByRole('button', { name: 'Browse artifacts in reports/cloud-spend-review', exact: true })
  await currentFile.tap()

  const menu = page.getByRole('menu', { name: 'Artifacts in reports/cloud-spend-review', exact: true })
  const menuList = menu.locator('.breadcrumb-menu-list')
  await expect(menuList.getByRole('menuitem')).toHaveCount(29)
  const viewport = page.viewportSize()!
  const bounds = await menu.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
  await expect.poll(() => menuList.evaluate((element) => element.scrollHeight > element.clientHeight)).toBeTruthy()

  await page.keyboard.press('ArrowDown')
  const firstSibling = menu.getByRole('menuitem', { name: /Follow-up 01/ })
  await expect(firstSibling).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/showcase\/reports\/cloud-spend-review\/follow-up-01\.html$/)

  await page.goBack()
  await expect(page).toHaveURL(/\/showcase\/reports\/cloud-spend-review\/index\.html$/)
  await currentFile.click()
  await page.getByRole('menu', { name: 'Artifacts in reports/cloud-spend-review', exact: true })
    .getByRole('menuitem', { name: /Follow-up 01/ }).click()
  await expect(page).toHaveURL(/\/showcase\/reports\/cloud-spend-review\/follow-up-01\.html$/)

  await page.goBack()
  await expect(page).toHaveURL(/\/showcase\/reports\/cloud-spend-review\/index\.html$/)
  await currentFile.tap()
  const reopenedMenu = page.getByRole('menu', { name: 'Artifacts in reports/cloud-spend-review', exact: true })
  await reopenedMenu.getByRole('menuitem', { name: /Follow-up 28/ }).tap()
  await expect(page).toHaveURL(/\/showcase\/reports\/cloud-spend-review\/follow-up-28\.html$/)
  await expect(reopenedMenu).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Artifact path' }).locator('.breadcrumb-current')).toHaveText('Follow-up 28')
  await page.unrouteAll({ behavior: 'wait' })
  await page.close()
})

test('the site home jumps to a page by name through the palette, ignoring IME Enter', async ({ page }) => {
  await page.goto('/sre')

  // The site home has no inline filter; finding a page by name is the palette's job.
  await expect(page.locator('.site-home').getByRole('searchbox')).toHaveCount(0)
  const homeJump = page.locator('.site-home').getByRole('button', { name: /Jump to a page/ })
  await homeJump.click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await expect(search).toBeFocused()
  await search.fill('topology')
  const topology = palette.getByRole('option', { name: /Platform topology/ })
  await expect(topology).toHaveAttribute('aria-selected', 'true')
  await search.press('Enter')
  await expect(page).toHaveURL(/\/sre\/architecture\/platform-topology\/index\.html$/)
  await expect(page.locator('.browse-tree .tree-artifact[aria-current="page"]')).toBeVisible()

  await page.keyboard.press('Control+k')
  await search.fill('Checkout latency incident review')
  await expect(palette.getByRole('option', { name: /Checkout latency incident review/ })).toHaveAttribute('aria-selected', 'true')
  // Enter that confirms an IME conversion is not a selection.
  await search.evaluate((input) => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
  })
  await expect(palette).toBeVisible()
  await expect(page).toHaveURL(/\/sre\/architecture\/platform-topology\/index\.html$/)
  await search.press('Enter')
  await expect(page).toHaveURL(/\/sre\/incidents\/checkout-latency\/index\.html$/)
  await expect(page.locator('.browse-tree .tree-artifact[aria-current="page"]')).toBeVisible()
})

test('artifact title and site home navigation stay clear on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/sre/reports/latency-retrospective.md')

  const article = page.locator('.markdown-article')
  await expect(article.locator('h1')).toHaveCount(0)

  const currentArtifact = page.locator('.breadcrumbs .breadcrumb-current')
  await expect(currentArtifact).toHaveText('Latency Retrospective')
  await expect(currentArtifact).toHaveAttribute('aria-current', 'page')

  const homeButton = page.getByRole('button', { name: 'Go to SRE home' })
  await expect(homeButton).toBeVisible()
  await expect(page.getByRole('button', { name: 'Switch site. Current site: SRE' })).toBeVisible()

  await homeButton.click()
  await expect(page).toHaveURL(/\/sre\/?$/)
  await expect(page.getByRole('heading', { name: 'SRE' })).toBeVisible()
})

test('all-sites navigation is available from site home and documents with the sidebar closed on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })

  for (const path of ['/sre', '/sre/reports/latency-retrospective.md']) {
    await page.goto(path)
    await expect(page.locator('.sidebar-panel')).toBeHidden()

    const allSitesButton = page.getByRole('button', { name: 'Go to all sites' })
    await expect(allSitesButton).toBeVisible()
    if (path !== '/sre') {
      await expect(page.getByRole('button', { name: 'Go to SRE home' })).toBeVisible()
    }

    await allSitesButton.click()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  }
})

test('site home hides artifact actions while an open artifact provides usable actions', async ({ page }) => {
  await page.goto('/sre')

  const contextActions = page.locator('.context-actions')
  await expect(contextActions.getByRole('button', { name: 'Go to all sites' })).toBeVisible()
  await expect(contextActions.getByRole('button', { name: 'Contents', exact: true })).toHaveCount(0)
  await expect(contextActions.getByRole('button', { name: 'Details', exact: true })).toHaveCount(0)
  await expect(contextActions.getByRole('button', { name: 'Copy artifact link' })).toHaveCount(0)
  await expect(contextActions.getByRole('link', { name: 'Open raw artifact' })).toHaveCount(0)

  await page.goto('/sre/incidents/checkout-latency/index.html')
  const contentsButton = contextActions.getByRole('button', { name: 'Contents', exact: true })
  const detailsButton = contextActions.getByRole('button', { name: 'Details', exact: true })
  const copyButton = contextActions.getByRole('button', { name: 'Copy artifact link' })
  const rawLink = contextActions.getByRole('link', { name: 'Open raw artifact' })

  await expect(contentsButton).toBeEnabled()
  await expect(detailsButton).toBeEnabled()
  await expect(copyButton).toBeEnabled()
  await expect(rawLink).toHaveAttribute('href', '/_artifacts/sre/incidents/checkout-latency/index.html')

  await detailsButton.click()
  await expect(page.getByRole('complementary', { name: 'Details' })).toBeVisible()
  await contentsButton.click()
  await expect(page.getByRole('complementary', { name: 'Contents' })).toBeVisible()
})

test('unknown sites show a clear not-found state and safe recovery action', async ({ page }) => {
  await page.goto('/unknown-site')

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('The page you requested does not exist or is no longer available.')
  await expect(page.locator('.status-content')).not.toContainText('/_indexes/')

  await page.getByRole('button', { name: '← All sites' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
})

test('invalid site IDs also use the not-found state', async ({ page }) => {
  await page.goto('/unknown_site')

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('The page you requested does not exist or is no longer available.')
  await expect(page.locator('.status-content')).not.toContainText('/_indexes/')
})

for (const path of ['/unknown-site/_previews', '/unknown-site/_previews?group=pr%3A42', '/unknown-site/_previews/0123456789abcdef0123456789abcdef01234567/notes.md']) {
  test(`unregistered site preview route ${path} uses generic not-found recovery`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveText('The page you requested does not exist or is no longer available.')
    await expect(page.locator('a[href="/unknown-site"]')).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await page.getByRole('button', { name: '← All sites' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  })
}

test('preview routes of an unregistered site are not found even when preview objects remain', async ({ page }) => {
  // Model a reload after unregister while the site's preview catalog is still cached or present.
  await page.route('**/_indexes/sites.json', async (route) => {
    const response = await route.fetch()
    const registry = await response.json() as { sites: Array<{ id: string }> }
    await route.fulfill({ response, body: JSON.stringify({ ...registry, sites: registry.sites.filter(({ id }) => id !== 'sre') }) })
  })
  await page.goto('/sre/_previews')
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await expect(page.locator('a[href="/sre"]')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
})

test('a failed site registry load does not turn a preview list into not-found', async ({ page }) => {
  await page.route('**/_indexes/sites.json', (route) => route.fulfill({ status: 503, body: 'temporarily unavailable' }))
  await page.goto('/sre/_previews')
  await expect(page.getByRole('heading', { name: 'Previews', exact: true })).toBeVisible()
  await expect(page.locator('.preview-group').first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0)
})

for (const path of ['/_control/sites/guide/lock.json', '/%5Fcontrol/sites/guide/lock.json', '/_CONTROL/sites/guide/lock.json', '/unknown-site/nested/missing.html']) {
  test(`unavailable resource ${path} uses generic not-found recovery`, async ({ page }) => {
    if (decodeURIComponent(path).toLowerCase().startsWith('/_control/')) {
      // nginx rejects control paths before React runs. Model the permitted
      // Cloudflare SPA fallback without weakening the local storage boundary.
      await page.route('**/*', async (route) => {
        const request = route.request()
        if (request.resourceType() === 'document' && decodeURIComponent(new URL(request.url()).pathname).toLowerCase().startsWith('/_control/')) {
          await route.fulfill({ response: await page.request.get('/index.html') })
        } else {
          await route.continue()
        }
      })
    }
    const controlRequests: string[] = []
    page.on('request', (request) => {
      if (request.resourceType() !== 'document' && /^\/_control(?:\/|$)/iu.test(new URL(request.url()).pathname)) {
        controlRequests.push(request.url())
      }
    })
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveText('The page you requested does not exist or is no longer available.')
    await expect(page.locator('.status-content')).not.toContainText('_control')
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    expect(controlRequests).toEqual([])
    await page.getByRole('button', { name: '← All sites' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  })
}

test('an unmatched artifact uses generic not-found while preserving site navigation', async ({ page }) => {
  await page.goto('/sre/no-such-document.html')
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('The page you requested does not exist or is no longer available.')
  await expect(page.getByRole('complementary', { name: 'SRE navigation' })).toBeVisible()
  await expect(page.locator('.artifact-frame')).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to site', exact: true }).click()
  await expect(page).toHaveURL('/sre')
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
})

test('a failed known-site index load stays distinct from an unknown site', async ({ page }) => {
  const indexRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (/^\/_indexes\/[^/]+\/index\.json$/u.test(pathname)) indexRequests.push(pathname)
  })
  await page.route('**/_indexes/sre/index.json', (route) => route.fulfill({ status: 503, body: 'temporarily unavailable' }))
  await page.goto('/sre')

  await expect(page.getByRole('heading', { name: 'Unable to load this site' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('The site could not be loaded (HTTP 503). Please try again in a moment.')
  await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0)
  await expect(page.locator('.status-content')).not.toContainText('/_indexes/')
  expect(indexRequests).toEqual(['/_indexes/sre/index.json'])

  await page.getByRole('button', { name: '← All sites' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
})

const previewHeadSha = '0123456789abcdef0123456789abcdef01234567'

test('preview list separates documents affected by a resource change', async ({ page }) => {
  const changed = { path: 'guides/changed.md', title: 'Changed guide', format: 'markdown', reason: 'changed' }
  const affected = { path: 'guides/affected.html', title: 'Affected page', format: 'html', reason: 'dependency', changedResources: ['assets/site.css'] }
  const documents = [affected, changed]
  await page.route('**/_previews/showcase/catalog.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ schemaVersion: 1, site: 'showcase', groups: [{
      id: 'pr:702', kind: 'pull-request', headSha: previewHeadSha,
      prUrl: 'https://github.com/acme/showcase/pull/702', updatedAt: '2026-09-27T00:00:00Z', documents,
    }] }),
  }))
  await page.route(`**/_previews/showcase/revisions/${previewHeadSha}/manifest.json`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1, site: 'showcase', headSha: previewHeadSha,
      defaultHeadSha: '1111111111111111111111111111111111111111', mergeBaseSha: '2222222222222222222222222222222222222222',
      createdAt: '2026-09-27T00:00:00Z', bundleDigest: `sha256:${'0'.repeat(64)}`,
      files: documents.map(({ path }) => ({ path, sha256: 'a'.repeat(64), contentType: 'text/plain' })),
      documents,
    }),
  }))
  await page.goto('/showcase/_previews')
  const group = page.getByRole('region', { name: 'Preview pr:702' })
  await expect(group.getByRole('link', { name: /Changed guide/ })).toBeVisible()
  const section = group.getByRole('group', { name: 'Affected by resource change' })
  await expect(section.getByRole('link', { name: /Affected page/ })).toBeVisible()
  await expect(section).toContainText('Uses changed assets/site.css')
  await expect(section).not.toContainText('Changed guide')
})

test('published preview documents stay out of production browsing and the site-home link opens previews', async ({ page }) => {
  const previewOnlyTitle = 'Preview-only rollout note'
  const previewOnlyDocument = { path: 'guides/preview-only.md', title: previewOnlyTitle, format: 'markdown' }
  const previewOnlyGroup = {
    id: 'pr:701',
    kind: 'pull-request',
    headSha: previewHeadSha,
    prUrl: 'https://github.com/acme/showcase/pull/701',
    updatedAt: '2026-09-27T00:00:00Z',
    documents: [previewOnlyDocument],
  }
  const previewOnlyManifest = {
    schemaVersion: 1,
    site: 'showcase',
    headSha: previewHeadSha,
    defaultHeadSha: '1111111111111111111111111111111111111111',
    mergeBaseSha: '2222222222222222222222222222222222222222',
    createdAt: '2026-09-27T00:00:00Z',
    bundleDigest: `sha256:${'0'.repeat(64)}`,
    files: [{ path: previewOnlyDocument.path, sha256: 'a'.repeat(64), contentType: 'text/markdown; charset=utf-8' }],
    documents: [previewOnlyDocument],
  }
  const previewRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.includes('/_previews/')) previewRequests.push(pathname)
  })
  await page.route('**/_previews/showcase/catalog.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ schemaVersion: 1, site: 'showcase', groups: [previewOnlyGroup] }),
  }))
  await page.route(`**/_previews/showcase/revisions/${previewHeadSha}/manifest.json`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(previewOnlyManifest),
  }))

  await page.goto('/showcase')
  await expect(page.getByRole('heading', { name: 'HTML Showcase', exact: true })).toBeVisible()
  const recent = page.locator('.site-home .artifact-list-section[aria-label="Recently updated"]')
  const browse = page.locator('.site-home .browse-section')
  await expect(recent).toBeVisible()
  await expect(browse).toBeVisible()
  await expect(recent).not.toContainText(previewOnlyTitle)
  await expect(browse).not.toContainText(previewOnlyTitle)
  await expect(page.getByRole('status')).toHaveText('1 preview listed.')
  expect(previewRequests).toContain('/_previews/showcase/catalog.json')
  expect(previewRequests).toContain(`/_previews/showcase/revisions/${previewHeadSha}/manifest.json`)

  await page.getByRole('button', { name: 'View previews' }).click()
  await expect(page).toHaveURL('/showcase/_previews')
  await expect(page.getByRole('region', { name: 'Preview pr:701' })).toBeVisible()
  await expect(page.getByRole('link', { name: previewOnlyTitle })).toBeVisible()
  expect(previewRequests).toContain('/_previews/showcase/catalog.json')
  expect(previewRequests).toContain(`/_previews/showcase/revisions/${previewHeadSha}/manifest.json`)

  await page.getByRole('link', { name: '← HTML Showcase' }).click()
  await expect(page).toHaveURL('/showcase')
  await expect(recent).toBeVisible()
  await expect(browse).toBeVisible()
  await expect(recent).not.toContainText(previewOnlyTitle)
  await expect(browse).not.toContainText(previewOnlyTitle)

  previewRequests.length = 0
  await page.getByRole('button', { name: 'Jump to a page in HTML Showcase' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const paletteSearch = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await paletteSearch.fill(previewOnlyTitle)
  await expect(palette.getByRole('option')).toHaveCount(0)
  await expect(palette.getByText('Nothing matches. Try > for commands or @ for sites.')).toBeVisible()
  expect(previewRequests).toEqual([])
})

test('preview list validates candidate manifests before presenting entries', async ({ page }) => {
  let manifestState: 'mismatched' | 'malformed' = 'mismatched'
  await page.route(`**/_previews/sre/revisions/${previewHeadSha}/manifest.json`, async (route) => {
    const response = await route.fetch()
    const manifest = await response.json()
    if (manifestState === 'mismatched') {
      manifest.documents = manifest.documents.slice(0, 1)
      await route.fulfill({ response, body: JSON.stringify(manifest) })
      return
    }
    const { files: _files, ...malformed } = manifest
    await route.fulfill({ response, body: JSON.stringify(malformed) })
  })

  await page.goto('/sre/_previews')
  await expect(page.getByRole('alert')).toHaveText('Some preview catalog records did not match their revision manifests.')
  await expect(page.getByRole('region', { name: 'Preview pr:42' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Preview pr:43' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: `Preview head:${previewHeadSha}` })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'There are no available previews for this site.' })).toBeVisible()

  manifestState = 'malformed'
  await page.reload()
  await expect(page.getByRole('alert')).toHaveText('Some preview catalog records did not match their revision manifests.')
  await expect(page.getByRole('region', { name: 'Preview pr:42' })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'There are no available previews for this site.' })).toBeVisible()

  // The palette's Open previews command reaches the same validated list.
  await page.goto('/sre')
  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' }).fill('>open previews')
  await palette.getByRole('option', { name: /Open previews/ }).click()
  await expect(page).toHaveURL('/sre/_previews')
  await expect(page.getByRole('alert')).toHaveText('Some preview catalog records did not match their revision manifests.')
  await expect(page.getByRole('region', { name: 'Preview pr:42' })).toHaveCount(0)
})

test('preview list distinguishes missing groups, empty catalogs, missing catalogs, and catalog errors', async ({ page }) => {
  let catalogState: 'empty' | 'missing' | 'error' = 'empty'
  await page.route('**/_previews/sre/catalog.json', (route) => {
    if (catalogState === 'missing') return route.fulfill({ status: 404, body: 'not found' })
    if (catalogState === 'error') return route.fulfill({ status: 503, body: 'temporarily unavailable' })
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ schemaVersion: 1, site: 'sre', groups: [] }),
    })
  })

  await page.goto('/sre/_previews?group=pr%3A404')
  await expect(page.getByRole('status')).toHaveText('This preview is no longer listed.')

  await page.goto('/sre/_previews')
  await expect(page.getByRole('status')).toHaveText('There are no available previews for this site.')

  catalogState = 'missing'
  await page.reload()
  await expect(page.getByRole('status')).toHaveText('There are no available previews for this site.')

  catalogState = 'error'
  await page.reload()
  await expect(page.getByRole('alert')).toHaveText('The preview list could not be loaded.')
  await page.getByRole('link', { name: '← SRE' }).click()
  await expect(page).toHaveURL('/sre')
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
})

test('site home reports empty preview availability and the empty page explains how to return', async ({ page }) => {
  await page.route('**/_previews/sre/catalog.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ schemaVersion: 1, site: 'sre', groups: [] }),
  }))

  await page.goto('/sre')
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('There are no available previews for this site.')
  const previewEntry = page.getByRole('button', { name: 'View previews' })
  await expect(previewEntry).toHaveAttribute('aria-disabled', 'true')
  await expect(previewEntry).toHaveAccessibleDescription('There are no available previews for this site.')
  await expect(page.getByText(/^Previews are review copies of changed documents/)).toBeVisible()
  await previewEntry.focus()
  await expect(previewEntry).toBeFocused()
  await page.keyboard.press('Enter')
  await previewEntry.click({ force: true })
  await expect(page).toHaveURL('/sre')

  await page.goto('/sre/_previews')
  await expect(page.getByRole('status')).toHaveText('There are no available previews for this site.')
  await expect(page.getByText(/Previews show changed documents from pull requests and manual preview builds\./)).toBeVisible()
  await page.getByRole('link', { name: 'Back to site home' }).click()
  await expect(page).toHaveURL('/sre')
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
})

test('site home keeps the preview entry active when previews exist', async ({ page }) => {
  await page.goto('/sre')
  await expect(page.getByRole('status')).toContainText('listed.')
  const previewEntry = page.getByRole('button', { name: 'View previews' })
  await expect(previewEntry).toBeEnabled()
  await previewEntry.click()
  await expect(page).toHaveURL('/sre/_previews')
})

test('preview list loading does not block returning to the site', async ({ page }) => {
  let releaseCatalog!: () => void
  let signalCatalogStarted!: () => void
  const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve })
  const catalogStarted = new Promise<void>((resolve) => { signalCatalogStarted = resolve })
  const catalogResponse = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/_previews/sre/catalog.json'
  ))
  await page.route('**/_previews/sre/catalog.json', async (route) => {
    signalCatalogStarted()
    await catalogGate
    await route.fulfill({ status: 503, body: 'temporarily unavailable' })
  })

  await page.goto('/sre')
  await page.getByRole('button', { name: 'View previews' }).click()
  await catalogStarted
  await expect(page.getByRole('status')).toHaveText('Loading previews…')
  try {
    await page.getByRole('link', { name: '← SRE' }).click()
    await expect(page).toHaveURL('/sre')
    await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
  } finally {
    releaseCatalog()
  }
  await catalogResponse
})

test('site previews filter missing revisions and keep PR and manual groups distinct', async ({ page }) => {
  const previewCatalogRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.includes('/_previews/') && pathname.endsWith('/catalog.json')) previewCatalogRequests.push(pathname)
  })

  await page.goto('/sre/_previews')
  await expect(page.getByRole('heading', { name: 'Previews', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Preview pr:43' })).toBeVisible()
  await expect(page.getByRole('region', { name: `Preview head:${previewHeadSha}` })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Preview pr:99' })).toHaveCount(0)
  await expect.poll(() => [...previewCatalogRequests]).toEqual(['/_previews/sre/catalog.json'])

  const markdownLink = page.getByRole('link', { name: /Local preview guide/ }).first()
  await expect(markdownLink).toHaveAttribute('href', new RegExp(`/sre/_previews/${previewHeadSha}/guides/preview-guide\\.md\\?group=pr%3A42$`))
  const previewImageResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === `/_previews/sre/revisions/${previewHeadSha}/files/assets/mark.svg`
      && url.search === '?theme=dark'
      && response.status() === 200
  })
  await markdownLink.click()
  await expect(page).toHaveURL(new RegExp(`/sre/_previews/${previewHeadSha}/guides/preview-guide\\.md\\?group=pr%3A42$`))
  await expect(page.getByRole('link', { name: 'Return to PR #42 ↗' })).toHaveAttribute('href', 'https://github.com/acme/sre-docs/pull/42')
  await expect(page.locator('.preview-reader-header h1')).toHaveText('Local preview guide')
  const previewMark = page.getByRole('img', { name: 'Preview mark' })
  await expect(previewMark).toBeVisible()
  await previewImageResponse
  await expect.poll(() => previewMark.evaluate((node) => {
    const image = node as HTMLImageElement
    return image.complete && image.naturalWidth > 0
  })).toBe(true)
  const previewMarkCurrentSrc = await previewMark.evaluate((node) => (node as HTMLImageElement).currentSrc)
  expect(new URL(previewMarkCurrentSrc).pathname).toBe(`/_previews/sre/revisions/${previewHeadSha}/files/assets/mark.svg`)
  await expect(page.getByRole('link', { name: 'Open the published latency retrospective' })).toHaveAttribute('href', '/sre/reports/latency-retrospective.md')

  await page.goto('/sre/_previews')
  const encodedDocument = page.getByRole('region', { name: 'Preview pr:42' })
    .getByRole('link', { name: 'Encoded preview route' })
  await expect(encodedDocument).toHaveAttribute('href', `/sre/_previews/${previewHeadSha}/guides/review%20r%C3%A9sum%C3%A9%20%23%25%20%2B%3F.md?group=pr%3A42`)
  await encodedDocument.click()
  await expect.poll(() => {
    const url = new URL(page.url())
    return `${url.pathname}${url.search}`
  }).toBe(`/sre/_previews/${previewHeadSha}/guides/review%20r%C3%A9sum%C3%A9%20%23%25%20%2B%3F.md?group=pr%3A42`)
  await expect(page.locator('.preview-reader-header h1')).toHaveText('Encoded preview route')
  await page.reload()
  await expect(page.locator('.preview-reader-header h1')).toHaveText('Encoded preview route')

  await page.goto('/sre/_previews?group=pr%3A43')
  await expect(page.getByRole('region', { name: 'Preview pr:43' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Preview pr:42' })).toHaveCount(0)
  await page.getByRole('region', { name: 'Preview pr:43' }).getByRole('link', { name: /Local preview guide/ }).click()
  await expect(page.getByRole('link', { name: 'Return to PR #43 ↗' })).toHaveAttribute('href', 'https://github.com/acme/sre-docs/pull/43')

  await page.goto('/sre/_previews')
  await page.getByRole('region', { name: `Preview head:${previewHeadSha}` })
    .getByRole('link', { name: /Local preview guide/ }).click()
  await expect(page).toHaveURL(new RegExp(`/sre/_previews/${previewHeadSha}/guides/preview-guide\\.md\\?group=head%3A${previewHeadSha}$`))
  await expect(page.getByRole('link', { name: /Return to PR/ })).toHaveCount(0)
})

test('the in-site palette opens previews by command without loading preview data itself', async ({ page }) => {
  const previewRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.includes('/_previews/')) previewRequests.push(pathname)
  })

  await page.goto('/sre')
  await expect(page.getByRole('status')).toContainText('listed.')
  previewRequests.length = 0
  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  // Previews are not palette results; they are reached through the Open previews command.
  await palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' }).fill('Local preview guide')
  await expect(palette.getByRole('option', { name: /Local preview guide/ })).toHaveCount(0)
  await palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' }).fill('>previews')
  expect(previewRequests).toEqual([])
  await palette.getByRole('option', { name: /Open previews/ }).click()
  await expect(page).toHaveURL('/sre/_previews')
  await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
  await expect.poll(() => previewRequests.some((pathname) => pathname === '/_previews/sre/catalog.json')).toBe(true)
  expect(previewRequests.every((pathname) => pathname.startsWith('/_previews/sre/'))).toBeTruthy()
  await page.getByRole('region', { name: 'Preview pr:42' }).getByRole('link', { name: /Local preview guide/ }).click()
  await expect(page).toHaveURL(new RegExp(`/sre/_previews/${previewHeadSha}/guides/preview-guide\\.md\\?group=pr%3A42$`))
})

test('preview PR context disappears when its catalog group advances or is removed', async ({ page }) => {
  let catalogState: 'current' | 'advanced' | 'removed' = 'current'
  await page.route('**/_previews/sre/catalog.json', async (route) => {
    const response = await route.fetch()
    const catalog = await response.json()
    if (catalogState === 'advanced') {
      catalog.groups = catalog.groups.map((group: { id: string; headSha: string }) => (
        group.id === 'pr:42' ? { ...group, headSha: 'ffffffffffffffffffffffffffffffffffffffff' } : group
      ))
    } else if (catalogState === 'removed') {
      catalog.groups = catalog.groups.filter((group: { id: string }) => group.id !== 'pr:42')
    }
    await route.fulfill({ response, body: JSON.stringify(catalog) })
  })

  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview-guide.md?group=pr%3A42`)
  await expect(page.getByRole('link', { name: 'Return to PR #42 ↗' })).toBeVisible()
  catalogState = 'advanced'
  await page.reload()
  await expect(page.locator('.preview-reader-header h1')).toHaveText('Local preview guide')
  await expect(page.getByRole('link', { name: /Return to PR/ })).toHaveCount(0)

  catalogState = 'removed'
  await page.reload()
  await expect(page.locator('.preview-reader-header h1')).toHaveText('Local preview guide')
  await expect(page.getByRole('link', { name: /Return to PR/ })).toHaveCount(0)

  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview-guide.md?group=pr%3A43`)
  await expect(page.getByRole('link', { name: 'Return to PR #43 ↗' })).toHaveAttribute('href', 'https://github.com/acme/sre-docs/pull/43')
})

// The reader injects preview-bridge.js after the frame loads and marks the script "ready" once it has executed;
// clicking earlier would fall through to native frame navigation instead of the bridge.
async function waitForPreviewBridge(page: Page) {
  await expect(page.frameLocator('iframe[title="Local preview HTML"]').locator('script[data-preview-reader-bridge="ready"]')).toHaveCount(1)
}

test('preview HTML keeps changed-document navigation in the preview and unchanged documents in production', async ({ page }) => {
  const externalResourcePaths = new Set<string>()
  let insecureResourceReached = false
  await page.route(`**/_previews/sre/revisions/${previewHeadSha}/files/guides/preview.html`, async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    const extraLinks = [
      '<p><a href="preview-guide.md?tab=summary#local-preview-guide">Open the changed Markdown document with query and fragment</a></p>',
      '<p><a href="https://docs.example.test/guide?mode=full#overview">Open external HTTPS documentation</a></p>',
      '<link rel="stylesheet" href="https://assets.example.test/preview.css">',
      '<script src="https://assets.example.test/preview.js"></script>',
      '<img src="https://assets.example.test/preview.svg" alt="External HTTPS mark">',
      '<style>html { --preview-css-containment: child; }</style>',
      '<script type="module">import "./modules/entry.js";</script>',
      `<script>
        document.addEventListener('securitypolicyviolation', (event) => {
          if (event.blockedURI.includes('attacker.localhost')) document.body.dataset.httpResourceBlocked = event.blockedURI
        })
        const blockedImage = new Image()
        blockedImage.src = 'http://attacker.localhost/preview-exfil'
        try {
          parent.document.body.dataset.previewParentDom = 'accessible'
          localStorage.setItem('issue026-preview-storage', 'accessible')
          document.body.dataset.parentAccess = 'accessible'
        } catch {
          document.body.dataset.parentAccess = 'blocked'
        }
        fetch('./preview-runtime.json').then((response) => response.json()).then((data) => {
          document.body.dataset.runtimeResource = data.status
        }).catch(() => { document.body.dataset.runtimeResource = 'blocked' })
      </script>`,
    ].join('')
    await route.fulfill({ response, body: source.replace('</main>', `${extraLinks}</main>`) })
  })
  await page.route('**/files/guides/preview-runtime.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'loaded' }),
  }))
  await page.route('https://assets.example.test/**', (route) => {
    const pathname = new URL(route.request().url()).pathname
    externalResourcePaths.add(pathname)
    if (pathname.endsWith('.css')) return route.fulfill({
      status: 200,
      contentType: 'text/css',
      body: 'body { --external-https-style: loaded; }',
    })
    if (pathname.endsWith('.js')) return route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'document.body.dataset.externalHttpsScript = "loaded";',
    })
    return route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="blue"/></svg>',
    })
  })
  await page.route('http://attacker.localhost/preview-exfil*', (route) => {
    insecureResourceReached = true
    return route.fulfill({ status: 204 })
  })
  await page.route('https://docs.example.test/guide?mode=full', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body><h1>External guide</h1></body></html>',
  }))
  const bridgeResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/preview-bridge.js')
  const moduleResponses = Promise.all(['entry.js', 'dependency.js'].map((name) => page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname.endsWith(`/guides/modules/${name}`)
  })))
  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`)
  await expect(page.getByRole('heading', { name: 'Local preview HTML' })).toBeVisible()
  const frame = page.frameLocator('iframe[title="Local preview HTML"]')
  const frameElement = page.locator('iframe[title="Local preview HTML"]')
  const frameSrc = await frameElement.getAttribute('src')
  expect(frameSrc).toBe(`/_previews/sre/revisions/${previewHeadSha}/files/guides/preview.html`)
  expect(new URL(frameSrc!, page.url()).origin).toBe(new URL(page.url()).origin)
  await expect(frameElement).not.toHaveAttribute('sandbox', /.+/)
  const rawHtmlResponse = await page.request.get(`/_previews/sre/revisions/${previewHeadSha}/files/guides/preview.html`)
  const htmlCsp = rawHtmlResponse.headers()['content-security-policy']
  expect(htmlCsp).toContain('https:')
  expect(htmlCsp).toContain('/preview-bridge.js')
  expect(htmlCsp).not.toContain("connect-src 'none'")
  expect(htmlCsp).not.toContain('sandbox')
  await bridgeResponse
  await expect(frame.getByRole('heading', { name: 'Local preview HTML' })).toBeVisible()
  await expect.poll(() => frame.locator('body').evaluate(() => window.location.origin)).toBe(new URL(page.url()).origin)
  expect((await moduleResponses).map((response) => response.status())).toEqual([200, 200])
  await expect.poll(() => frame.locator('body').getAttribute('data-static-module')).toBe('loaded')
  await expect(frame.getByRole('img', { name: 'Blue preview mark' })).toBeVisible()
  await expect.poll(() => frame.locator('body').evaluate(async () => {
    await document.fonts.ready
    return document.fonts.check('16px PreviewFixture')
  })).toBeTruthy()
  await expect.poll(() => frame.locator('body').getAttribute('data-runtime-resource')).toBe('loaded')
  await expect.poll(() => frame.locator('body').getAttribute('data-external-https-script')).toBe('loaded')
  await expect.poll(() => frame.locator('body').getAttribute('data-http-resource-blocked')).toContain('attacker.localhost')
  await expect(frame.getByRole('img', { name: 'External HTTPS mark' })).toBeVisible()
  await expect.poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).getPropertyValue('--external-https-style').trim())).toBe('loaded')
  await expect.poll(() => frame.locator('html').evaluate((html) => getComputedStyle(html).getPropertyValue('--preview-css-containment').trim())).toBe('child')
  expect(await page.locator('html').evaluate((html) => getComputedStyle(html).getPropertyValue('--preview-css-containment').trim())).toBe('')
  await expect(page.locator('body')).toHaveAttribute('data-preview-parent-dom', 'accessible')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('issue026-preview-storage'))).toBe('accessible')
  expect(insecureResourceReached).toBe(false)
  expect([...externalResourcePaths].sort()).toEqual(['/preview.css', '/preview.js', '/preview.svg'])
  await expect(page.getByRole('link', { name: 'Return to PR #42 ↗' })).toBeVisible()

  await expect.poll(() => frame.locator('html').getAttribute('data-preview-fixture')).toBe('loaded')
  const parentAccess = await frame.locator('body').evaluate(() => {
    try {
      void window.parent.document
      return 'accessible'
    } catch {
      return 'blocked'
    }
  })
  expect(parentAccess).toBe('accessible')
  await page.evaluate(() => {
    delete document.body.dataset.previewParentDom
    localStorage.removeItem('issue026-preview-storage')
  })

  await waitForPreviewBridge(page)
  await frame.getByRole('link', { name: 'Open the changed Markdown document with query and fragment' }).click()
  await expect(page).toHaveURL(`/sre/_previews/${previewHeadSha}/guides/preview-guide.md?group=pr%3A42&tab=summary#local-preview-guide`)
  await expect(page.getByRole('link', { name: 'Return to PR #42 ↗' })).toBeVisible()

  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`)
  const externalFrame = page.frameLocator('iframe[title="Local preview HTML"]')
  await waitForPreviewBridge(page)
  await externalFrame.getByRole('link', { name: 'Open external HTTPS documentation' }).click()
  await expect(externalFrame.getByRole('heading', { name: 'External guide' })).toBeVisible()
  await expect(page).toHaveURL(`/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`)

  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`)
  const changedFrame = page.frameLocator('iframe[title="Local preview HTML"]')
  await waitForPreviewBridge(page)
  await changedFrame.getByRole('link', { name: 'Open the changed Markdown document', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/sre/_previews/${previewHeadSha}/guides/preview-guide\\.md\\?group=pr%3A42$`))
  await expect(page.getByRole('link', { name: 'Return to PR #42 ↗' })).toBeVisible()

  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`)
  await waitForPreviewBridge(page)
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open the published retrospective' }).click()
  await expect(page).toHaveURL('/sre/reports/latency-retrospective.md')
  await expect(page.getByRole('heading', { name: 'Preview' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Go to SRE home' })).toBeVisible()
})

test('preview HTML fragments reach the frame on direct load, same-document links, history, and delayed load', async ({ page }) => {
  const previewUrl = `/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`
  const filesPrefix = `/_previews/sre/revisions/${previewHeadSha}/files`
  let holdFirstResponse = true
  let notifyHeldResponse: (() => void) | undefined
  let releaseHeldResponse: (() => void) | undefined
  const heldHtmlResponse = new Promise<void>((resolve) => { notifyHeldResponse = resolve })
  const releaseHtmlResponse = new Promise<void>((resolve) => { releaseHeldResponse = resolve })
  await page.route(`**/_previews/sre/revisions/${previewHeadSha}/manifest.json`, async (route) => {
    const response = await route.fetch()
    const manifest = await response.json() as {
      files: Array<{ path: string; sha256: string; contentType: string }>
      documents: Array<{ path: string; title: string; format: string }>
    }
    manifest.files.push({
      path: 'guides/preview-target.html',
      sha256: 'a'.repeat(64),
      contentType: 'text/html; charset=utf-8',
    })
    manifest.documents.push({ path: 'guides/preview-target.html', title: 'Preview fragment target', format: 'html' })
    await route.fulfill({ response, body: JSON.stringify(manifest) })
  })
  await page.route(`**${filesPrefix}/guides/preview-target.html`, async (route) => {
    if (route.request().method() === 'HEAD') {
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body><div style="height: 3200px"></div><h1 id="changed-target">Changed HTML target</h1></body></html>',
    })
  })
  await page.route(`**${filesPrefix}/guides/preview.html`, async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    if (holdFirstResponse) {
      holdFirstResponse = false
      notifyHeldResponse?.()
      await releaseHtmlResponse
    }
    const fixture = source.replace('</main>', [
      '<p><a href="#deep-target">Jump to deep target</a></p>',
      '<p><a href="#missing-target">Jump to missing target</a></p>',
      '<p><a href="preview-target.html?source=fixture#changed-target">Open a changed HTML document with fragment</a></p>',
      '<div aria-hidden="true" style="height: 3200px"></div>',
      '<section id="deep-target"><h2>Deep target</h2></section>',
      '</main>',
    ].join(''))
    await route.fulfill({ response, body: fixture })
  })

  await page.goto(`${previewUrl}#deep-target`, { waitUntil: 'domcontentloaded' })
  await heldHtmlResponse
  await expect(page).toHaveURL(`${previewUrl}#deep-target`)
  releaseHeldResponse?.()

  const iframe = page.locator('iframe[title="Local preview HTML"]')
  const frame = page.frameLocator('iframe[title="Local preview HTML"]')
  const frameHash = () => iframe.evaluate((element) => (element as HTMLIFrameElement).contentWindow?.location.hash ?? null)
  const deepTarget = frame.getByRole('heading', { name: 'Deep target' })
  await expect.poll(frameHash).toBe('#deep-target')
  await expect(deepTarget).toBeInViewport()
  await expect(page.getByRole('link', { name: 'Return to PR #42 ↗' })).toBeVisible()

  await page.reload()
  await expect.poll(frameHash).toBe('#deep-target')
  await expect(deepTarget).toBeInViewport()

  await page.goto(previewUrl)
  await expect(page.frameLocator('iframe[title="Local preview HTML"]').locator('script[data-preview-reader-bridge]')).toHaveCount(1)
  await waitForPreviewBridge(page)
  await frame.getByRole('link', { name: 'Jump to deep target' }).click()
  await expect(page).toHaveURL(`${previewUrl}#deep-target`)
  await expect.poll(frameHash).toBe('#deep-target')
  await expect(deepTarget).toBeInViewport()

  await page.goBack()
  await expect(page).toHaveURL(previewUrl)
  await expect.poll(frameHash).toBe('')
  await expect(frame.getByRole('heading', { name: 'Local preview HTML' })).toBeInViewport()

  await page.goForward()
  await expect(page).toHaveURL(`${previewUrl}#deep-target`)
  await expect.poll(frameHash).toBe('#deep-target')
  await expect(deepTarget).toBeInViewport()

  await page.goto(previewUrl)
  await waitForPreviewBridge(page)
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Jump to missing target' }).click()
  await expect(page).toHaveURL(`${previewUrl}#missing-target`)
  await expect.poll(frameHash).toBe('#missing-target')
  await expect(page.getByRole('link', { name: 'Return to PR #42 ↗' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(iframe).toBeVisible()

  await page.goto(previewUrl)
  await waitForPreviewBridge(page)
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open a changed HTML document with fragment' }).click()
  const changedPreviewUrl = `/sre/_previews/${previewHeadSha}/guides/preview-target.html?group=pr%3A42&source=fixture#changed-target`
  await expect(page).toHaveURL(changedPreviewUrl)
  const changedPreviewFrame = page.locator('iframe[title="Preview fragment target"]')
  await expect.poll(() => changedPreviewFrame.evaluate((element) => (element as HTMLIFrameElement).contentWindow?.location.hash ?? null)).toBe('#changed-target')
  await expect(page.frameLocator('iframe[title="Preview fragment target"]').getByRole('heading', { name: 'Changed HTML target' })).toBeInViewport()
  await expect(page.getByRole('link', { name: 'Return to PR #42 ↗' })).toBeVisible()
})

test('preview HTML link clicked before the reader bridge runs still navigates the reader', async ({ page }) => {
  const previewUrl = `/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`
  const filesPrefix = `/_previews/sre/revisions/${previewHeadSha}/files`
  await page.route(`**/_previews/sre/revisions/${previewHeadSha}/manifest.json`, async (route) => {
    const response = await route.fetch()
    const manifest = await response.json() as {
      files: Array<{ path: string; sha256: string; contentType: string }>
      documents: Array<{ path: string; title: string; format: string }>
    }
    manifest.files.push({ path: 'guides/preview-target.html', sha256: 'a'.repeat(64), contentType: 'text/html; charset=utf-8' })
    manifest.documents.push({ path: 'guides/preview-target.html', title: 'Preview fragment target', format: 'html' })
    await route.fulfill({ response, body: JSON.stringify(manifest) })
  })
  await page.route(`**${filesPrefix}/guides/preview-target.html`, async (route) => {
    if (route.request().method() === 'HEAD') {
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body><h1 id="changed-target">Changed HTML target</h1></body></html>',
    })
  })
  await page.route(`**${filesPrefix}/guides/preview.html`, async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    await route.fulfill({
      response,
      body: source.replace('</main>', '<p><a href="preview-target.html?source=fixture#changed-target">Open a changed HTML document with fragment</a></p></main>'),
    })
  })
  // Hold the bridge script so the click deliberately lands before the bridge is installed.
  let releaseBridge: (() => void) | undefined
  const bridgeHeld = new Promise<void>((resolve) => { releaseBridge = resolve })
  await page.route('**/preview-bridge.js', async (route) => {
    await bridgeHeld
    await route.continue().catch(() => undefined)
  })

  await page.goto('/sre')
  await page.goto(previewUrl)
  const frame = page.frameLocator('iframe[title="Local preview HTML"]')
  const link = frame.getByRole('link', { name: 'Open a changed HTML document with fragment' })
  await expect(link).toBeVisible()
  await expect(frame.locator('script[data-preview-reader-bridge="ready"]')).toHaveCount(0)
  await link.click()

  await expect(page).toHaveURL(`/sre/_previews/${previewHeadSha}/guides/preview-target.html?group=pr%3A42&source=fixture#changed-target`)
  await expect(page.locator('.preview-reader-header h1')).toHaveText('Preview fragment target')
  await expect(page.locator('.preview-reader-path')).toHaveText('guides/preview-target.html')
  await expect(page.frameLocator('iframe[title="Preview fragment target"]').getByRole('heading', { name: 'Changed HTML target' })).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(1)
  releaseBridge?.()

  // The frame's own early navigation must not leave a dead Back step: one Back is the previous document, the next leaves the preview.
  const targetUrl = `/sre/_previews/${previewHeadSha}/guides/preview-target.html?group=pr%3A42&source=fixture#changed-target`
  await page.goBack()
  await expect(page).toHaveURL(previewUrl)
  await expect(page.locator('.preview-reader-header h1')).toHaveText('Local preview HTML')
  await expect(page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open a changed HTML document with fragment' })).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(1)
  await page.goBack()
  await expect(page).toHaveURL('/sre')
  await page.goForward()
  await expect(page).toHaveURL(previewUrl)
  await expect(page.locator('.preview-reader-header h1')).toHaveText('Local preview HTML')
  await page.goForward()
  await expect(page).toHaveURL(targetUrl)
  await expect(page.locator('.preview-reader-header h1')).toHaveText('Preview fragment target')
  await expect(page.frameLocator('iframe[title="Preview fragment target"]').getByRole('heading', { name: 'Changed HTML target' })).toBeVisible()
})

test('preview HTML raw resources use native frame navigation and preserve download, target, and modifier intent', async ({ page }) => {
  const previewUrl = `/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`
  const filesPrefix = `/_previews/sre/revisions/${previewHeadSha}/files`
  await page.route(`**${filesPrefix}/guides/preview.html`, async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    await route.fulfill({
      response,
      body: source.replace('</main>', '<p><a href="/sre/reports/latency-retrospective.md">Open a logical document outside the preview files</a></p></main>'),
    })
  })
  await page.goto(previewUrl)
  const frame = page.frameLocator('iframe[title="Local preview HTML"]')
  const parentUrl = page.url()

  const svgResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'GET' && url.pathname === `${filesPrefix}/assets/mark.svg` && url.search === '?view=raw'
  }, { timeout: 5000 })
  await waitForPreviewBridge(page)
  await frame.getByRole('link', { name: 'Open the preview SVG resource' }).click()
  const svgResponse = await svgResponsePromise
  expect(svgResponse.status()).toBe(200)
  expect(svgResponse.headers()['content-type']).toContain('image/svg+xml')
  const rawSvgUrl = `${new URL(parentUrl).origin}${filesPrefix}/assets/mark.svg?view=raw#preview-mark`
  await expect.poll(() => page.frames().some((candidate) => candidate.url() === rawSvgUrl)).toBe(true)
  expect(page.url()).toBe(parentUrl)
  await expect(page.frameLocator('iframe[title="Local preview HTML"]').locator('svg')).toBeVisible()

  await page.goto(previewUrl)
  const pdfResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'GET' && url.pathname === `${filesPrefix}/assets/guide.pdf`
  })
  await waitForPreviewBridge(page)
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open the preview PDF resource' }).click()
  const pdfResponse = await pdfResponsePromise
  expect(pdfResponse.status()).toBe(200)
  expect(pdfResponse.headers()['content-type']).toContain('application/pdf')
  expect(pdfResponse.request().frame().parentFrame()).toBe(page.mainFrame())
  expect(page.url()).toBe(parentUrl)

  await page.goto(previewUrl)
  const downloadPromise = page.waitForEvent('download')
  await waitForPreviewBridge(page)
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Download the preview SVG resource' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('preview-mark.svg')
  expect(page.url()).toBe(parentUrl)
  await expect(page.getByRole('heading', { name: 'Local preview HTML' })).toBeVisible()

  await page.goto(previewUrl)
  const targetPopupPromise = page.waitForEvent('popup')
  await waitForPreviewBridge(page)
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open the preview SVG in a new tab' }).click()
  const targetPopup = await targetPopupPromise
  await expectTabLocation(targetPopup, `${filesPrefix}/assets/mark.svg`, '?target=tab')
  await expect(targetPopup.locator('svg')).toBeVisible()
  expect(page.url()).toBe(parentUrl)
  await targetPopup.close()

  await page.goto(previewUrl)
  await waitForPreviewBridge(page)
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open the preview SVG with a modifier' }).click({ modifiers: ['ControlOrMeta'] })
  const modifiedResourceUrl = `${new URL(parentUrl).origin}${filesPrefix}/assets/mark.svg?modifier=tab`
  await expect.poll(async () => {
    if (page.frames().some((candidate) => candidate.url() === modifiedResourceUrl)) return true
    for (const candidate of page.context().pages()) {
      if (candidate === page) continue
      // Read the location from inside the tab: its Playwright-side URL can be stale.
      const href = await candidate.evaluate(() => location.href).catch(() => undefined)
      if (href === modifiedResourceUrl) return true
    }
    return false
  }).toBe(true)
  expect(page.url()).toBe(parentUrl)

  await page.goto(previewUrl)
  await waitForPreviewBridge(page)
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open a logical document outside the preview files' }).click()
  await expect.poll(() => page.frames().some((candidate) => new URL(candidate.url()).pathname === '/sre/reports/latency-retrospective.md')).toBe(true)
  expect(page.url()).toBe(parentUrl)
})

test('preview HTML uses the actual app origin and survives direct reload on a non-loopback-equivalent hostname', async ({ page }) => {
  await page.goto('/sre')
  const appOrigin = new URL(page.url())
  appOrigin.hostname = 'preview-app.localhost'
  await page.route(`**/_previews/sre/revisions/${previewHeadSha}/files/guides/preview.html`, async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    await route.fulfill({
      response,
      body: source.replace('</main>', '<script type="module">import "./modules/entry.js";</script></main>'),
    })
  })
  const moduleResponses = Promise.all(['entry.js', 'dependency.js'].map((name) => page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname.endsWith(`/guides/modules/${name}`)
  })))
  await page.goto(`${appOrigin.origin}/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`)

  const iframe = page.locator('iframe[title="Local preview HTML"]')
  await expect(iframe).not.toHaveAttribute('sandbox', /.+/)
  await expect(iframe).toHaveAttribute('src', `/_previews/sre/revisions/${previewHeadSha}/files/guides/preview.html`)

  const frame = page.frameLocator('iframe[title="Local preview HTML"]')
  await expect(frame.getByRole('heading', { name: 'Local preview HTML' })).toBeVisible()
  await expect(frame.getByRole('img', { name: 'Blue preview mark' })).toBeVisible()
  expect((await moduleResponses).map((response) => response.status())).toEqual([200, 200])
  await expect.poll(() => frame.locator('body').getAttribute('data-static-module')).toBe('loaded')
  await expect.poll(() => frame.locator('html').getAttribute('data-preview-fixture')).toBe('loaded')
  expect(new URL(await iframe.getAttribute('src') ?? '', page.url()).origin).toBe(appOrigin.origin)

  await page.reload()
  await expect(page.locator('iframe[title="Local preview HTML"]')).toHaveAttribute('src', `/_previews/sre/revisions/${previewHeadSha}/files/guides/preview.html`)
  await expect(page.frameLocator('iframe[title="Local preview HTML"]').getByRole('heading', { name: 'Local preview HTML' })).toBeVisible()

  await waitForPreviewBridge(page)
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open the changed Markdown document' }).click()
  await expect(page).toHaveURL(`${appOrigin.origin}/sre/_previews/${previewHeadSha}/guides/preview-guide.md?group=pr%3A42`)
})

test('an unavailable preview HTML document is reported after its raw response', async ({ page }) => {
  const methods: string[] = []
  await page.route(`**/_previews/sre/revisions/${previewHeadSha}/files/guides/preview.html`, async (route) => {
    methods.push(route.request().method())
    await route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Preview document not found</h1>' })
  })

  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`)
  await expect(page.getByRole('alert')).toHaveText('This HTML preview document could not be loaded.')
  await expect(page.locator('iframe[title="Local preview HTML"]')).toHaveCount(0)
  expect(methods).toEqual(['GET', 'HEAD'])
})

test('a third-party opaque-origin sandbox cannot read local preview objects', async ({ page }) => {
  await page.goto('/sre')
  const appUrl = new URL(page.url())
  appUrl.hostname = 'attacker.localhost'
  await page.goto(appUrl.origin)
  const previewUrl = new URL(`/_previews/sre/revisions/${previewHeadSha}/files/guides/preview.html`, page.url())
  previewUrl.hostname = '127.0.0.1'

  const result = await page.evaluate((targetUrl) => new Promise<{ origin: string; readable: boolean }>((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    const timer = window.setTimeout(() => resolve({ origin: 'unknown', readable: true }), 5000)
    const onMessage = (event: MessageEvent<{ type?: unknown; origin?: unknown; readable?: unknown }>) => {
      if (event.source !== frame.contentWindow || event.data?.type !== 'opaque-preview-result') return
      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve({ origin: String(event.data.origin), readable: event.data.readable === true })
    }
    window.addEventListener('message', onMessage)
    frame.srcdoc = `<script>const frameOrigin = location.origin; fetch(${JSON.stringify(targetUrl)}).then(async (response) => { const body = await response.text(); parent.postMessage({ type: 'opaque-preview-result', origin: frameOrigin, readable: response.ok && body.includes('Local preview HTML') }, '*'); }).catch(() => parent.postMessage({ type: 'opaque-preview-result', origin: frameOrigin, readable: false }, '*'))</script>`
    document.body.append(frame)
  }), previewUrl)

  expect(result.origin).toBe('null')
  expect(result.readable).toBe(false)
})

test('a direct preview document resolves without catalog membership and suppresses stale PR context', async ({ page }) => {
  const catalogRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.endsWith('/_previews/sre/catalog.json')) catalogRequests.push(pathname)
  })
  await page.route('**/_previews/sre/catalog.json', (route) => route.fulfill({ status: 404, body: 'catalog unavailable' }))

  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview-guide.md`)
  await expect(page.locator('.preview-reader-header h1')).toHaveText('Local preview guide')
  await expect(page.getByRole('link', { name: /Return to PR/ })).toHaveCount(0)
  expect(catalogRequests).toEqual([])
  await page.reload()
  await expect(page.locator('.preview-reader-header h1')).toHaveText('Local preview guide')
  expect(catalogRequests).toEqual([])

  const missingManifest = await page.request.get('/_previews/sre/revisions/ffffffffffffffffffffffffffffffffffffffff/manifest.json')
  expect(missingManifest.status()).toBe(404)
  await page.goto('/sre/_previews/ffffffffffffffffffffffffffffffffffffffff/guides/missing.md')
  await expect(page.getByRole('heading', { name: 'Preview unavailable' })).toBeVisible()
  await page.getByRole('link', { name: '← Back to previews' }).click()
  await expect(page).toHaveURL('/sre/_previews')
})

test('a preview-manifest read error stays visible as unknown availability', async ({ page }) => {
  await page.route(`**/_previews/sre/revisions/${previewHeadSha}/manifest.json`, (route) => (
    route.fulfill({ status: 503, body: 'temporarily unavailable' })
  ))
  await page.goto('/sre/_previews')
  await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
  await expect(page.getByText('Availability could not be checked. Direct document links may still work.')).toHaveCount(3)
  await expect(page.getByRole('region', { name: 'Preview pr:99' })).toHaveCount(0)
})

test('raw preview resources have real 404s, media types, no-store and no CORS access', async ({ page }) => {
  const base = `/_previews/sre/revisions/${previewHeadSha}/files`
  const [catalog, manifest, missingRoot, missingSlash, missing, malformedHtml, css, script, svg, pdf, font, markdown, html, nullOrigin, externalOrigin] = await Promise.all([
    page.request.get('/_previews/sre/catalog.json'),
    page.request.get(`/_previews/sre/revisions/${previewHeadSha}/manifest.json`),
    page.request.get('/_previews'),
    page.request.get('/_previews/'),
    page.request.get(`${base}/missing.css`),
    page.request.get('/_previews/sre/unversioned/guides/preview.html'),
    page.request.get(`${base}/assets/preview.css`),
    page.request.get(`${base}/assets/preview.js`),
    page.request.get(`${base}/assets/mark.svg`),
    page.request.get(`${base}/assets/guide.pdf`),
    page.request.get(`${base}/fonts/preview.woff2`),
    page.request.get(`${base}/guides/preview-guide.md`),
    page.request.get(`${base}/guides/preview.html`),
    page.request.get(`${base}/fonts/preview.woff2`, { headers: { origin: 'null' } }),
    page.request.get(`${base}/fonts/preview.woff2`, { headers: { origin: 'https://attacker.example' } }),
  ])

  expect(catalog.status()).toBe(200)
  expect(catalog.headers()['content-type']).toContain('application/json')
  expect(manifest.status()).toBe(200)
  expect(manifest.headers()['content-type']).toContain('application/json')
  expect(missingRoot.status()).toBe(404)
  expect(missingSlash.status()).toBe(404)
  expect((await missingRoot.text()).toLowerCase()).not.toContain('<div id="root">')
  expect((await missingSlash.text()).toLowerCase()).not.toContain('<div id="root">')
  expect(missing.status()).toBe(404)
  expect((await missing.text()).toLowerCase()).not.toContain('<div id="root">')
  expect(malformedHtml.status()).toBe(404)
  expect(malformedHtml.headers()['content-security-policy']).toContain("script-src 'none'")
  expect(css.headers()['content-type']).toContain('text/css')
  expect(script.headers()['content-type']).toContain('javascript')
  expect(svg.headers()['content-type']).toContain('image/svg+xml')
  expect(pdf.headers()['content-type']).toContain('application/pdf')
  expect(font.headers()['content-type']).toContain('font/woff2')
  expect(markdown.headers()['content-type']).toContain('text/markdown')
  expect(html.headers()['content-type']).toContain('text/html')
  expect(html.headers()['cache-control']).toContain('no-store')
  for (const response of [catalog, manifest, css, script, svg, pdf, font, markdown, html]) {
    expect(response.headers()['cache-control']).toContain('no-store')
  }
  const htmlCsp = html.headers()['content-security-policy']
  expect(htmlCsp).toContain('script-src')
  expect(htmlCsp).toContain('https:')
  expect(htmlCsp).not.toContain("script-src 'none'")
  expect(htmlCsp).not.toContain("connect-src 'none'")
  expect(htmlCsp).not.toContain('sandbox')
  expect(markdown.headers()['content-security-policy']).toContain("script-src 'none'")
  for (const response of [svg, pdf]) {
    expect(response.headers()['content-security-policy']).toContain("script-src 'none'")
    expect(response.headers()['x-content-type-options']).toBe('nosniff')
  }
  expect(html.headers()['x-content-type-options']).toBe('nosniff')
  expect(nullOrigin.headers()['access-control-allow-origin']).toBeUndefined()
  expect(nullOrigin.headers()['vary']).toBeUndefined()
  expect(externalOrigin.headers()['access-control-allow-origin']).toBeUndefined()
  expect(externalOrigin.headers()['vary']).toBeUndefined()
})

test('artifact CSP uses the HTTPS site prefix and keeps insecure external resources blocked', async ({ page }) => {
  const browser = page.context().browser()
  expect(browser).not.toBeNull()
  const context = await browser!.newContext({ ignoreHTTPSErrors: true })
  const httpsPage = await context.newPage()
  const artifactURL = 'https://csp-artifact.test/_artifacts/sre/index.html'
  const sitePrefix = new URL('.', artifactURL).toString()
  const csp = [
    `default-src ${sitePrefix} https: data: blob:`,
    `script-src ${sitePrefix} https: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:`,
    `style-src ${sitePrefix} https: 'unsafe-inline' data: blob:`,
  ].join('; ')
  const siteAssetPaths: string[] = []
  const externalHttpsPaths: string[] = []
  let insecureRequestReachedRoute = false

  await httpsPage.route('https://csp-artifact.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    siteAssetPaths.push(pathname)
    if (pathname === '/_artifacts/sre/index.html') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'content-security-policy': csp },
        body: `<!doctype html><html><head><link rel="stylesheet" href="./relative.css"></head><body>
          <script>document.body.dataset.inlineScript = 'loaded'</script>
          <script src="./relative.js"></script>
          <script src="https://external-artifact.test/probe.js"></script>
          <script>
            fetch('https://external-artifact.test/data.json').then((response) => response.json())
              .then((data) => { document.body.dataset.httpsFetch = data.result })
              .catch(() => { document.body.dataset.httpsFetch = 'failed' });
            fetch('http://insecure-artifact.test/data.json').then(() => {
              document.body.dataset.httpFetch = 'loaded'
            }).catch(() => { document.body.dataset.httpFetch = 'blocked' });
          </script>
        </body></html>`,
      })
    } else if (pathname === '/_artifacts/sre/relative.css') {
      await route.fulfill({ status: 200, contentType: 'text/css', body: 'body { --relative-site-css: loaded; }' })
    } else if (pathname === '/_artifacts/sre/relative.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: "document.body.dataset.relativeScript = 'loaded';" })
    } else {
      await route.fulfill({ status: 404 })
    }
  })
  await httpsPage.route('https://external-artifact.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    externalHttpsPaths.push(pathname)
    if (pathname === '/probe.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: "document.body.dataset.externalScript = 'loaded';" })
    } else if (pathname === '/data.json') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ result: 'allowed' }),
      })
    } else {
      await route.fulfill({ status: 404 })
    }
  })
  await httpsPage.route('http://insecure-artifact.test/**', async (route) => {
    insecureRequestReachedRoute = true
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  try {
    const response = await httpsPage.goto(artifactURL)
    expect(response?.status()).toBe(200)
    expect(response?.headers()['content-security-policy']).toBe(csp)
    await expect(httpsPage.locator('body')).toHaveAttribute('data-inline-script', 'loaded')
    await expect(httpsPage.locator('body')).toHaveAttribute('data-relative-script', 'loaded')
    await expect(httpsPage.locator('body')).toHaveAttribute('data-external-script', 'loaded')
    await expect.poll(() => httpsPage.locator('body').getAttribute('data-https-fetch')).toBe('allowed')
    await expect.poll(() => httpsPage.locator('body').getAttribute('data-http-fetch')).toBe('blocked')
    expect(await httpsPage.locator('body').evaluate((body) => getComputedStyle(body).getPropertyValue('--relative-site-css').trim())).toBe('loaded')
    expect(siteAssetPaths).toContain('/_artifacts/sre/relative.css')
    expect(siteAssetPaths).toContain('/_artifacts/sre/relative.js')
    expect(siteAssetPaths.every((pathname) => pathname.startsWith('/_artifacts/sre/'))).toBeTruthy()
    expect(externalHttpsPaths.sort()).toEqual(['/data.json', '/probe.js'])
    expect(insecureRequestReachedRoute).toBeFalsy()
  } finally {
    await context.close()
  }
})

test('artifact CSP blocks off-site HTTP requests when an artifact is served over HTTP', async ({ page }) => {
  const browser = page.context().browser()
  expect(browser).not.toBeNull()
  const context = await browser!.newContext()
  const httpPage = await context.newPage()
  const artifactURL = 'http://csp-artifact.test/_artifacts/sre/index.html'
  const sitePrefix = new URL('.', artifactURL).toString()
  const csp = [
    `default-src ${sitePrefix} https: data: blob:`,
    `script-src ${sitePrefix} https: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:`,
    `style-src ${sitePrefix} https: 'unsafe-inline' data: blob:`,
  ].join('; ')
  let insecureRequestReachedRoute = false

  await httpPage.route('http://csp-artifact.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/_artifacts/sre/index.html') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'content-security-policy': csp },
        body: `<!doctype html><html><body>
          <script src="./relative.js"></script>
          <script>
            fetch('http://insecure-artifact.test/data.json').then(() => {
              document.body.dataset.httpFetch = 'loaded'
            }).catch(() => { document.body.dataset.httpFetch = 'blocked' });
          </script>
        </body></html>`,
      })
    } else if (pathname === '/_artifacts/sre/relative.js') {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: "document.body.dataset.relativeScript = 'loaded';",
      })
    } else {
      await route.fulfill({ status: 404 })
    }
  })
  await httpPage.route('http://insecure-artifact.test/**', async (route) => {
    insecureRequestReachedRoute = true
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  try {
    const response = await httpPage.goto(artifactURL)
    expect(response?.status()).toBe(200)
    expect(response?.headers()['content-security-policy']).toBe(csp)
    expect(csp).toContain(`default-src ${sitePrefix} https:`)
    expect(csp).not.toContain('http://insecure-artifact.test')
    await expect(httpPage.locator('body')).toHaveAttribute('data-relative-script', 'loaded')
    await expect.poll(() => httpPage.locator('body').getAttribute('data-http-fetch')).toBe('blocked')
    expect(insecureRequestReachedRoute).toBeFalsy()
  } finally {
    await context.close()
  }
})

// Page text search runs against the generated `textsearch` projection (scripts/prepare-e2e-storage.mjs):
// the SRE fixture pages, 24 bulk notes that all contain "lighthouse", and two long scroll-target pages.
// A custom STORAGE_ROOT must be produced by that script for these tests to run.
test.describe('page text search', () => {
  const field = (page: Page) => page.getByRole('searchbox', { name: 'Search page text in Text Search' })
  const sidebar = (page: Page) => page.locator('.sidebar-panel')
  const status = (page: Page) => page.locator('#page-text-search-status')
  const hits = (page: Page) => page.locator('.page-text-result-list [data-text-search-item="hit"]')

  function recordSearchRequests(page: Page) {
    const requests: string[] = []
    page.on('request', (request) => {
      if (isSearchDataRequest(request.url())) requests.push(new URL(request.url()).pathname)
    })
    return requests
  }

  async function pressImeEnter(page: Page, variant: 'isComposing' | 'keyCode229') {
    await field(page).evaluate((input, kind) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: kind === 'isComposing' })
      if (kind === 'keyCode229') Object.defineProperty(event, 'keyCode', { value: 229 })
      input.dispatchEvent(event)
    }, variant)
  }

  /** Records the page text search status and alerts on every DOM change from now on. */
  async function startStatusRecorder(page: Page) {
    await page.evaluate(() => {
      const records: string[] = []
      const snapshot = () => {
        const label = document.querySelector('#page-text-search-status')?.textContent ?? ''
        const alert = document.querySelector('.sidebar-panel [role="alert"]')?.textContent
        const entry = alert ? `alert: ${alert}` : `status: ${label}`
        if (records[records.length - 1] !== entry) records.push(entry)
      }
      const observer = new MutationObserver(snapshot)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      ;(window as unknown as { __statusRecords: string[] }).__statusRecords = records
    })
  }

  /** Records from the moment the newer query started loading. */
  async function statusRecordsSinceLoading(page: Page) {
    const records = await page.evaluate(() => (window as unknown as { __statusRecords: string[] }).__statusRecords)
    const loading = records.indexOf('status: Searching 32 pages…')
    expect(loading, JSON.stringify(records)).toBeGreaterThanOrEqual(0)
    return records.slice(loading)
  }

  test.beforeEach(async ({ page }) => {
    const metadata = await page.request.get(`/_indexes/${TEXT_SEARCH_SITE.id}/meta.json`)
    test.skip(
      !metadata.ok(),
      `/_indexes/${TEXT_SEARCH_SITE.id}/meta.json is not served (HTTP ${metadata.status()}). Page text search tests need the storage root built by scripts/prepare-e2e-storage.mjs; a custom STORAGE_ROOT must be produced by it.`,
    )
    await registerTextSearchSite(page)
  })

  test('the site picker marks sites with page text search', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: /Text Search/ }).locator('.site-picker-badge')).toHaveText('Page text search')
    await expect(page.getByRole('link', { name: /SRE/ }).locator('.site-picker-badge')).toHaveCount(0)
    await expect(page.locator('.site-picker-badge')).toHaveCount(1)
  })

  test('search data is fetched only after Enter, never while typing or confirming IME input', async ({ page }) => {
    const requests = recordSearchRequests(page)
    await page.goto('/textsearch')
    await expect(page.getByRole('heading', { name: 'Text Search', exact: true })).toBeVisible()
    await expect(sidebar(page).getByRole('button', { name: 'Jump to a page in Text Search' })).toHaveCount(0)

    await field(page).focus()
    await field(page).pressSequentially('latency')
    await expect(field(page)).toHaveValue('latency')
    // Typing does nothing: Browse stays, no results, no URL change, no search data.
    await expect(sidebar(page).locator('.browse-tree')).toBeVisible()
    await expect(page.locator('.page-text-results')).toHaveCount(0)
    await pressImeEnter(page, 'isComposing')
    await pressImeEnter(page, 'keyCode229')
    await expect(sidebar(page).locator('.browse-tree')).toBeVisible()
    await expect(page).toHaveURL(/\/textsearch$/)
    expect(requests).toEqual([])

    await field(page).press('Enter')
    await expect(page).toHaveURL(/\/textsearch\?q=latency$/)
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    expect(requests[0]).toBe('/_indexes/textsearch/search/manifest.json')
    expect(requests.every((pathname) => pathname.startsWith('/_indexes/textsearch/search/'))).toBe(true)

    // Editing after a search dims the previous results until Enter; it fetches nothing.
    const committedRequestCount = requests.length
    await field(page).fill('lighthouse')
    // The hint is shown, but the live status keeps describing the committed results.
    await expect(page.locator('.page-text-search-pending')).toHaveText('Press Enter to search “lighthouse”')
    await expect(page.locator('.page-text-search-pending')).not.toHaveAttribute('role')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await expect(page.locator('.page-text-result-list')).toHaveClass(/is-stale/)
    await expect(hits(page)).toHaveCount(5)
    expect(requests).toHaveLength(committedRequestCount)
    await field(page).press('Enter')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    await expect(page.locator('.page-text-result-list')).not.toHaveClass(/is-stale/)
    await expect(page.locator('.page-text-search-pending')).toHaveCount(0)
  })

  test('Enter on the committed query adds no history entry and a new query keeps the fragment', async ({ page }) => {
    const requests = recordSearchRequests(page)
    await page.goto('/textsearch?q=latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    const historyLength = await page.evaluate(() => history.length)
    const requestCount = requests.length
    await field(page).press('Enter')
    await field(page).press('Enter')
    await expect(page).toHaveURL(/\/textsearch\?q=latency$/)
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
    expect(requests).toHaveLength(requestCount)

    // After a failure, Enter on the same query retries.
    let failing = true
    await page.route('**/_indexes/textsearch/search/manifest.json', (route) => failing
      ? route.fulfill({ status: 503, body: 'unavailable' })
      : route.continue())
    await page.goto('/textsearch?q=representative')
    await expect(sidebar(page).getByRole('alert')).toContainText('Search data could not be loaded')
    failing = false
    const retryHistoryLength = await page.evaluate(() => history.length)
    await field(page).press('Enter')
    await expect(status(page)).toHaveText('1 page contains “representative”')
    expect(await page.evaluate(() => history.length)).toBe(retryHistoryLength)

    await page.goto('/textsearch/long/scroll-target.md#middle-section')
    await expect(page.getByRole('heading', { name: 'Middle section' })).toBeInViewport()
    await field(page).fill('zephyrmarker')
    await field(page).press('Enter')
    await expect(page).toHaveURL(/\/textsearch\/long\/scroll-target\.md\?q=zephyrmarker#middle-section$/)
    await expect(status(page)).toHaveText('2 pages contain “zephyrmarker”')
  })

  test('clearing a draft that was never searched leaves the URL and history alone', async ({ page }) => {
    const requests = recordSearchRequests(page)
    await page.goto('/textsearch')
    await expect(page.getByRole('heading', { name: 'Text Search', exact: true })).toBeVisible()
    const historyLength = await page.evaluate(() => history.length)

    await field(page).fill('draft')
    await field(page).press('Escape')
    await expect(field(page)).toHaveValue('')
    await field(page).fill('draft')
    await sidebar(page).getByRole('button', { name: 'Clear page text search' }).click()
    await expect(field(page)).toHaveValue('')
    // The clear button removes itself; focus stays in the search field.
    await expect(field(page)).toBeFocused()
    await field(page).fill('   ')
    await field(page).press('Enter')
    await expect(field(page)).toHaveValue('')

    await expect(page).toHaveURL(/\/textsearch$/)
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
    expect(requests).toEqual([])
  })

  test('"Back to site" on a missing page keeps the committed query', async ({ page }) => {
    await page.goto('/textsearch/no-such-page.md?q=latency')
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await page.getByRole('button', { name: 'Back to site' }).click()
    await expect(page).toHaveURL(/\/textsearch\?q=latency$/)
    await expect(status(page)).toHaveText('5 pages contain “latency”')
  })

  test('results group by folder, open from the keyboard, and persist through navigation and history', async ({ page }) => {
    await page.goto('/textsearch?q=latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await expect(field(page)).toHaveValue('latency')
    // Results replace Pinned and Browse, in path order.
    await expect(sidebar(page).locator('.browse-tree')).toHaveCount(0)
    await expect(page.locator('.page-text-result-folder-name')).toHaveText([
      'diagrams/', 'guides/', 'incidents/checkout-latency/', 'reports/', 'runbooks/',
    ])
    await expect(hits(page)).toHaveCount(5)
    await expect(hits(page).first()).toHaveAttribute('data-hit-id', 'diagrams/mermaid-catalog.md')
    await expect(sidebar(page).getByRole('region', { name: '5 pages contain “latency”' })).toBeVisible()

    await field(page).focus()
    await page.keyboard.press('ArrowDown')
    await expect(hits(page).first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('.page-text-result-folder', { hasText: 'guides/' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    const guidesHit = page.locator('[data-hit-id="guides/markdown-style-gallery.md"]')
    await expect(guidesHit).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/textsearch\/guides\/markdown-style-gallery\.md\?q=latency$/)
    await expect(guidesHit).toBeFocused()
    await expect(guidesHit).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.page-text-results-title .mono')).toHaveText('2 / 5')
    await page.keyboard.press('End')
    await expect(page.locator('[data-hit-id="runbooks/service-recovery.md"]')).toBeFocused()
    await page.keyboard.press('Home')
    await expect(page.locator('.page-text-result-folder', { hasText: 'diagrams/' })).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(field(page)).toBeFocused()

    // Other in-site navigation keeps the query.
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' }).fill('Platform topology')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/textsearch\/architecture\/platform-topology\/index\.html\?q=latency$/)
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await expect(page.locator('.page-text-results-title .mono')).toHaveText('5')

    // Clearing restores Pinned and Browse; history restores the search.
    await field(page).press('Escape')
    await expect(page).toHaveURL(/\/textsearch\/architecture\/platform-topology\/index\.html$/)
    await expect(field(page)).toHaveValue('')
    await expect(page.locator('.page-text-results')).toHaveCount(0)
    await expect(sidebar(page).locator('.browse-tree')).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(/\?q=latency$/)
    await expect(field(page)).toHaveValue('latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await page.goBack()
    await expect(page).toHaveURL(/\/textsearch\/guides\/markdown-style-gallery\.md\?q=latency$/)
    await expect(page.locator('.page-text-results-title .mono')).toHaveText('2 / 5')
    await page.goForward()
    await page.goForward()
    await expect(page).toHaveURL(/\/textsearch\/architecture\/platform-topology\/index\.html$/)
    await expect(sidebar(page).locator('.browse-tree')).toBeVisible()

    await page.goBack()
    await sidebar(page).getByRole('button', { name: 'Clear page text search' }).click()
    await expect(page).toHaveURL(/\/textsearch\/architecture\/platform-topology\/index\.html$/)
    await expect(sidebar(page).locator('.browse-tree')).toBeVisible()
    await expect(field(page)).toBeFocused()
  })

  test('a superseded query cannot overwrite the newer results', async ({ page }) => {
    // Warm the manifest and root so the next searches differ only in the leaves they need.
    await page.goto('/textsearch?q=representative')
    await expect(status(page)).toHaveText('1 page contains “representative”')

    const held: Array<() => Promise<void>> = []
    const heldUrls: string[] = []
    let holding = true
    await page.route('**/_indexes/textsearch/search/leaf-*', async (route) => {
      if (!holding) return route.continue()
      heldUrls.push(route.request().url())
      await new Promise<void>((resolve) => held.push(async () => { await route.continue(); resolve() }))
    })

    await field(page).fill('latency')
    await field(page).press('Enter')
    await expect(status(page)).toHaveText('Searching 32 pages…')
    await expect.poll(() => held.length).toBeGreaterThan(0)
    holding = false
    await field(page).fill('lighthouse')
    await expect(page.locator('.page-text-search-pending')).toBeVisible()
    // From the newer commit on, nothing about the older query may ever render:
    // the abort that supersedes it must not surface as an error or a result.
    await startStatusRecorder(page)
    await field(page).press('Enter')
    await expect(page).toHaveURL(/\?q=lighthouse$/)
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')

    // Releasing the older query's data must not replace the current results.
    const heldResponses = Promise.all(heldUrls.map((url) => page.waitForResponse(url)))
    await Promise.all(held.map((release) => release()))
    await heldResponses
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)))
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    await expect(hits(page)).toHaveCount(20)
    await expect(field(page)).toHaveValue('lighthouse')
    const records = await statusRecordsSinceLoading(page)
    expect(records.filter((entry) => entry.startsWith('alert:') || entry.includes('latency'))).toEqual([])
    expect(records.at(-1)).toBe('status: 24 pages contain “lighthouse”')
  })

  test('a new query supersedes a pending "Show more" page', async ({ page }) => {
    // Search data is cached for a minute; moving the clock forward makes the
    // next page reload the search data, whose leaves are held to keep "Show more" pending.
    const start = new Date('2026-10-02T00:00:00Z')
    await page.clock.setFixedTime(start)
    await page.goto('/textsearch?q=lighthouse')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')

    const held = new Map<string, () => Promise<void>>()
    const releasedUrls = new Set<string>()
    await page.route('**/_indexes/textsearch/search/leaf-*', async (route) => {
      const url = route.request().url()
      if (releasedUrls.has(url)) return route.continue()
      await new Promise<void>((resolve) => held.set(url, async () => { await route.continue(); resolve() }))
    })
    const release = async (urls: string[]) => {
      for (const url of urls) releasedUrls.add(url)
      await Promise.all(urls.map((url) => held.get(url)?.()))
    }
    await page.clock.setFixedTime(new Date(start.getTime() + 61_000))
    const more = page.locator('.page-text-result-more')
    await more.click()
    await expect(more).toHaveAttribute('aria-disabled', 'true')
    await expect.poll(() => held.size).toBeGreaterThan(0)
    const olderLeaves = [...held.keys()]

    await field(page).fill('latency')
    await expect(page.locator('.page-text-search-pending')).toBeVisible()
    await startStatusRecorder(page)
    await field(page).press('Enter')
    await expect(status(page)).toHaveText('Searching 32 pages…')
    // The newer query finishes first; only then does the older page arrive.
    await expect.poll(() => [...held.keys()].filter((url) => !olderLeaves.includes(url)).length).toBeGreaterThan(0)
    await release([...held.keys()].filter((url) => !olderLeaves.includes(url)))
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await release(olderLeaves)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)))
    await expect(hits(page)).toHaveCount(5)
    await expect(more).toHaveCount(0)
    const records = await statusRecordsSinceLoading(page)
    expect(records.filter((entry) => entry.startsWith('alert:') || entry.includes('lighthouse'))).toEqual([])
  })

  test('results page twenty at a time, and zero results explain the AND rule', async ({ page }) => {
    await page.goto('/textsearch?q=lighthouse')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    await expect(hits(page)).toHaveCount(20)
    const more = page.getByRole('button', { name: 'Show 4 more (20 of 24 shown)' })
    // From the keyboard, focus moves to the first newly listed result.
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(hits(page)).toHaveCount(24)
    await expect(more).toHaveCount(0)
    await expect(hits(page).last()).toHaveAttribute('data-hit-id', 'bulk/note-24.md')
    await expect(page.locator('[data-hit-id="bulk/note-21.md"]')).toBeFocused()

    await field(page).fill('latency lighthouse')
    await field(page).press('Enter')
    await expect(status(page)).toHaveText('0 pages contain “latency lighthouse”')
    await expect(page.getByText('No pages contain these words')).toBeVisible()
    await expect(page.getByText('Only pages that contain every word are listed. Try fewer words.')).toBeVisible()

    await field(page).fill('zzzqqq')
    await field(page).press('Enter')
    await expect(page.getByText('Check the spelling or try a different word.')).toBeVisible()
  })

  test('"Show more" expands a collapsed folder to focus the first new result', async ({ page }) => {
    await page.goto('/textsearch?q=lighthouse')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    const bulk = page.locator('[data-text-search-item="group"][data-folder="bulk"]')
    await bulk.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(bulk).toHaveAttribute('aria-expanded', 'false')
    await expect(hits(page).and(page.locator('[data-folder="bulk"]'))).toHaveCount(0)
    await page.keyboard.press('End')
    const more = page.getByRole('button', { name: 'Show 4 more (20 of 24 shown)' })
    await expect(more).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(more).toHaveCount(0)
    await expect(bulk).toHaveAttribute('aria-expanded', 'true')
    await expect(hits(page)).toHaveCount(24)
    await expect(page.locator('[data-hit-id="bulk/note-21.md"]')).toBeFocused()
  })

  test('"Show more" leaves focus where the reader moved it while the page loaded', async ({ page }) => {
    // As in the "Show more" race test: an expired cache makes the next page reload, and its leaves are held.
    const start = new Date('2026-10-02T00:00:00Z')
    await page.clock.setFixedTime(start)
    await page.goto('/textsearch?q=lighthouse')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    const held: Array<() => Promise<void>> = []
    let holding = true
    await page.route('**/_indexes/textsearch/search/leaf-*', async (route) => {
      if (!holding) return route.continue()
      await new Promise<void>((resolve) => held.push(async () => { await route.continue(); resolve() }))
    })
    await page.clock.setFixedTime(new Date(start.getTime() + 61_000))
    const more = page.getByRole('button', { name: 'Show 4 more (20 of 24 shown)' })
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.page-text-result-more')).toHaveAttribute('aria-disabled', 'true')
    await expect.poll(() => held.length).toBeGreaterThan(0)

    const firstHit = page.locator('[data-hit-id="bulk/note-01.md"]')
    await firstHit.focus()
    holding = false
    await Promise.all(held.map((release) => release()))
    await expect(hits(page)).toHaveCount(24)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
    await expect(firstHit).toBeFocused()
  })

  test('"Show more" leaves focus on the page when the reader clicks article text while it loads', async ({ page }) => {
    const start = new Date('2026-10-02T00:00:00Z')
    await page.clock.setFixedTime(start)
    await page.goto('/textsearch/long/scroll-target.md?q=lighthouse')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    const reader = page.getByTestId('markdown-document')
    await expect(reader.locator('h1')).toBeVisible()
    const held: Array<() => Promise<void>> = []
    let holding = true
    await page.route('**/_indexes/textsearch/search/leaf-*', async (route) => {
      if (!holding) return route.continue()
      await new Promise<void>((resolve) => held.push(async () => { await route.continue(); resolve() }))
    })
    await page.clock.setFixedTime(new Date(start.getTime() + 61_000))
    const more = page.getByRole('button', { name: 'Show 4 more (20 of 24 shown)' })
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.page-text-result-more')).toHaveAttribute('aria-disabled', 'true')
    await expect.poll(() => held.length).toBeGreaterThan(0)

    // Clicking plain text moves focus to the page (the focusable main region, else <body>), which must not read as "the button was removed".
    const focusIsOnPage = () => page.evaluate(() => (
      document.activeElement === document.body || document.activeElement?.classList.contains('stage') === true
    ))
    await reader.locator('article p').first().click()
    await expect.poll(focusIsOnPage).toBe(true)
    holding = false
    await Promise.all(held.map((release) => release()))
    await expect(hits(page)).toHaveCount(24)
    await expect(page.locator('.page-text-result-more')).toHaveCount(0)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
    await expect(page.locator('[data-hit-id="bulk/note-21.md"]')).not.toBeFocused()
    expect(await focusIsOnPage()).toBe(true)
  })

  test('a "Show more" failure is announced and can be retried', async ({ page }) => {
    const start = new Date('2026-10-02T00:00:00Z')
    await page.clock.setFixedTime(start)
    await page.goto('/textsearch?q=lighthouse')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    let failing = true
    await page.route('**/_indexes/textsearch/search/leaf-*', (route) => failing
      ? route.fulfill({ status: 503, body: 'temporarily unavailable' })
      : route.continue())
    await page.clock.setFixedTime(new Date(start.getTime() + 61_000))
    const live = sidebar(page).locator('.page-text-result-list [role="status"]')
    await expect(live).toHaveText('')
    await page.getByRole('button', { name: 'Show 4 more (20 of 24 shown)' }).click()
    await expect(page.locator('.page-text-result-more')).toHaveText('Could not load more. Try again')
    await expect(live).toHaveText('Could not load more results.')
    await expect(hits(page)).toHaveCount(20)

    failing = false
    await page.locator('.page-text-result-more').click()
    await expect(hits(page)).toHaveCount(24)
    await expect(live).toHaveText('')
  })

  test('"Show more" after a republish lists the new generation from the start', async ({ page }) => {
    // The site is republished (two more "lighthouse" notes sort first) between
    // the first and second result pages; the next page must not be appended to
    // offsets of the old generation.
    const start = new Date('2026-10-02T00:00:00Z')
    await page.clock.setFixedTime(start)
    await page.goto('/textsearch?q=lighthouse')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    await expect(hits(page)).toHaveCount(20)
    await expect(hits(page).first()).toHaveAttribute('data-hit-id', 'bulk/note-01.md')

    await page.route('**/_indexes/textsearch/search/manifest.json', async (route) => {
      const next = route.request().url().replace(/manifest\.json$/, 'manifest-next-generation.json')
      await route.fulfill({ response: await route.fetch({ url: next }) })
    })
    // Search data is cached for a minute; afterwards the client revalidates the manifest.
    await page.clock.setFixedTime(new Date(start.getTime() + 61_000))
    const more = page.getByRole('button', { name: 'Show 4 more (20 of 24 shown)' })
    await more.focus()
    await page.keyboard.press('Enter')

    await expect(status(page)).toHaveText('26 pages contain “lighthouse”')
    await expect(hits(page)).toHaveCount(26)
    const ids = await hits(page).evaluateAll((elements) => elements.map((element) => element.getAttribute('data-hit-id')))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.slice(0, 3)).toEqual(['bulk/note-00a.md', 'bulk/note-00b.md', 'bulk/note-01.md'])
    expect(ids.at(-1)).toBe('bulk/note-24.md')
    await expect(page.locator('.page-text-result-more')).toHaveCount(0)
    // Focus moves from the removed button to the result at the old list length.
    await expect(page.locator('[data-hit-id="bulk/note-19.md"]')).toBeFocused()
  })

  test('network and invalid-data failures are distinguished and can be retried', async ({ page }) => {
    let manifestState: 'unavailable' | 'invalid' | 'ok' = 'unavailable'
    await page.route('**/_indexes/textsearch/search/manifest.json', async (route) => {
      if (manifestState === 'unavailable') return route.fulfill({ status: 503, body: 'temporarily unavailable' })
      if (manifestState === 'invalid') {
        const response = await route.fetch()
        return route.fulfill({ response, json: { ...(await response.json()), generation: 'not-a-digest' } })
      }
      return route.continue()
    })

    await page.goto('/textsearch?q=latency')
    const alert = sidebar(page).getByRole('alert')
    await expect(alert).toContainText('Search data could not be loaded')
    await expect(alert).toContainText('The server returned HTTP 503.')

    manifestState = 'invalid'
    await alert.getByRole('button', { name: 'Try again' }).click()
    await expect(alert).toContainText('Search data could not be read')
    // "Try again" was removed while the query reloaded; focus is in the search field.
    await expect(field(page)).toBeFocused()

    manifestState = 'ok'
    await field(page).press('Enter')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await expect(alert).toHaveCount(0)
  })

  test('a decoder chunk that fails to load is a retryable network failure', async ({ page }) => {
    let failing = true
    await page.route('**/assets/fulltext-codec-*.js', (route) => failing
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.continue())
    await page.goto('/textsearch?q=latency')
    const alert = sidebar(page).getByRole('alert')
    await expect(alert).toContainText('Search data could not be loaded')
    await expect(alert).toContainText('If trying again does not help, reload the page.')
    await expect(alert).not.toContainText('This query could not be searched')
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
    // Chromium keeps a failed module import failed for the page's lifetime, so
    // recovery is checked after a reload rather than through "Try again".
    failing = false
    await page.reload()
    await expect(status(page)).toHaveText('5 pages contain “latency”')
  })

  test('a query over the length limit is reported as a query problem, not a data problem', async ({ page }) => {
    const requests = recordSearchRequests(page)
    await page.goto(`/textsearch?q=${'a'.repeat(4097)}`)
    const alert = sidebar(page).getByRole('alert')
    await expect(alert).toContainText('This query is too long')
    await expect(alert).toContainText('Shorten it to 4,096 characters or fewer.')
    await expect(alert).not.toContainText('Search data')
    await expect(alert.getByRole('button', { name: 'Try again' })).toHaveCount(0)
    expect(requests).toEqual([])
  })

  test('each newly committed query scrolls to its first match unless the URL has a fragment', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    // HTML: loading with a query scrolls to the match.
    await page.goto('/textsearch/long/scroll-target.html?q=zephyrmarker')
    const frame = page.frameLocator('iframe.artifact-frame')
    await expect(frame.getByText('The zephyrmarker word is at the end.')).toBeInViewport()

    // A new query on the open page scrolls to its first match.
    await field(page).fill('midmarker')
    await field(page).press('Enter')
    await expect(frame.getByText('The midmarker word is here.')).toBeInViewport()
    await expect(frame.getByText('The zephyrmarker word is at the end.')).not.toBeInViewport()

    // Re-applying the same query after DOM changes does not scroll again.
    await frame.locator('h1').evaluate((heading) => heading.scrollIntoView())
    await frame.locator('body').evaluate((body) => body.append(Object.assign(body.ownerDocument.createElement('p'), { textContent: 'late content' })))
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
    await expect(frame.locator('h1')).toBeInViewport()
    await expect(frame.getByText('The midmarker word is here.')).not.toBeInViewport()

    // A fragment wins on load and over a newly committed query.
    await page.goto('/textsearch/long/scroll-target.html?q=zephyrmarker#middle-section')
    await expect(frame.getByRole('heading', { name: 'Middle section' })).toBeInViewport()
    await expect.poll(() => frame.locator('body').evaluate(() => (
      (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('gap-page-text-search')?.size ?? 0
    ))).toBe(1)
    await expect(frame.getByText('The zephyrmarker word is at the end.')).not.toBeInViewport()

    // Markdown: the same rules.
    await page.goto('/textsearch/long/scroll-target.md?q=zephyrmarker')
    const reader = page.getByTestId('markdown-document')
    await expect(reader.getByText('The zephyrmarker word is at the end.')).toBeInViewport()
    await field(page).fill('midmarker')
    await field(page).press('Enter')
    await expect(reader.getByText('The midmarker word is here.')).toBeInViewport()
    await reader.locator('h1').evaluate((heading) => heading.scrollIntoView())
    await reader.locator('article').evaluate((article) => article.append(Object.assign(document.createElement('p'), { textContent: 'late content' })))
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
    await expect(reader.locator('h1')).toBeInViewport()

    await page.goto('/textsearch/long/scroll-target.md?q=zephyrmarker#middle-section')
    await expect(reader.getByRole('heading', { name: 'Middle section' })).toBeInViewport()
    await expect.poll(() => page.evaluate(() => (
      (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('gap-page-text-search')?.size ?? 0
    ))).toBe(1)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
    await expect(reader.getByText('The zephyrmarker word is at the end.')).not.toBeInViewport()
    await expect(reader.getByRole('heading', { name: 'Middle section' })).toBeInViewport()
  })

  test('a match that appears late scrolls into view only if the reader has not scrolled meanwhile', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    const appendLateMatch = (root: import('@playwright/test').Locator) => root.evaluate((element) => {
      element.append(Object.assign(element.ownerDocument.createElement('p'), { textContent: 'The latemarker word arrived late.' }))
    })

    // Markdown: without reader scrolling, the late match is scrolled to (the control case).
    await page.goto('/textsearch/long/scroll-target.md?q=latemarker')
    const reader = page.getByTestId('markdown-document')
    await expect(reader.locator('h1')).toBeInViewport()
    await appendLateMatch(reader.locator('article'))
    await expect(reader.getByText('The latemarker word arrived late.')).toBeInViewport()

    // After the reader scrolled, the late match only gets highlighted.
    await page.goto('/textsearch/long/scroll-target.md?q=latemarker')
    await expect(reader.locator('h1')).toBeInViewport()
    await reader.hover()
    await page.mouse.wheel(0, 300)
    await expect.poll(() => reader.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    const markdownTop = await reader.evaluate((element) => element.scrollTop)
    await appendLateMatch(reader.locator('article'))
    await expect.poll(() => page.evaluate(() => (
      (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('gap-page-text-search')?.size ?? 0
    ))).toBe(1)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(await reader.evaluate((element) => element.scrollTop)).toBe(markdownTop)
    await expect(reader.getByText('The latemarker word arrived late.')).not.toBeInViewport()

    // HTML: the same rule inside the artifact frame.
    await page.goto('/textsearch/long/scroll-target.html?q=latemarker')
    const frame = page.frameLocator('iframe.artifact-frame')
    await expect(frame.locator('h1')).toBeInViewport()
    await appendLateMatch(frame.locator('body'))
    await expect(frame.getByText('The latemarker word arrived late.')).toBeInViewport()

    await page.goto('/textsearch/long/scroll-target.html?q=latemarker')
    await expect(frame.locator('h1')).toBeInViewport()
    // Wait for the frame's highlight to be applied (on load) before the reader scrolls.
    await expect.poll(() => frame.locator('body').evaluate(() => typeof CSS !== 'undefined' && 'highlights' in CSS)).toBe(true)
    await page.locator('iframe.artifact-frame').hover()
    await page.mouse.wheel(0, 300)
    await expect.poll(() => frame.locator('body').evaluate((body) => body.ownerDocument.defaultView!.scrollY)).toBeGreaterThan(0)
    const frameTop = await frame.locator('body').evaluate((body) => body.ownerDocument.defaultView!.scrollY)
    await appendLateMatch(frame.locator('body'))
    await expect.poll(() => frame.locator('body').evaluate(() => (
      (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('gap-page-text-search')?.size ?? 0
    ))).toBe(1)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(await frame.locator('body').evaluate((body) => body.ownerDocument.defaultView!.scrollY)).toBe(frameTop)
  })

  test('a fragment change does not forget that the reader scrolled before a late match', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/textsearch/long/scroll-target.md?q=latemarker')
    const reader = page.getByTestId('markdown-document')
    await expect(reader.locator('h1')).toBeInViewport()
    await reader.hover()
    await page.mouse.wheel(0, 300)
    await expect.poll(() => reader.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    // A fragment change and its removal re-apply the highlight for the same query.
    await page.evaluate(() => { location.hash = 'middle-section' })
    await expect(reader.getByRole('heading', { name: 'Middle section' })).toBeInViewport()
    await page.goBack()
    await expect(page).toHaveURL(/\/textsearch\/long\/scroll-target\.md\?q=latemarker$/)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
    const top = await reader.evaluate((element) => element.scrollTop)
    await reader.locator('article').evaluate((article) => {
      article.append(Object.assign(document.createElement('p'), { textContent: 'The latemarker word arrived late.' }))
    })
    await expect.poll(() => page.evaluate(() => (
      (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('gap-page-text-search')?.size ?? 0
    ))).toBe(1)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(await reader.evaluate((element) => element.scrollTop)).toBe(top)
    await expect(reader.getByText('The latemarker word arrived late.')).not.toBeInViewport()
  })

  test('removing a fragment from an HTML page returns to the top without reloading or jumping to the first match', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/textsearch/long/scroll-target.html?q=zephyrmarker')
    const frame = page.frameLocator('iframe.artifact-frame')
    const match = frame.getByText('The zephyrmarker word is at the end.')
    await expect(match).toBeInViewport()
    // The reader scrolls back to the top, then jumps to a section.
    await page.locator('iframe.artifact-frame').hover()
    for (let i = 0; i < 40; i += 1) await page.mouse.wheel(0, -2000)
    await expect(frame.locator('h1')).toBeInViewport()
    await frame.locator('body').evaluate((body) => { (body.ownerDocument.defaultView as Window & { __sameDocument?: boolean }).__sameDocument = true })
    await page.evaluate(() => { location.hash = 'middle-section' })
    await expect(frame.getByRole('heading', { name: 'Middle section' })).toBeInViewport()
    // Going back removes the fragment without reloading the frame or scrolling to the match.
    await page.goBack()
    await expect(page).toHaveURL(/\/textsearch\/long\/scroll-target\.html\?q=zephyrmarker$/)
    await expect.poll(() => frame.locator('body').evaluate((body) => body.ownerDocument.defaultView!.location.hash)).toBe('')
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))
    await expect(match).not.toBeInViewport()
    await expect(frame.locator('h1')).toBeInViewport()
    // The frame document was not replaced.
    expect(await frame.locator('body').evaluate((body) => (body.ownerDocument.defaultView as Window & { __sameDocument?: boolean }).__sameDocument)).toBe(true)
    await expect.poll(() => frame.locator('body').evaluate(() => (
      (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('gap-page-text-search')?.size ?? 0
    ))).toBe(1)
  })

  test('a fragment in an in-artifact link wins over the first match', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/textsearch/incidents/checkout-latency/index.html?q=zephyrmarker')
    const frameElement = page.locator('iframe.artifact-frame')
    await expect(frameElement).toBeVisible()
    const frame = page.frameLocator('iframe.artifact-frame')
    await expect(frame.locator('body')).toBeVisible()
    // An ordinary link inside the artifact loads the page in the frame; the app URL is unchanged.
    await frame.locator('body').evaluate((body) => {
      const link = Object.assign(body.ownerDocument.createElement('a'), {
        href: '/_artifacts/textsearch/long/scroll-target.html#middle-section',
        textContent: 'Go to the middle section',
      })
      body.prepend(link)
    })
    await frame.getByRole('link', { name: 'Go to the middle section' }).click()
    await expect.poll(() => frameElement.evaluate((element: HTMLIFrameElement) => element.contentWindow?.location.pathname))
      .toBe('/_artifacts/textsearch/long/scroll-target.html')
    await expect(page).toHaveURL(/\/textsearch\/incidents\/checkout-latency\/index\.html\?q=zephyrmarker$/)
    await expect.poll(() => frame.locator('body').evaluate(() => (
      (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('gap-page-text-search')?.size ?? 0
    ))).toBe(1)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
    await expect(frame.getByRole('heading', { name: 'Middle section' })).toBeInViewport()
    await expect(frame.getByText('The zephyrmarker word is at the end.')).not.toBeInViewport()
  })

  test('committed terms are highlighted in HTML and Markdown pages without changing their DOM', async ({ page }) => {
    const highlightSize = (target: Page | import('@playwright/test').Frame) => target.evaluate(() => (
      (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('gap-page-text-search')?.size ?? 0
    ))

    await page.goto('/textsearch/incidents/checkout-latency/index.html?q=representative')
    const frameElement = page.locator('iframe.artifact-frame')
    await expect(frameElement).toBeVisible()
    const frame = (await frameElement.elementHandle())!
    const artifactFrame = (await frame.contentFrame())!
    await expect.poll(() => highlightSize(artifactFrame)).toBe(1)
    expect(await artifactFrame.evaluate(() => document.body.querySelectorAll('mark').length)).toBe(0)
    expect(await highlightSize(page)).toBe(0)
    // The highlight style is an adopted style sheet: no element is added to the artifact.
    const frameStyles = () => artifactFrame.evaluate(() => ({
      elements: document.querySelectorAll('style[data-gap-search-highlight]').length,
      adopted: document.adoptedStyleSheets.filter((sheet) => [...sheet.cssRules].some((rule) => rule.cssText.includes('gap-page-text-search'))).length,
    }))
    expect(await frameStyles()).toEqual({ elements: 0, adopted: 1 })

    await field(page).press('Escape')
    await expect.poll(() => highlightSize(artifactFrame)).toBe(0)
    // Committing again reuses the adopted sheet instead of adding another.
    await field(page).fill('fixture')
    await field(page).press('Enter')
    await expect.poll(() => highlightSize(artifactFrame)).toBeGreaterThan(0)
    expect(await frameStyles()).toEqual({ elements: 0, adopted: 1 })

    await page.goto('/textsearch/reports/latency-retrospective.md?q=latency')
    const reader = page.getByTestId('markdown-document')
    await expect(reader).toBeVisible()
    await expect.poll(() => highlightSize(page)).toBeGreaterThan(1)
    expect(await reader.locator('mark').count()).toBe(0)

    // A different committed query replaces the highlight.
    await field(page).fill('outage')
    await field(page).press('Enter')
    await expect(status(page)).toContainText('“outage”')
    await expect.poll(() => highlightSize(page)).toBe(1)
  })

  test('the palette hands its query to page text search', async ({ page }) => {
    await page.goto('/textsearch')
    await expect(page.getByRole('heading', { name: 'Text Search', exact: true })).toBeVisible()
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
    await expect(palette.locator('.palette-footer')).toContainText('search page text')

    // A page name matches, so it stays selected; the hand-off row follows the page matches.
    await search.fill('latency')
    const handOff = palette.getByRole('option', { name: /Search page text for “latency”/ })
    await expect(handOff).toBeVisible()
    await expect(palette.locator('.palette-section-title').first()).toHaveText('Pages')
    await expect(handOff).toHaveAttribute('aria-selected', 'false')
    await search.press('Control+Enter')
    await expect(palette).toBeHidden()
    await expect(page).toHaveURL(/\/textsearch\?q=latency$/)
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    // Focus lands in the search field, so ↓ enters the results.
    await expect(field(page)).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(hits(page).first()).toBeFocused()

    // No page name matches, so the hand-off is the default selection.
    await page.keyboard.press('Control+k')
    await search.fill('representative')
    const representative = palette.getByRole('option', { name: /Search page text for “representative”/ })
    await expect(representative).toHaveAttribute('aria-selected', 'true')
    await search.press('Enter')
    await expect(page).toHaveURL(/\/textsearch\?q=representative$/)
    await expect(field(page)).toHaveValue('representative')
    await expect(field(page)).toBeFocused()
  })

  test('the page text shortcut focuses the field, and a collapsed sidebar shows the query as a chip', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/textsearch/reports/latency-retrospective.md?q=latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await page.getByTestId('markdown-document').click()
    await page.keyboard.press('ControlOrMeta+Shift+F')
    await expect(field(page)).toBeFocused()

    // From inside an HTML artifact frame as well.
    await page.goto('/textsearch/incidents/checkout-latency/index.html?q=latency')
    const artifactFrame = page.frameLocator('iframe.artifact-frame')
    // The app attaches its key handler to the frame's window in the same load
    // callback that adds the highlight style, so the style means the frame is wired.
    await expect.poll(() => artifactFrame.locator('body').evaluate((body) => (
      body.ownerDocument.adoptedStyleSheets.some((sheet) => [...sheet.cssRules].some((rule) => rule.cssText.includes('gap-page-text-search')))
    ))).toBe(true)
    await artifactFrame.locator('body').click()
    await page.keyboard.press('ControlOrMeta+Shift+F')
    await expect(field(page)).toBeFocused()

    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    const chip = page.getByRole('button', { name: 'Show page text search results for latency' })
    await expect(chip).toBeVisible()
    await expect(chip).toContainText('3 / 5')
    await chip.click()
    await expect(sidebar(page)).toBeVisible()
    await expect(chip).toHaveCount(0)

    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await page.keyboard.press('ControlOrMeta+Shift+F')
    await expect(field(page)).toBeFocused()
  })

  test('sites without page text search keep the jump button and offer no hand-off', async ({ page }) => {
    const requests = recordSearchRequests(page)
    await page.goto('/sre?q=latency')
    await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
    await expect(page.getByRole('searchbox', { name: /Search page text/ })).toHaveCount(0)
    await expect(sidebar(page).getByRole('button', { name: 'Jump to a page in SRE' })).toBeVisible()
    await expect(page.locator('.page-text-results')).toHaveCount(0)
    await expect(sidebar(page).locator('.browse-tree')).toBeVisible()

    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' }).fill('latency')
    await expect(palette.getByRole('option', { name: /Latency Retrospective/ })).toBeVisible()
    await expect(palette.getByRole('option', { name: /Search page text/ })).toHaveCount(0)
    await expect(palette.locator('.palette-footer')).not.toContainText('search page text')
    await page.keyboard.press('Escape')

    await page.keyboard.press('ControlOrMeta+Shift+F')
    await expect(page.locator('.toast')).toHaveText('Page text search is not available for this site.')
    expect(requests).toEqual([])
  })

  test('result links keep ?q= and leave modified clicks to the browser', async ({ page, context }) => {
    await page.goto('/textsearch/long/scroll-target.md?q=lighthouse')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    const hit = page.locator('[data-hit-id="bulk/note-01.md"]')
    await expect(hit).toHaveJSProperty('tagName', 'A')
    await expect(hit).toHaveAttribute('href', '/textsearch/bulk/note-01.md?q=lighthouse')
    const [tab] = await Promise.all([
      context.waitForEvent('page'),
      hit.click({ modifiers: ['ControlOrMeta'] }),
    ])
    await expectTabLocation(tab, '/textsearch/bulk/note-01.md', '?q=lighthouse')
    await tab.close()
    await expect(page).toHaveURL(/\/long\/scroll-target\.md\?q=lighthouse$/)
    await hit.click()
    await expect(page).toHaveURL(/\/bulk\/note-01\.md\?q=lighthouse$/)
  })

  test('site home rows and Browse rows carry ?q= while a search is committed', async ({ page }) => {
    await page.goto('/textsearch?q=lighthouse')
    await expect(page.locator('.site-home .artifact-list-row').first()).toHaveAttribute('href', /\?q=lighthouse$/)
    await expect(page.locator('.site-home a.tree-artifact').first()).toHaveAttribute('href', /\?q=lighthouse$/)
    await page.goto('/textsearch')
    await expect(page.locator('.site-home .artifact-list-row').first()).not.toHaveAttribute('href', /q=/)
  })

  test('Copy link omits the committed search and keeps the fragment', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/textsearch/long/scroll-target.md?q=lighthouse#middle-section')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    const origin = new URL(page.url()).origin
    await page.getByRole('button', { name: 'Copy artifact link' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Link copied to clipboard.' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${origin}/textsearch/long/scroll-target.md#middle-section`)
    await expect(page).toHaveURL(/\?q=lighthouse#middle-section$/)

    await page.keyboard.press('Control+k')
    await page.getByRole('dialog', { name: 'Command palette' })
      .getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' }).fill('>copy artifact link')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${origin}/textsearch/long/scroll-target.md#middle-section`)
  })

  test('the site picker shows the page text search badge at 390px', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true })
    await registerTextSearchSite(page)
    await page.goto('/')
    const badge = page.getByRole('link', { name: /Text Search/ }).locator('.site-picker-badge')
    await expect(badge).toBeVisible()
    const box = await badge.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    await page.unrouteAll({ behavior: 'wait' })
    await page.close()
  })

  test('in-frame links of the documentation script carry the committed search to same-site routes only', async ({ page }) => {
    // docs/public/shared/assets/site.js is embedded by the documentation sites; load it into an artifact frame.
    const docsScript = readFileSync('docs/public/shared/assets/site.js', 'utf8').replace(/<\/script/gi, '<\\/script')
    await page.route('**/_artifacts/textsearch/long/scroll-target.html', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Docs</title></head><body>
        <a id="same" href="/_artifacts/textsearch/bulk/note-01.md">same site</a>
        <a id="own" href="/_artifacts/textsearch/bulk/note-02.md?q=mine">own query</a>
        <a id="other" href="/_artifacts/sre/incidents/checkout-latency/index.html">other site</a>
        <script>${docsScript}</script></body></html>`,
    }))
    const open = async (id: string) => {
      await page.goto('/textsearch/long/scroll-target.html?q=lighthouse')
      await page.frameLocator('iframe.artifact-frame').locator(`#${id}`).click()
    }
    await open('same')
    await expect(page).toHaveURL(/\/textsearch\/bulk\/note-01\.md\?q=lighthouse$/)
    await open('own')
    await expect(page).toHaveURL(/\/textsearch\/bulk\/note-02\.md\?q=mine$/)
    await open('other')
    await expect(page).toHaveURL(/\/sre\/incidents\/checkout-latency\/index\.html$/)
  })
})

test.describe('release UX fixes', () => {
  const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' })
  const paletteInput = (page: Page) => palette(page).getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  const checkoutPath = '/sre/incidents/checkout-latency/index.html'

  test('palette folds full-width input and prefixes like ordinary text', async ({ page }) => {
    await page.goto(checkoutPath)
    // The shortcut listener exists once the workspace has rendered.
    await expect(page.getByRole('complementary', { name: 'SRE navigation' })).toBeVisible()
    await page.keyboard.press('Control+k')
    await paletteInput(page).fill('ＣＨＥＣＫＯＵＴ')
    await expect(palette(page).getByRole('option', { name: /Checkout latency incident review/ })).toBeVisible()
    await expect(palette(page).locator('mark.palette-match').first()).toBeVisible()

    await paletteInput(page).fill('＠ｓｒｅ')
    await expect(palette(page).locator('.palette-scope')).toHaveText('Sites')
    await expect(palette(page).getByRole('option', { name: /SRE/ })).toBeVisible()

    await paletteInput(page).fill('＞ＤＡＲＫ')
    await expect(palette(page).getByRole('option', { name: /Use dark theme/ })).toBeVisible()

    await paletteInput(page).fill('＃')
    await expect(palette(page).locator('.palette-scope')).toHaveText('This artifact')
  })

  test('palette folds full-width input on the site picker too', async ({ page }) => {
    await registerManySites(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
    await page.keyboard.press('Control+k')
    await paletteInput(page).fill('ＨＴＭＬ')
    await expect(palette(page).getByRole('option', { name: /HTML Showcase/ })).toBeVisible()
    await paletteInput(page).fill('ｎｏｔｈｉｎｇ－ｈｅｒｅ')
    await expect(palette(page).getByText('No sites or commands match. Pages are searched after you choose a site.')).toBeVisible()
  })

  test('artifact counts are singular for one artifact', async ({ page }) => {
    await page.route('**/_indexes/sre/meta.json', async (route) => {
      const response = await route.fetch()
      const metadata = await response.json()
      await route.fulfill({ response, json: { ...metadata, artifactCount: 1 } })
    })
    await page.goto('/')
    const row = page.getByRole('link', { name: /SRE/ })
    await expect(row).toContainText('1 artifact ·')
    await expect(row).not.toContainText('1 artifacts')
    await page.keyboard.press('Control+k')
    await paletteInput(page).fill('@sre')
    await expect(palette(page).getByRole('option', { name: /SRE/ })).toContainText('1 artifact')
    await expect(palette(page).getByRole('option', { name: /SRE/ })).not.toContainText('1 artifacts')
  })

  test('the tab title follows the route', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle('Git Artifact Pages')
    await page.getByRole('link', { name: /SRE/ }).click()
    await expect(page).toHaveTitle('SRE')
    await page.goto(checkoutPath)
    await expect(page).toHaveTitle('Checkout latency incident review · SRE')
    await page.goto('/sre/_previews')
    await expect(page).toHaveTitle('Previews · SRE')
    await page.goto('/sre/does-not-exist.html')
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await expect(page).toHaveTitle('Page not found · SRE')
    await page.goto('/no-such-site')
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await expect(page).toHaveTitle('Page not found · Git Artifact Pages')
    // In-app navigation updates the title without a reload.
    await page.goto('/sre')
    await page.locator('.site-home .tree-artifact').first().click()
    await expect(page).toHaveTitle(/ · SRE$/)
  })

  test('navigation rows are real links that keep modified clicks for the browser', async ({ page }) => {
    await registerManySites(page)
    await page.goto('/')
    await expect(page.getByRole('link', { name: /SRE/ })).toHaveAttribute('href', '/sre')
    // Whether the browser then opens a tab is browser behavior, and under load Chromium/Playwright
    // sometimes never reports the tab (ISSUE-072 A3), so this test does not wait for one. It proves the
    // app's contract instead: a modified or middle click reaches the window with defaultPrevented still
    // false (the app did not intercept it). The bubble-phase listener runs after the app's React root
    // handler; it then prevents the default so the browser does not open a tab. The listener is removed
    // before the plain click. Real new-tab coverage lives in the Browse row and result link tests.
    await page.evaluate(() => {
      const w = window as unknown as { __clicks: ClickRecord[], __stopClicks: AbortController }
      w.__clicks = []
      w.__stopClicks = new AbortController()
      const record = (event: Event) => {
        const mouse = event as MouseEvent
        if (!(event.target instanceof Element) || !event.target.closest('a[href="/sre"]')) return
        w.__clicks.push({ type: event.type, button: mouse.button, modified: mouse.ctrlKey || mouse.metaKey, defaultPrevented: event.defaultPrevented })
        event.preventDefault()
      }
      window.addEventListener('click', record, { signal: w.__stopClicks.signal })
      window.addEventListener('auxclick', record, { signal: w.__stopClicks.signal })
    })
    const clicks = () => page.evaluate(() => (window as unknown as { __clicks: ClickRecord[] }).__clicks)
    await page.getByRole('link', { name: /SRE/ }).click({ modifiers: ['ControlOrMeta'] })
    await expect.poll(async () => (await clicks()).length).toBe(1)
    await page.getByRole('link', { name: /SRE/ }).click({ button: 'middle' })
    await expect.poll(async () => (await clicks()).length).toBe(2)
    const [ctrlClick, middleClick] = await clicks()
    expect(ctrlClick).toMatchObject({ type: 'click', button: 0, modified: true, defaultPrevented: false })
    expect(middleClick).toMatchObject({ type: 'auxclick', button: 1, defaultPrevented: false })
    await expect(page).toHaveURL(/\/$/)
    await page.evaluate(() => (window as unknown as { __stopClicks: AbortController }).__stopClicks.abort())

    // A plain click stays inside the app (no document reload).
    await page.evaluate(() => { (window as unknown as { __kept: boolean }).__kept = true })
    await page.mouse.move(0, 0)
    await page.getByRole('link', { name: /SRE/ }).click()
    await expect(page).toHaveURL(/\/sre$/)
    expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true)

    // Site home and sidebar rows.
    await expect(page.locator('.site-home a.tree-artifact').first()).toHaveAttribute('href', /^\/sre\//)
  })

  test('sidebar Browse rows, Pinned items and breadcrumb menu entries are links', async ({ page, context }) => {
    await page.goto(checkoutPath)
    const browseRow = page.locator('.browse-tree a.tree-artifact[aria-current="page"]')
    await expect(browseRow).toHaveAttribute('href', checkoutPath)
    const [rowTab] = await Promise.all([
      context.waitForEvent('page'),
      browseRow.click({ modifiers: ['ControlOrMeta'] }),
    ])
    await expectTabLocation(rowTab, checkoutPath)
    await rowTab.close()
    await page.getByRole('button', { name: 'Pin Checkout latency incident review' }).click()
    await expect(page.locator('.pinned-tree a.tree-artifact')).toHaveAttribute('href', checkoutPath)
    await page.getByRole('navigation', { name: 'Artifact path' })
      .getByRole('button', { name: 'Browse artifacts in incidents/checkout-latency', exact: true }).click()
    const item = page.getByRole('menu').getByRole('menuitem').first()
    await expect(item).toHaveAttribute('href', /^\/sre\/incidents\//)
    await expect(item).toHaveJSProperty('tagName', 'A')
  })

  test('the 390px header keeps the current document title readable', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await page.goto(checkoutPath)
    const nav = page.getByRole('navigation', { name: 'Artifact path' })
    const label = nav.locator('.breadcrumb-current .breadcrumb-trigger-label')
    await expect(label).toHaveText('Checkout latency incident review')
    const metrics = await page.evaluate(() => {
      const navElement = document.querySelector('.breadcrumbs')!
      const text = document.querySelector('.breadcrumb-current .breadcrumb-trigger-label')!
      const navBox = navElement.getBoundingClientRect()
      const textBox = text.getBoundingClientRect()
      return { navLeft: navBox.left, navRight: navBox.right, left: textBox.left, right: textBox.right, scrollLeft: navElement.scrollLeft, width: textBox.width }
    })
    expect(metrics.scrollLeft).toBe(0)
    expect(metrics.left).toBeGreaterThanOrEqual(metrics.navLeft - 1)
    expect(metrics.right).toBeLessThanOrEqual(metrics.navRight + 1)
    expect(metrics.width).toBeGreaterThanOrEqual(180)
    expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    // Folders stay reachable through their menus.
    await expect(nav.getByRole('button', { name: 'Browse artifacts in incidents', exact: true })).toHaveCount(1)
    await page.close()
  })

  test('preview pages show the registered site title and fall back to the site ID', async ({ page }) => {
    await page.goto('/sre/_previews')
    await expect(page.getByRole('link', { name: '← SRE', exact: true })).toBeVisible()
    await expect(page.getByText('SRE · Previews')).toBeVisible()

    await page.unroute('**/_indexes/sites.json').catch(() => undefined)
    await page.route('**/_indexes/sites.json', (route) => route.fulfill({ status: 503, body: 'unavailable' }))
    await page.goto('/sre/_previews')
    await expect(page.getByRole('link', { name: '← sre', exact: true })).toBeVisible()
  })

  test('Esc returns focus to where it was and a chosen page receives focus', async ({ page }) => {
    await page.goto(checkoutPath)
    const trigger = page.locator('.sidebar-palette-trigger, #site-switcher').first()
    await trigger.focus()
    await page.keyboard.press('Control+k')
    await expect(paletteInput(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(palette(page)).toHaveCount(0)
    await expect(trigger).toBeFocused()

    // With nothing focused, Esc lands on the page rather than <body>.
    await page.goto(checkoutPath)
    await expect(page.locator('iframe.artifact-frame')).toBeVisible()
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => (
      document.activeElement === document.body ? 'body' : document.activeElement?.closest('.stage') ? 'stage' : 'other'
    ))).toBe('stage')

    // Choosing a page moves focus to the page.
    await page.keyboard.press('Control+k')
    await paletteInput(page).fill('platform topology')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/sre\/architecture\/platform-topology\/index\.html$/)
    await expect.poll(() => page.evaluate(() => (
      document.activeElement === document.body ? 'body' : document.activeElement?.closest('.stage') ? 'stage' : 'other'
    ))).toBe('stage')
  })

  test('Ctrl/⌘ B toggles the sidebar while focus is inside the HTML artifact', async ({ page }) => {
    await page.goto(checkoutPath)
    const frame = page.frameLocator('iframe.artifact-frame')
    await expect(frame.locator('body')).toBeVisible()
    await frame.locator('body').click()
    await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/)
    await page.keyboard.press('ControlOrMeta+b')
    await expect(page.locator('.app-shell')).toHaveClass(/sidebar-collapsed/)
    await page.locator('iframe.artifact-frame').focus()
    await frame.locator('body').click()
    await page.keyboard.press('ControlOrMeta+b')
    await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/)
  })

  test('non-canonical paths are replaced in place with the canonical route', async ({ page }) => {
    await page.goto('/')
    await page.goto('/sre//incidents//checkout-latency//index.html?x=1#section')
    await expect(page).toHaveURL(`/sre/incidents/checkout-latency/index.html?x=1#section`)
    await expect(page).toHaveTitle('Checkout latency incident review · SRE')
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)

    await page.goto('/sre/')
    await expect(page).toHaveURL(/\/sre$/)
    await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()

    // Folder-like paths are left alone.
    await page.goto('/sre/incidents/')
    await expect(page).toHaveURL(/\/sre\/incidents\/$/)
  })

  test('@ lists name and ID matches before description-only matches', async ({ page }) => {
    await page.route('**/_indexes/sites.json', async (route) => {
      const response = await route.fetch()
      const registry = await response.json() as { sites: Array<Record<string, string>> }
      const sites = registry.sites.map((site) => (
        site.id === 'frontend' ? { ...site, description: 'Component archives and architecture notes' } : site
      ))
      sites.push({ id: 'arch-hub', name: 'Arch Hub', repository: 'example/e2e', sourcePath: 'sites/arch-hub' })
      sites.sort((left, right) => (left.id < right.id ? -1 : 1))
      await route.fulfill({ response, json: { ...registry, sites } })
    })
    await page.goto('/sre')
    await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
    await page.keyboard.press('Control+k')
    await paletteInput(page).fill('@arch')
    const options = palette(page).getByRole('option')
    await expect(options).toHaveCount(2)
    await expect(options.first()).toContainText('Arch Hub')
    await expect(options.nth(1)).toContainText('Frontend')
  })
})

// Reader compatibility rules (TD2): unknown fields are ignored; an unknown
// schemaVersion is a confirmed but unreadable format and shows a republish
// state, which is distinct from a network or invalid-data error.
test.describe('reader compatibility rules', () => {
  type Json = Record<string, unknown>
  async function mutateJson(page: Page, glob: string, mutate: (payload: Json) => Json) {
    await page.route(glob, async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, json: mutate(await response.json() as Json) })
    })
  }

  test('unknown fields in every published format are ignored', async ({ page }) => {
    await mutateJson(page, '**/_indexes/sites.json', (registry) => ({
      ...registry,
      futureRootField: { anything: true },
      sites: (registry.sites as Json[]).map((site) => ({ ...site, futureEntryField: 'x' })),
    }))
    await mutateJson(page, '**/_indexes/sre/meta.json', (meta) => ({ ...meta, futureMetaField: [1, 2, 3] }))
    await mutateJson(page, '**/_indexes/sre/index.json', (index) => ({
      ...index,
      futureIndexField: 'x',
      artifacts: (index.artifacts as Json[]).map((artifact) => ({ ...artifact, futureArtifactField: { nested: 1 } })),
    }))
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
    await expect(page.getByRole('link', { name: /SRE/ }).first()).toBeVisible()
    await page.goto('/sre')
    await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
    await expect(page.getByText('needs to be republished')).toHaveCount(0)
  })

  test('an unknown registry schemaVersion shows a product-level republish state on the site picker', async ({ page }) => {
    await mutateJson(page, '**/_indexes/sites.json', (registry) => ({ ...registry, schemaVersion: 2 }))
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'This library needs to be updated' })).toBeVisible()
    await expect(page.getByText(/cannot read/)).toBeVisible()
    await expect(page.getByText('Unable to load sites')).toHaveCount(0)
    await expect(page).toHaveTitle(/Git Artifact Pages/)
  })

  test('an unreadable registry is an error, not a republish state', async ({ page }) => {
    await page.route('**/_indexes/sites.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"schemaVersion":1,"sites":"nope"}' }))
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Unable to load sites' })).toBeVisible()
    await expect(page.getByText('needs to be updated')).toHaveCount(0)
  })

  test('an unknown meta.json schemaVersion lists the site as needing a republish and opens the republish state', async ({ page }) => {
    await mutateJson(page, '**/_indexes/sre/meta.json', (meta) => ({ ...meta, schemaVersion: 2, someNewShape: { x: 1 } }))
    await mutateJson(page, '**/_indexes/sre/index.json', (index) => ({ ...index, schemaVersion: 2 }))
    await page.goto('/')
    const row = page.getByRole('link', { name: /SRE/ }).first()
    await expect(row).toContainText('needs to be republished')
    await expect(page.getByRole('link', { name: /Frontend/ }).first()).not.toContainText('needs to be republished')
    await row.click()
    await expect(page.getByRole('heading', { name: 'This site needs to be republished' })).toBeVisible()
    await expect(page.getByRole('status')).toContainText('Ask the site owner to publish it again')
    await page.getByRole('button', { name: '← All sites' }).click()
    await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  })

  test('an unknown index.json schemaVersion opens the republish state even when meta.json is readable', async ({ page }) => {
    await mutateJson(page, '**/_indexes/sre/index.json', (index) => ({ ...index, schemaVersion: 2 }))
    await page.goto('/sre')
    await expect(page.getByRole('heading', { name: 'This site needs to be republished' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Unable to load this site' })).toHaveCount(0)
    // A deep link to an artifact reaches the same state instead of a misread page.
    await page.goto('/sre/incidents/checkout-latency/index.html')
    await expect(page.getByRole('heading', { name: 'This site needs to be republished' })).toBeVisible()
  })

  test('a server error for index.json stays an ordinary load error', async ({ page }) => {
    await page.route('**/_indexes/sre/index.json', (route) => route.fulfill({ status: 503, body: 'unavailable' }))
    await page.goto('/sre')
    await expect(page.getByRole('heading', { name: 'Unable to load this site' })).toBeVisible()
    await expect(page.getByText('needs to be republished')).toHaveCount(0)
  })

  test('an unknown preview catalog schemaVersion says previews need a republish', async ({ page }) => {
    await mutateJson(page, '**/_previews/sre/catalog.json', (catalog) => ({ ...catalog, schemaVersion: 2 }))
    await page.goto('/sre/_previews')
    await expect(page.getByRole('heading', { name: 'Previews need to be republished' })).toBeVisible()
    await expect(page.getByText('The preview list could not be loaded.')).toHaveCount(0)
  })

  test('an unknown preview manifest schemaVersion marks only that preview as needing a republish', async ({ page }) => {
    await mutateJson(page, `**/_previews/sre/revisions/${previewHeadSha}/manifest.json`, (manifest) => ({ ...manifest, schemaVersion: 2 }))
    await page.goto('/sre/_previews')
    await expect(page.getByRole('alert')).toHaveText('Some previews need to be republished and are not listed.')
  })

  test('an unknown full-text manifest version says search needs a republish, not a read error', async ({ page }) => {
    await registerTextSearchSite(page)
    await mutateJson(page, '**/_indexes/textsearch/search/manifest.json', (manifest) => ({ ...manifest, version: 2 }))
    await page.goto('/textsearch?q=latency')
    const alert = page.locator('.sidebar-panel').getByRole('alert')
    await expect(alert).toContainText('Page text search needs to be republished')
    await expect(alert).not.toContainText('could not be read')
  })

  test('unknown preview fields are ignored', async ({ page }) => {
    await mutateJson(page, '**/_previews/sre/catalog.json', (catalog) => ({
      ...catalog,
      futureField: 1,
      groups: (catalog.groups as Json[]).map((group) => ({ ...group, futureGroupField: 1 })),
    }))
    await page.goto('/sre/_previews')
    await expect(page.getByRole('heading', { name: 'Previews', exact: true })).toBeVisible()
    await expect(page.getByText('Previews need to be republished')).toHaveCount(0)
    await expect(page.locator('.preview-group').first()).toBeVisible()
  })
})
