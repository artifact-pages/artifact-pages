import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

/** True while the viewport uses the narrow reader chrome (ISSUE-080: menu button and More menu). */
function isNarrowChrome(page: Page) {
  return (page.viewportSize()?.width ?? 1280) <= 620
}

function moreActionsButton(page: Page) {
  return page.getByRole('button', { name: 'More actions' })
}

/** Runs a secondary toolbar action: its button on wide screens, its More menu item on narrow ones. */
async function clickToolbarAction(page: Page, desktop: Locator, menuName: string | RegExp) {
  if (!isNarrowChrome(page)) {
    await desktop.click()
    return
  }
  await moreActionsButton(page).click()
  await page.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name: menuName })
    .or(page.getByRole('menu', { name: 'More actions' }).getByRole('menuitemcheckbox', { name: menuName }))
    .click()
}

/** The control that takes focus when a panel opened from the toolbar closes. */
function toolbarFocusTarget(page: Page, desktop: Locator) {
  return isNarrowChrome(page) ? moreActionsButton(page) : desktop
}

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

/**
 * Ctrl/Meta-click a link and prove the app leaves it to the browser: the click reaches the window with
 * `defaultPrevented` still false and the app neither navigated nor reloaded. Whether the browser then
 * opens a tab is browser behavior, and under load Chromium/Playwright sometimes never reports the tab
 * (ISSUE-072 A3), so this does not wait for one. A bubble-phase listener on `window` runs after the app's
 * React root handler; it then prevents the default so no tab opens.
 */
async function expectModifiedClickKeptForBrowser(page: Page, link: Locator) {
  const pagesBefore = page.context().pages().length
  const urlBefore = page.url()
  await link.evaluate((element) => {
    const w = window as unknown as { __probe: ClickRecord[], __probeStop: AbortController }
    w.__probe = []
    w.__probeStop = new AbortController()
    const record = (event: Event) => {
      const mouse = event as MouseEvent
      if (!(event.target instanceof Element) || event.target.closest('a') !== element) return
      w.__probe.push({ type: event.type, button: mouse.button, modified: mouse.ctrlKey || mouse.metaKey, defaultPrevented: event.defaultPrevented })
      event.preventDefault()
    }
    window.addEventListener('click', record, { signal: w.__probeStop.signal })
  })
  await link.click({ modifiers: ['ControlOrMeta'] })
  const records = () => page.evaluate(() => (window as unknown as { __probe: ClickRecord[] }).__probe)
  await expect.poll(async () => (await records()).length).toBe(1)
  expect((await records())[0]).toMatchObject({ type: 'click', button: 0, modified: true, defaultPrevented: false })
  await page.evaluate(() => {
    const w = window as unknown as { __probe?: ClickRecord[], __probeStop?: AbortController }
    w.__probeStop?.abort()
    delete w.__probe
    delete w.__probeStop
  })
  // A delayed in-app navigation would show up within a short window; require the URL to stay put.
  await page.waitForTimeout(500)
  expect(page.url()).toBe(urlBefore)
  expect(page.context().pages().length).toBe(pagesBefore)
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
  const siteRoot = page.getByTestId('directory-page')
  await expect(siteRoot.locator('.site-home-heading')).toBeVisible()
  await expect(siteRoot.locator('.artifact-list-section[aria-label="Recently updated"]')).toHaveCount(0)
  await expect(siteRoot.locator('.browse-section')).toHaveCount(0)
  // The site root lists its top-level folders (ISSUE-076 order); there is no Browse tree.
  await expect(siteRoot.getByRole('region', { name: 'Folders' }).getByRole('link')).toHaveText([
    'architecture', 'diagrams', 'guides', 'incidents', 'reports', 'runbooks',
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
  await expect(sitePalette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' }))
    .toHaveAttribute('placeholder', 'Search sites...')
  await page.keyboard.press('Escape')

  await page.getByRole('link', { name: /SRE/ }).click()
  await expect(page).toHaveURL(/\/sre$/)
  const homeJump = page.getByRole('button', { name: 'Search this site' })
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

/** Presses Tab (or Shift+Tab) `times` times and returns, for each stop, whether focus is inside the dialog. */
async function tabInsideDialog(page: Page, key: 'Tab' | 'Shift+Tab', times: number) {
  const inside: boolean[] = []
  for (let step = 0; step < times; step++) {
    await page.keyboard.press(key)
    inside.push(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"][aria-label="Command palette"]'))))
  }
  return inside
}

for (const entry of [
  { name: 'site list', path: '/', trigger: 'Search sites' },
  { name: 'in-site', path: '/sre', trigger: 'Jump to a page in SRE' },
]) {
  test(`the ${entry.name} palette keeps keyboard focus inside and hands it back on dismissal`, async ({ page }) => {
    await registerManySites(page)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(entry.path)
    const trigger = page.getByRole('button', { name: entry.trigger }).first()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    const input = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })

    for (const query of ['', 'zzzqqqnothing', '>']) {
      await trigger.focus()
      await trigger.press('Enter')
      await expect(input).toBeFocused()
      if (query) await input.fill(query)
      expect(await tabInsideDialog(page, 'Tab', 6)).toEqual(Array(6).fill(true))
      expect(await tabInsideDialog(page, 'Shift+Tab', 6)).toEqual(Array(6).fill(true))
      // The page behind cannot take focus while the dialog is open: focusing a link there leaves focus in the dialog.
      expect(await page.evaluate(() => document.getElementById('root')?.inert)).toBe(true)
      await page.locator('#root a[href]').first().evaluate((element) => (element as HTMLElement).focus())
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true)
      await page.keyboard.press('Escape')
      await expect(palette).toBeHidden()
      await expect(trigger).toBeFocused()
      expect(await page.evaluate(() => document.getElementById('root')?.inert)).toBe(false)
    }

    await trigger.press('Enter')
    await palette.getByRole('button', { name: 'Close command palette' }).click()
    await expect(palette).toBeHidden()
    await expect(trigger).toBeFocused()
  })
}

test('the palette is a combobox whose active descendant follows the selection and never dangles', async ({ page }) => {
  await page.goto('/sre')
  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const input = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
  await input.fill('latency')
  await expect(palette.getByRole('option').first()).toBeVisible()
  await expect(input).toHaveAttribute('aria-expanded', 'true')
  const listboxId = await palette.getByRole('listbox').getAttribute('id')
  expect(await input.getAttribute('aria-controls')).toBe(listboxId)

  const check = async () => {
    const id = await input.getAttribute('aria-activedescendant')
    expect(id).toBeTruthy()
    const option = page.locator(`[id="${id}"]`)
    await expect(option).toHaveAttribute('role', 'option')
    await expect(option).toHaveAttribute('aria-selected', 'true')
    await expect(palette.locator('[aria-selected="true"]')).toHaveCount(1)
  }
  await check()
  await input.press('ArrowDown')
  await check()
  await input.press('ArrowDown')
  await check()
  expect(await palette.getByRole('group').count()).toBeGreaterThan(0)

  await input.fill('zzzqqqnothing')
  await expect(palette.locator('.palette-empty')).toBeVisible()
  await expect(input).not.toHaveAttribute('aria-activedescendant', /.+/)
  await expect(input).toHaveAttribute('aria-expanded', 'false')
  await expect(input).not.toHaveAttribute('aria-controls', /.+/)
  await expect(palette.getByRole('listbox')).toHaveCount(0)

  await input.fill('latency')
  await check()
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
  // The site home has no inline filter; the search entry beside the section links opens the palette.
  await expect(page.getByTestId('directory-page').getByRole('searchbox')).toHaveCount(0)
  const homeJump = page.getByRole('button', { name: 'Search this site' })
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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  expect(directoryRequests).toEqual([])
  // The landing page reads discovery metadata only; no site index is requested.
  await page.waitForTimeout(1000)
  expect(indexRequests).toEqual([])

  // Opening a site reads exactly that site's index.
  await page.getByRole('link', { name: /SRE registered/ }).click()
  await expect(page).toHaveURL(/\/sre$/u)
  await expect(page.getByRole('heading', { name: 'SRE registered', exact: true })).toBeVisible()
  await expect.poll(() => indexRequests).toEqual(['/_indexes/sre/index.json'])
  expect(indexRequests).not.toContain('/_indexes/orphaned/index.json')
})

test('site cards show the description, page counts per top-level folder and a Start reading link', async ({ page }) => {
  const indexRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (/^\/_indexes\/[^/]+\/index\.json$/u.test(pathname)) indexRequests.push(pathname)
  })
  const meta = (id: string, count: number, extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    site: { id, title: id },
    generatedAt: '2026-10-09T00:00:00Z',
    artifactCount: count,
    artifactIndexUrl: `/_indexes/${id}/index.json`,
    ...extra,
  })
  const folders = (...pairs: [string, number][]) => pairs.map(([name, artifactCount]) => ({ name, artifactCount }))
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  const sites = [
    { id: 'drafts', name: 'Drafts', description: 'Not yet published.' },
    { id: 'flat', name: 'Flat site', description: 'Pages without folders.' },
    { id: 'guide', name: 'Guide', description: 'Start here.' },
    { id: 'handbook', name: 'handbook', description: 'Has a root README.' },
    { id: 'old', name: 'Old', description: 'Published by an older CLI.' },
    { id: 'wide', name: 'Wide', description: 'Many folders.' },
  ].map((site) => ({ ...site, repository: `acme/${site.id}`, sourcePath: `sites/${site.id}` }))
  await page.route('**/_indexes/sites.json', (route) => route.fulfill(json({ schemaVersion: 1, sites })))
  await page.route('**/_indexes/drafts/meta.json', (route) => route.fulfill({ status: 404, body: '{}' }))
  await page.route('**/_indexes/flat/meta.json', (route) => route.fulfill(json(meta('flat', 2, {
    contentUpdatedAt: '2026-10-03T12:00:00Z', rootArtifactCount: 2, topLevelFolderCount: 0, topLevelFolders: [],
  }))))
  await page.route('**/_indexes/guide/meta.json', (route) => route.fulfill(json(meta('guide', 5, {
    contentUpdatedAt: '2026-10-05T12:00:00Z', rootArtifactCount: 0, topLevelFolderCount: 2, topLevelFolders: folders(['en', 3], ['ja', 2]),
  }))))
  await page.route('**/_indexes/handbook/meta.json', (route) => route.fulfill(json(meta('handbook', 3, {
    contentUpdatedAt: '2026-10-04T12:00:00Z', rootArtifactCount: 1, topLevelFolderCount: 2, topLevelFolders: folders(['en', 1], ['ja', 1]),
  }))))
  await page.route('**/_indexes/old/meta.json', (route) => route.fulfill(json(meta('old', 4))))
  await page.route('**/_indexes/wide/meta.json', (route) => route.fulfill(json(meta('wide', 5, {
    contentUpdatedAt: '2026-10-06T12:00:00Z', rootArtifactCount: 0, topLevelFolderCount: 5,
    topLevelFolders: folders(['a', 1], ['b', 1], ['c', 1], ['d', 1], ['e', 1]),
  }))))

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()

  // Deterministic order: by site title (case-insensitive), not by registry order.
  await expect(page.locator('.site-picker-main strong')).toHaveText(['Drafts', 'Flat site', 'Guide', 'handbook', 'Old', 'Wide'])

  // Start reading always opens the site root, which shows the root README when there is one.
  const handbook = page.getByRole('link', { name: /handbook/ })
  await expect(handbook).toHaveAttribute('href', '/handbook')
  await expect(page.getByRole('link', { name: /Guide/ })).toHaveAttribute('href', '/guide')
  await expect(page.getByRole('link', { name: /Flat site/ })).toHaveAttribute('href', '/flat')

  const guide = page.getByRole('link', { name: /Guide/ })
  await expect(guide.locator('.site-picker-description')).toHaveText('Start here.')
  await expect(guide.locator('.site-picker-folder')).toHaveText(['en 3', 'ja 2'])
  await expect(guide.locator('.site-picker-sr-only')).toHaveText('en: 3 pages, ja: 2 pages')
  await expect(guide.locator('.site-picker-folders')).toHaveAttribute('aria-hidden', 'true')
  await expect(guide.locator('.site-picker-start')).toHaveText('Start reading')
  await expect(guide).toContainText('5 artifacts · updated Oct 5')
  await expect(guide.locator('.site-picker-meta')).toContainText('/guide')

  await expect(handbook.locator('.site-picker-folder')).toHaveText(['en 1', 'ja 1', '(root) 1'])

  const flat = page.getByRole('link', { name: /Flat site/ })
  await expect(flat).toContainText('2 artifacts · updated Oct 3')
  await expect(flat.locator('.site-picker-folder')).toHaveCount(0)
  await expect(flat.locator('.site-picker-start')).toBeVisible()

  // Metadata from an older publisher has no freshness or folder fields: count only, no "updated".
  const old = page.getByRole('link', { name: /Old/ })
  await expect(old).toContainText('4 artifacts')
  await expect(old.locator('.site-picker-meta')).not.toContainText('updated')
  await expect(old.locator('.site-picker-folder')).toHaveCount(0)

  const wide = page.getByRole('link', { name: /Wide/ })
  await expect(wide).toContainText('5 artifacts · updated Oct 6')
  await expect(wide.locator('.site-picker-folder')).toHaveText('5 top-level folders')

  const drafts = page.getByRole('link', { name: /Drafts/ })
  await expect(drafts).toContainText('Registered · not published yet')
  await expect(drafts.locator('.site-picker-start')).toHaveCount(0)
  await expect(drafts.locator('.site-picker-folder')).toHaveCount(0)

  // The list is drawn from discovery metadata alone.
  await page.waitForTimeout(1000)
  expect(indexRequests).toEqual([])

  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expect(guide.locator('.site-picker-start')).toBeVisible()

  await handbook.locator('.site-picker-start').click()
  await expect(page).toHaveURL(/\/handbook$/u)
  await page.goBack()
  await guide.locator('.site-picker-start').click()
  await expect(page).toHaveURL(/\/guide$/u)
})

test('the landing page requests no site index for a long site list', async ({ page }) => {
  const ids = Array.from({ length: 10 }, (_, i) => `site-${String(i).padStart(2, '0')}`)
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/_indexes/sites.json', (route) => route.fulfill(json({
    schemaVersion: 1,
    sites: ids.map((id) => ({ id, name: id, repository: `acme/${id}`, sourcePath: `sites/${id}` })),
  })))
  const indexRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (/^\/_indexes\/[^/]+\/index\.json$/u.test(pathname)) indexRequests.push(pathname)
  })
  for (const id of ids) {
    await page.route(`**/_indexes/${id}/meta.json`, (route) => route.fulfill(json({
      schemaVersion: 1,
      site: { id, title: id },
      generatedAt: '2026-10-09T00:00:00Z',
      artifactCount: 2,
      artifactIndexUrl: `/_indexes/${id}/index.json`,
      contentUpdatedAt: '2026-10-01T00:00:00Z',
      rootArtifactCount: 0,
      topLevelFolderCount: 2,
      topLevelFolders: [{ name: 'en', artifactCount: 1 }, { name: 'ja', artifactCount: 1 }],
    })))
  }

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  await expect(page.getByRole('link', { name: /site-09/ }).locator('.site-picker-folder')).toHaveText(['en 1', 'ja 1'])
  await page.waitForTimeout(1000)
  expect(indexRequests).toEqual([])
})

test('a real folder named root is not confused with pages at the site root', async ({ page }) => {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/_indexes/sites.json', (route) => route.fulfill(json({
    schemaVersion: 1,
    sites: [{ id: 'mixed', name: 'Mixed', repository: 'acme/mixed', sourcePath: 'sites/mixed' }],
  })))
  await page.route('**/_indexes/mixed/meta.json', (route) => route.fulfill(json({
    schemaVersion: 1, site: { id: 'mixed', title: 'Mixed' }, generatedAt: '2026-10-09T00:00:00Z', artifactCount: 3,
    artifactIndexUrl: '/_indexes/mixed/index.json',
    contentUpdatedAt: '2026-10-01T00:00:00Z', rootArtifactCount: 1, topLevelFolderCount: 1,
    topLevelFolders: [{ name: 'root', artifactCount: 2 }],
  })))
  await page.goto('/')
  const chips = page.getByRole('link', { name: /Mixed/ }).locator('.site-picker-folder')
  await expect(chips).toHaveText(['root 2', '(root) 1'])
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
  await expect(page.locator('.site-home-heading .site-home-lede')).toContainText('0 pages')
  await expect(page.getByText('No artifacts have been published to this site yet.')).toBeVisible()
  await expect(page.getByTestId('directory-page')).toHaveCount(0)
  await expect(page.locator('.artifact-frame')).toHaveCount(0)

  await page.goto('/empty/index.html')
  await expect(page).toHaveURL(/\/empty\/index\.html$/u)
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  expect(artifactRequests).toEqual([])

  await page.goto('/neighbor')
  await expect(page.getByRole('heading', { name: 'Neighbor', exact: true })).toBeVisible()
  await expect(page.getByTestId('directory-page').locator('.directory-row-link')).toHaveText('Neighbor report')
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
  // The landing page reads no index at all; the unpublished site is not requested either.
  await page.waitForTimeout(500)
  expect(indexRequests).toEqual([])

  const requestsAfterLanding = indexRequests.length
  await frontendBeforePublish.click()
  await expect(page.getByRole('heading', { name: 'Site registered, but not published yet' })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('This site is registered and will appear here after its first publish.')
  expect(indexRequests.slice(requestsAfterLanding)).toEqual(['/_indexes/frontend/index.json'])

  const requestsBeforeReload = indexRequests.length
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  await page.keyboard.press('Control+k')
  const searchPalette = page.getByRole('dialog', { name: 'Command palette' })
  const search = searchPalette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('SRE registered')
  await expect(searchPalette.getByRole('option', { name: /SRE registered/ })).toBeVisible()
  await search.press('Enter')
  await expect(page).toHaveURL(/\/sre$/u)
  await expect(page.getByRole('heading', { name: 'SRE registered', exact: true })).toBeVisible()
  // A fresh page load reads only the opened site's index.
  expect(indexRequests.slice(requestsBeforeReload)).toEqual(['/_indexes/sre/index.json'])

  frontendPublished = true
  const requestsBeforePublishedLanding = indexRequests.length
  await page.goto('/')
  const frontendAfterPublish = page.getByRole('link', { name: /Frontend registered/ })
  await expect(frontendAfterPublish).toContainText('3 artifacts')
  await expect(frontendAfterPublish).not.toContainText('not published yet')
  await frontendAfterPublish.click()
  await expect(page).toHaveURL(/\/frontend$/u)
  await expect(page.getByRole('heading', { name: 'Frontend registered', exact: true })).toBeVisible()
  expect(indexRequests.slice(requestsBeforePublishedLanding)).toEqual(['/_indexes/frontend/index.json'])
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
    const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
    // The failed site never gets an index request; the healthy site's index is read once for the card and reused by the site view.
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
  await expect(page.getByRole('alert')).toHaveText('The site catalog is damaged or was written by an incompatible version. Ask the administrator to run the registry sync again.')
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)

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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  const reopenedSearch = reopenedPalette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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

  await expect(page.locator('.directory-page .artifact-list-section[aria-label="Recently updated"]')).toHaveCount(0)
  await expect(page.locator('.directory-page .browse-section')).toHaveCount(0)
  await expect(page.locator('.sidebar-panel .sidebar-section-label', { hasText: 'Recently updated' })).toHaveCount(0)
  await expect(page.locator('.sidebar-panel .browse-tree')).toBeVisible()

  await page.goto('/showcase')

  await expect(page.locator('.directory-page .artifact-list-section[aria-label="Recently updated"]')).toBeVisible()
  // Recently updated lives on the site root only; the sidebar keeps Pinned and Browse.
  await expect(page.locator('.sidebar-panel .sidebar-section-label', { hasText: 'Recently updated' })).toHaveCount(0)
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
  // Focus falls back to the first Browse folder, which is now "architecture" (folders first, by name; ISSUE-076).
  await expect(browse.locator('.tree-directory-button[data-tree-path="architecture"]')).toBeFocused()
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
  await page.setViewportSize({ width: 1100, height: 800 }) // below the reader column breakpoint (ISSUE-108): Contents and Details open as panels
  await page.goto('/sre/architecture/platform-topology/index.html')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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

  // At 390px the pin action lives in the More menu (ISSUE-080).
  const more = moreActionsButton(page)
  const menu = page.getByRole('menu', { name: 'More actions' })
  await more.click()
  await expect(menu.getByRole('menuitem', { name: 'Pin', exact: true })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Pin', exact: true }).click()
  await expect(menu).toBeHidden()
  await expect(more).toBeFocused()
  await expect(page.getByRole('status')).toHaveText('Pinned Platform topology.')
  await expect.poll(() => page.evaluate(() => JSON.parse(
    window.localStorage.getItem('git-artifact-pages:pinned-artifacts:v1') ?? '{}',
  ))).toEqual({ sre: ['architecture/platform-topology/index.html'] })

  await page.reload()
  await expect(page.locator('.sidebar-panel')).toBeHidden()
  await more.click()
  await expect(menu.getByRole('menuitem', { name: 'Unpin', exact: true })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Unpin', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Unpinned Platform topology.')
  await page.reload()
  await more.click()
  await expect(menu.getByRole('menuitem', { name: 'Pin', exact: true })).toBeVisible()

  // Wide screens keep the labeled toolbar button.
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.getByRole('button', { name: 'Pin Platform topology' })).toHaveAttribute('aria-pressed', 'false')
})

test('the palette footer advertises headings only when a site is open', async ({ page }) => {
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
    .getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' }).fill('#')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toContainText('Headings are searched after you choose a site.')
  await page.keyboard.press('Escape')

  await page.goto('/sre')
  footer = await open('Jump to a page in SRE')
  await expect(footer).toContainText('> commands')
  await expect(footer).toContainText('# headings')
  await expect(footer).not.toContainText('search full text')
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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  let search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('platform topology')
  await search.press('Enter')
  await expect(page).toHaveURL(/\/sre\/architecture\/platform-topology\/index\.html$/)

  palette = await openPalette()
  search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('checkout latency')
  await search.press('Enter')
  await expect(page).toHaveURL(/\/sre\/incidents\/checkout-latency\/index\.html$/)

  // No scope tabs: the blank palette lists the reader's own recent reads; commands stay behind ">".
  palette = await openPalette()
  search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
  await expect(palette.locator('.palette-section-title')).toHaveText(['Recently read'])
  await expect(palette.getByRole('option', { name: /Platform topology/ })).toBeVisible()

  await search.fill('platform')
  // The wrapper folder "platform-topology" matched by name, so it is listed after the page.
  await expect(palette.locator('.palette-section-title')).toHaveText(['Pages', 'Folders'])
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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
  await expect(search).toHaveAttribute('placeholder', 'Search pages... (> commands, # headings, @ sites)')
  await expect(palette.locator('.palette-scope')).toHaveText('SRE only')

  await search.fill('incident')
  await expect(palette.getByRole('option', { name: /Checkout latency incident review/ })).toBeVisible()
  await expect(palette.locator('.palette-section-title')).toHaveText(['Pages', 'Folders'])

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
  await palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL }).press('Enter')
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
  const search = palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL })
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
  const search = palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL })
  await search.fill('latency')
  // Two pages and the "checkout-latency" folder match; Chromium reports the pointer as entering the row that now sits under it.
  await expect(palette.getByRole('option')).toHaveCount(3)
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
  await expect(palette.locator('.palette-hint')).toContainText('Type > for commands, # for headings, @ to switch sites.')
  await expect(palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL }))
    .toHaveAttribute('placeholder', 'Search pages... (> commands, # headings, @ sites)')
})

test('typing a page name lists only Pages (and Full text), not headings or commands', async ({ page }) => {
  // "recovery" is the title of the page "Service recovery" and also matches two headings on the open page.
  await page.goto('/sre/runbooks/service-recovery.md')
  await expect(page.locator('.markdown-scroll')).toBeVisible()
  const palette = await openPaletteWithShortcut(page)
  const search = palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL })
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
  const search = palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL })

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
  const search = palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL })

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

test('a heading of another page is listed below pages and opens that page at the heading', async ({ page }) => {
  await page.goto(`/sre/${CHECKOUT_PATH}`)
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()
  const palette = await openPaletteWithShortcut(page)
  const search = palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL })

  await search.fill('request path')
  await expect(palette.locator('.palette-section-title')).toHaveText(['Headings in other pages'])
  const heading = palette.getByRole('option', { name: /Request path/ })
  await expect(heading).toContainText('Service recovery · runbooks')
  // This site has no page text search, so the heading is the first row and Enter opens it.
  await expect(heading).toHaveAttribute('aria-selected', 'true')
  await search.press('Enter')
  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(/\/sre\/runbooks\/service-recovery\.md#md-request-path$/)
  await expect(page.locator('.markdown-scroll')).toBeVisible()
  await expect(page.locator('#md-request-path')).toBeInViewport()
})

test('a folder with several pages is listed below the page matches and opens its folder route', async ({ page }) => {
  await registerTextSearchSite(page)
  await page.goto('/textsearch')
  await expect(page.getByRole('complementary', { name: 'Text Search navigation' })).toBeVisible()
  const palette = await openPaletteWithShortcut(page)
  const search = palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL })

  await search.fill('bulk')
  const titles = await palette.locator('.palette-section-title').allTextContents()
  expect(titles.slice(0, 3)).toEqual(['Pages', 'Full text', 'Folders'])
  // Pages keep priority: the first Enter would open a page, not the folder.
  await expect(palette.locator('.palette-section').first().getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
  const folder = palette.getByRole('option', { name: /^bulk/ })
  await expect(folder).toContainText('24 pages')
  await folder.click()
  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(/\/textsearch\/bulk$/)
  await expect(page.getByTestId('directory-page').getByRole('heading', { level: 1, name: 'bulk' })).toBeVisible()
})

test('full-text search stays the default Enter target when only headings of other pages match', async ({ page }) => {
  await registerTextSearchSite(page)
  await page.goto(`/textsearch/${CHECKOUT_PATH}`)
  await expect(page.getByRole('complementary', { name: 'Text Search navigation' })).toBeVisible()
  const palette = await openPaletteWithShortcut(page)
  const search = palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL })

  await search.fill('request path')
  await expect(palette.locator('.palette-section-title')).toHaveText(['Full text', 'Headings in other pages'])
  await expect(palette.getByRole('option', { name: /Request path/ })).toBeVisible()
  await expect(palette.getByRole('option', { name: /Search full text for/ })).toHaveAttribute('aria-selected', 'true')
  await search.press('Enter')
  await expect(page).toHaveURL(/\/textsearch\/_search\?q=request(%20|\+)path$/)
})

test('a one-page wrapper folder that matched only through its parent does not echo its page', async ({ page }) => {
  await page.goto(`/sre/${TOPOLOGY_PATH}`)
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()
  const palette = await openPaletteWithShortcut(page)
  await palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL }).fill('incidents')
  await expect(palette.getByRole('option', { name: /Checkout latency incident review/ })).toBeVisible()
  await expect(palette.locator('[data-palette-entry-id="folder:sre:incidents"]')).toBeVisible()
  await expect(palette.locator('[data-palette-entry-id="folder:sre:incidents/checkout-latency"]')).toHaveCount(0)
})

test('# searches headings of all pages with the open page first', async ({ page }) => {
  await page.goto(`/sre/${CHECKOUT_PATH}`)
  await expect(page.locator('iframe.artifact-frame')).toBeVisible()
  const palette = await openPaletteWithShortcut(page)
  const search = palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL })

  await search.fill('#follow')
  await expect(palette.locator('.palette-section-title')).toHaveText(['In Checkout latency incident review', 'In other pages'])
  const options = palette.getByRole('option')
  await expect(options.nth(0)).toContainText('Follow-up')
  await expect(options.nth(1)).toContainText('Latency Retrospective')
  await options.nth(1).click()
  await expect(page).toHaveURL(/\/sre\/reports\/latency-retrospective\.md#md-follow-up$/)

  const reopened = await openPaletteWithShortcut(page)
  await reopened.getByRole('combobox', { name: PALETTE_SEARCH_LABEL }).fill('#')
  await expect(reopened.locator('.palette-section-title')).toHaveText(['In Latency Retrospective'])
  await reopened.getByRole('combobox', { name: PALETTE_SEARCH_LABEL }).fill('#zzzzzzzz')
  await expect(reopened).toContainText('No headings match.')
})

test('plain search stays in the active site', async ({ page }) => {
  await page.goto('/sre')
  const palette = await (async () => {
    await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
    return page.getByRole('dialog', { name: 'Command palette' })
  })()
  const search = palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL })
  // "Button guidelines" is a Frontend page; it is only reachable by switching sites.
  await search.fill('Button guidelines')
  await expect(palette.getByRole('option', { name: /Button guidelines/ })).toHaveCount(0)
  await search.fill('platform')
  await expect(palette.getByRole('option', { name: /Platform topology/ })).toBeVisible()
  await expect(palette.locator('.palette-section-title')).toHaveText(['Pages', 'Folders'])
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
    const search = palette.getByRole('combobox', { name: PALETTE_SEARCH_LABEL })
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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })

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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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

  await page.setViewportSize({ width: 1100, height: 420 })
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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('#repeated heading')
  const duplicateOptions = palette.locator('.palette-section').first().getByRole('option', { name: /Repeated heading/ })
  await expect(duplicateOptions).toHaveCount(2)
  await duplicateOptions.last().click()
  const duplicateHeading = reader.locator('#md-repeated-heading-1')
  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(/#md-repeated-heading-1$/)
  await expect(duplicateHeading).toBeInViewport()
  await expect.poll(() => scrollport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
})

test('a known HTML document whose body fails to load shows reader guidance and can be retried', async ({ page }) => {
  const artifactPath = 'guides/missing.html'
  let available = false
  await page.route('**/_indexes/sre/index.json', async (route) => {
    const response = await route.fetch()
    const index = await response.json() as { artifacts: Array<Record<string, unknown>> }
    index.artifacts.push({
      id: artifactPath,
      title: 'Missing body',
      path: artifactPath,
      format: 'html',
      filename: 'missing.html',
      artifactUrl: `/_artifacts/sre/${artifactPath}`,
      updatedAt: '2026-10-01T00:00:00Z',
    })
    await route.fulfill({ response, body: JSON.stringify(index) })
  })
  await page.route(`**/_artifacts/sre/${artifactPath}`, (route) => available
    ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Back</title><p id="body">Body is back</p>' })
    : route.fulfill({ status: 404, contentType: 'text/html; charset=utf-8', body: '<h1>404 Not Found</h1>' }))

  await page.goto(`/sre/${artifactPath}`)
  const alert = page.getByRole('alert')
  await expect(alert.getByRole('heading', { name: 'Document unavailable' })).toBeVisible()
  await expect(alert).toContainText('The content of “Missing body” could not be loaded (HTTP 404).')
  await expect(alert.getByRole('link', { name: /← / })).toBeVisible()
  await expect(page.locator('iframe[title="Missing body"]')).toBeHidden()

  // A retry while the body is still missing keeps the guidance and returns focus to the button.
  await alert.getByRole('button', { name: 'Try again' }).click()
  await expect(alert.getByRole('button', { name: 'Try again' })).toBeFocused()
  await expect(alert).toContainText('HTTP 404')

  available = true
  await alert.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.frameLocator('iframe[title="Missing body"]').locator('#body')).toHaveText('Body is back')
  await expect(page.locator('iframe[title="Missing body"]')).toBeFocused()
  await expect(page).toHaveURL(new RegExp(`/sre/${artifactPath}$`))
})

test('navigating inside a working HTML frame to a failing page does not mark the document unavailable', async ({ page }) => {
  const artifactPath = 'guides/working.html'
  await page.route('**/_indexes/sre/index.json', async (route) => {
    const response = await route.fetch()
    const index = await response.json() as { artifacts: Array<Record<string, unknown>> }
    index.artifacts.push({
      id: artifactPath,
      title: 'Working body',
      path: artifactPath,
      format: 'html',
      filename: 'working.html',
      artifactUrl: `/_artifacts/sre/${artifactPath}`,
      updatedAt: '2026-10-01T00:00:00Z',
    })
    await route.fulfill({ response, body: JSON.stringify(index) })
  })
  await page.route(`**/_artifacts/sre/${artifactPath}`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><title>Working</title><a id="go" href="/_artifacts/sre/guides/gone.html">Go</a>',
  }))
  await page.route('**/_artifacts/sre/guides/gone.html', (route) => route.fulfill({
    status: 404,
    contentType: 'text/html; charset=utf-8',
    body: '<h1 id="gone">404 Not Found</h1>',
  }))

  await page.goto(`/sre/${artifactPath}`)
  const frame = page.frameLocator('iframe[title="Working body"]')
  await frame.locator('#go').click()
  await expect(frame.locator('#gone')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('iframe[title="Working body"]')).toBeVisible()
})

test('HTML heading navigation keeps the URL and iframe section in sync with one history step', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 }) // below the reader column breakpoint (ISSUE-108): Contents and Details open as panels
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
  await page.setViewportSize({ width: 1100, height: 800 }) // below the reader column breakpoint (ISSUE-108): Contents and Details open as panels
  const iframe = page.locator('iframe[title="Designing for resilience"]')
  const iframeScrollY = () => iframe.evaluate((frame) => (frame as HTMLIFrameElement).contentWindow?.scrollY ?? -1)
  const iframeHash = () => iframe.evaluate((frame) => (frame as HTMLIFrameElement).contentWindow?.location.hash ?? null)
  const contentsButton = page.locator('.context-actions .context-button[title^="Contents"]')
  const detailsButton = page.locator('.context-actions .context-button[title="Artifact details"]')

  for (const viewport of [{ width: 1100, height: 800 }, { width: 390, height: 844 }]) {
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

    await clickToolbarAction(page, contentsButton, 'Contents')
    const contents = page.getByRole('complementary', { name: 'Contents' })
    const closeContents = contents.getByRole('button', { name: 'Close Contents' })
    await expect(closeContents).toBeVisible()
    await expect(closeContents).toBeInViewport()
    await expect(closeContents).toHaveAttribute('title', 'Close Contents')
    await closeContents.click()
    await expect(contents).toBeHidden()
    await expect(toolbarFocusTarget(page, contentsButton)).toBeFocused()
    await expectReadingPositionPreserved()

    await clickToolbarAction(page, contentsButton, 'Contents')
    await expect(contents).toBeVisible()
    await expectReadingPositionPreserved()
    await clickToolbarAction(page, detailsButton, 'Details')
    const details = page.getByRole('complementary', { name: 'Details' })
    const closeDetails = details.getByRole('button', { name: 'Close Details' })
    await expect(closeDetails).toBeVisible()
    await expect(closeDetails).toHaveAttribute('title', 'Close Details')
    await closeDetails.click()
    await expect(details).toBeHidden()
    await expect(toolbarFocusTarget(page, detailsButton)).toBeFocused()
    await expectReadingPositionPreserved()

    await clickToolbarAction(page, detailsButton, 'Details')
    await expect(details).toBeVisible()
    await expectReadingPositionPreserved()
    expect(await iframe.evaluate((frame) => frame.getBoundingClientRect().width)).toBe(frameWidth)

    await clickToolbarAction(page, contentsButton, 'Contents')
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
      { width: 1100, height: 800, sidebar: true },
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

      const contentsToggle = page.locator('.context-actions .context-button[title^="Contents"]')
      await clickToolbarAction(page, contentsToggle, 'Contents')
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
        await expect(toolbarFocusTarget(page, contentsToggle), label).toBeFocused()
      } else if (intersects(headingBox, panelBox)) {
        await expect(contents, label).toBeHidden()
        await expect(toolbarFocusTarget(page, contentsToggle), label).toBeFocused()
      } else {
        expect(viewport.width, label).toBeGreaterThan(620)
        await expect(contents, label).toBeVisible()
        await expect(entry, label).toBeFocused()
        await expect(entry, label).toHaveAttribute('aria-current', 'location')
        keptOpenCases += 1
        expect(target.name, label).toBe('Markdown')
        if (viewport.width === 1100) keptOpenAtDesktop = true
      }
    }
  }
  expect(keptOpenCases).toBeGreaterThan(0)
  expect(keptOpenAtDesktop).toBe(true)
})

test('a stale heading-jump check never closes a reopened Contents panel', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 })
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
  await page.setViewportSize({ width: 1100, height: 800 }) // below the reader column breakpoint (ISSUE-108): Contents and Details open as panels
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
  await expect(details.getByText('Last committed by')).toHaveCount(0)
  await expect(details.getByText('Maya Chen', { exact: true })).toBeVisible()
  await expect(details.getByText('Sep 22, 2026')).toBeVisible()
  const sourceLink = details.getByRole('link', { name: /\.md|\.html/ })
  await expect(sourceLink).toHaveAttribute('href', /^https:\/\/github\.com\/example\/payments\/blob\/[^/]+\/.+/)
  await expect(sourceLink).toHaveAttribute('target', '_blank')
  await expect(sourceLink).toHaveAttribute('rel', 'noreferrer')
  await expect(details.getByText('example/payments', { exact: true })).toBeVisible()

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
  await palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' }).fill('設計')
  await expect(palette.getByRole('option', { name: /設計 Note/ })).toBeVisible()
})

test('Markdown pages render safely with GFM, Mermaid, local assets, and extensionful links', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 }) // below the reader column breakpoint (ISSUE-108): Contents and Details open as panels
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
  await page.setViewportSize({ width: 1100, height: 800 }) // below the reader column breakpoint (ISSUE-108): Contents and Details open as panels
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
  // At 390px the theme choice lives in the More menu (ISSUE-080).
  await moreActionsButton(page).click()
  await page.getByRole('menuitemradio', { name: 'Theme: Dark' }).click()
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
  await homePalette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' }).fill('Go to site home')
  await homePalette.getByRole('option', { name: /Go to site home/ }).click()
  await expect(page).toHaveURL(/\/sre$/)
  await expect(sidebar).toBeHidden()

  await page.getByRole('button', { name: 'Expand navigation' }).click()
  await page.getByRole('button', { name: 'Switch site. Current site: SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  await expect(reader.locator('figure.markdown-diagram[data-diagram-type="flowchart"] .katex')).toBeVisible()
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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  const systemSearch = systemPalette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  const artifactSearch = searchPalette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
  await artifactSearch.fill('Platform topology')
  await expect(searchPalette.getByRole('option', { name: /Platform topology/ })).toBeVisible()
  await artifactSearch.press('Enter')
  await expect(searchPalette).toBeHidden()

  await expect(page).toHaveURL(/\/sre\/architecture\/platform-topology\/index\.html$/)
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Artifact path' })).not.toContainText('SRE')

  await page.getByRole('button', { name: 'Switch site. Current site: SRE' }).click()
  const sitePalette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(sitePalette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })).toHaveValue('@')
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
    const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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

  // Filename order puts follow-up-01..28 before index.html (ISSUE-076); Home reaches the first sibling.
  await page.keyboard.press('Home')
  const firstSibling = menu.getByRole('menuitem', { name: /Follow-up 01/ })
  await expect(firstSibling).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: /Follow-up 02/ })).toBeFocused()
  await page.keyboard.press('Home')
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
  await expect(page.getByTestId('directory-page').getByRole('searchbox')).toHaveCount(0)
  const homeJump = page.getByRole('button', { name: 'Search this site' })
  await homeJump.click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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

  // Site home and all sites are More menu items; the site switcher is in the drawer (ISSUE-080).
  await moreActionsButton(page).click()
  const menu = page.getByRole('menu', { name: 'More actions' })
  await expect(menu.getByRole('menuitem', { name: 'SRE home' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'SRE home' }).click()
  await expect(page).toHaveURL(/\/sre\/?$/)
  await expect(page.getByRole('heading', { name: 'SRE' })).toBeVisible()
})

test('all-sites navigation is available from site home and documents with the sidebar closed on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })

  for (const path of ['/sre', '/sre/reports/latency-retrospective.md']) {
    await page.goto(path)
    await expect(page.locator('.sidebar-panel')).toBeHidden()

    await moreActionsButton(page).click()
    const menu = page.getByRole('menu', { name: 'More actions' })
    const allSitesItem = menu.getByRole('menuitem', { name: 'All sites' })
    await expect(allSitesItem).toBeVisible()
    if (path !== '/sre') {
      await expect(menu.getByRole('menuitem', { name: 'SRE home' })).toBeVisible()
    }

    await allSitesItem.click()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  }
})

test('site home hides artifact actions while an open artifact provides usable actions', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 }) // below the reader column breakpoint (ISSUE-108): Contents and Details open as panels
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

test('a site index with a malformed row is a load error with a republish hint', async ({ page }) => {
  await page.route('**/_indexes/sre/index.json', async (route) => {
    const response = await route.fetch()
    const index = await response.json() as { artifacts: Array<Record<string, unknown>> }
    await route.fulfill({ response, json: { ...index, artifacts: [{ id: 'broken' }, ...index.artifacts.slice(1)] } })
  })
  await page.goto('/sre/')

  await expect(page.getByRole('heading', { name: 'Unable to load this site' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText(
    "This site's index is damaged or was written by an incompatible publisher. Ask the site's publisher to republish it.",
  )
  await page.unrouteAll({ behavior: 'wait' })
})

test('a render-time exception shows the recovery screen instead of a blank page', async ({ page }) => {
  // buildArtifactTree (inside ArtifactTree's useMemo) sorts directory names with compareNames,
  // which calls String.prototype.toLowerCase on the 'incidents' folder name while React renders
  // the site page. Only that call throws, and only while the flag is set, so the load itself
  // and the rest of the app are unaffected.
  await page.addInitScript(() => {
    ;(window as unknown as { __apForceRenderError: boolean }).__apForceRenderError = true
    const original = String.prototype.toLowerCase
    String.prototype.toLowerCase = function (this: string) {
      if ((window as unknown as { __apForceRenderError?: boolean }).__apForceRenderError === true && String(this) === 'incidents') {
        throw new Error('forced render error')
      }
      return original.call(this)
    }
  })
  await page.goto('/sre/')

  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible()
  await expect(page.getByRole('link', { name: '← All sites' })).toHaveAttribute('href', '/')
})

const previewHeadSha = '0123456789abcdef0123456789abcdef01234567'

/** The open preview document's title: the last breadcrumb of the reader shell. */
function previewTitle(page: Page) {
  return page.locator('.preview-crumbs .breadcrumb-current')
}

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
  const recent = page.locator('.directory-page .artifact-list-section[aria-label="Recently updated"]')
  const browse = page.getByTestId('directory-page')
  await expect(recent).toBeVisible()
  await expect(browse).toBeVisible()
  await expect(recent).not.toContainText(previewOnlyTitle)
  await expect(browse).not.toContainText(previewOnlyTitle)
  const previewsLink = page.getByRole('navigation', { name: 'Site sections' }).getByRole('link', { name: /^Previews/ })
  await expect(previewsLink.locator('.site-section-count')).toHaveText('1')
  expect(previewRequests).toContain('/_previews/showcase/catalog.json')
  expect(previewRequests).toContain(`/_previews/showcase/revisions/${previewHeadSha}/manifest.json`)

  await expect(previewsLink).toHaveAttribute('href', '/showcase/_previews')
  await expectModifiedClickKeptForBrowser(page, previewsLink)
  await expect(page).toHaveURL('/showcase')

  await previewsLink.click()
  await expect(page).toHaveURL('/showcase/_previews')
  await expect(page.getByRole('region', { name: 'Preview pr:701' })).toBeVisible()
  // The time names its zone and keeps the full-precision UTC instant.
  const previewTime = page.getByRole('region', { name: 'Preview pr:701' }).locator('time')
  await expect(previewTime).toHaveAttribute('datetime', '2026-09-27T00:00:00.000Z')
  await expect(previewTime).toHaveAttribute('title', '2026-09-27 00:00:00 UTC')
  await expect(previewTime).toHaveText(/\d{4}, \d{1,2}:\d{2} [AP]M \S+$/)
  await expect(page.getByRole('link', { name: previewOnlyTitle })).toBeVisible()
  expect(previewRequests).toContain('/_previews/showcase/catalog.json')
  expect(previewRequests).toContain(`/_previews/showcase/revisions/${previewHeadSha}/manifest.json`)

  await page.getByRole('navigation', { name: 'Site sections' }).getByRole('link', { name: 'Files' }).click()
  await expect(page).toHaveURL('/showcase')
  await expect(recent).toBeVisible()
  await expect(browse).toBeVisible()
  await expect(recent).not.toContainText(previewOnlyTitle)
  await expect(browse).not.toContainText(previewOnlyTitle)

  previewRequests.length = 0
  await page.getByRole('button', { name: 'Jump to a page in HTML Showcase' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const paletteSearch = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
  await palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' }).fill('>open previews')
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
  // The failed list can be retried in place, and the count stays absent while it fails.
  await expect(page.locator('.site-section-count')).toHaveCount(0)
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('alert')).toHaveText('The preview list could not be loaded.')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeFocused()
  catalogState = 'empty'
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('status')).toHaveText('There are no available previews for this site.')
  await page.getByRole('navigation', { name: 'Site sections' }).getByRole('link', { name: 'Files' }).click()
  await expect(page).toHaveURL('/sre')
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
})

test('site home keeps Previews reachable when none are available and the empty section explains it', async ({ page }) => {
  await page.route('**/_previews/sre/catalog.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ schemaVersion: 1, site: 'sre', groups: [] }),
  }))

  await page.goto('/sre')
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
  const previewEntry = page.getByRole('navigation', { name: 'Site sections' }).getByRole('link', { name: /^Previews/ })
  await expect(previewEntry).toHaveAttribute('href', '/sre/_previews')
  await expect(previewEntry.locator('.site-section-count')).toHaveText('0')
  await expect(page.getByText(/^Previews are review copies of changed documents/)).toHaveCount(0)
  await previewEntry.click()
  await expect(page).toHaveURL('/sre/_previews')
  await expect(previewEntry).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('status')).toHaveText('There are no available previews for this site.')
  await expect(page.getByText(/Previews show changed documents from pull requests and manual preview builds\./)).toBeVisible()
  await page.getByRole('navigation', { name: 'Site sections' }).getByRole('link', { name: 'Files' }).click()
  await expect(page).toHaveURL('/sre')
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()

  // The standalone list (no site index to build the home from) still offers the way back.
  await page.route('**/_indexes/sre/index.json', (route) => route.fulfill({ status: 503, body: 'unavailable' }))
  await page.goto('/sre/_previews')
  await expect(page.getByRole('status')).toHaveText('There are no available previews for this site.')
  await page.getByRole('link', { name: 'Back to site home' }).click()
  await expect(page).toHaveURL('/sre')
})

test('site home keeps the preview entry active when previews exist', async ({ page }) => {
  await page.goto('/sre')
  const previewEntry = page.getByRole('navigation', { name: 'Site sections' }).getByRole('link', { name: /^Previews/ })
  await expect(previewEntry.locator('.site-section-count')).toBeVisible()
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
  await page.getByRole('navigation', { name: 'Site sections' }).getByRole('link', { name: /^Previews/ }).click()
  await catalogStarted
  await expect(page.getByRole('status')).toHaveText('Loading previews…')
  // No number is shown before the catalog has loaded.
  await expect(page.locator('.site-section-count')).toHaveCount(0)
  try {
    await page.getByRole('navigation', { name: 'Site sections' }).getByRole('link', { name: 'Files' }).click()
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
  await expect(page.getByRole('link', { name: '#42 on GitHub' })).toHaveAttribute('href', 'https://github.com/acme/sre-docs/pull/42')
  await expect(previewTitle(page)).toHaveText('Local preview guide')
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
  await expect(previewTitle(page)).toHaveText('Encoded preview route')
  await page.reload()
  await expect(previewTitle(page)).toHaveText('Encoded preview route')

  await page.goto('/sre/_previews?group=pr%3A43')
  await expect(page.getByRole('region', { name: 'Preview pr:43' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Preview pr:42' })).toHaveCount(0)
  await page.getByRole('region', { name: 'Preview pr:43' }).getByRole('link', { name: /Local preview guide/ }).click()
  await expect(page.getByRole('link', { name: '#43 on GitHub' })).toHaveAttribute('href', 'https://github.com/acme/sre-docs/pull/43')

  await page.goto('/sre/_previews')
  await page.getByRole('region', { name: `Preview head:${previewHeadSha}` })
    .getByRole('link', { name: /Local preview guide/ }).click()
  await expect(page).toHaveURL(new RegExp(`/sre/_previews/${previewHeadSha}/guides/preview-guide\\.md\\?group=head%3A${previewHeadSha}$`))
  await expect(page.getByRole('link', { name: /on GitHub/ })).toHaveCount(0)
})

test('the in-site palette opens previews by command without loading preview data itself', async ({ page }) => {
  const previewRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.includes('/_previews/')) previewRequests.push(pathname)
  })

  await page.goto('/sre')
  await expect(page.locator('.site-section-count')).toBeVisible()
  previewRequests.length = 0
  await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  // Previews are not palette results; they are reached through the Open previews command.
  await palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' }).fill('Local preview guide')
  await expect(palette.getByRole('option', { name: /Local preview guide/ })).toHaveCount(0)
  await palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' }).fill('>previews')
  expect(previewRequests).toEqual([])
  await palette.getByRole('option', { name: /Open previews/ }).click()
  await expect(page).toHaveURL('/sre/_previews')
  await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
  // The list joins the load the section badge already made during this visit.
  expect(previewRequests.filter((pathname) => pathname === '/_previews/sre/catalog.json')).toEqual([])
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
  await expect(page.getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
  catalogState = 'advanced'
  await page.reload()
  await expect(previewTitle(page)).toHaveText('Local preview guide')
  await expect(page.getByRole('link', { name: /on GitHub/ })).toHaveCount(0)

  catalogState = 'removed'
  await page.reload()
  await expect(previewTitle(page)).toHaveText('Local preview guide')
  await expect(page.getByRole('link', { name: /on GitHub/ })).toHaveCount(0)

  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview-guide.md?group=pr%3A43`)
  await expect(page.getByRole('link', { name: '#43 on GitHub' })).toHaveAttribute('href', 'https://github.com/acme/sre-docs/pull/43')
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
  await expect(previewTitle(page)).toHaveText('Local preview HTML')
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
  await expect(page.getByRole('link', { name: '#42 on GitHub' })).toBeVisible()

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
  await expect(page.getByRole('link', { name: '#42 on GitHub' })).toBeVisible()

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
  await expect(page.getByRole('link', { name: '#42 on GitHub' })).toBeVisible()

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
  await expect(page.getByRole('link', { name: '#42 on GitHub' })).toBeVisible()

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
  await expect(page.getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
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
  await expect(page.getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
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
  await expect(previewTitle(page)).toHaveText('Preview fragment target')
  await expect(page.locator('.preview-path')).toHaveText('guides/preview-target.html')
  await expect(page.frameLocator('iframe[title="Preview fragment target"]').getByRole('heading', { name: 'Changed HTML target' })).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(1)
  releaseBridge?.()

  // The frame's own early navigation must not leave a dead Back step: one Back is the previous document, the next leaves the preview.
  const targetUrl = `/sre/_previews/${previewHeadSha}/guides/preview-target.html?group=pr%3A42&source=fixture#changed-target`
  await page.goBack()
  await expect(page).toHaveURL(previewUrl)
  await expect(previewTitle(page)).toHaveText('Local preview HTML')
  await expect(page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open a changed HTML document with fragment' })).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(1)
  await page.goBack()
  await expect(page).toHaveURL('/sre')
  await page.goForward()
  await expect(page).toHaveURL(previewUrl)
  await expect(previewTitle(page)).toHaveText('Local preview HTML')
  await page.goForward()
  await expect(page).toHaveURL(targetUrl)
  await expect(previewTitle(page)).toHaveText('Preview fragment target')
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
  await expect(previewTitle(page)).toHaveText('Local preview HTML')

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

test('a direct preview document resolves without catalog membership and never shows a stale PR', async ({ page }) => {
  const catalogRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.endsWith('/_previews/sre/catalog.json')) catalogRequests.push(pathname)
  })
  await page.route('**/_previews/sre/catalog.json', (route) => route.fulfill({ status: 404, body: 'catalog unavailable' }))

  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview-guide.md`)
  await expect(previewTitle(page)).toHaveText('Local preview guide')
  await expect(page.getByRole('link', { name: /on GitHub/ })).toHaveCount(0)
  // The revision reads; only the details that need the catalog are reported missing.
  await expect(page.getByText('Preview details could not be loaded; this revision is shown as published.')).toBeVisible()
  expect(catalogRequests.length).toBeGreaterThan(0)

  const missingManifest = await page.request.get('/_previews/sre/revisions/ffffffffffffffffffffffffffffffffffffffff/manifest.json')
  expect(missingManifest.status()).toBe(404)
  await page.goto('/sre/_previews/ffffffffffffffffffffffffffffffffffffffff/guides/missing.md')
  await expect(page.getByRole('heading', { name: 'Preview unavailable' })).toBeVisible()
  await page.getByRole('main').getByRole('link', { name: 'Preview list' }).click()
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
  /** The results page's field. */
  const field = (page: Page) => page.getByRole('searchbox', { name: 'Search page text in Text Search' })
  /** The sidebar's title and path filter. */
  const filter = (page: Page) => page.getByRole('searchbox', { name: 'Filter pages in Text Search by title or path' })
  const sidebar = (page: Page) => page.locator('.sidebar-panel')
  const status = (page: Page) => page.locator('.search-page-count-text')
  const hits = (page: Page) => page.locator('.search-page-results [data-hit-id]')
  const facets = (page: Page) => page.locator('.search-page-facets .search-page-facet')
  const matchNav = (page: Page) => page.getByRole('group', { name: 'Matches in this page' })
  const highlightSize = (target: Page | import('@playwright/test').Frame, name = 'gap-page-text-search') => target.evaluate((highlight) => (
    (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get(highlight)?.size ?? 0
  ), name)

  /** Lowers the ranking threshold (test-only `window.__artifactPagesTest`) so the 24 "lighthouse" notes exceed it and the paged, path-ordered fallback is shown. */
  async function usePagedFallback(page: Page) {
    await page.addInitScript(() => {
      ;(window as unknown as { __artifactPagesTest: { rankingMaxHits: number } }).__artifactPagesTest = { rankingMaxHits: 20 }
    })
  }

  function recordSearchRequests(page: Page) {
    const requests: string[] = []
    page.on('request', (request) => {
      if (isSearchDataRequest(request.url())) requests.push(new URL(request.url()).pathname)
    })
    return requests
  }

  /** Moves the app to another URL without a reload, as back/forward would. */
  async function changeUrl(page: Page, href: string) {
    await page.evaluate((target) => {
      history.pushState({}, '', target)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, href)
  }

  async function pressImeEnter(page: Page, variant: 'isComposing' | 'keyCode229') {
    await field(page).evaluate((input, kind) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: kind === 'isComposing' })
      if (kind === 'keyCode229') Object.defineProperty(event, 'keyCode', { value: 229 })
      input.dispatchEvent(event)
    }, variant)
  }

  /** The facets as "label:count" strings. */
  async function facetSummary(page: Page) {
    return facets(page).evaluateAll((buttons) => buttons.map((button) => (
      `${button.children[0].textContent}:${button.children[1].textContent}${button.getAttribute('aria-pressed') === 'true' ? '*' : ''}`
    )))
  }

  /** Records the results page status and alerts on every DOM change from now on (and once at once). */
  async function startStatusRecorder(page: Page) {
    await page.evaluate(() => {
      const records: string[] = []
      const snapshot = () => {
        const label = document.querySelector('.search-page-count-text')?.textContent ?? ''
        const alert = document.querySelector('.search-page [role="alert"]')?.textContent
        const entry = alert ? `alert: ${alert}` : `status: ${label}`
        if (records[records.length - 1] !== entry) records.push(entry)
      }
      const observer = new MutationObserver(snapshot)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      snapshot()
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

  test('the sidebar filters titles and paths without searching, and Enter opens the results page', async ({ page }) => {
    const requests = recordSearchRequests(page)
    await page.goto('/textsearch')
    await expect(page.getByRole('heading', { name: 'Text Search', exact: true })).toBeVisible()
    await expect(sidebar(page).getByRole('button', { name: 'Jump to a page in Text Search' })).toHaveCount(0)

    await filter(page).focus()
    await filter(page).pressSequentially('latency')
    const section = sidebar(page).locator('.filter-results')
    await expect(section.locator('a[data-tree-path="reports/latency-retrospective.md"]')).toBeVisible()
    // The tree is filtered by title and path; the last row leads to the results page.
    await expect(sidebar(page).locator('.browse-tree')).toHaveCount(0)
    const fullTextRow = section.getByRole('link', { name: /Search full text for “latency”/ })
    await expect(fullTextRow).toHaveAttribute('href', '/textsearch/_search?q=latency')
    // Typing, and an IME conversion's Enter, search nothing and change nothing.
    await expect(page).toHaveURL(/\/textsearch$/)
    expect(requests).toEqual([])
    // ↓ moves from the field to the first title match.
    await page.keyboard.press('ArrowDown')
    await expect(section.locator('a[data-tree-path]').first()).toBeFocused()
    await filter(page).focus()

    await filter(page).press('Enter')
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=latency$/)
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    // The results page is ready to refine, and the sidebar is back to browsing.
    await expect(field(page)).toHaveValue('latency')
    await expect(field(page)).toBeFocused()
    await expect(filter(page)).toHaveValue('')
    await expect(sidebar(page).locator('.browse-tree')).toBeVisible()
    expect(requests[0]).toBe('/_indexes/textsearch/search/manifest.json')
    expect(requests.every((pathname) => pathname.startsWith('/_indexes/textsearch/search/'))).toBe(true)

    // The row works as a link too.
    await page.goto('/textsearch')
    await filter(page).fill('lighthouse')
    await sidebar(page).getByRole('link', { name: /Search full text for “lighthouse”/ }).click()
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=lighthouse$/)
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
  })

  test('a filter without title or path matches still offers the full-text search, and Esc clears it', async ({ page }) => {
    await page.goto('/textsearch')
    await filter(page).fill('zzzqqq')
    await expect(sidebar(page).getByText('No titles or paths match “zzzqqq”.')).toBeVisible()
    await expect(sidebar(page).getByRole('link', { name: /Search full text for “zzzqqq”/ })).toBeVisible()
    await filter(page).press('Escape')
    await expect(filter(page)).toHaveValue('')
    await expect(sidebar(page).locator('.browse-tree')).toBeVisible()
    await filter(page).fill('x')
    await sidebar(page).getByRole('button', { name: 'Clear filter' }).click()
    await expect(filter(page)).toBeFocused()
    await expect(filter(page)).toHaveValue('')
    // A blank filter never opens the results page.
    await filter(page).fill('   ')
    await filter(page).press('Enter')
    await expect(page).toHaveURL(/\/textsearch$/)
  })

  test('the results page has a titled, shareable URL', async ({ page }) => {
    await page.goto('/textsearch/_search?q=latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await expect(page).toHaveTitle('Search “latency” · Text Search')
    await page.reload()
    await expect(field(page)).toHaveValue('latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')

    await page.goto('/textsearch/_search')
    await expect(page).toHaveTitle('Search · Text Search')
    await expect(status(page)).toHaveText('Type to search page text.')
    await expect(field(page)).toBeFocused()
    await expect(page.getByRole('heading', { level: 1, name: 'Search Text Search' })).toBeAttached()
  })

  test('results update as you type, replace the history entry, and wait for an IME conversion', async ({ page }) => {
    const requests = recordSearchRequests(page)
    await page.goto('/textsearch/_search')
    await expect(field(page)).toBeFocused()
    expect(requests).toEqual([])
    const historyLength = await page.evaluate(() => history.length)

    await field(page).pressSequentially('latency')
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=latency$/)
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await field(page).fill('lighthouse')
    await expect(page).toHaveURL(/\?q=lighthouse$/)
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    // Typing replaces the entry instead of adding one per query.
    expect(await page.evaluate(() => history.length)).toBe(historyLength)

    // Clearing goes back to the empty page at once.
    await field(page).press('Escape')
    await expect(field(page)).toHaveValue('')
    await expect(page).toHaveURL(/\/textsearch\/_search$/)
    await expect(status(page)).toHaveText('Type to search page text.')

    // Nothing is searched while a conversion is in progress, not even its Enter.
    await field(page).evaluate((input) => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    await field(page).fill('latency')
    await pressImeEnter(page, 'isComposing')
    await pressImeEnter(page, 'keyCode229')
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))
    await expect(page).toHaveURL(/\/textsearch\/_search$/)
    await field(page).evaluate((input) => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    await expect(page).toHaveURL(/\?q=latency$/)
    await expect(status(page)).toHaveText('5 pages contain “latency”')

    // Enter on the query that is already shown adds no history entry and fetches nothing.
    const requestCount = requests.length
    await field(page).press('Enter')
    await field(page).press('Enter')
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
    expect(requests).toHaveLength(requestCount)
  })

  test('Back returns through the typed query to the page the search started from', async ({ page }) => {
    await page.goto('/textsearch/reports/latency-retrospective.md')
    await filter(page).fill('latency')
    await filter(page).press('Enter')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await field(page).fill('lighthouse')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    await hits(page).first().click()
    await expect(page).toHaveURL(/\/textsearch\/bulk\/note-01\.md\?q=lighthouse#md-[^/]+$/)

    await page.goBack()
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=lighthouse$/)
    await expect(field(page)).toHaveValue('lighthouse')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    await page.goBack()
    await expect(page).toHaveURL(/\/textsearch\/reports\/latency-retrospective\.md$/)
    await page.goForward()
    await expect(field(page)).toHaveValue('lighthouse')
    // The field follows the URL after history navigation.
    await changeUrl(page, '/textsearch/_search?q=latency')
    await expect(field(page)).toHaveValue('latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
  })

  test('ranked results are a list of links that open from the keyboard', async ({ page }) => {
    await page.goto('/textsearch/_search?q=latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await expect(field(page)).toBeFocused()
    // Title matches first, path order within a tier.
    await expect(page.getByRole('list', { name: 'Results' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Results' }).getByRole('listitem')).toHaveCount(5)
    const order = ['incidents/checkout-latency/index.html', 'reports/latency-retrospective.md', 'diagrams/mermaid-catalog.md', 'guides/markdown-style-gallery.md', 'runbooks/service-recovery.md']
    expect(await hits(page).evaluateAll((elements) => elements.map((element) => element.getAttribute('data-hit-id')))).toEqual(order)
    await expect(hits(page).first()).toHaveJSProperty('tagName', 'A')
    await expect(hits(page).nth(1)).toHaveAttribute('href', '/textsearch/reports/latency-retrospective.md?q=latency')
    await expect(hits(page).nth(1)).toContainText('reports/latency-retrospective.md')
    await expect(sidebar(page).locator('.page-text-results')).toHaveCount(0)

    // ↓ moves real focus from the field to the first result link, ↑/↓ walk the links, and Enter is the native link activation (ISSUE-104).
    await expect(page.locator('.search-page-result a[aria-current]')).toHaveCount(0)
    const active = page.locator('.search-page-result[data-active]')
    await expect(active).toHaveCount(0)
    await page.keyboard.press('ArrowDown')
    await expect(hits(page).nth(0)).toBeFocused()
    await expect(active.locator('[data-hit-id]')).toHaveAttribute('data-hit-id', 'incidents/checkout-latency/index.html')
    await page.keyboard.press('ArrowDown')
    await expect(hits(page).nth(1)).toBeFocused()
    await expect(active).toHaveCount(1)
    await expect(active.locator('[data-hit-id]')).toHaveAttribute('data-hit-id', 'reports/latency-retrospective.md')
    await expect(page.locator('.search-page-result a[aria-current]')).toHaveCount(0)
    await page.keyboard.press('ArrowUp')
    await expect(hits(page).nth(0)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(field(page)).toBeFocused()
    // Enter in the field commits the query; it never opens a result.
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=latency$/)
    await expect(field(page)).toBeFocused()
    // Escape on a link returns to the field; the last link is a clamp for ↓.
    await page.keyboard.press('ArrowDown')
    await expect(hits(page).nth(0)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(field(page)).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(hits(page).nth(1)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/textsearch\/reports\/latency-retrospective\.md\?q=latency$/)
    await expect(page.getByTestId('markdown-document')).toBeVisible()
    await expect(matchNav(page)).toBeVisible()

    // Other in-site navigation drops the search: the page is read without highlights.
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' }).fill('Platform topology')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/textsearch\/architecture\/platform-topology\/index\.html$/)
    await expect(matchNav(page)).toHaveCount(0)

    // ↓ on the last link stays on it.
    await page.goto('/textsearch/_search?q=latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await hits(page).last().focus()
    await page.keyboard.press('ArrowDown')
    await expect(hits(page).last()).toBeFocused()
  })

  /** Serves the text search manifest with a section table and one text pack for `long/scroll-target.html` (ISSUE-085). */
  async function serveExcerptData(page: Page) {
    const pack = Buffer.from('Middle section The midmarker word is here.')
    const table = Buffer.from(JSON.stringify({
      version: 1,
      documents: [{ path: 'long/scroll-target.html', sections: [{ heading: 'Middle section', anchor: 'middle-section', pack: 0, offset: 0, length: pack.length }] }],
    }))
    const ref = (kind: string, raw: Buffer) => {
      const gz = gzipSync(raw, { level: 9 }), sha256 = createHash('sha256').update(gz).digest('hex')
      return { gz, ref: { url: `/_indexes/textsearch/search/${kind}-${sha256}.gz`, sha256, bytes: gz.length, rawBytes: raw.length } }
    }
    const sections = ref('sections', table), text = ref('text', pack)
    await page.route('**/_indexes/textsearch/search/manifest.json', async (route) => {
      const response = await route.fetch()
      const manifest = await response.json()
      manifest.sections = sections.ref
      manifest.texts = [text.ref]
      manifest.snippetLimits = { maxDocumentBytes: 262144, maxSiteBytes: 33554432, truncatedDocuments: [], omittedDocuments: [] }
      await route.fulfill({ response, json: manifest })
    })
    for (const blob of [sections, text]) {
      await page.route(`**${blob.ref.url}`, (route) => route.fulfill({ body: blob.gz, contentType: 'application/octet-stream' }))
    }
  }

  test('a result shows the text around the match and links to its section', async ({ page }) => {
    await serveExcerptData(page)
    await page.goto('/textsearch/_search?q=midmarker')
    await expect(status(page)).toHaveText('2 pages contain “midmarker”')
    const row = page.locator('.search-page-result', { has: page.locator('[data-hit-id="long/scroll-target.html"]') })
    const excerpt = row.locator('.search-page-result-excerpt')
    await expect(excerpt).toBeVisible()
    await expect(excerpt.locator('.search-page-result-section')).toHaveText('Middle section')
    await expect(excerpt.locator('mark')).toHaveText('midmarker')
    await expect(excerpt.locator('.search-page-result-snippet')).toHaveText('Middle section The midmarker word is here.')
    await expect(row.locator('a')).toHaveCount(1)
    await expect(row.locator('a')).toHaveAttribute('href', /\/textsearch\/long\/scroll-target\.html\?q=midmarker#middle-section$/)
    // The page that has no section data keeps the plain row.
    await expect(page.locator('.search-page-result-excerpt')).toHaveCount(1)
    await row.locator('a').click()
    await expect(page).toHaveURL(/\/textsearch\/long\/scroll-target\.html\?q=midmarker#middle-section$/)
    await expect(page.frameLocator('iframe.artifact-frame').getByRole('heading', { name: 'Middle section' })).toBeInViewport()
  })

  test('a manifest without section data shows plain results without an error', async ({ page }) => {
    await page.route('**/_indexes/textsearch/search/manifest.json', async (route) => {
      const response = await route.fetch()
      const manifest = await response.json()
      delete manifest.sections
      delete manifest.texts
      delete manifest.snippetLimits
      await route.fulfill({ response, json: manifest })
    })
    await page.goto('/textsearch/_search?q=midmarker')
    await expect(status(page)).toHaveText('2 pages contain “midmarker”')
    await expect(page.locator('.search-page-result-excerpt')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('arrow keys move focus along the results and Enter opens the focused one when excerpts are shown', async ({ page }) => {
    await serveExcerptData(page)
    await page.goto('/textsearch/_search?q=midmarker')
    await expect(page.locator('.search-page-result-excerpt')).toHaveCount(1)
    const active = page.locator('.search-page-result[data-active]')
    await page.keyboard.press('ArrowDown')
    await expect(hits(page).nth(0)).toBeFocused()
    await expect(active.locator('[data-hit-id]')).toHaveAttribute('data-hit-id', 'long/scroll-target.html')
    await page.keyboard.press('ArrowDown')
    await expect(hits(page).nth(1)).toBeFocused()
    await expect(active.locator('[data-hit-id]')).toHaveAttribute('data-hit-id', 'long/scroll-target.md')
    await page.keyboard.press('ArrowUp')
    await expect(hits(page).nth(0)).toBeFocused()
    await expect(active.locator('[data-hit-id]')).toHaveAttribute('data-hit-id', 'long/scroll-target.html')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/textsearch\/long\/scroll-target\.html\?q=midmarker#middle-section$/)
  })

  test('the results page moves real focus: ArrowDown enters the list, ArrowUp from the first link returns, Enter commits in the field', async ({ page }) => {
    await page.goto('/textsearch/_search?q=latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await expect(field(page)).toBeFocused()
    await expect(page.locator('.search-page-keys')).toHaveText('↓ results ↑↓ move ↵ open')
    await page.keyboard.press('ArrowDown')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-hit-id'))).toBe('incidents/checkout-latency/index.html')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(field(page)).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/textsearch\/reports\/latency-retrospective\.md\?q=latency$/)
  })

  test('folder facets count the current query and limit the list', async ({ page }) => {
    await page.goto('/textsearch/_search?q=latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await expect(page.getByRole('navigation', { name: 'Folders' })).toBeVisible()
    expect(await facetSummary(page)).toEqual(['All:5*', 'diagrams/:1', 'guides/:1', 'incidents/:1', 'reports/:1', 'runbooks/:1'])

    await facets(page).filter({ hasText: 'guides/' }).click()
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=latency&in=guides$/)
    await expect(status(page)).toHaveText('1 page in guides/ contains “latency”')
    await expect(hits(page)).toHaveCount(1)
    await expect(hits(page).first()).toHaveAttribute('data-hit-id', 'guides/markdown-style-gallery.md')
    // The counts stay those of the whole query, and the choice is shown as pressed.
    expect(await facetSummary(page)).toEqual(['All:5', 'diagrams/:1', 'guides/:1*', 'incidents/:1', 'reports/:1', 'runbooks/:1'])
    // The title and the result links keep the query (not the folder).
    await expect(hits(page).first()).toHaveAttribute('href', /^\/textsearch\/guides\/markdown-style-gallery\.md\?q=latency#md-[^/]+$/)

    await page.goBack()
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await page.goForward()
    await page.reload()
    await expect(facets(page).filter({ hasText: 'guides/' })).toHaveAttribute('aria-pressed', 'true')
    await expect(hits(page)).toHaveCount(1)
    await facets(page).filter({ hasText: 'All' }).click()
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=latency$/)
    await expect(hits(page)).toHaveCount(5)

    // The folder stays while the query changes.
    await changeUrl(page, '/textsearch/_search?q=latency&in=guides')
    await field(page).fill('retrospective')
    await expect(page).toHaveURL(/\?q=retrospective&in=guides$/)
  })

  test('a folder without matches says so and offers the way out', async ({ page }) => {
    await page.goto('/textsearch/_search?q=representative&in=guides')
    await expect(page.getByRole('heading', { name: 'No pages in guides/ contain “representative”' })).toBeVisible()
    await expect(status(page)).toHaveText('0 pages in guides/ contain “representative”')
    // The chosen folder stays visible and pressed even without hits.
    expect(await facetSummary(page)).toContain('guides/:0*')
    await page.getByRole('button', { name: 'Clear folder filter (guides/)' }).click()
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=representative$/)
    await expect(status(page)).toHaveText('1 page contains “representative”')

    // A query without any match offers a title and path search instead.
    await field(page).fill('zzzqqq')
    await expect(page.getByRole('heading', { name: 'No pages contain “zzzqqq”' })).toBeVisible()
    await expect(page.getByText('Check the spelling or try a different word.')).toBeVisible()
    await page.getByRole('button', { name: 'Search titles and paths only' }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })).toHaveValue('zzzqqq')
  })

  test('narrow screens scroll the facets sideways and the page never does', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true })
    await registerTextSearchSite(page)
    await page.goto('/textsearch/_search?q=latency')
    await expect(page.locator('.search-page-count-text')).toHaveText('5 pages contain “latency”')
    const facetRow = page.locator('.search-page-facets')
    await expect(facetRow).toBeVisible()
    expect(await facetRow.evaluate((element) => getComputedStyle(element).overflowX)).toBe('auto')
    expect(await facetRow.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    // A long title and path wrap instead of widening the page.
    expect(await page.locator('.search-page-wrap').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.unrouteAll({ behavior: 'wait' })
    await page.close()
  })

  test('a site without page text search explains the results page route', async ({ page }) => {
    const requests = recordSearchRequests(page)
    await page.goto('/sre/_search?q=latency')
    await expect(page.getByRole('alert')).toContainText('Page text search is not available')
    await expect(page.getByRole('searchbox')).toHaveCount(0)
    expect(requests).toEqual([])
  })

  test('a cold results page waits for site discovery instead of saying search is unavailable (ISSUE-113)', async ({ page }) => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/_indexes/textsearch/meta.json', async (route) => {
      await gate
      await route.continue()
    })
    await page.goto('/textsearch/_search?q=latency')
    await expect(page.getByRole('status').filter({ hasText: 'Loading search' })).toBeVisible()
    await expect(page.getByText('Page text search is not available')).toHaveCount(0)
    await expect(page.getByText('published without page text search')).toHaveCount(0)
    release()
    await expect(page.locator('#search-page-input')).toBeVisible()
    await expect(page.locator('.search-page-result').first()).toBeVisible()
    await expect(page.getByText('Page text search is not available')).toHaveCount(0)
    await page.unrouteAll({ behavior: 'wait' })
  })

  test('a failed discovery on the results page offers a retry instead of saying search is unavailable (ISSUE-113)', async ({ page }) => {
    let failing = true
    await page.route('**/_indexes/sites.json', (route) => failing ? route.fulfill({ status: 500, body: 'error' }) : route.fallback())
    await page.goto('/textsearch/_search?q=latency')
    await expect(page.getByRole('alert')).toContainText('Search data could not be loaded')
    await expect(page.getByText('Page text search is not available')).toHaveCount(0)
    failing = false
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.locator('.search-page-result').first()).toBeVisible()
    await page.unrouteAll({ behavior: 'wait' })
  })

  test('an unsupported registry format on the results page gives administrator guidance without a retry (ISSUE-113)', async ({ page }) => {
    await page.route('**/_indexes/sites.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schemaVersion: 999, sites: [] }) }))
    await page.goto('/textsearch/_search?q=latency')
    await expect(page.getByRole('alert')).toContainText('Ask the administrator')
    await expect(page.getByRole('alert')).not.toContainText('Check your connection')
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
    await expect(page.getByText('Page text search is not available')).toHaveCount(0)
    await page.unrouteAll({ behavior: 'wait' })
  })

  test('ArrowDown does not enter the list for an uncommitted query', async ({ page }) => {
    await page.goto('/textsearch/_search?q=latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await expect(field(page)).toBeFocused()
    await field(page).fill('lighthouse')
    await page.keyboard.press('ArrowDown')
    await expect(field(page)).toBeFocused()
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-hit-id') ?? null)).toBeNull()
  })

  test('stale results return focus to the field and cannot be opened', async ({ page }) => {
    await page.goto('/textsearch/_search?q=latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    const held: Array<() => Promise<void>> = []
    let holding = true
    await page.route('**/_indexes/textsearch/search/leaf-*', async (route) => {
      if (!holding) return route.continue()
      await new Promise<void>((resolve) => held.push(async () => { await route.continue(); resolve() }))
    })
    await field(page).fill('lighthouse')
    await hits(page).first().focus()
    await expect(status(page)).toHaveText('Searching 32 pages…')
    // Going stale moved focus off the old result.
    await expect(field(page)).toBeFocused()
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=lighthouse$/)
    // A stale link focused by other means is disabled: Enter and a click open nothing.
    await hits(page).first().focus()
    await expect(hits(page).first()).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Enter')
    await hits(page).first().click({ force: true })
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=lighthouse$/)
    holding = false
    await Promise.all(held.map((release) => release()))
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    await expect(hits(page).first()).not.toHaveAttribute('aria-disabled', 'true')
  })

  test('a superseded query cannot overwrite the newer results', async ({ page }) => {
    await usePagedFallback(page)
    // Warm the manifest and root so the next searches differ only in the leaves they need.
    await page.goto('/textsearch/_search?q=representative')
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
    await expect(status(page)).toHaveText('Searching 32 pages…')
    await expect.poll(() => held.length).toBeGreaterThan(0)
    holding = false
    // From the newer query on, nothing about the older one may ever render:
    // the abort that supersedes it must not surface as an error or a result.
    await startStatusRecorder(page)
    await field(page).fill('lighthouse')
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
    await usePagedFallback(page)
    // Search data is cached for a minute; moving the clock forward makes the
    // next page reload the search data, whose leaves are held to keep "Show more" pending.
    const start = new Date('2026-10-02T00:00:00Z')
    await page.clock.setFixedTime(start)
    await page.goto('/textsearch/_search?q=lighthouse')
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
    const more = page.locator('.search-page-more')
    await more.click()
    await expect(more).toHaveAttribute('aria-disabled', 'true')
    await expect.poll(() => held.size).toBeGreaterThan(0)
    const olderLeaves = [...held.keys()]

    await startStatusRecorder(page)
    await field(page).fill('latency')
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
    await usePagedFallback(page)
    await page.goto('/textsearch/_search?q=lighthouse')
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
    await expect(page.getByRole('heading', { name: 'No pages contain “latency lighthouse”' })).toBeVisible()
    await expect(page.getByText('Only pages that contain every word are listed. Try fewer words.')).toBeVisible()

    await field(page).fill('zzzqqq')
    await field(page).press('Enter')
    await expect(page.getByText('Check the spelling or try a different word.')).toBeVisible()
  })

  test('the paged fallback has no folder counts but still limits the loaded pages to a folder', async ({ page }) => {
    await usePagedFallback(page)
    await page.goto('/textsearch/_search?q=lighthouse')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    await expect(hits(page)).toHaveCount(20)
    // Counting folders would need every hit; above the ranking threshold only path-ordered pages are loaded.
    await expect(page.locator('.search-page-facets')).toHaveCount(0)
    await page.goto('/textsearch/_search?q=lighthouse&in=bulk')
    await expect(hits(page)).toHaveCount(20)
    // The count says the list is partial rather than claiming a folder total.
    await expect(status(page)).toHaveText('20 pages in bulk/ so far, among 20 of 24 pages that contain “lighthouse”')
    // No match among the first page: further pages load by themselves, and "no matches" appears only once the list has ended.
    await page.goto('/textsearch/_search?q=lighthouse&in=guides')
    await expect(page.getByRole('heading', { name: 'No pages in guides/ contain “lighthouse”' })).toBeVisible()
    await expect(page.locator('.search-page-more')).toHaveCount(0)
  })

  test('"Show more" leaves focus where the reader moved it while the page loaded', async ({ page }) => {
    await usePagedFallback(page)
    // As in the "Show more" race test: an expired cache makes the next page reload, and its leaves are held.
    const start = new Date('2026-10-02T00:00:00Z')
    await page.clock.setFixedTime(start)
    await page.goto('/textsearch/_search?q=lighthouse')
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
    await expect(page.locator('.search-page-more')).toHaveAttribute('aria-disabled', 'true')
    await expect.poll(() => held.length).toBeGreaterThan(0)

    const firstHit = page.locator('[data-hit-id="bulk/note-01.md"]')
    await firstHit.focus()
    holding = false
    await Promise.all(held.map((release) => release()))
    await expect(hits(page)).toHaveCount(24)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
    await expect(firstHit).toBeFocused()
  })

  test('a "Show more" failure is announced and can be retried', async ({ page }) => {
    await usePagedFallback(page)
    const start = new Date('2026-10-02T00:00:00Z')
    await page.clock.setFixedTime(start)
    await page.goto('/textsearch/_search?q=lighthouse')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    let failing = true
    await page.route('**/_indexes/textsearch/search/leaf-*', (route) => failing
      ? route.fulfill({ status: 503, body: 'temporarily unavailable' })
      : route.continue())
    await page.clock.setFixedTime(new Date(start.getTime() + 61_000))
    const live = page.locator('.search-page-main [role="status"]')
    await expect(live).toHaveText('')
    await page.getByRole('button', { name: 'Show 4 more (20 of 24 shown)' }).click()
    await expect(page.locator('.search-page-more')).toHaveText('Could not load more. Try again')
    await expect(live).toHaveText('Could not load more results.')
    await expect(hits(page)).toHaveCount(20)

    failing = false
    await page.locator('.search-page-more').click()
    await expect(hits(page)).toHaveCount(24)
    await expect(live).toHaveText('')
  })

  test('"Show more" after a republish lists the new generation from the start', async ({ page }) => {
    await usePagedFallback(page)
    // The site is republished (two more "lighthouse" notes sort first) between
    // the first and second result pages; the next page must not be appended to
    // offsets of the old generation.
    const start = new Date('2026-10-02T00:00:00Z')
    await page.clock.setFixedTime(start)
    await page.goto('/textsearch/_search?q=lighthouse')
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
    await expect(page.locator('.search-page-more')).toHaveCount(0)
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

    await page.goto('/textsearch/_search?q=latency')
    const alert = page.locator('.search-page').getByRole('alert')
    await expect(alert).toContainText('Search data could not be loaded')
    await expect(alert).toContainText('The server returned HTTP 503.')

    manifestState = 'invalid'
    await alert.getByRole('button', { name: 'Try again' }).click()
    await expect(alert).toContainText('Search data could not be read')
    // "Try again" was removed while the query reloaded; focus is in the search field.
    await expect(field(page)).toBeFocused()

    // Enter on the same query retries, without a new history entry.
    manifestState = 'ok'
    const historyLength = await page.evaluate(() => history.length)
    await field(page).press('Enter')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    await expect(alert).toHaveCount(0)
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
  })

  test('a decoder chunk that fails to load is a retryable network failure', async ({ page }) => {
    let failing = true
    await page.route('**/assets/fulltext-codec-*.js', (route) => failing
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.continue())
    await page.goto('/textsearch/_search?q=latency')
    const alert = page.locator('.search-page').getByRole('alert')
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
    await page.goto(`/textsearch/_search?q=${'a'.repeat(4097)}`)
    const alert = page.locator('.search-page').getByRole('alert')
    await expect(alert).toContainText('This query is too long')
    await expect(alert).toContainText('Shorten it to 4,096 characters or fewer.')
    await expect(alert).not.toContainText('Search data')
    await expect(alert.getByRole('button', { name: 'Try again' })).toHaveCount(0)
    expect(requests).toEqual([])
  })
  test('a newly arrived query scrolls to its first match unless the URL has a fragment', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    // HTML: loading with a query scrolls to the match.
    await page.goto('/textsearch/long/scroll-target.html?q=zephyrmarker')
    const frame = page.frameLocator('iframe.artifact-frame')
    await expect(frame.getByText('The zephyrmarker word is at the end.')).toBeInViewport()

    // A new query on the open page (history navigation) scrolls to its first match.
    await changeUrl(page, '/textsearch/long/scroll-target.html?q=midmarker')
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
    await changeUrl(page, '/textsearch/long/scroll-target.md?q=midmarker')
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

  test('the terms of the search are highlighted in HTML and Markdown pages without changing their DOM', async ({ page }) => {
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

    // Closing the match navigator removes the highlight.
    await page.getByRole('button', { name: 'Close match navigator' }).click()
    await expect.poll(() => highlightSize(artifactFrame)).toBe(0)
    // Another query reuses the adopted sheet instead of adding another.
    await changeUrl(page, '/textsearch/incidents/checkout-latency/index.html?q=fixture')
    await expect.poll(() => highlightSize(artifactFrame)).toBeGreaterThan(0)
    expect(await frameStyles()).toEqual({ elements: 0, adopted: 1 })

    await page.goto('/textsearch/reports/latency-retrospective.md?q=latency')
    const reader = page.getByTestId('markdown-document')
    await expect(reader).toBeVisible()
    await expect.poll(() => highlightSize(page)).toBeGreaterThan(1)
    expect(await reader.locator('mark').count()).toBe(0)

    // A different committed query replaces the highlight.
    await changeUrl(page, '/textsearch/reports/latency-retrospective.md?q=outage')
    await expect.poll(() => highlightSize(page)).toBe(1)
  })

  test('an opened result offers a match navigator for Markdown pages', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/textsearch/long/scroll-target.md?q=word')
    const reader = page.getByTestId('markdown-document')
    await expect(reader).toBeVisible()
    await expect.poll(() => highlightSize(page)).toBeGreaterThan(1)
    const total = await highlightSize(page)
    await expect(matchNav(page)).toBeVisible()
    await expect(matchNav(page)).toContainText('word')
    const count = matchNav(page).locator('.match-nav-count')
    await expect(count).toHaveText(`1 / ${total}`)
    // The current match is drawn over the others.
    await expect.poll(() => highlightSize(page, 'gap-page-text-search-current')).toBe(1)

    await matchNav(page).getByRole('button', { name: 'Next match' }).click()
    await expect(count).toHaveText(`2 / ${total}`)
    await expect(reader.getByText('The zephyrmarker word is at the end.')).toBeInViewport()
    await matchNav(page).getByRole('button', { name: 'Previous match' }).click()
    await expect(count).toHaveText(`1 / ${total}`)
    // Stepping wraps around.
    await matchNav(page).getByRole('button', { name: 'Previous match' }).click()
    await expect(count).toHaveText(`${total} / ${total}`)

    // Enter steps forward and Shift+Enter back while the bar has focus.
    await matchNav(page).locator('.match-nav-term').focus()
    await page.keyboard.press('Enter')
    await expect(count).toHaveText(`1 / ${total}`)
    await page.keyboard.press('Shift+Enter')
    await expect(count).toHaveText(`${total} / ${total}`)

    // Esc closes the bar, removes the highlight and returns focus to the page.
    await page.keyboard.press('Escape')
    await expect(matchNav(page)).toHaveCount(0)
    await expect.poll(() => highlightSize(page)).toBe(0)
    await expect(page.locator('#main-content')).toBeFocused()
    // The URL keeps the search for reload and for Back from here.
    await expect(page).toHaveURL(/\?q=word$/)
  })

  test('an opened result offers a match navigator for HTML pages, and no bar without matches', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/textsearch/long/scroll-target.html?q=word')
    const frame = page.frameLocator('iframe.artifact-frame')
    await expect(matchNav(page)).toBeVisible()
    const count = matchNav(page).locator('.match-nav-count')
    await expect(count).toHaveText(/^1 \/ \d+$/)
    const total = Number((await count.textContent())!.split('/')[1])
    expect(total).toBeGreaterThan(1)
    await matchNav(page).getByRole('button', { name: 'Next match' }).click()
    await expect(count).toHaveText(`2 / ${total}`)
    await expect.poll(() => frame.locator('body').evaluate(() => (
      (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('gap-page-text-search-current')?.size ?? 0
    ))).toBe(1)
    await expect(frame.getByText('The zephyrmarker word is at the end.')).toBeInViewport()

    await matchNav(page).getByRole('button', { name: 'Close match navigator' }).click()
    await expect(matchNav(page)).toHaveCount(0)
    await expect(page.locator('iframe.artifact-frame')).toBeFocused()

    // A query that does not occur in the page shows no bar (and no highlight).
    await page.goto('/textsearch/long/scroll-target.md?q=qqqzzznotthere')
    await expect(page.getByTestId('markdown-document')).toBeVisible()
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
    await expect(matchNav(page)).toHaveCount(0)
    expect(await highlightSize(page)).toBe(0)
    // A page opened without a search has none either.
    await page.goto('/textsearch/long/scroll-target.md')
    await expect(page.getByTestId('markdown-document')).toBeVisible()
    await expect(matchNav(page)).toHaveCount(0)
  })

  test('the match navigator starts over on another page and never keeps the previous count', async ({ page }) => {
    await page.goto('/textsearch/long/scroll-target.md?q=word')
    await expect(matchNav(page).locator('.match-nav-count')).toHaveText(/^1 \/ \d+$/)
    await matchNav(page).getByRole('button', { name: 'Next match' }).click()
    await expect(matchNav(page).locator('.match-nav-count')).toHaveText(/^2 \/ \d+$/)
    // Another page starts at 1 again.
    await changeUrl(page, '/textsearch/long/scroll-target.html?q=word')
    await expect(matchNav(page).locator('.match-nav-count')).toHaveText(/^1 \/ \d+$/)
  })

  test('the palette opens the results page from its full-text entry', async ({ page }) => {
    await page.goto('/textsearch')
    await expect(page.getByRole('heading', { name: 'Text Search', exact: true })).toBeVisible()
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    const search = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
    await expect(palette.locator('.palette-footer')).toContainText('search full text')

    // A page name matches, so it stays selected; the full-text row follows the page matches.
    await search.fill('latency')
    const handOff = palette.getByRole('option', { name: /Search full text for “latency”/ })
    await expect(handOff).toBeVisible()
    await expect(palette.locator('.palette-section-title').first()).toHaveText('Pages')
    await expect(handOff).toHaveAttribute('aria-selected', 'false')
    await search.press('Control+Enter')
    await expect(palette).toBeHidden()
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=latency$/)
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    // Focus lands in the results page's field.
    await expect(field(page)).toBeFocused()

    // No page name matches, so the full-text row is the default selection (also from the results page itself).
    await page.keyboard.press('Control+k')
    await search.fill('representative')
    const representative = palette.getByRole('option', { name: /Search full text for “representative”/ })
    await expect(representative).toHaveAttribute('aria-selected', 'true')
    await search.press('Enter')
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=representative$/)
    await expect(field(page)).toHaveValue('representative')
    await expect(field(page)).toBeFocused()
  })

  test('the page text shortcut opens the results page with the open search ready to change', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/textsearch/reports/latency-retrospective.md?q=latency')
    await expect(matchNav(page)).toBeVisible()
    await page.getByTestId('markdown-document').click()
    await page.keyboard.press('ControlOrMeta+Shift+F')
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=latency$/)
    await expect(field(page)).toBeFocused()
    await expect(field(page)).toHaveValue('latency')

    // On the results page it focuses and selects the field.
    await sidebar(page).locator('.browse-tree').click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('ControlOrMeta+Shift+F')
    await expect(field(page)).toBeFocused()

    // From inside an HTML artifact frame as well, and without a search it opens the empty page.
    await page.goto('/textsearch/incidents/checkout-latency/index.html')
    const artifactFrame = page.frameLocator('iframe.artifact-frame')
    // The app attaches its key handler to the frame's window in the same load
    // callback that adds the highlight style, so wait for the frame to be wired.
    await expect(artifactFrame.locator('body')).toBeVisible()
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
    await artifactFrame.locator('body').click()
    await page.keyboard.press('ControlOrMeta+Shift+F')
    await expect(page).toHaveURL(/\/textsearch\/_search$/)
    await expect(field(page)).toBeFocused()
  })

  test('the results page is built from landmarks, labels and live regions', async ({ page }) => {
    await page.goto('/textsearch/_search?q=latency')
    await expect(status(page)).toHaveText('5 pages contain “latency”')
    // The field is labelled and inside a search landmark; the count is a status region.
    await expect(page.getByRole('search').getByRole('searchbox', { name: 'Search page text in Text Search' })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: '5 pages contain “latency”' })).toBeVisible()
    // Facets are buttons that expose their state.
    const all = page.getByRole('navigation', { name: 'Folders' }).getByRole('button').first()
    await expect(all).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('navigation', { name: 'Folders' }).getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'false')
    // Results are links in a list.
    await expect(page.getByRole('list', { name: 'Results' }).getByRole('link')).toHaveCount(5)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  })

  test('sites without page text search keep the jump button and offer no hand-off', async ({ page }) => {
    const requests = recordSearchRequests(page)
    await page.goto('/sre?q=latency')
    await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
    await expect(page.getByRole('searchbox', { name: /Search page text/ })).toHaveCount(0)
    await expect(page.getByRole('searchbox', { name: /Filter pages/ })).toHaveCount(0)
    await expect(sidebar(page).getByRole('button', { name: 'Jump to a page in SRE' })).toBeVisible()
    await expect(sidebar(page).locator('.browse-tree')).toBeVisible()

    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' }).fill('latency')
    await expect(palette.getByRole('option', { name: /Latency Retrospective/ })).toBeVisible()
    await expect(palette.getByRole('option', { name: /Search full text/ })).toHaveCount(0)
    await expect(palette.locator('.palette-footer')).not.toContainText('search full text')
    await page.keyboard.press('Escape')

    await page.keyboard.press('ControlOrMeta+Shift+F')
    await expect(page.locator('.toast')).toHaveText('Page text search is not available for this site.')
    expect(requests).toEqual([])
  })

  test('result links carry ?q= and leave modified clicks to the browser', async ({ page }) => {
    await page.goto('/textsearch/_search?q=lighthouse')
    await expect(status(page)).toHaveText('24 pages contain “lighthouse”')
    const hit = page.locator('[data-hit-id="bulk/note-01.md"]')
    await expect(hit).toHaveJSProperty('tagName', 'A')
    await expect(hit).toHaveAttribute('href', /^\/textsearch\/bulk\/note-01\.md\?q=lighthouse#md-[^/]+$/)
    await expectModifiedClickKeptForBrowser(page, hit)
    await expect(page).toHaveURL(/\/_search\?q=lighthouse$/)
    await hit.click()
    await expect(page).toHaveURL(/\/bulk\/note-01\.md\?q=lighthouse#md-[^/]+$/)
    await expect(matchNav(page)).toBeVisible()
  })

  test('moving around the site leaves the search behind', async ({ page }) => {
    await page.goto('/textsearch/bulk/note-01.md?q=lighthouse')
    await expect(matchNav(page)).toBeVisible()
    await page.goto('/textsearch?q=lighthouse')
    await expect(page.locator('.directory-page .artifact-list-row').first()).not.toHaveAttribute('href', /q=/)
    await expect(page.locator('.directory-page a[data-directory-folder]').first()).not.toHaveAttribute('href', /q=/)
    await page.locator('.directory-page .artifact-list-row').first().click()
    await expect(page).not.toHaveURL(/q=/)
    await expect(page.getByTestId('directory-page')).toHaveCount(0)
    await expect(matchNav(page)).toHaveCount(0)
  })

  test('Copy link omits the search and keeps the fragment', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/textsearch/long/scroll-target.md?q=lighthouse#middle-section')
    await expect(page.getByTestId('markdown-document')).toBeVisible()
    const origin = new URL(page.url()).origin
    await page.getByRole('button', { name: 'Copy artifact link' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Link copied to clipboard.' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${origin}/textsearch/long/scroll-target.md#middle-section`)
    await expect(page).toHaveURL(/\?q=lighthouse#middle-section$/)

    await page.keyboard.press('Control+k')
    await page.getByRole('dialog', { name: 'Command palette' })
      .getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' }).fill('>copy artifact link')
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

  test('in-frame links of the docs-site fixture script carry the committed search to same-site routes only', async ({ page }) => {
    // This frozen fixture models the embedded docs script without depending on the docs repository checkout.
    const docsScript = readFileSync('fixtures/docs-site/assets/site.js', 'utf8').replace(/<\/script/gi, '<\\/script')
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
  const paletteInput = (page: Page) => palette(page).getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
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
    await expect(palette(page).locator('.palette-scope')).toHaveText('All pages')
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
    await page.locator('.directory-page a[data-directory-folder]').first().click()
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
    // before the plain click. The same check is shared with the other modified-click tests (expectModifiedClickKeptForBrowser).
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
    await expect(page.locator('.directory-page a[data-directory-folder]').first()).toHaveAttribute('href', /^\/sre\//)
  })

  test('sidebar Browse rows, Pinned items and breadcrumb menu entries are links', async ({ page }) => {
    await page.goto(checkoutPath)
    const browseRow = page.locator('.browse-tree a.tree-artifact[aria-current="page"]')
    await expect(browseRow).toHaveAttribute('href', checkoutPath)
    await expectModifiedClickKeptForBrowser(page, browseRow)
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
    await expect(label).toBeVisible()
    // The single-row bar (ISSUE-080) may scroll folders out of view to keep the whole title visible.
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
    await expect(page.getByRole('heading', { level: 1, name: 'SRE', exact: true })).toBeVisible()
    await expect(page).toHaveTitle('Previews · SRE')

    // Without the site index the list stands alone.
    await page.route('**/_indexes/sre/index.json', (route) => route.fulfill({ status: 503, body: 'unavailable' }))
    await page.goto('/sre/_previews')
    await expect(page.getByRole('link', { name: '← SRE', exact: true })).toBeVisible()
    await expect(page.getByText('SRE · Previews')).toBeVisible()

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
    await page.goto('/textsearch/_search?q=latency')
    const alert = page.locator('.search-page').getByRole('alert')
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

test.describe('reader shell polish', () => {
  const checkoutPath = '/sre/incidents/checkout-latency/index.html'

  test('the skip link is the first tab stop, shows on focus and moves focus to the document', async ({ page }) => {
    await page.goto(checkoutPath)
    const frame = page.locator('iframe.artifact-frame')
    await expect(frame).toBeVisible()

    const skipLink = page.getByRole('link', { name: 'Skip to content' })
    await expect(skipLink).not.toBeInViewport()
    await page.keyboard.press('Tab')
    await expect(skipLink).toBeFocused()
    await expect(skipLink).toBeInViewport({ ratio: 1 })

    await page.keyboard.press('Enter')
    await expect(frame).toBeFocused()
    await expect(page).toHaveURL(checkoutPath)
    await expect(skipLink).not.toBeInViewport()
  })

  test('the skip link focuses the main region for a Markdown document', async ({ page }) => {
    await page.goto('/sre/runbooks/service-recovery.md')
    await expect(page.getByTestId('markdown-document')).toBeVisible()
    await page.getByRole('link', { name: 'Skip to content' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('main')).toBeFocused()
    await expect(page).toHaveURL('/sre/runbooks/service-recovery.md')
  })

  test('the artifact frame carries the language its HTML declares', async ({ page }) => {
    await page.route('**/_artifacts/sre/architecture/platform-topology/index.html', async (route) => {
      const response = await route.fetch()
      const html = (await response.text()).replace(/<html[^>]*>/i, '<html lang="ja">')
      await route.fulfill({ response, body: html })
    })
    await page.goto('/sre/architecture/platform-topology/index.html')
    await expect(page.locator('iframe.artifact-frame')).toHaveAttribute('lang', 'ja')
    // The shell chrome stays English.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')

    await page.goto(checkoutPath)
    await expect(page.locator('iframe.artifact-frame')).toHaveAttribute('lang', 'en')
  })

  test('a Japanese Markdown document is marked lang="ja" and an English one is not', async ({ page }) => {
    await page.route('**/_artifacts/sre/runbooks/service-recovery.md', (route) => route.fulfill({
      contentType: 'text/markdown; charset=utf-8',
      body: '# サービス復旧手順\n\nこのページでは、障害発生時の初動と復旧の流れをまとめます。\n',
    }))
    await page.goto('/sre/runbooks/service-recovery.md')
    await expect(page.getByTestId('markdown-document')).toHaveAttribute('lang', 'ja')

    await page.goto('/sre/reports/latency-retrospective.md')
    await expect(page.getByTestId('markdown-document')).toBeVisible()
    await expect(page.getByTestId('markdown-document')).not.toHaveAttribute('lang', /.+/)
  })

  test('a Markdown artifact that fails to load shows the unavailable message', async ({ page }) => {
    await page.route('**/_artifacts/sre/runbooks/service-recovery.md', (route) => route.fulfill({ status: 404, body: 'gone' }))
    await page.goto('/sre/runbooks/service-recovery.md')
    await expect(page.getByRole('alert')).toContainText('Markdown unavailable')
  })

  test('a missing page is not indexable and suggests similar pages', async ({ page }) => {
    const noindex = page.locator('head meta[name="robots"][content="noindex"]')
    await page.goto('/sre/incidents/checkout-latency/nope.html')
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await expect(noindex).toHaveCount(1)

    const suggestions = page.getByRole('navigation', { name: 'Similar pages' })
    const suggestion = suggestions.getByRole('link', { name: /Checkout latency incident review/ })
    await expect(suggestion).toHaveAttribute('href', checkoutPath)
    await suggestion.click()
    await expect(page).toHaveURL(checkoutPath)
    await expect(page.locator('iframe.artifact-frame')).toBeVisible()
    await expect(noindex).toHaveCount(0)
  })

  test('a missing page with nothing similar offers no suggestions and an unknown site is not indexable either', async ({ page }) => {
    await page.goto('/sre/zzzz/qqqq')
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Similar pages' })).toHaveCount(0)
    await expect(page.locator('head meta[name="robots"][content="noindex"]')).toHaveCount(1)

    await page.goto('/no-such-site')
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await expect(page.locator('head meta[name="robots"][content="noindex"]')).toHaveCount(1)
  })
})

// ISSUE-075: every directory is a routable page.
test.describe('directory pages', () => {
  const sharedMarkdown = '/_artifacts/sre/runbooks/service-recovery.md'
  const toc = (...texts: string[]) => texts.map((text, index) => ({
    level: 2, text, id: `section-${index + 1}`,
  }))
  const extraPages = [
    ['guide/en/publishing.md', 'Publishing', '2026-10-03T00:00:00Z', toc('Publish on', 'Dry runs', 'Credentials', 'Cache', 'Rollback')],
    ['guide/en/previews.md', 'Previews', '2026-10-04T00:00:00Z', toc('Pull requests')],
    ['guide/en/reference/cli/publish.md', 'publish command', '2026-10-09T00:00:00Z', []],
    ['guide/en/reference/cli/preview.md', 'preview command', '2026-10-05T00:00:00Z', []],
    ['guide/en/reference/config.md', 'Configuration', '2026-10-06T00:00:00Z', []],
    ['guide/ja/publishing.md', '公開する', '2026-10-02T00:00:00Z', []],
    ['docs/README.md', 'Docs home', '2026-10-01T00:00:00Z', toc('Where to start')],
    ['docs/changelog.md', 'Changelog', '2026-10-07T00:00:00Z', []],
    ['solo/only.md', 'Only page', '2026-10-08T00:00:00Z', []],
    ['my folder/日本語 ノート/page.md', 'Encoded page', '2026-10-08T00:00:00Z', []],
  ] as const
  type ExtraPage = readonly [string, string, string, readonly { level: number, text: string, id: string }[]]
  // Folders with a README: 13 children (capped), exactly 12 (not capped).
  const readmeFolder = (folder: string, children: number): ExtraPage[] => [
    [`${folder}/README.md`, `${folder} home`, '2026-10-01T00:00:00Z', toc('Welcome')],
    ...Array.from({ length: children }, (_, position): ExtraPage => [
      `${folder}/topic-${String(position + 1).padStart(2, '0')}.md`, `Topic ${position + 1}`, '2026-10-05T00:00:00Z', [],
    ]),
  ]
  const cappedPages = [...readmeFolder('handbook', 13), ...readmeFolder('twelve', 12)]

  async function routeDirectoryIndex(page: Page, pages: readonly ExtraPage[] = extraPages, siteId = 'sre') {
    await page.route(`**/_indexes/${siteId}/index.json`, async (route) => {
      const response = await route.fetch()
      const index = await response.json()
      // Every row must point into its own site; reuse one of the site's own Markdown documents.
      const documentUrl = siteId === 'sre'
        ? sharedMarkdown
        : index.artifacts.find((entry: { format: string }) => entry.format === 'markdown').artifactUrl
      index.artifacts.push(...pages.map(([path, title, updatedAt, headings]) => ({
        id: path,
        path,
        title,
        format: 'markdown',
        filename: path.split('/').at(-1),
        artifactUrl: documentUrl,
        updatedAt,
        lastCommitter: { name: 'Ada Writer' },
        toc: headings,
      })))
      await route.fulfill({ response, json: index })
    })
  }

  test('a folder URL renders its folders and pages instead of Page not found', async ({ page }) => {
    await routeDirectoryIndex(page)
    await page.goto('/sre/guide/en')

    const directory = page.getByTestId('directory-page')
    await expect(directory.getByRole('heading', { level: 1, name: 'en' })).toBeVisible()
    await expect(directory).toContainText('5 pages · updated Oct 9, 2026')
    await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0)
    await expect(page.locator('head meta[name="robots"][content="noindex"]')).toHaveCount(0)
    await expect(page).toHaveTitle('en · SRE')

    const folders = directory.getByRole('region', { name: 'Folders' })
    await expect(folders.getByRole('link')).toHaveText(['reference'])
    await expect(folders).toContainText('3 pages · Oct 9, 2026')
    await expect(folders.getByRole('link', { name: 'reference' })).toHaveAttribute('href', '/sre/guide/en/reference')

    const pages = directory.getByRole('region', { name: 'Pages' })
    await expect(pages.locator('.directory-row-link')).toHaveText(['Previews', 'Publishing'])
    const publishing = pages.locator('.directory-row', { hasText: 'Publishing' })
    await expect(publishing).toContainText('Oct 3, 2026 · Ada Writer')
    await expect(publishing.locator('.directory-chip')).toHaveText(['Publish on', 'Dry runs', 'Credentials', '+2'])
    await expect(publishing.locator('.directory-chip').first()).toHaveAttribute('href', '/sre/guide/en/publishing.md#section-1')
    await expect(pages.locator('.directory-row', { hasText: 'Previews' }).locator('.directory-chip')).toHaveText(['Pull requests'])
  })

  // ISSUE-093: 5,000 pages in one folder (no README) and 5,000 children under a README.
  const bulkNumber = (position: number) => String(position + 1).padStart(4, '0')
  const bulkPages: ExtraPage[] = [
    ...Array.from({ length: 5000 }, (_, position): ExtraPage => [
      `wide/page-${bulkNumber(position)}.md`,
      `${position % 5 < 2 ? 'Alpha' : 'Beta'} page ${bulkNumber(position)}`,
      '2026-10-05T00:00:00Z',
      [],
    ]),
    ['wideroot/README.md', 'Wide README home', '2026-10-01T00:00:00Z', toc('Welcome')],
    ...Array.from({ length: 5000 }, (_, position): ExtraPage => [
      `wideroot/child-${bulkNumber(position)}.md`, `Child ${bulkNumber(position)}`, '2026-10-05T00:00:00Z', [],
    ]),
  ]

  test('a 5,000-page folder mounts at most 100 rows, pages to the last row and bounds the sidebar branch', async ({ page }) => {
    await routeDirectoryIndex(page, bulkPages)
    await page.goto('/sre/wide')

    const directory = page.getByTestId('directory-page')
    const rows = directory.locator('a[data-directory-page]')
    const pager = directory.getByRole('navigation', { name: 'Pages of this folder' })
    await expect(rows).toHaveCount(100)
    await expect(pager).toContainText('Showing 1–100 of 5,000')
    await expect(pager.getByRole('button', { name: 'Previous' })).toBeDisabled()
    const branchRows = page.locator('.browse-tree a.tree-artifact[data-tree-path^="wide/"]')
    await expect(branchRows).toHaveCount(100)
    await expect(page.locator('.browse-tree .tree-more')).toHaveText('4900 more in wide')
    await expect(page.locator('.browse-tree .tree-more')).toHaveAttribute('href', '/sre/wide')

    await pager.getByRole('button', { name: 'Next' }).click()
    await expect(pager).toContainText('Showing 101–200 of 5,000')
    await expect(rows.first()).toBeFocused()
    await expect(rows.first()).toHaveAttribute('data-directory-page', 'wide/page-0101.md')
    expect(await rows.count()).toBeLessThanOrEqual(100)

    for (let step = 0; step < 48; step += 1) await pager.getByRole('button', { name: 'Next' }).click()
    await expect(pager).toContainText('Showing 4,901–5,000 of 5,000')
    await expect(pager.getByRole('button', { name: 'Next' })).toBeDisabled()
    await expect(rows).toHaveCount(100)
    await expect(directory.locator('a[data-directory-page="wide/page-5000.md"]')).toBeVisible()
  })

  test('the sidebar keeps the open page row when it is beyond the branch limit', async ({ page }) => {
    await routeDirectoryIndex(page, bulkPages)
    await page.goto('/sre/wide/page-4321.md')

    const branchRows = page.locator('.browse-tree a.tree-artifact[data-tree-path^="wide/"]')
    await expect(branchRows).toHaveCount(101)
    const active = page.locator('.browse-tree a.tree-artifact[data-tree-path="wide/page-4321.md"]')
    await expect(active).toHaveCount(1)
    await expect(active).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.browse-tree .tree-more')).toHaveText('4899 more in wide')
  })

  test('a sidebar filter matching 2,000 pages mounts at most 101 rows', async ({ page }) => {
    // The sidebar filter needs a site with page text search data.
    await registerTextSearchSite(page)
    await routeDirectoryIndex(page, bulkPages, 'textsearch')
    await page.goto('/textsearch')
    await page.getByRole('searchbox', { name: 'Filter pages in Text Search by title or path' }).fill('alpha page')
    const results = page.locator('.filter-results a.tree-artifact')
    await expect(results.first()).toBeVisible()
    expect(await results.count()).toBeLessThanOrEqual(101)
    await expect(page.locator('.filter-results .tree-more')).toContainText('more matches')
  })

  test('a filter matching 60 folders of 60 pages stays within the tree-wide row budget', async ({ page }) => {
    const grid: ExtraPage[] = Array.from({ length: 3600 }, (_, position): ExtraPage => {
      const folder = String(Math.floor(position / 60) + 1).padStart(2, '0')
      const number = String((position % 60) + 1).padStart(2, '0')
      return [`zf${folder}/p${number}.md`, `Zeta ${folder}-${number}`, '2026-10-05T00:00:00Z', []]
    })
    await registerTextSearchSite(page)
    await routeDirectoryIndex(page, grid, 'textsearch')
    await page.goto('/textsearch')
    await page.getByRole('searchbox', { name: 'Filter pages in Text Search by title or path' }).fill('zeta')
    const tree = page.locator('.filter-results .artifact-tree')
    await expect(tree.locator('a.tree-artifact').first()).toBeVisible()
    // Budgeted rows (folder and page rows) <= 400; at most one overflow row per branch (60 folders + the root).
    const mounted = await tree.locator('.tree-directory-row, .tree-directory-button:not(.tree-directory-toggle), a.tree-artifact').count()
    expect(mounted).toBeLessThanOrEqual(400)
    const overflow = await tree.locator('.tree-more:not(:has-text("Some folders"))').count()
    expect(overflow).toBeLessThanOrEqual(61)
    await expect(tree.locator('.tree-more', { hasText: 'Some folders are not fully shown. Collapse folders or refine the filter.' })).toBeVisible()
  })

  test('a README folder with 5,000 children collapses to 10 rows and pages after Show all', async ({ page }) => {
    await routeDirectoryIndex(page, bulkPages)
    await page.goto('/sre/wideroot')

    const directory = page.getByTestId('directory-page')
    const rows = directory.locator('.directory-compact a')
    await expect(rows).toHaveCount(10)
    await expect(directory.getByRole('navigation', { name: 'Pages of this folder' })).toHaveCount(0)
    await directory.getByRole('button', { name: /Show all/ }).click()
    await expect(rows).toHaveCount(100)
    const pager = directory.getByRole('navigation', { name: 'Pages of this folder' })
    await expect(pager).toContainText('Showing 1–100 of 5,000')
    await expect(directory.getByRole('button', { name: 'Show fewer' })).toBeVisible()
  })

  test('a trailing slash and percent-encoded folder names name the same directory', async ({ page }) => {
    await routeDirectoryIndex(page)
    await page.goto('/sre/guide/en/')
    await expect(page.getByTestId('directory-page').getByRole('heading', { level: 1, name: 'en' })).toBeVisible()
    await expect(page).toHaveURL('/sre/guide/en/')

    await page.goto('/sre/my%20folder/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%8E%E3%83%BC%E3%83%88')
    await expect(page.getByTestId('directory-page').getByRole('heading', { level: 1, name: '日本語 ノート' })).toBeVisible()
    await expect(page.getByTestId('directory-page').getByRole('link', { name: 'Encoded page' })).toHaveAttribute(
      'href', '/sre/my%20folder/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%8E%E3%83%BC%E3%83%88/page.md')

    await page.goto('/showcase/guides/url%20route%20samples')
    await expect(page.getByTestId('directory-page').getByRole('heading', { level: 1, name: 'url route samples' })).toBeVisible()
  })

  test('a folder with only subfolders and a folder with one page keep their folder URLs', async ({ page }) => {
    await routeDirectoryIndex(page)
    await page.goto('/sre/guide')
    const directory = page.getByTestId('directory-page')
    await expect(directory.getByRole('region', { name: 'Folders' }).getByRole('link')).toHaveText(['en', 'ja'])
    await expect(directory.getByRole('region', { name: 'Pages' })).toHaveCount(0)

    await page.goto('/sre/solo')
    await expect(page).toHaveURL('/sre/solo')
    await expect(directory.getByRole('heading', { level: 1, name: 'solo' })).toBeVisible()
    await expect(directory).toContainText('1 page ·')
    await expect(directory.locator('.directory-row')).toHaveCount(1)
  })

  test('a README renders as the body with the other pages listed below it', async ({ page }) => {
    await routeDirectoryIndex(page)
    await page.goto('/sre/docs')

    const directory = page.getByTestId('directory-page')
    await expect(directory).toHaveAttribute('data-directory-variant', 'index')
    await expect(directory.getByTestId('markdown-document')).toBeVisible()
    await expect(directory.locator('.directory-readme-label')).toHaveText('README.md')
    await expect(directory).not.toContainText('rendered from')
    const children = directory.getByRole('navigation', { name: /In this folder/ })
    // The folder header and the list come first; the README sits below them under its file label.
    const top = (selector: string) => directory.locator(selector).first().evaluate((element) => element.getBoundingClientRect().top)
    const [headerTop, listTop, labelTop, bodyTop] = await Promise.all([
      top('.directory-header'), top('.directory-children'), top('.directory-readme-label'), top('[data-testid="markdown-document"]'),
    ])
    expect(headerTop).toBeLessThan(listTop)
    expect(listTop).toBeLessThan(labelTop)
    expect(labelTop).toBeLessThan(bodyTop)
    await expect(children.getByRole('link')).toHaveText([/Changelog/])
    await expect(children.getByRole('link', { name: /Docs home/ })).toHaveCount(0)
    await expect(page).toHaveTitle('Docs home · SRE')
    await expect(page.getByRole('button', { name: 'Contents' })).toBeEnabled()
  })

  test('a folder with a README is labelled by its title and its README row is folded into the folder', async ({ page }) => {
    await routeDirectoryIndex(page)
    await page.goto('/sre/docs')

    const directory = page.getByTestId('directory-page')
    await expect(directory.getByRole('heading', { level: 1, name: 'Docs home' })).toBeVisible()
    const browse = page.locator('.browse-tree')
    const folder = browse.locator('a[data-tree-folder="docs"]')
    await expect(folder).toContainText('Docs home')
    await expect(folder).toHaveAttribute('title', 'docs')
    await expect(folder).toHaveAttribute('aria-current', 'page')
    await expect(browse.getByRole('button', { name: 'Toggle Docs home' })).toBeVisible()
    await expect(browse.locator('a[data-tree-path="docs/changelog.md"]')).toHaveCount(1)
    await expect(browse.locator('a[data-tree-path="docs/README.md"]')).toHaveCount(0)
    await expect(page.getByRole('navigation', { name: 'Artifact path' }).getByRole('link', { name: 'Docs home' })).toHaveCount(0)

    // A nested page shows the labelled folder in its breadcrumb; a folder without a README keeps its name.
    await page.goto('/sre/docs/changelog.md')
    await expect(page.getByRole('navigation', { name: 'Artifact path' }).getByRole('link', { name: 'Docs home' })).toBeVisible()
    await expect(browse.locator('a[data-tree-folder="solo"]')).toContainText('solo')

    // A folder whose only child is its index page keeps that row, which carries the active state.
    await page.goto('/sre/architecture/platform-topology/index.html')
    await expect(browse.locator('a.tree-artifact[data-tree-path="architecture/platform-topology/index.html"]')).toHaveAttribute('aria-current', 'page')
    await expect(browse.locator('a[data-tree-folder="architecture/platform-topology"]')).not.toHaveAttribute('aria-current', 'page')
  })

  test('a folder with a README and more than 12 children shows 10 rows until expanded', async ({ page }) => {
    await routeDirectoryIndex(page, [...extraPages, ...cappedPages])
    await page.goto('/sre/handbook')

    const directory = page.getByTestId('directory-page')
    const rows = directory.getByRole('navigation', { name: /In this folder/ }).locator('.directory-compact li')
    const more = directory.getByRole('button', { name: 'Show all 13 items' })
    await expect(rows).toHaveCount(10)
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await expect(more).toHaveAttribute('aria-controls', 'directory-children-list')
    await expect(directory.locator('#directory-children-list')).toHaveCount(1)

    await more.click()
    await expect(rows).toHaveCount(13)
    const fewer = directory.getByRole('button', { name: 'Show fewer' })
    await expect(fewer).toHaveAttribute('aria-expanded', 'true')
    await expect(fewer).toBeFocused()

    await fewer.click()
    await expect(rows).toHaveCount(10)
    await expect(directory.getByRole('button', { name: 'Show all 13 items' })).toBeFocused()
    await expect(directory.getByRole('button', { name: 'Show all 13 items' })).toHaveAttribute('aria-expanded', 'false')
    // The README stays below the list.
    await expect(directory.locator('.directory-readme-label')).toHaveText('README.md')
  })

  test('a folder with a README and 12 or fewer children shows every row and no button', async ({ page }) => {
    await routeDirectoryIndex(page, [...extraPages, ...cappedPages])
    for (const [path, count] of [['/sre/twelve', 12], ['/sre/docs', 1]] as const) {
      await page.goto(path)
      const directory = page.getByTestId('directory-page')
      await expect(directory.getByRole('navigation', { name: /In this folder/ }).locator('.directory-compact li')).toHaveCount(count)
      await expect(directory.locator('.directory-more')).toHaveCount(0)
    }
  })

  test('the site root shows the header, the section row and the README as Overview', async ({ page }) => {
    await routeDirectoryIndex(page, [...extraPages, ...cappedPages, ['README.md', 'Site home', '2026-10-02T00:00:00Z', toc('Welcome')]])
    await page.goto('/sre')

    const directory = page.getByTestId('directory-page')
    await expect(directory).toHaveAttribute('data-directory-variant', 'index')
    await expect(directory.getByRole('heading', { level: 1, name: 'SRE', exact: true })).toBeVisible()
    await expect(directory.locator('.site-home-lede')).toContainText('pages · Updated')
    const sections = directory.getByRole('navigation', { name: 'Site sections' })
    await expect(sections.getByRole('link')).toHaveText([/^Overview$/, /^Files$/, /^Previews/])
    await expect(sections.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
    await expect(directory.getByRole('button', { name: 'Search this site' })).toBeVisible()
    await expect(directory.locator('.browse-section')).toHaveCount(0)
    await expect(directory.locator('.directory-children')).toHaveCount(0)
    await expect(directory.locator('.directory-readme-label')).toHaveText('README.md')
    await expect(directory.getByTestId('markdown-document')).toBeVisible()
    await expect(page).toHaveTitle('SRE')
    // The page's own panels refer to the root README; the site home button is not shown on the home itself.
    await expect(page.getByRole('button', { name: 'Contents' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Go to SRE home' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Copy site link' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Copy folder link' })).toHaveCount(0)

    // Files lists the children and the recent updates, without the README.
    await sections.getByRole('link', { name: 'Files' }).click()
    await expect(page).toHaveURL('/sre?section=files')
    await expect(directory).toHaveAttribute('data-directory-variant', 'list')
    await expect(directory.locator('.directory-readme-label')).toHaveCount(0)
    await expect(directory.getByTestId('markdown-document')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Contents' })).toHaveCount(0)
    const top = (selector: string) => directory.locator(selector).first().evaluate((element) => element.getBoundingClientRect().top)
    const [headerTop, barTop, listTop, recentTop] = await Promise.all([
      top('.site-home-heading'), top('.site-home-bar'), top('.directory-row'), top('.artifact-list-section[aria-label="Recently updated"]'),
    ])
    expect(headerTop).toBeLessThan(barTop)
    expect(barTop).toBeLessThan(listTop)
    expect(listTop).toBeLessThan(recentTop)
  })

  test('the site root without a README shows the header and full rows', async ({ page }) => {
    await page.goto('/sre')
    const directory = page.getByTestId('directory-page')
    await expect(directory).toHaveAttribute('data-directory-variant', 'list')
    await expect(directory.locator('.site-home-heading')).toBeVisible()
    await expect(directory.locator('.directory-readme-label')).toHaveCount(0)
    await expect(directory.locator('.directory-row').first()).toBeVisible()
  })

  test('a folder whose index.html is the only page renders it inside the directory page', async ({ page }) => {
    await page.goto('/showcase/reports/cloud-spend-review')
    const directory = page.getByTestId('directory-page')
    await expect(directory).toHaveAttribute('data-directory-variant', 'index')
    await expect(directory.locator('iframe.artifact-frame')).toBeVisible()
    await expect(directory.getByRole('navigation', { name: /In this folder/ })).toHaveCount(0)
  })

  test('a path that is neither a page nor a folder is still not found', async ({ page }) => {
    await routeDirectoryIndex(page)
    for (const path of ['/sre/guide/nope', '/sre/gui', '/sre/guide/en/publishing']) {
      await page.goto(path)
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
      await expect(page.locator('head meta[name="robots"][content="noindex"]')).toHaveCount(1)
      await expect(page).toHaveTitle('Page not found · SRE')
    }
    await page.goto('/sre/guide/en/nope.md')
    await expect(page.getByRole('navigation', { name: 'Similar pages' })).toBeVisible()
  })

  test('a sidebar folder label is a link and the chevron alone toggles', async ({ page }) => {
    await routeDirectoryIndex(page)
    await page.goto('/sre/guide/en/publishing.md')
    const browse = page.locator('.browse-tree')
    const label = browse.locator('a[data-tree-folder="guide/en"]')
    const toggle = browse.locator('button[data-tree-path="guide/en"]')

    await expect(label).toHaveAttribute('href', '/sre/guide/en')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page).toHaveURL('/sre/guide/en/publishing.md')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await expectModifiedClickKeptForBrowser(page, label)
    await expect(page).toHaveURL('/sre/guide/en/publishing.md')

    const navigations = await page.evaluate(() => performance.getEntriesByType('navigation').length)
    await label.click()
    await expect(page).toHaveURL('/sre/guide/en')
    await expect(label).toHaveAttribute('aria-current', 'page')
    await expect(browse.locator('a.tree-artifact[aria-current="page"]')).toHaveCount(0)
    await expect(page.getByTestId('directory-page')).toBeVisible()
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(navigations)

    await page.goBack()
    await expect(page).toHaveURL('/sre/guide/en/publishing.md')
    await expect(browse.locator('a.tree-artifact[aria-current="page"]')).toHaveCount(1)
    await page.goForward()
    await expect(page.getByTestId('directory-page').getByRole('heading', { level: 1, name: 'en' })).toBeVisible()
  })

  test('a folder label is keyboard operable: Enter opens it, Right and Left expand and collapse', async ({ page }) => {
    await routeDirectoryIndex(page)
    await page.goto('/sre')
    const browse = page.locator('.browse-tree')
    const label = browse.locator('a[data-tree-folder="guide"]')
    const toggle = browse.locator('button[data-tree-path="guide"]')

    await label.focus()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('ArrowRight')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(label).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/sre/guide')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  test('breadcrumb folder segments are links and the sibling menu moves to a chevron', async ({ page }) => {
    await routeDirectoryIndex(page)
    await page.goto('/sre/guide/en/reference/config.md')
    const breadcrumb = page.getByRole('navigation', { name: 'Artifact path' })

    await expect(breadcrumb.getByRole('link')).toHaveText(['guide', 'en', 'reference'])
    await expect(breadcrumb.getByRole('link', { name: 'en', exact: true })).toHaveAttribute('href', '/sre/guide/en')
    await breadcrumb.getByRole('button', { name: 'Browse artifacts in guide/en', exact: true }).click()
    await expect(page.getByRole('menu', { name: 'Artifacts in guide/en', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    await breadcrumb.getByRole('link', { name: 'en', exact: true }).click()
    await expect(page).toHaveURL('/sre/guide/en')
    await expect(page.getByTestId('directory-page')).toBeVisible()
    await expect(breadcrumb.locator('.breadcrumb-current')).toHaveText('en')
    await expect(breadcrumb.locator('.breadcrumb-current')).toHaveAttribute('aria-current', 'page')
    await expect(breadcrumb.getByRole('link')).toHaveText(['guide'])

    await page.goBack()
    await expect(page).toHaveURL('/sre/guide/en/reference/config.md')
  })

  test('directory rows and chips are real links that navigate in the app', async ({ page }) => {
    await routeDirectoryIndex(page)
    await page.goto('/sre/guide/en')
    await page.getByTestId('directory-page').getByRole('link', { name: 'reference', exact: true }).click()
    await expect(page).toHaveURL('/sre/guide/en/reference')
    await expect(page.getByTestId('directory-page').getByRole('heading', { level: 1, name: 'reference' })).toBeVisible()
    await page.getByTestId('directory-page').getByRole('link', { name: 'Configuration' }).click()
    await expect(page).toHaveURL('/sre/guide/en/reference/config.md')
    await page.goBack()
    await page.goBack()
    await expect(page).toHaveURL('/sre/guide/en')
    await page.getByTestId('directory-page').getByRole('link', { name: 'Dry runs' }).click()
    await expect(page).toHaveURL('/sre/guide/en/publishing.md#section-2')
  })

  test('the directory page fits a 390px screen and the drawer folder label closes the drawer', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await routeDirectoryIndex(page)
    await page.goto('/sre/guide/en')
    await expect(page.getByTestId('directory-page')).toBeVisible()
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      scroll: (() => {
        const scroll = document.querySelector('.directory-scroll')!
        return scroll.scrollWidth - scroll.clientWidth
      })(),
    }))
    expect(overflow).toEqual({ page: 0, scroll: 0 })

    await page.getByRole('button', { name: 'Expand navigation' }).tap()
    await page.locator('.browse-tree a[data-tree-folder="docs"]').tap()
    await expect(page).toHaveURL('/sre/docs')
    await expect(page.getByTestId('directory-page')).toHaveAttribute('data-directory-variant', 'index')
    await expect(page.locator('#workspace-sidebar')).toBeHidden()
    await page.close()
  })
})

// ISSUE-075 review follow-ups: scrolling inside a directory page.
test.describe('directory page scrolling', () => {
  const field = (page: Page) => page.getByRole('searchbox', { name: 'Search page text in Text Search' })

  /** `long/` gets a README.md and (second site variant) an index.html, both reusing the long scroll-target pages. */
  async function routeLongIndex(page: Page, kind: 'markdown' | 'html') {
    await registerTextSearchSite(page)
    await page.route('**/_indexes/textsearch/index.json', async (route) => {
      const response = await route.fetch()
      const index = await response.json()
      const source = kind === 'markdown' ? 'long/scroll-target.md' : 'long/scroll-target.html'
      const original = index.artifacts.find((artifact: { path: string }) => artifact.path === source)
      expect(original, 'the generated textsearch site has the long scroll-target pages').toBeTruthy()
      index.artifacts.push({
        ...original,
        id: `long/${kind === 'markdown' ? 'README.md' : 'index.html'}`,
        path: `long/${kind === 'markdown' ? 'README.md' : 'index.html'}`,
        title: 'Long folder index',
      })
      await route.fulfill({ response, json: index })
    })
  }

  test('moving to another folder page starts at the top', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 })
    await page.route('**/_indexes/sre/index.json', async (route) => {
      const response = await route.fetch()
      const index = await response.json()
      const template = index.artifacts.find((artifact: { format: string }) => artifact.format === 'markdown')
      for (let number = 1; number <= 40; number += 1) {
        const path = `big/page-${String(number).padStart(2, '0')}.md`
        index.artifacts.push({ ...template, id: path, path, title: `Big page ${number}`, toc: [] })
      }
      index.artifacts.push({ ...template, id: 'big/sub/inner.md', path: 'big/sub/inner.md', title: 'Inner', toc: [] })
      await route.fulfill({ response, json: index })
    })
    await page.goto('/sre/big')
    const scroller = page.locator('.directory-scroll')
    await scroller.evaluate((element) => { element.scrollTop = 600 })
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(300)
    await page.locator('.browse-tree a[data-tree-folder="big/sub"]').click()
    await expect(page).toHaveURL('/sre/big/sub')
    await expect.poll(() => page.locator('.directory-scroll').evaluate((element) => element.scrollTop)).toBe(0)
  })

  test('a Markdown index body scrolls the directory page to a first match and respects reader scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await routeLongIndex(page, 'markdown')
    await page.goto('/textsearch/long?q=zephyrmarker')
    const reader = page.getByTestId('markdown-document')
    await expect(reader.getByText('The zephyrmarker word is at the end.')).toBeInViewport()
    expect(await page.locator('.directory-scroll').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

    await page.goto('/textsearch/long#middle-section')
    await expect(reader.getByRole('heading', { name: 'Middle section' })).toBeInViewport()

    // Scrolling the directory page by hand (outside the article) means a match that turns up late does not pull it away.
    await page.goto('/textsearch/long?q=latemarker')
    await expect(reader.locator('h1')).toBeInViewport()
    await page.mouse.move(1260, 400)
    await page.mouse.wheel(0, 40)
    await page.evaluate(() => {
      document.querySelector('.markdown-article')!.append(Object.assign(document.createElement('p'), { textContent: 'The latemarker word arrives late.' }))
    })
    await expect.poll(() => page.evaluate(() => (
      (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('gap-page-text-search')?.size ?? 0
    ))).toBe(1)
    await expect(reader.getByText('The latemarker word arrives late.')).not.toBeInViewport()
  })

  test('an HTML index body scrolls the directory page to a fragment and to a first match', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await routeLongIndex(page, 'html')
    const frame = page.frameLocator('iframe.artifact-frame')

    await page.goto('/textsearch/long#middle-section')
    await expect(frame.getByRole('heading', { name: 'Middle section' })).toBeInViewport()
    expect(await page.locator('.directory-scroll').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

    await page.goto('/textsearch/long?q=zephyrmarker')
    await expect(frame.getByText('The zephyrmarker word is at the end.')).toBeInViewport()
    expect(await page.locator('.directory-scroll').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  })
})

test.describe('narrow chrome and scroll cues (ISSUE-080)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  const markdownPath = '/sre/reports/latency-retrospective.md'

  test('the rail is gone, a menu button opens the drawer and the page does not scroll sideways', async ({ page }) => {
    await page.goto(markdownPath)
    await expect(page.locator('.collapsed-rail')).toHaveCount(0)
    await expect(page.locator('.sidebar-panel')).toBeHidden()

    const bar = page.locator('.context-bar')
    const barBox = (await bar.boundingBox())!
    expect(barBox.height).toBeLessThanOrEqual(48)
    const workspaceBox = (await page.locator('.workspace').boundingBox())!
    expect(workspaceBox.x).toBe(0)
    expect(workspaceBox.width).toBe(390)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

    const menuButton = page.getByRole('button', { name: 'Expand navigation' })
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false')
    await menuButton.click()
    await expect(page.locator('.sidebar-panel')).toBeVisible()
    await expect(page.locator('.reader-menu-button')).toHaveAttribute('aria-expanded', 'true')
    await page.locator('.sidebar-backdrop').click({ position: { x: 360, y: 400 } })
    await expect(page.locator('.sidebar-panel')).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })

  test('the More menu is a keyboard-operable menu button that returns focus', async ({ page }) => {
    await page.goto(markdownPath)
    const more = moreActionsButton(page)
    await expect(more).toHaveAttribute('aria-haspopup', 'menu')
    await expect(more).toHaveAttribute('aria-expanded', 'false')

    await more.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'More actions' })
    await expect(menu).toBeVisible()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    const items = menu.getByRole('menuitem')
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Contents' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Details' })).toBeFocused()
    await page.keyboard.press('End')
    await expect(menu.getByRole('menuitemradio', { name: 'Theme: Dark' })).toBeFocused()
    await page.keyboard.press('Home')
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Contents' })).toBeFocused()
    expect(await items.count()).toBeGreaterThan(2)
    const box = (await menu.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)

    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(more).toBeFocused()
    await expect(more).toHaveAttribute('aria-expanded', 'false')

    // Click outside closes it without moving focus into the page.
    await more.click()
    await expect(menu).toBeVisible()
    await page.locator('.markdown-article').click({ position: { x: 20, y: 20 } })
    await expect(menu).toBeHidden()
  })

  test('More menu actions: Contents, Details, Pin, Copy link and theme', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(markdownPath)
    const more = moreActionsButton(page)
    const menu = page.getByRole('menu', { name: 'More actions' })

    await more.click()
    await menu.getByRole('menuitemcheckbox', { name: 'Contents' }).click()
    const contents = page.getByRole('complementary', { name: 'Contents' })
    await expect(contents).toBeVisible()
    await expect(more).toBeFocused()
    await more.click()
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Contents' })).toHaveAttribute('aria-checked', 'true')
    await menu.getByRole('menuitemcheckbox', { name: 'Details' }).click()
    const details = page.getByRole('complementary', { name: 'Details' })
    await expect(details).toBeVisible()
    await details.getByRole('button', { name: 'Close Details' }).click()
    await expect(details).toBeHidden()
    await expect(more).toBeFocused()

    await more.click()
    await menu.getByRole('menuitem', { name: 'Pin', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Pinned')
    await more.click()
    await expect(menu.getByRole('menuitem', { name: 'Unpin', exact: true })).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Unpin', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Unpinned')

    await more.click()
    await menu.getByRole('menuitem', { name: 'Copy link' }).click()
    await expect(page.getByRole('status')).toContainText(/copied/i)

    await more.click()
    await menu.getByRole('menuitemradio', { name: 'Theme: Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await more.click()
    await expect(menu.getByRole('menuitemradio', { name: 'Theme: Dark' })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
  })

  test('folder pages and the not-found view use the same chrome', async ({ page }) => {
    await page.goto('/sre/reports')
    await expect(page.getByTestId('directory-page')).toBeVisible()
    await expect(page.locator('.collapsed-rail')).toHaveCount(0)
    const more = moreActionsButton(page)
    await more.click()
    const menu = page.getByRole('menu', { name: 'More actions' })
    await expect(menu.getByRole('menuitem', { name: 'Copy link' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'SRE home' })).toBeVisible()
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Contents' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

    await page.goto('/sre/nowhere/missing.md')
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await moreActionsButton(page).click()
    const missingMenu = page.getByRole('menu', { name: 'More actions' })
    await expect(missingMenu.getByRole('menuitem', { name: 'All sites' })).toBeVisible()
    await expect(missingMenu.getByRole('menuitem', { name: 'Copy link' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })

  test('the skip link still moves focus to the main content', async ({ page }) => {
    await page.goto(markdownPath)
    await expect(page.locator('.markdown-article')).toBeVisible()
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: 'Skip to content' })
    await expect(skip).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('#main-content')).toBeFocused()
  })

  test('a Markdown table stays mounted and keeps its scroll position after the page settles', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/sre/reports/latency-retrospective.md')
    await expect(page.locator('.markdown-table-hint').first()).toBeVisible()
    await page.locator('.scroll-cue').first().evaluate((element) => {
      element.setAttribute('data-probe', 'kept')
      element.querySelector<HTMLElement>('.markdown-table-scroll')!.scrollLeft = 60
    })
    await page.waitForTimeout(1000)
    const state = await page.evaluate(() => {
      const element = document.querySelector('.scroll-cue[data-probe="kept"]')
      return { connected: Boolean(element?.isConnected), scrollLeft: element?.querySelector<HTMLElement>('.markdown-table-scroll')?.scrollLeft }
    })
    expect(state).toEqual({ connected: true, scrollLeft: 60 })
  })

  test('a wide table and a code block show edge shadows only where content is clipped', async ({ page }) => {
    await page.route('**/latency-retrospective.md', async (route) => {
      const response = await route.fetch()
      const body = await response.text()
      await route.fulfill({
        response,
        body: `${body}\n\n## Scroll cue fixtures\n\n\`\`\`sh\n${'artifact-pages publish --site guide --environment production --registry .artifact-pages/registry.yaml '.repeat(3)}\n\`\`\`\n\n\`\`\`sh\nshort\n\`\`\`\n`,
      })
    })
    await page.goto(markdownPath)
    const article = page.locator('.markdown-article')

    const tableCue = article.locator('.scroll-cue-table').first()
    const tableScroll = tableCue.locator('.markdown-table-scroll')
    await expect(tableCue).toHaveAttribute('data-right', 'true')
    await expect(tableCue).toHaveAttribute('data-left', 'false')
    const shadow = (locator: Locator, edge: '::before' | '::after') => locator.evaluate(
      (element, pseudo) => getComputedStyle(element, pseudo).opacity, edge,
    )
    await expect.poll(() => shadow(tableCue, '::after')).toBe('1')
    expect(await shadow(tableCue, '::before')).toBe('0')
    await expect(article.locator('.markdown-table-hint').first()).toHaveText('Scroll to see more columns →')

    await tableScroll.evaluate((element) => { element.scrollLeft = 60 })
    await expect(tableCue).toHaveAttribute('data-left', 'true')
    await expect(tableCue).toHaveAttribute('data-right', 'true')
    await tableScroll.evaluate((element) => { element.scrollLeft = element.scrollWidth })
    await expect(tableCue).toHaveAttribute('data-left', 'true')
    await expect(tableCue).toHaveAttribute('data-right', 'false')
    await expect.poll(() => shadow(tableCue, '::after')).toBe('0')
    expect(await shadow(tableCue, '::before')).toBe('1')

    const longCode = article.locator('.scroll-cue-code').filter({ hasText: 'artifact-pages publish' })
    await expect(longCode).toHaveAttribute('data-right', 'true')
    await expect(longCode).toHaveAttribute('data-left', 'false')
    await expect(longCode.locator('pre')).toHaveAttribute('tabindex', '0')
    await longCode.locator('pre').evaluate((element) => { element.scrollLeft = element.scrollWidth })
    await expect(longCode).toHaveAttribute('data-left', 'true')
    await expect(longCode).toHaveAttribute('data-right', 'false')

    const shortCode = article.locator('.scroll-cue-code').filter({ hasText: 'short' })
    await expect(shortCode).toHaveAttribute('data-left', 'false')
    await expect(shortCode).toHaveAttribute('data-right', 'false')
    expect(await shadow(shortCode, '::before')).toBe('0')
    expect(await shadow(shortCode, '::after')).toBe('0')
    await expect(shortCode.locator('pre')).not.toHaveAttribute('tabindex', '0')

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })

  test('HTML artifact frames get no injected cues', async ({ page }) => {
    await page.goto('/sre/architecture/platform-topology/index.html')
    await expect(page.locator('iframe.artifact-frame')).toBeVisible()
    await expect(page.locator('.scroll-cue')).toHaveCount(0)
    const injected = await page.locator('iframe.artifact-frame').evaluate(
      (frame) => (frame as HTMLIFrameElement).contentDocument?.querySelectorAll('.scroll-cue').length ?? 0,
    )
    expect(injected).toBe(0)
  })

  test('wide screens keep the rail and the labeled toolbar', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.goto(markdownPath)
    await expect(moreActionsButton(page)).toHaveCount(0)
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect(page.locator('.collapsed-rail')).toBeVisible()
    await expect(page.locator('.context-actions').getByRole('button', { name: 'Contents', exact: true })).toBeVisible()
    await page.setViewportSize({ width: 800, height: 800 })
    await expect(page.locator('.collapsed-rail')).toBeVisible()
    await expect(moreActionsButton(page)).toHaveCount(0)
  })
})

// ISSUE-086: a "Read next" list ends Markdown pages only; HTML artifacts get none.
test.describe('read next list', () => {
  test('ends a Markdown page, links in-app and is keyboard reachable', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/sre/reports/latency-retrospective.md')
    const document = page.getByTestId('markdown-document')
    await expect(document.getByRole('heading', { level: 2, name: 'Outcome at a glance' })).toBeVisible()
    const readNext = document.getByTestId('read-next')
    await expect(readNext.getByRole('heading', { level: 2, name: 'Read next' })).toBeVisible()

    // It sits after the article content, inside the scrolling region.
    const afterArticle = await document.evaluate((scroll) => {
      const article = scroll.querySelector('article')!
      const list = scroll.querySelector('[data-testid="read-next"]')!
      return Boolean(article.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) && !article.contains(list)
    })
    expect(afterArticle).toBe(true)

    const link = readNext.getByRole('link', { name: /Checkout latency incident review/ })
    await expect(link).toHaveAttribute('href', '/sre/incidents/checkout-latency/index.html')
    await expect(link).toContainText('incidents/checkout-latency/')
    await link.focus()
    await expect(link).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/sre\/incidents\/checkout-latency\/index\.html$/u)
    await expect(page.locator('iframe.artifact-frame')).toBeVisible()
  })

  test('is absent on an HTML artifact and on a Markdown page without related pages', async ({ page }) => {
    await page.goto('/sre/incidents/checkout-latency/index.html')
    await expect(page.locator('iframe.artifact-frame')).toBeVisible()
    await expect(page.getByTestId('read-next')).toHaveCount(0)

    await page.goto('/sre/runbooks/service-recovery.md')
    await expect(page.getByTestId('markdown-document')).toBeVisible()
    await expect(page.getByTestId('read-next')).toHaveCount(0)
  })

  test('fits a 390px viewport without horizontal page scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto('/sre/reports/latency-retrospective.md')
    const readNext = page.getByTestId('read-next')
    await readNext.scrollIntoViewIfNeeded()
    await expect(readNext).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    const box = await readNext.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  })
})

test('loading text appears only after a 300 ms delay and the page stays blank but busy until then', async ({ page }) => {
  let releaseRegistry!: () => void
  const registryGate = new Promise<void>((resolve) => { releaseRegistry = resolve })
  await page.route('**/_indexes/sites.json', async (route) => {
    await registryGate
    await route.continue()
  })

  await page.clock.install({ time: 0 })
  await page.clock.pauseAt(1000)
  await page.goto('/')
  try {
    await expect(page.locator('main.status-page[aria-busy="true"]')).toBeAttached()
    await expect(page.getByText('Loading sites…')).toHaveCount(0)
    await page.clock.runFor(299)
    await expect(page.getByText('Loading sites…')).toHaveCount(0)
    await page.clock.runFor(2)
    await expect(page.getByText('Loading sites…')).toBeVisible()
  } finally {
    releaseRegistry()
  }
})

test('switching to another Markdown document delays its loading text again', async ({ page }) => {
  await page.goto('/sre/runbooks/service-recovery.md')
  await expect(page.getByTestId('markdown-document')).toBeVisible()

  let releaseDocument!: () => void
  const documentGate = new Promise<void>((resolve) => { releaseDocument = resolve })
  await page.route('**/_artifacts/sre/diagrams/mermaid-catalog.md', async (route) => {
    await documentGate
    await route.continue()
  })

  await page.clock.install({ time: 0 })
  await page.clock.pauseAt(1000)
  try {
    await page.evaluate(() => {
      window.history.pushState({}, '', '/sre/diagrams/mermaid-catalog.md')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await expect(page.locator('.markdown-state[aria-busy="true"]')).toBeAttached()
    await expect(page.getByText('Loading document…')).toHaveCount(0)
    await page.clock.runFor(299)
    await expect(page.getByText('Loading document…')).toHaveCount(0)
    await page.clock.runFor(2)
    await expect(page.getByText('Loading document…')).toBeVisible()
  } finally {
    releaseDocument()
  }
})

// --- load deadlines and retry actions (ISSUE-101, ISSUE-102) ---

test('a catalog failure offers Try again, keeps focus on it after another failure, and recovers without a reload', async ({ page }) => {
  let healthy = false
  await page.route('**/_indexes/sites.json', (route) => healthy ? route.continue() : route.fulfill({ status: 503, body: 'unavailable' }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Unable to load sites' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('HTTP 503')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { name: 'Unable to load sites' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again' })).toBeFocused()
  healthy = true
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('link', { name: /SRE/ })).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
})

test('a site index failure offers Try again and recovers on the same route, query and fragment', async ({ page }) => {
  let healthy = false
  await page.route('**/_indexes/sre/index.json', (route) => healthy ? route.continue() : route.fulfill({ status: 503, body: 'unavailable' }))
  await page.goto('/sre/runbooks/service-recovery.md?q=latency#md-request-path')
  await expect(page.getByRole('heading', { name: 'Unable to load this site' })).toBeVisible()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('button', { name: 'Try again' })).toBeFocused()
  healthy = true
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.locator('.markdown-scroll')).toBeVisible()
  await expect(page).toHaveURL(/\/sre\/runbooks\/service-recovery\.md\?q=latency#md-request-path$/)
})

test('a Markdown failure offers Try again and the document renders afterwards', async ({ page }) => {
  let healthy = false
  await page.route('**/_artifacts/sre/runbooks/service-recovery.md', (route) => healthy ? route.continue() : route.fulfill({ status: 503, body: 'unavailable' }))
  await page.goto('/sre/runbooks/service-recovery.md')
  await expect(page.getByRole('heading', { name: 'Markdown unavailable' })).toBeVisible()
  await expect(page.getByText('This document could not be loaded (HTTP 503). Try again in a moment.')).toBeVisible()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('button', { name: 'Try again' })).toBeFocused()
  healthy = true
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.locator('.markdown-scroll')).toBeVisible()
  await expect(page).toHaveURL(/\/sre\/runbooks\/service-recovery\.md$/)
})

test('a stalled registry times out with a message and Try again recovers', async ({ page }) => {
  let healthy = false
  const stalled: Route[] = []
  await page.clock.install()
  await page.route('**/_indexes/sites.json', (route) => {
    if (healthy) return route.continue()
    stalled.push(route) // never answered: the request stays pending until the application gives up
  })
  await page.goto('/')
  await page.clock.runFor(15_000)
  await expect(page.getByRole('heading', { name: 'Unable to load sites' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('The site catalog is taking too long to load. Try again in a moment.')
  healthy = true
  await page.getByRole('button', { name: 'Try again' }).click()
  await page.clock.runFor(1_000)
  await expect(page.getByRole('link', { name: /SRE/ })).toBeVisible()
  // The shared cleanup waits for in-flight handlers; release the abandoned request.
  await Promise.all(stalled.map((route) => route.abort().catch(() => undefined)))
})

test('leaving the site from a preview document aborts its stalled production index read', async ({ page }) => {
  const stalled: Route[] = []
  await page.route('**/_indexes/sre/index.json', (route) => { stalled.push(route) })
  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview-guide.md`)
  await expect(previewTitle(page)).toHaveText('Local preview guide')
  await expect.poll(() => stalled.length).toBe(1)
  const aborted = page.waitForEvent('requestfailed', (request) => request.url().endsWith('/_indexes/sre/index.json'))
  await page.evaluate(() => {
    window.history.pushState({}, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page).toHaveURL(/\/$/)
  await aborted
  await Promise.all(stalled.map((route) => route.abort().catch(() => undefined)))
})

// ISSUE-108: a persistent Details and Contents column beside a document page at 1200 px or more.
test.describe('reader context column (ISSUE-108)', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  const markdownPath = '/sre/guides/markdown-style-gallery.md'
  const htmlPath = '/showcase/editorial/field-notes/index.html'
  const columnOf = (page: Page) => page.getByRole('complementary', { name: 'Reading context' })
  // clamp(256px, 21vw, 312px)
  const columnWidth = (viewportWidth: number) => Math.min(312, Math.max(256, viewportWidth * 0.21))
  const noHorizontalOverflow = (page: Page) => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
    && document.body.scrollWidth <= document.documentElement.clientWidth
  ))
  const focusInColumn = (page: Page) => page.evaluate(() => {
    const active = document.activeElement
    return active?.closest('[data-reader-column]') ? (active.tagName === 'BUTTON' ? `button:${active.textContent}` : active.tagName) : null
  })

  test('Markdown page shows Details above Contents beside the document and no toolbar buttons', async ({ page }) => {
    await page.goto(markdownPath)
    const column = columnOf(page)
    await expect(column).toBeVisible()
    expect((await column.boundingBox())?.width).toBeCloseTo(columnWidth(1440), 0)
    await expect(column.getByRole('heading', { name: 'Details' })).toBeVisible()
    await expect(column.getByText('Last committed by')).toHaveCount(0)
    await expect(column.getByText('Documentation QA')).toBeVisible()
    await expect(column.locator('.details-updated')).toContainText('Updated')
    await expect(column.getByText('example/markdown-qa', { exact: true })).toBeVisible()
    await expect(column.getByRole('link', { name: /guides\/markdown-style-gallery\.md/ })).toHaveAttribute('href', 'https://github.com/example/markdown-qa/blob/main/guides/markdown-style-gallery.md')
    await expect(column.getByRole('region', { name: 'Contents' })).toBeVisible()
    await expect(column.getByRole('navigation', { name: 'Artifact headings' }).getByRole('button').first()).toBeVisible()
    const detailsTop = (await column.getByRole('heading', { name: 'Details' }).boundingBox())!.y
    const contentsTop = (await column.getByRole('heading', { name: 'Contents' }).boundingBox())!.y
    expect(detailsTop).toBeLessThan(contentsTop)
    const actions = page.locator('.context-actions')
    await expect(actions.getByRole('button', { name: 'Contents', exact: true })).toHaveCount(0)
    await expect(actions.getByRole('button', { name: 'Details', exact: true })).toHaveCount(0)
    expect(await noHorizontalOverflow(page)).toBe(true)
    const article = (await page.locator('.markdown-article').boundingBox())!
    expect(article.x + article.width).toBeLessThanOrEqual((await column.boundingBox())!.x)
  })

  test('Contents sit on a rail and mark the part already read (ISSUE-114)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(markdownPath)
    const column = columnOf(page)
    expect((await column.boundingBox())?.width).toBeCloseTo(columnWidth(1280), 0)
    expect((await page.locator('#workspace-sidebar').boundingBox())?.width).toBeCloseTo(columnWidth(1280), 0)
    const items = column.locator('.toc-rail .toc-item')
    expect(await items.count()).toBeGreaterThan(2)
    await column.locator('.toc-link').nth(2).click()
    const current = column.locator('.toc-rail .toc-item.is-current')
    await expect(current).toHaveCount(1)
    await expect(current.locator('.toc-link')).toHaveAttribute('aria-current', 'location')
    expect(await column.locator('.toc-rail .toc-item.is-done').count()).toBe(
      await current.evaluate((element) => Array.from(element.parentElement!.children).indexOf(element)),
    )
    // Dots appear only on level-2 entries; level-3 entries carry none until they are current.
    const dots = await items.evaluateAll((elements) => elements.map((element) => ({
      level3: element.classList.contains('toc-item-3') && !element.classList.contains('is-current'),
      dot: getComputedStyle(element, '::before').content !== 'none',
    })))
    for (const entry of dots) if (entry.level3) expect(entry.dot).toBe(false)
  })

  test('HTML page shows the column beside the frame, which keeps its own scroll', async ({ page }) => {
    await page.goto(htmlPath)
    const column = columnOf(page)
    await expect(column).toBeVisible()
    const frame = (await page.locator('iframe.artifact-frame').boundingBox())!
    const box = (await column.boundingBox())!
    expect(box.width).toBeCloseTo(columnWidth(1440), 0)
    expect(frame.x + frame.width).toBeLessThanOrEqual(box.x + 0.5)
    await expect(column.getByRole('navigation', { name: 'Artifact headings' }).getByRole('button')).toHaveCount(4)
    expect(await noHorizontalOverflow(page)).toBe(true)
    // Publisher HTML is untouched.
    expect(await page.locator('iframe.artifact-frame').evaluate(
      (frame) => (frame as HTMLIFrameElement).contentDocument?.querySelectorAll('[data-reader-column], .toc-list').length ?? 0,
    )).toBe(0)
  })

  test('Markdown: Details scrolls away and Contents stays near the top of the reading pane', async ({ page }) => {
    await page.goto(markdownPath)
    const column = columnOf(page)
    const pane = page.locator('.markdown-scroll')
    await expect(column).toBeVisible()
    await expect(column.getByRole('heading', { name: 'Contents' })).toBeVisible()
    const paneTop = (await pane.boundingBox())!.y
    await expect.poll(async () => ((await column.getByRole('heading', { name: 'Contents' }).boundingBox())?.y ?? 0) - paneTop).toBeGreaterThan(60)
    await pane.evaluate((element) => element.scrollTo(0, 900))
    await expect.poll(async () => {
      const contents = (await column.getByRole('region', { name: 'Contents' }).boundingBox())!
      return Math.round(contents.y - paneTop)
    }).toBeLessThanOrEqual(10)
    const contentsTop = (await column.getByRole('region', { name: 'Contents' }).boundingBox())!.y - paneTop
    expect(contentsTop).toBeGreaterThanOrEqual(6)
    expect((await column.getByRole('heading', { name: 'Details' }).boundingBox())!.y + 20).toBeLessThan(paneTop)
    await expect(column.getByRole('navigation', { name: 'Artifact headings' })).toBeVisible()
  })

  test('Markdown: a heading list taller than the pane scrolls on its own without moving the document', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 420 })
    await page.goto('/sre/diagrams/mermaid-catalog.md')
    const pane = page.locator('.markdown-scroll')
    const list = columnOf(page).getByRole('navigation', { name: 'Artifact headings' })
    await expect(list).toBeVisible()
    await expect.poll(() => pane.evaluate((element) => { element.scrollTo(0, 600); return element.scrollTop })).toBeGreaterThan(500)
    await expect.poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    // Measured in one step so late layout shifts (diagrams rendering) cannot move the pane in between.
    const moved = await list.evaluate((element) => {
      const scroller = element.closest('.markdown-scroll')!
      const before = scroller.scrollTop
      element.scrollTop = 200
      return { listTop: element.scrollTop, paneDelta: scroller.scrollTop - before }
    })
    expect(moved.listTop).toBeGreaterThan(0)
    expect(moved.paneDelta).toBe(0)
    await expect.poll(async () => {
      const bounds = (await list.boundingBox())!
      return bounds.y + bounds.height
    }).toBeLessThanOrEqual(420)
  })

  test('HTML: the column scrolls on its own, Details first and then Contents', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 300 })
    await page.goto(htmlPath)
    const column = columnOf(page)
    await expect(column).toBeVisible()
    const frameScroll = () => page.locator('iframe.artifact-frame').evaluate((frame) => (frame as HTMLIFrameElement).contentWindow?.scrollY ?? -1)
    await expect.poll(() => column.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    const contents = column.getByRole('region', { name: 'Contents' })
    const columnBox = (await column.boundingBox())!
    expect((await column.getByRole('heading', { name: 'Details' }).boundingBox())!.y).toBeLessThan((await contents.boundingBox())!.y)
    await column.evaluate((element) => element.scrollTo(0, element.scrollHeight))
    expect(await column.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    expect(await frameScroll()).toBe(0)
    await expect(contents).toBeInViewport()
    const after = (await contents.boundingBox())!
    expect(after.y + after.height).toBeLessThanOrEqual(columnBox.y + columnBox.height + 1)
  })

  test('the current heading follows the scroll in Markdown', async ({ page }) => {
    await page.goto(markdownPath)
    const column = columnOf(page)
    const buttons = column.getByRole('navigation', { name: 'Artifact headings' }).getByRole('button')
    await expect(buttons.first()).toBeVisible()
    const count = await buttons.count()
    expect(count).toBeGreaterThan(5)
    const name = (await buttons.nth(5).textContent())!
    await page.evaluate(async (text) => {
      const headings = Array.from(document.querySelectorAll<HTMLElement>('.markdown-article h1, .markdown-article h2, .markdown-article h3'))
      headings.find((heading) => heading.textContent?.trim() === text)?.scrollIntoView({ block: 'start' })
    }, name.trim())
    await expect(column.locator('[aria-current="location"]')).toHaveText(name)
    await page.locator('.markdown-scroll').evaluate((element) => element.scrollTo(0, 0))
    await expect(column.locator('[aria-current="location"]')).toHaveText((await buttons.first().textContent())!)
  })

  test('the current heading follows the scroll in an HTML frame', async ({ page }) => {
    await page.goto(htmlPath)
    const column = columnOf(page)
    await expect(column.getByRole('navigation', { name: 'Artifact headings' })).toBeVisible()
    const frame = page.locator('iframe.artifact-frame')
    const current = column.locator('[aria-current="location"]')
    // Scrolling is repeated until the frame has loaded and the marking has caught up.
    await expect.poll(async () => {
      await frame.evaluate((element) => {
        const doc = (element as HTMLIFrameElement).contentDocument
        const win = (element as HTMLIFrameElement).contentWindow
        const target = doc?.getElementById('principles')
        if (doc && win && target) win.scrollTo({ top: target.getBoundingClientRect().top + win.scrollY - 20, behavior: 'instant' })
      })
      return current.textContent({ timeout: 1000 }).catch(() => null)
    }).toBe('Three useful tensions')
    await frame.evaluate((element) => (element as HTMLIFrameElement).contentWindow!.scrollTo({ top: 0, behavior: 'instant' }))
    await expect(column.locator('[aria-current="location"]')).toHaveText('Designing for resilience')
  })

  test('the marked entry stays visible inside the Contents list', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 420 })
    await page.goto('/sre/diagrams/mermaid-catalog.md')
    const list = columnOf(page).getByRole('navigation', { name: 'Artifact headings' })
    await expect(list).toBeVisible()
    await page.locator('.markdown-scroll').evaluate((element) => element.scrollTo(0, element.scrollHeight))
    const current = columnOf(page).locator('[aria-current="location"]')
    await expect(current).toBeVisible()
    await expect.poll(async () => {
      const entry = (await current.boundingBox())!
      const box = (await list.boundingBox())!
      return entry.y >= box.y - 1 && entry.y + entry.height <= box.y + box.height + 1
    }).toBe(true)
  })

  test('activating an entry goes to the heading, updates the fragment and keeps focus on the entry', async ({ page }) => {
    for (const path of [markdownPath, htmlPath]) {
      await page.goto(path)
      const entries = columnOf(page).getByRole('navigation', { name: 'Artifact headings' }).getByRole('button')
      await expect(entries.first()).toBeVisible()
      const entry = entries.nth(2)
      const text = (await entry.textContent())!
      const historyBefore = await page.evaluate(() => window.history.length)
      await entry.click()
      await expect(page).toHaveURL(/#[^#]+$/)
      await expect(entry).toBeFocused()
      expect(await page.evaluate(() => window.history.length)).toBe(historyBefore + 1)
      if (path === htmlPath) {
        await expect.poll(() => page.locator('iframe.artifact-frame').evaluate(
          (frame) => (frame as HTMLIFrameElement).contentWindow?.location.hash ?? '',
        )).toMatch(/^#.+/)
        await expect.poll(() => page.locator('iframe.artifact-frame').evaluate(
          (frame) => (frame as HTMLIFrameElement).contentWindow?.scrollY ?? 0,
        )).toBeGreaterThan(0)
      } else {
        const heading = page.locator('.markdown-article').getByRole('heading', { name: text, exact: true }).first()
        await expect(heading).toBeInViewport()
      }
      await expect(entry).toBeFocused()
    }
  })

  test('below 1200 px the column is gone and Contents and Details open as panels', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.goto(markdownPath)
    await expect(columnOf(page)).toHaveCount(0)
    const actions = page.locator('.context-actions')
    await actions.getByRole('button', { name: 'Contents', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Contents' })).toBeVisible()
    await actions.getByRole('button', { name: 'Details', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Details' })).toBeVisible()
    expect(await noHorizontalOverflow(page)).toBe(true)
  })

  test('narrow to wide closes the overlay panel and moves focus into the matching part of the column', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.goto(markdownPath)
    await page.locator('.context-actions').getByRole('button', { name: 'Contents', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Contents' })
    await panel.locator('.toc-link').nth(1).focus()
    await page.setViewportSize({ width: 1300, height: 800 })
    await expect(panel).toHaveCount(0)
    await expect(columnOf(page)).toBeVisible()
    await expect.poll(() => focusInColumn(page)).toMatch(/^button:/)
    await expect(page.locator('.context-actions').getByRole('button', { name: 'Contents', exact: true })).toHaveCount(0)

    await page.setViewportSize({ width: 1100, height: 800 })
    await page.locator('.context-actions').getByRole('button', { name: 'Details', exact: true }).click()
    await page.getByRole('complementary', { name: 'Details' }).getByRole('link').first().focus()
    await page.setViewportSize({ width: 1300, height: 800 })
    await expect(page.getByRole('complementary', { name: 'Details' })).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('reader-column-details-heading')
  })

  test('wide to narrow moves focus from the column to the matching toolbar button', async ({ page }) => {
    await page.goto(markdownPath)
    await columnOf(page).getByRole('navigation', { name: 'Artifact headings' }).getByRole('button').nth(1).focus()
    await page.setViewportSize({ width: 1100, height: 800 })
    await expect(columnOf(page)).toHaveCount(0)
    await expect(page.locator('.context-actions').getByRole('button', { name: 'Contents', exact: true })).toBeFocused()

    await page.setViewportSize({ width: 1300, height: 800 })
    await columnOf(page).getByRole('heading', { name: 'Details' }).focus()
    await page.setViewportSize({ width: 1100, height: 800 })
    await expect(page.locator('.context-actions').getByRole('button', { name: 'Details', exact: true })).toBeFocused()
  })

  test('the Contents shortcut and the palette commands move focus into the column', async ({ page }) => {
    await page.goto(markdownPath)
    const column = columnOf(page)
    await expect(column).toBeVisible()
    await expect(page.getByTestId('markdown-document')).toBeVisible()
    await page.keyboard.press('Control+Shift+O')
    await expect.poll(() => focusInColumn(page)).toMatch(/^button:/)
    await expect(column.locator('.toc-link:focus')).toHaveCount(1)

    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await page.keyboard.press('Control+k')
    await palette.getByRole('combobox').fill('>Toggle details')
    await palette.getByRole('option', { name: 'Toggle details' }).click()
    await expect(palette).toBeHidden()
    await expect(column.getByRole('heading', { name: 'Details' })).toBeFocused()

    await page.keyboard.press('Control+k')
    await palette.getByRole('combobox').fill('>Toggle contents')
    await palette.getByRole('option', { name: 'Toggle contents' }).click()
    await expect(palette).toBeHidden()
    await expect.poll(() => focusInColumn(page)).toMatch(/^button:/)
  })

  test('Tab reaches the document controls before the column', async ({ page }) => {
    await page.goto(markdownPath)
    await expect(columnOf(page)).toBeVisible()
    await expect(page.locator('.markdown-article')).toBeVisible()
    const order = await page.evaluate(() => {
      const column = document.querySelector('[data-reader-column]')!
      const article = document.querySelector('.markdown-article')!
      return Boolean(article.compareDocumentPosition(column) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(order).toBe(true)
  })

  test('a document with no headings shows the empty message and the Contents command lands on it', async ({ page }) => {
    await page.route('**/_indexes/sre/index.json', async (route) => {
      const response = await route.fetch()
      const index = await response.json() as { artifacts: Array<Record<string, unknown>> }
      for (const artifact of index.artifacts) if (artifact.path === 'runbooks/service-recovery.md') artifact.toc = []
      await route.fulfill({ response, body: JSON.stringify(index) })
    })
    await page.goto('/sre/runbooks/service-recovery.md')
    const column = columnOf(page)
    await expect(page.getByTestId('markdown-document')).toBeVisible()
    await expect(column.getByText('This artifact does not include indexed headings.')).toBeVisible()
    await page.keyboard.press('Control+Shift+O')
    await expect(column.getByText('This artifact does not include indexed headings.')).toBeFocused()
  })

  test('a document without provenance shows only what exists', async ({ page }) => {
    await page.goto('/showcase/tests/color-scheme-response/index.html')
    const column = columnOf(page)
    await expect(column.locator('.details-updated')).toContainText('Updated')
    await expect(column.getByText('Last committed by')).toHaveCount(0)
    await expect(column.locator('.details-avatar')).toHaveCount(0)
    await expect(column.locator('.details-source')).toHaveCount(0)
    await expect(column.locator('.artifact-details a')).toHaveCount(0)
  })

  test('long headings, titles and repository names wrap inside the column', async ({ page }) => {
    const longHeading = 'Reviewing_changes_touching_the_registry_release_workflow_and_Terraform_together_in_one_unbroken_pass'
    await page.route('**/_indexes/sre/index.json', async (route) => {
      const response = await route.fetch()
      const index = await response.json() as { artifacts: Array<{ path: string, toc?: unknown[], source?: { repository: string }, lastCommitter?: { name: string } }> }
      for (const artifact of index.artifacts) {
        if (artifact.path !== 'reports/latency-retrospective.md') continue
        artifact.toc = [{ level: 2, text: longHeading, id: 'md-outcome-at-a-glance' }, { level: 3, text: `${longHeading} again`, id: 'md-timeline' }]
        if (artifact.source) artifact.source.repository = 'example/a-very-long-repository-name-that-keeps-going-and-going-without-a-break'
        if (artifact.lastCommitter) artifact.lastCommitter.name = 'A Committer With An Extraordinarily Long Display Name That Wraps'
      }
      await route.fulfill({ response, body: JSON.stringify(index) })
    })
    await page.goto('/sre/reports/latency-retrospective.md')
    const column = columnOf(page)
    await expect(column.getByRole('button', { name: longHeading, exact: true })).toBeVisible()
    expect(await column.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect((await column.boundingBox())?.width).toBeCloseTo(columnWidth(1440), 0)
    expect(await noHorizontalOverflow(page)).toBe(true)
  })

  test('1200 px with the sidebar expanded and 1280 px with it collapsed have no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 })
    for (const path of [markdownPath, htmlPath]) {
      await page.goto(path)
      await expect(columnOf(page)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible()
      expect(await noHorizontalOverflow(page)).toBe(true)
      const sidebar = (await page.locator('#workspace-sidebar').boundingBox())!
      const column = (await columnOf(page).boundingBox())!
      expect(sidebar.x + sidebar.width).toBeLessThanOrEqual(column.x)
      if (path === markdownPath) {
        expect((await page.locator('.markdown-article').boundingBox())!.width).toBeGreaterThanOrEqual(600)
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect(page.locator('.collapsed-rail')).toBeVisible()
    await expect(columnOf(page)).toBeVisible()
    expect(await noHorizontalOverflow(page)).toBe(true)
    await page.getByRole('button', { name: 'Expand navigation' }).click()
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible()
    expect(await noHorizontalOverflow(page)).toBe(true)
  })

  test('the search-match navigator does not sit on top of the column', async ({ page }) => {
    await registerTextSearchSite(page)
    await page.goto('/textsearch/long/scroll-target.md?q=word')
    await expect(page.getByTestId('markdown-document')).toBeVisible()
    await expect(columnOf(page)).toBeVisible()
    const navigator = page.getByRole('group', { name: 'Matches in this page' })
    await expect(navigator).toBeVisible({ timeout: 20_000 })
    const nav = (await navigator.boundingBox())!
    const column = (await columnOf(page).boundingBox())!
    expect(nav.x + nav.width).toBeLessThanOrEqual(column.x)
  })

  test('the column is absent when a Markdown document fails to load, and returns after a retry', async ({ page }) => {
    let available = false
    await page.route('**/_artifacts/sre/runbooks/service-recovery.md', (route) => available ? route.continue() : route.fulfill({ status: 500, body: 'broken' }))
    await page.goto('/sre/runbooks/service-recovery.md')
    await expect(page.getByRole('alert')).toContainText('Markdown unavailable')
    await expect(columnOf(page)).toHaveCount(0)
    await expect(page.locator('.context-actions').getByRole('button', { name: 'Contents', exact: true })).toBeVisible()
    available = true
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(columnOf(page)).toBeVisible()
  })

  test('the column is absent when an HTML body fails to load, and returns after a retry', async ({ page }) => {
    const artifactPath = 'guides/missing.html'
    let available = false
    await page.route('**/_indexes/sre/index.json', async (route) => {
      const response = await route.fetch()
      const index = await response.json() as { artifacts: Array<Record<string, unknown>> }
      index.artifacts.push({
        id: artifactPath, title: 'Missing body', path: artifactPath, format: 'html', filename: 'missing.html',
        artifactUrl: `/_artifacts/sre/${artifactPath}`, updatedAt: '2026-10-01T00:00:00Z',
      })
      await route.fulfill({ response, body: JSON.stringify(index) })
    })
    await page.route(`**/_artifacts/sre/${artifactPath}`, (route) => available
      ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Back</title><p id="body">Body is back</p>' })
      : route.fulfill({ status: 404, contentType: 'text/html; charset=utf-8', body: '<h1>404 Not Found</h1>' }))
    await page.goto(`/sre/${artifactPath}`)
    await expect(page.getByRole('alert').getByRole('heading', { name: 'Document unavailable' })).toBeVisible()
    await expect(columnOf(page)).toHaveCount(0)
    available = true
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(columnOf(page)).toBeVisible()
  })

  test('narrow to wide from the More menu keeps focus: the open panel maps to its column part, otherwise Contents', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 800 })
    await page.goto(markdownPath)
    const more = moreActionsButton(page)
    const menu = page.getByRole('menu', { name: 'More actions' })
    const menuItem = (name: string) => menu.getByRole('menuitem', { name }).or(menu.getByRole('menuitemcheckbox', { name }))
    const activeId = () => page.evaluate(() => {
      const active = document.activeElement
      if (!active || active === document.body) return 'body'
      return active.closest('[data-reader-column]') ? (active.id || `column:${active.className}`) : 'outside'
    })

    // A Details panel opened from the More menu, focus on the More trigger.
    await more.click()
    await menuItem('Details').click()
    await expect(page.getByRole('complementary', { name: 'Details' })).toBeVisible()
    await expect(more).toBeFocused()
    await page.setViewportSize({ width: 1440, height: 800 })
    await expect(columnOf(page)).toBeVisible()
    await expect.poll(activeId).toBe('reader-column-details-heading')

    // A Contents panel with focus inside it.
    await page.setViewportSize({ width: 500, height: 800 })
    await expect(columnOf(page)).toHaveCount(0)
    await more.click()
    await menuItem('Contents').click()
    const panel = page.getByRole('complementary', { name: 'Contents' })
    await expect(panel).toBeVisible()
    await panel.locator('.toc-link').nth(1).focus()
    await page.setViewportSize({ width: 1440, height: 800 })
    await expect(columnOf(page)).toBeVisible()
    await expect.poll(activeId).toContain('toc-link')

    // No panel open, focus on the More trigger: Contents.
    await page.setViewportSize({ width: 500, height: 800 })
    await expect(columnOf(page)).toHaveCount(0)
    await more.focus()
    await page.setViewportSize({ width: 1440, height: 800 })
    await expect(columnOf(page)).toBeVisible()
    await expect.poll(activeId).toContain('toc-link')
  })

  test('the column is not remounted when a Markdown document finishes loading, so focus stays', async ({ page }) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/_artifacts/sre/runbooks/service-recovery.md', async (route) => {
      await gate
      await route.continue()
    })
    await page.goto('/sre/runbooks/service-recovery.md', { waitUntil: 'commit' })
    const column = columnOf(page)
    await expect(column).toBeVisible()
    await expect(page.getByTestId('markdown-document')).toHaveCount(0)
    // Focus a Contents entry and mark both it and the Details heading so identity can be compared later.
    await page.keyboard.press('Control+Shift+O')
    await expect.poll(() => focusInColumn(page)).toMatch(/^button:/)
    const focusedText = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement
      active.dataset.probe = 'focus'
      document.querySelector<HTMLElement>('#reader-column-details-heading')!.dataset.probe = 'details'
      return active.textContent
    })
    release()
    await expect(page.getByTestId('markdown-document')).toBeVisible()
    await expect(page.locator('.markdown-article')).toBeVisible()
    expect(await page.evaluate(() => ({
      focusKept: document.activeElement?.getAttribute('data-probe'),
      detailsKept: document.querySelector('#reader-column-details-heading')?.getAttribute('data-probe'),
      text: document.activeElement?.textContent,
      inColumn: Boolean(document.activeElement?.closest('[data-reader-column]')),
    }))).toEqual({ focusKept: 'focus', detailsKept: 'details', text: focusedText, inColumn: true })
  })

  test('narrow to wide with an item of the open More menu focused lands on Contents in the column', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 800 })
    await page.goto(markdownPath)
    await moreActionsButton(page).click()
    const menu = page.getByRole('menu', { name: 'More actions' })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Copy link' }).focus()
    await expect(menu.getByRole('menuitem', { name: 'Copy link' })).toBeFocused()
    await page.setViewportSize({ width: 1440, height: 800 })
    await expect(columnOf(page)).toBeVisible()
    await expect(menu).toHaveCount(0)
    await expect.poll(() => focusInColumn(page)).toMatch(/^button:/)
  })

  test('an HTML body whose status probe fails at the network level is reported as unavailable', async ({ page }) => {
    // Browsers that do not expose the navigation response status (Safari) classify the first load with a HEAD request.
    await page.addInitScript(() => {
      const proto = (window as unknown as { PerformanceNavigationTiming?: { prototype: object } }).PerformanceNavigationTiming?.prototype
      if (proto) Object.defineProperty(proto, 'responseStatus', { get: () => 0, configurable: true })
    })
    const artifactPath = 'guides/unprobed.html'
    await page.route('**/_indexes/sre/index.json', async (route) => {
      const response = await route.fetch()
      const index = await response.json() as { artifacts: Array<Record<string, unknown>> }
      index.artifacts.push({
        id: artifactPath, title: 'Unprobed body', path: artifactPath, format: 'html', filename: 'unprobed.html',
        artifactUrl: `/_artifacts/sre/${artifactPath}`, updatedAt: '2026-10-01T00:00:00Z', toc: [{ level: 1, text: 'Hello', id: 'hello' }],
      })
      await route.fulfill({ response, body: JSON.stringify(index) })
    })
    let probeFails = true
    await page.route(`**/_artifacts/sre/${artifactPath}`, (route) => {
      if (route.request().method() === 'HEAD') return probeFails ? route.abort('connectionreset') : route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8' })
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Body</title><h1 id="hello">Hello</h1>' })
    })
    await page.goto(`/sre/${artifactPath}`)
    const alert = page.getByRole('alert')
    await expect(alert.getByRole('heading', { name: 'Document unavailable' })).toBeVisible()
    await expect(alert).toContainText('The content of “Unprobed body” could not be loaded.')
    await expect(alert).not.toContainText('HTTP')
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(alert.getByRole('link', { name: /SRE/ })).toBeVisible()
    await expect(columnOf(page)).toHaveCount(0)
    probeFails = false
    await alert.getByRole('button', { name: 'Try again' }).click()
    await expect(columnOf(page)).toBeVisible()
  })

  test('a late failing status probe does not hide a page the frame has since navigated to', async ({ page }) => {
    await page.addInitScript(() => {
      const proto = (window as unknown as { PerformanceNavigationTiming?: { prototype: object } }).PerformanceNavigationTiming?.prototype
      if (proto) Object.defineProperty(proto, 'responseStatus', { get: () => 0, configurable: true })
    })
    const artifactPath = 'guides/probe-first.html'
    await page.route('**/_indexes/sre/index.json', async (route) => {
      const response = await route.fetch()
      const index = await response.json() as { artifacts: Array<Record<string, unknown>> }
      index.artifacts.push({
        id: artifactPath, title: 'Probe first', path: artifactPath, format: 'html', filename: 'probe-first.html',
        artifactUrl: `/_artifacts/sre/${artifactPath}`, updatedAt: '2026-10-01T00:00:00Z',
      })
      await route.fulfill({ response, body: JSON.stringify(index) })
    })
    let failProbe!: () => void
    const gate = new Promise<void>((resolve) => { failProbe = resolve })
    await page.route(`**/_artifacts/sre/${artifactPath}`, async (route) => {
      if (route.request().method() === 'HEAD') {
        await gate
        await route.abort('connectionreset')
        return
      }
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>First</title><a id="go" href="probe-second.html">second</a>' })
    })
    await page.route('**/_artifacts/sre/guides/probe-second.html', (route) => route.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Second</title><p id="two">Second page</p>',
    }))
    await page.goto(`/sre/${artifactPath}`)
    const frame = page.frameLocator('iframe.artifact-frame')
    await frame.locator('#go').click()
    await expect(frame.locator('#two')).toBeVisible()
    failProbe()
    await page.waitForTimeout(500)
    await expect(page.getByRole('heading', { name: 'Document unavailable' })).toHaveCount(0)
    await expect(page.locator('iframe.artifact-frame')).toBeVisible()
    await expect(frame.locator('#two')).toBeVisible()
  })

  test('a failing status probe is also ignored while a navigation of the frame has started but not finished', async ({ page }) => {
    await page.addInitScript(() => {
      const proto = (window as unknown as { PerformanceNavigationTiming?: { prototype: object } }).PerformanceNavigationTiming?.prototype
      if (proto) Object.defineProperty(proto, 'responseStatus', { get: () => 0, configurable: true })
    })
    const artifactPath = 'guides/probe-pending.html'
    await page.route('**/_indexes/sre/index.json', async (route) => {
      const response = await route.fetch()
      const index = await response.json() as { artifacts: Array<Record<string, unknown>> }
      index.artifacts.push({
        id: artifactPath, title: 'Probe pending', path: artifactPath, format: 'html', filename: 'probe-pending.html',
        artifactUrl: `/_artifacts/sre/${artifactPath}`, updatedAt: '2026-10-01T00:00:00Z',
      })
      await route.fulfill({ response, body: JSON.stringify(index) })
    })
    let failProbe!: () => void
    const probeGate = new Promise<void>((resolve) => { failProbe = resolve })
    let finishNavigation!: () => void
    const navigationGate = new Promise<void>((resolve) => { finishNavigation = resolve })
    let navigationRequested!: () => void
    const requested = new Promise<void>((resolve) => { navigationRequested = resolve })
    await page.route(`**/_artifacts/sre/${artifactPath}`, async (route) => {
      if (route.request().method() === 'HEAD') {
        await probeGate
        await route.abort('connectionreset')
        return
      }
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>First</title><a id="go" href="probe-slow.html?v=2">slow</a><p id="one">First page</p>' })
    })
    await page.route('**/_artifacts/sre/guides/probe-slow.html**', async (route) => {
      navigationRequested()
      await navigationGate
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Slow</title><p id="two">Slow page</p>' })
    })
    await page.goto(`/sre/${artifactPath}`)
    const frame = page.frameLocator('iframe.artifact-frame')
    await frame.locator('#go').click()
    await requested
    failProbe()
    await page.waitForTimeout(500)
    await expect(page.getByRole('heading', { name: 'Document unavailable' })).toHaveCount(0)
    await expect(page.locator('iframe.artifact-frame')).toBeVisible()
    finishNavigation()
    await expect(frame.locator('#two')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Document unavailable' })).toHaveCount(0)
  })

  test('closing the More menu with a click on a blank area clears its focus record before a resize', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 800 })
    await page.goto(markdownPath)
    await moreActionsButton(page).click()
    const menu = page.getByRole('menu', { name: 'More actions' })
    await menu.getByRole('menuitem', { name: 'Copy link' }).focus()
    await page.mouse.click(250, 400)
    await expect(menu).toHaveCount(0)
    await page.setViewportSize({ width: 1440, height: 800 })
    await expect(columnOf(page)).toBeVisible()
    await page.waitForTimeout(400)
    expect(await focusInColumn(page)).toBeNull()
  })

  test('the column is absent on site home, folders, search, previews and missing pages', async ({ page }) => {
    await registerTextSearchSite(page)
    for (const path of [
      '/sre',
      '/sre/runbooks',
      '/textsearch/_search?q=latency',
      '/showcase/_previews',
      '/showcase/_previews/0123456789abcdef0123456789abcdef01234567/notes.md',
      '/sre/does-not-exist.md',
    ]) {
      await page.goto(path)
      await expect(page.locator('body')).toBeVisible()
      await expect(page.locator('#root')).not.toBeEmpty()
      await page.waitForTimeout(300)
      await expect(columnOf(page), path).toHaveCount(0)
      await expect(page.locator('[data-reader-column]'), path).toHaveCount(0)
    }
  })
})

// ISSUE-107: the site home is Overview / Files / Previews with the site search beside them.
test.describe('site home sections', () => {
  type HomeEntry = { path: string, title: string, format?: 'markdown' | 'html', updatedAt?: string, url?: string }

  /** Adds entries to (or, with `replace`, swaps all of) SRE's index; each entry's body is served by `bodies`. */
  async function routeSreHome(
    page: Page,
    entries: HomeEntry[],
    options: { replace?: boolean, bodies?: Record<string, { type: 'markdown' | 'html', body: string }> } = {},
  ) {
    for (const [url, { type, body }] of Object.entries(options.bodies ?? {})) {
      await page.route(`**${url}`, (route) => route.fulfill({
        status: 200,
        contentType: type === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
        body,
      }))
    }
    await page.route('**/_indexes/sre/index.json', async (route) => {
      const response = await route.fetch()
      const index = await response.json()
      if (options.replace) index.artifacts = []
      index.artifacts.push(...entries.map((entry) => ({
        id: entry.path,
        path: entry.path,
        title: entry.title,
        format: entry.format ?? 'markdown',
        filename: entry.path.split('/').at(-1),
        artifactUrl: entry.url ?? `/_artifacts/sre/${entry.path}`,
        updatedAt: entry.updatedAt ?? '2026-10-01T00:00:00Z',
        toc: [],
      })))
      await route.fulfill({ response, json: index })
    })
  }

  const readmeBodies = {
    '/_artifacts/sre/README.md': { type: 'markdown' as const, body: '# Readme heading\n\nREADME introduction text.\n' },
    '/_artifacts/sre/index.md': { type: 'markdown' as const, body: '# Index heading\n\nIndex introduction text.\n' },
  }
  const readmeEntries: HomeEntry[] = [
    { path: 'README.md', title: 'Welcome' },
    { path: 'index.md', title: 'Index page' },
  ]
  const sections = (page: Page) => page.getByRole('navigation', { name: 'Site sections' })
  const sectionLink = (page: Page, name: string) => sections(page).getByRole('link', { name: new RegExp(`^${name}`) })
  const searchEntry = (page: Page) => page.getByRole('button', { name: 'Search this site' })
  const scroller = (page: Page) => page.locator('.directory-scroll')
  const bulkEntries = (count: number): HomeEntry[] => Array.from({ length: count }, (_, position) => ({
    path: `bulk-${String(position + 1).padStart(2, '0')}.md`,
    title: `Bulk page ${position + 1}`,
    updatedAt: '2026-09-01T00:00:00Z',
  }))

  test('the header shows the title, description, page count and the newest document update', async ({ page }) => {
    await page.route('**/_indexes/sites.json', async (route) => {
      const response = await route.fetch()
      const registry = await response.json()
      for (const site of registry.sites) if (site.id === 'sre') site.description = 'Reliability runbooks.'
      await route.fulfill({ response, json: registry })
    })
    await routeSreHome(page, [{ path: 'late.md', title: 'Late page', updatedAt: '2026-10-15T08:00:00Z' }])
    await page.goto('/sre')
    const heading = page.locator('.site-home-heading')
    await expect(heading.getByRole('heading', { level: 1, name: 'SRE', exact: true })).toBeVisible()
    await expect(heading.getByText('Reliability runbooks.')).toBeVisible()
    await expect(heading.locator('.site-home-lede')).toHaveText('7 pages · Updated Oct 15, 2026')
    await expect(heading.locator('time')).toHaveAttribute('datetime', '2026-10-15T08:00:00Z')
    // The preview explanation, the preview action and the large jump control are gone from the header.
    await expect(page.getByText(/^Previews are review copies/)).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'View previews' })).toHaveCount(0)
    await expect(page.locator('.directory-page').getByText('Jump to a page…')).toHaveCount(0)
    await expect(sections(page).getByRole('link')).toHaveText([/^Files$/, /^Previews/])
  })

  test('Overview shows README.md in preference to index.md', async ({ page }) => {
    await routeSreHome(page, readmeEntries, { bodies: readmeBodies })
    await page.goto('/sre')
    await expect(sections(page).getByRole('link')).toHaveText([/^Overview$/, /^Files$/, /^Previews/])
    await expect(sectionLink(page, 'Overview')).toHaveAttribute('aria-current', 'page')
    await expect(sectionLink(page, 'Overview')).toHaveAttribute('href', '/sre')
    await expect(page.locator('.directory-readme-label')).toHaveText('README.md')
    await expect(page.getByRole('heading', { name: 'Readme heading' })).toBeVisible()
    await expect(page.getByText('Index introduction text.')).toHaveCount(0)
    // index.md is an ordinary document in Files; README.md is the introduction and is not listed twice.
    await sectionLink(page, 'Files').click()
    await expect(page).toHaveURL('/sre?section=files')
    await expect(page.locator('[data-directory-page="index.md"]')).toBeVisible()
    await expect(page.locator('[data-directory-page="README.md"]')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Readme heading' })).toHaveCount(0)

    // Without README.md, index.md is the introduction (case-insensitive).
    await page.unroute('**/_indexes/sre/index.json')
    await routeSreHome(page, [{ path: 'INDEX.MD', title: 'Upper index', url: '/_artifacts/sre/index.md' }])
    await page.goto('/sre')
    await expect(page.getByRole('heading', { name: 'Index heading' })).toBeVisible()
  })

  test('root index.html is not embedded: it is listed in Files and opens at its own URL', async ({ page }) => {
    const bodies = { '/_artifacts/sre/index.html': { type: 'html' as const, body: '<!doctype html><title>Root HTML</title><h1>Root HTML page</h1>' } }
    await routeSreHome(page, [
      { path: 'index.html', title: 'Root HTML page', format: 'html' },
      { path: 'README.md', title: 'Welcome' },
    ], { bodies: { ...bodies, '/_artifacts/sre/README.md': readmeBodies['/_artifacts/sre/README.md'] } })
    await page.goto('/sre')
    await expect(page.getByRole('heading', { name: 'Readme heading' })).toBeVisible()
    await expect(page.locator('iframe.artifact-frame')).toHaveCount(0)
    await sectionLink(page, 'Files').click()
    await expect(page.locator('iframe.artifact-frame')).toHaveCount(0)
    await page.locator('[data-directory-page="index.html"]').click()
    await expect(page).toHaveURL('/sre/index.html')
    await expect(page.locator('iframe.artifact-frame')).toBeVisible()
    await expect(page.frameLocator('iframe.artifact-frame').getByRole('heading', { name: 'Root HTML page' })).toBeVisible()

    // Alone, it does not become the introduction either.
    await page.unroute('**/_indexes/sre/index.json')
    await routeSreHome(page, [{ path: 'index.htm', title: 'Legacy index', format: 'html', url: '/_artifacts/sre/index.html' }])
    await page.goto('/sre')
    await expect(sectionLink(page, 'Files')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('iframe.artifact-frame')).toHaveCount(0)
    await expect(page.locator('[data-directory-page="index.htm"]')).toBeVisible()
  })

  test('nested folders keep their HTML and Markdown index bodies', async ({ page }) => {
    await routeSreHome(page, [
      { path: 'README.md', title: 'Welcome' },
      { path: 'html-folder/index.html', title: 'Folder HTML', format: 'html', url: '/_artifacts/sre/index.html' },
      { path: 'md-folder/README.md', title: 'Folder README' },
    ], {
      bodies: {
        '/_artifacts/sre/index.html': { type: 'html', body: '<!doctype html><h1>Nested HTML body</h1>' },
        '/_artifacts/sre/md-folder/README.md': { type: 'markdown', body: '# Nested markdown body\n' },
        ...readmeBodies,
      },
    })
    await page.goto('/sre/html-folder')
    await expect(page.getByTestId('directory-page')).toHaveAttribute('data-directory-variant', 'index')
    await expect(page.frameLocator('iframe.artifact-frame').getByRole('heading', { name: 'Nested HTML body' })).toBeVisible()
    await page.goto('/sre/md-folder')
    await expect(page.getByRole('heading', { name: 'Nested markdown body' })).toBeVisible()
    await expect(page.locator('.site-sections')).toHaveCount(0)
  })

  test('without an introduction Files is the default and there is no Overview link', async ({ page }) => {
    await page.goto('/sre')
    await expect(sectionLink(page, 'Overview')).toHaveCount(0)
    await expect(sectionLink(page, 'Files')).toHaveAttribute('aria-current', 'page')
    await expect(sectionLink(page, 'Files')).toHaveAttribute('href', '/sre')
    await page.goto('/sre?section=files')
    await expect(sectionLink(page, 'Files')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('region', { name: 'Folders' })).toBeVisible()
  })

  test('an introduction that disappears while Overview is open leaves Files in place without an error', async ({ page }) => {
    await routeSreHome(page, readmeEntries, { bodies: readmeBodies })
    await page.goto('/sre')
    await expect(sectionLink(page, 'Overview')).toHaveAttribute('aria-current', 'page')
    // A newer index without an introduction arrives (the shown address stays the same).
    await page.unroute('**/_indexes/sre/index.json')
    await page.reload()
    await expect(page).toHaveURL('/sre')
    await expect(sectionLink(page, 'Files')).toHaveAttribute('aria-current', 'page')
    await expect(sectionLink(page, 'Overview')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Folders' })).toBeVisible()
  })

  test('an unknown section value shows the default section and is replaced in history', async ({ page }) => {
    await routeSreHome(page, readmeEntries, { bodies: readmeBodies })
    await page.goto('/')
    await page.evaluate(() => { window.history.pushState({}, '', '/sre?section=bogus'); window.dispatchEvent(new PopStateEvent('popstate')) })
    await expect(page).toHaveURL('/sre')
    await expect(sectionLink(page, 'Overview')).toHaveAttribute('aria-current', 'page')
    await page.goBack()
    // The corrected entry replaced the bogus one, so Back leaves the site.
    await expect(page).toHaveURL('/')
  })

  test('an empty site has a zero count, no Overview, the empty message and a working Previews', async ({ page }) => {
    await routeSreHome(page, [], { replace: true })
    await page.goto('/sre')
    await expect(page.locator('.site-home-lede')).toHaveText('0 pages')
    await expect(sectionLink(page, 'Overview')).toHaveCount(0)
    await expect(sectionLink(page, 'Files')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByText('No artifacts have been published to this site yet.')).toBeVisible()
    await sectionLink(page, 'Previews').click()
    await expect(page).toHaveURL('/sre/_previews')
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
    await expect(sectionLink(page, 'Previews')).toHaveAttribute('aria-current', 'page')
  })

  test('a group link shows the catalog-wide preview count', async ({ page }) => {
    await page.goto('/sre/_previews?group=pr%3A42')
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Preview pr:43' })).toHaveCount(0)
    // The catalog lists three groups; the filtered view does not change the badge.
    await expect(sectionLink(page, 'Previews').locator('.site-section-count')).toHaveText('3')
  })

  for (const mode of ['in the site home', 'standalone'] as const) {
    test(`switching ?group= links never shows another group's results (${mode})`, async ({ page }) => {
      if (mode === 'standalone') await page.route('**/_indexes/sre/index.json', (route) => route.fulfill({ status: 503, body: 'unavailable' }))
      // Records every DOM state in which a shown preview group differs from the group named by the URL.
      await page.addInitScript(() => {
        const w = window as unknown as { __violations: string[] }
        w.__violations = []
        const check = () => {
          const wanted = new URLSearchParams(location.search).get('group')
          if (!wanted || !location.pathname.endsWith('/_previews')) return
          for (const element of document.querySelectorAll('section.preview-group')) {
            const shown = element.getAttribute('aria-label')?.replace(/^Preview /, '')
            if (shown !== wanted) w.__violations.push(`${shown} shown under ${wanted}`)
          }
        }
        new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true })
        // Also every frame, since a stale render can leave the DOM as it was and so cause no mutation.
        const frame = () => { check(); window.requestAnimationFrame(frame) }
        window.requestAnimationFrame(frame)
      })
      await page.goto('/sre/_previews?group=pr%3A42')
      await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
      for (const [from, to] of [['pr:42', 'pr:43'], ['pr:43', 'pr:42']]) {
        await page.evaluate((target) => {
          history.pushState({}, '', `/sre/_previews?group=${encodeURIComponent(target)}`)
          window.dispatchEvent(new PopStateEvent('popstate'))
        }, to)
        await expect(page.getByRole('region', { name: `Preview ${to}` })).toBeVisible()
        await expect(page.getByRole('region', { name: `Preview ${from}` })).toHaveCount(0)
      }
      expect(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([])
    })
  }

  test('the Previews list does not wait for a slow site index and keeps its data and scroll when it arrives', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 360 })
    const requests: string[] = []
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname.startsWith('/_previews/sre/')) requests.push(pathname)
    })
    let releaseIndex!: () => void
    const gate = new Promise<void>((resolve) => { releaseIndex = resolve })
    await page.route('**/_indexes/sre/index.json', async (route) => {
      await gate
      await route.continue()
    })
    await page.goto('/sre/_previews')
    // Standalone while the index is pending.
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
    await expect(sections(page)).toHaveCount(0)
    const standalone = page.locator('.preview-page')
    await standalone.evaluate((element) => { element.scrollTop = 150 })
    await expect.poll(() => standalone.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
    const before = await standalone.evaluate((element) => element.scrollTop)
    const requestsBefore = [...requests]
    expect(requestsBefore.filter((pathname) => pathname.endsWith('/catalog.json'))).toHaveLength(1)

    releaseIndex()
    await expect(sections(page)).toBeVisible()
    await expect(sectionLink(page, 'Previews')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
    await expect(sectionLink(page, 'Previews').locator('.site-section-count')).toHaveText('3')
    await expect.poll(() => scroller(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(before - 60)
    // No second load: the catalog and every manifest were requested once.
    expect([...requests].sort()).toEqual([...requestsBefore].sort())
    expect(new Set(requests).size).toBe(requests.length)
  })

  test('the Previews list stays standalone when the site index fails after a delay', async ({ page }) => {
    let releaseIndex!: () => void
    const gate = new Promise<void>((resolve) => { releaseIndex = resolve })
    await page.route('**/_indexes/sre/index.json', async (route) => {
      await gate
      await route.fulfill({ status: 503, body: 'unavailable' })
    })
    await page.goto('/sre/_previews')
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
    releaseIndex()
    await page.waitForResponse((response) => new URL(response.url()).pathname === '/_indexes/sre/index.json')
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
    await expect(page.getByRole('link', { name: '← SRE', exact: true })).toBeVisible()
    await expect(sections(page)).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('the badge and the list share one catalog load; Try again and leaving the site start a fresh one', async ({ page }) => {
    await routeSreHome(page, readmeEntries, { bodies: readmeBodies })
    const requests: string[] = []
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname.startsWith('/_previews/sre/')) requests.push(pathname)
    })
    const catalogs = () => requests.filter((pathname) => pathname.endsWith('/catalog.json')).length
    const manifests = () => requests.filter((pathname) => pathname.endsWith('/manifest.json'))
    await page.goto('/sre')
    await expect(sectionLink(page, 'Previews').locator('.site-section-count')).toHaveText('3')
    const manifestCount = manifests().length
    expect(catalogs()).toBe(1)
    expect(manifestCount).toBeGreaterThan(0)
    await sectionLink(page, 'Previews').click()
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
    await sectionLink(page, 'Overview').click()
    await sectionLink(page, 'Previews').click()
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
    expect(catalogs()).toBe(1)
    expect(manifests()).toHaveLength(manifestCount)
    expect(new Set(manifests()).size).toBe(manifestCount)

    // Leaving the site ends the visit: coming back loads again.
    await page.getByRole('button', { name: 'All sites' }).click()
    await expect(page).toHaveURL('/')
    await page.goto('/sre/_previews')
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
  })

  test('a joined load that is still in progress is not repeated, and Try again loads afresh', async ({ page }) => {
    await routeSreHome(page, readmeEntries, { bodies: readmeBodies })
    let catalogRequests = 0
    let releaseCatalog!: () => void
    const gate = new Promise<void>((resolve) => { releaseCatalog = resolve })
    let failing = true
    await page.route('**/_previews/sre/catalog.json', async (route) => {
      catalogRequests += 1
      if (catalogRequests === 1) await gate
      if (failing) await route.fulfill({ status: 503, body: 'unavailable' })
      else await route.continue()
    })
    await page.goto('/sre')
    // The badge's load is still in progress when the section opens and joins it.
    await sectionLink(page, 'Previews').click()
    await expect(page.getByRole('status')).toHaveText('Loading previews…')
    expect(catalogRequests).toBe(1)
    releaseCatalog()
    await expect(page.getByRole('alert')).toHaveText('The preview list could not be loaded.')
    expect(catalogRequests).toBe(1)
    failing = false
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
    expect(catalogRequests).toBe(2)
    await expect(sectionLink(page, 'Previews').locator('.site-section-count')).toHaveText('3')
  })

  test('a preview group link opens in the Previews section', async ({ page }) => {
    await page.goto('/sre/_previews?group=pr%3A42')
    await expect(sectionLink(page, 'Previews')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { level: 2, name: 'Preview link' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Preview pr:43' })).toHaveCount(0)
  })

  for (const [name, path] of [['Overview', '/sre'], ['Files', '/sre?section=files'], ['Previews', '/sre/_previews']] as const) {
    test(`site search opens the published-site palette from ${name} and returns focus`, async ({ page }) => {
      await routeSreHome(page, readmeEntries, { bodies: readmeBodies })
      await page.goto(path)
      await expect(sectionLink(page, name)).toHaveAttribute('aria-current', 'page')
      await expect(searchEntry(page)).toHaveCount(1)
      await searchEntry(page).click()
      const palette = page.getByRole('dialog', { name: 'Command palette' })
      await expect(palette.locator('.palette-scope')).toHaveText('SRE only')
      const field = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
      // It searches the published site, never preview content.
      await field.fill('Local preview guide')
      await expect(palette.getByRole('option', { name: /Local preview guide/ })).toHaveCount(0)
      await field.fill('topology')
      await expect(palette.getByRole('option', { name: /Platform topology/ })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(palette).toHaveCount(0)
      await expect(searchEntry(page)).toBeFocused()
    })
  }

  test('site search keeps the hand-off to full-text search', async ({ page }) => {
    await registerTextSearchSite(page)
    await page.goto('/textsearch?section=files')
    await expect(sectionLink(page, 'Files')).toHaveAttribute('aria-current', 'page')
    await searchEntry(page).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    const field = palette.getByRole('combobox', { name: 'Search artifacts, sites, commands, and headings' })
    await field.fill('latency')
    await expect(palette.getByRole('option', { name: /Search full text for “latency”/ })).toBeVisible()
    await field.press('Control+Enter')
    await expect(page).toHaveURL(/\/textsearch\/_search\?q=latency$/)
  })

  test('Files has no other search entry', async ({ page }) => {
    await page.goto('/sre?section=files')
    await expect(page.getByTestId('directory-page').getByRole('searchbox')).toHaveCount(0)
    await expect(page.getByTestId('directory-page').getByRole('button', { name: /search|jump/i })).toHaveCount(1)
  })

  test('sections are history entries: Back and Forward restore them', async ({ page }) => {
    await routeSreHome(page, readmeEntries, { bodies: readmeBodies })
    await page.goto('/sre')
    await sectionLink(page, 'Files').click()
    await expect(page).toHaveURL('/sre?section=files')
    await sectionLink(page, 'Previews').click()
    await expect(page).toHaveURL('/sre/_previews')
    await page.goBack()
    await expect(page).toHaveURL('/sre?section=files')
    await expect(sectionLink(page, 'Files')).toHaveAttribute('aria-current', 'page')
    await page.goBack()
    await expect(page).toHaveURL('/sre')
    await expect(sectionLink(page, 'Overview')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { name: 'Readme heading' })).toBeVisible()
    await page.goForward()
    await expect(sectionLink(page, 'Files')).toHaveAttribute('aria-current', 'page')
    // Refresh shows the section the URL names.
    await page.reload()
    await expect(sectionLink(page, 'Files')).toHaveAttribute('aria-current', 'page')
  })

  test('Back from a document restores the section and its scroll position; a new section starts at the top', async ({ page }) => {
    await routeSreHome(page, [...readmeEntries, ...bulkEntries(40)], { bodies: readmeBodies })
    await page.goto('/sre?section=files')
    await expect(page.locator('[data-directory-page="bulk-40.md"]')).toBeAttached()
    await scroller(page).evaluate((element) => { element.scrollTop = 700 })
    await expect.poll(() => scroller(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(600)
    const before = await scroller(page).evaluate((element) => element.scrollTop)
    await page.locator('[data-directory-page="bulk-30.md"]').click()
    await expect(page).toHaveURL('/sre/bulk-30.md')
    await page.goBack()
    await expect(page).toHaveURL('/sre?section=files')
    await expect(sectionLink(page, 'Files')).toHaveAttribute('aria-current', 'page')
    await expect.poll(() => scroller(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(before - 5)
    expect(await scroller(page).evaluate((element) => element.scrollTop)).toBeLessThan(before + 5)

    // A section chosen by link starts at the top, even when it was scrolled before.
    await sectionLink(page, 'Overview').click()
    await expect(sectionLink(page, 'Overview')).toHaveAttribute('aria-current', 'page')
    expect(await scroller(page).evaluate((element) => element.scrollTop)).toBe(0)
    await sectionLink(page, 'Files').click()
    await expect(page.locator('[data-directory-page="bulk-40.md"]')).toBeAttached()
    expect(await scroller(page).evaluate((element) => element.scrollTop)).toBe(0)
  })

  test('section links keep modified clicks for the browser and carry real hrefs', async ({ page }) => {
    await routeSreHome(page, readmeEntries, { bodies: readmeBodies })
    await page.goto('/sre')
    await expect(sectionLink(page, 'Overview')).toHaveAttribute('href', '/sre')
    await expect(sectionLink(page, 'Files')).toHaveAttribute('href', '/sre?section=files')
    await expect(sectionLink(page, 'Previews')).toHaveAttribute('href', '/sre/_previews')
    await expectModifiedClickKeptForBrowser(page, sectionLink(page, 'Files'))
    await expectModifiedClickKeptForBrowser(page, sectionLink(page, 'Previews'))
    await expect(sectionLink(page, 'Overview')).toHaveAttribute('aria-current', 'page')
  })

  test('switching sites does not carry a section or scroll position over', async ({ page }) => {
    await routeSreHome(page, [...readmeEntries, ...bulkEntries(40)], { bodies: readmeBodies })
    await page.goto('/sre?section=files')
    await expect(page.locator('[data-directory-page="bulk-40.md"]')).toBeAttached()
    await scroller(page).evaluate((element) => { element.scrollTop = 700 })
    await expect.poll(() => scroller(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(600)
    await page.getByRole('button', { name: 'All sites' }).click()
    await page.getByRole('link', { name: /HTML Showcase/ }).click()
    await expect(page).toHaveURL('/showcase')
    await expect(page.getByRole('heading', { level: 1, name: 'HTML Showcase', exact: true })).toBeVisible()
    await expect(sectionLink(page, 'Files')).toHaveAttribute('aria-current', 'page')
    expect(await scroller(page).evaluate((element) => element.scrollTop)).toBe(0)
    // The other site's introduction (none) and previews are its own.
    await expect(sectionLink(page, 'Overview')).toHaveCount(0)
  })

  test('at 390 px all three links stay visible, search is an icon button and nothing overflows', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await routeSreHome(page, readmeEntries, { bodies: readmeBodies })
    for (const path of ['/sre', '/sre?section=files', '/sre/_previews']) {
      await page.goto(path)
      await expect(sections(page).getByRole('link')).toHaveCount(3)
      for (const name of ['Overview', 'Files', 'Previews']) await expect(sectionLink(page, name)).toBeVisible()
      const search = searchEntry(page)
      await expect(search).toBeVisible()
      await expect(search.locator('.site-home-search-label')).toBeHidden()
      const box = await search.boundingBox()
      expect(box?.width).toBeLessThan(48)
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - window.innerWidth,
        scroller: (document.querySelector('.directory-scroll') as HTMLElement).scrollWidth - (document.querySelector('.directory-scroll') as HTMLElement).clientWidth,
        bar: (document.querySelector('.site-home-bar') as HTMLElement).scrollWidth - (document.querySelector('.site-home-bar') as HTMLElement).clientWidth,
      }))
      expect(overflow.page).toBeLessThanOrEqual(0)
      expect(overflow.scroller).toBeLessThanOrEqual(0)
      expect(overflow.bar).toBeLessThanOrEqual(0)
    }
  })

  test('keyboard order is Overview, Files, Previews, search; aria-current marks one link', async ({ page }) => {
    await routeSreHome(page, readmeEntries, { bodies: readmeBodies })
    await page.goto('/sre')
    await sectionLink(page, 'Overview').focus()
    await page.keyboard.press('Tab')
    await expect(sectionLink(page, 'Files')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(sectionLink(page, 'Previews')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(searchEntry(page)).toBeFocused()
    await expect(sections(page).locator('[aria-current="page"]')).toHaveCount(1)
    // Enter on a link switches the section, and focus follows to the new current link.
    await sectionLink(page, 'Files').focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/sre?section=files')
    await expect(sectionLink(page, 'Files')).toBeFocused()
    await expect(sectionLink(page, 'Files')).toHaveAttribute('aria-current', 'page')
    await expect(sections(page).locator('[aria-current="page"]')).toHaveCount(1)
  })

  test('the dark theme styles the section row', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await routeSreHome(page, readmeEntries, { bodies: readmeBodies })
    await page.goto('/sre')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    const luminance = (rgb: string) => {
      const [r, g, b] = rgb.match(/\d+/g)!.map(Number)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const current = await sectionLink(page, 'Overview').evaluate((element) => getComputedStyle(element).color)
    const other = await sectionLink(page, 'Files').evaluate((element) => getComputedStyle(element).color)
    const surface = await page.locator('.directory-scroll').evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(luminance(current)).toBeGreaterThan(200)
    expect(luminance(other)).toBeGreaterThan(110)
    expect(luminance(surface)).toBeLessThan(60)
  })
})

// ISSUE-109: a preview document opens in the normal reader shell, with the preview's metadata in Details.
test.describe('preview reading in the reader shell (ISSUE-109)', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  const newerHead = 'b'.repeat(40)
  const guidePath = 'guides/preview-guide.md'
  const guideUrl = (options: { group?: string; head?: string; path?: string } = {}) => {
    const group = options.group === undefined ? '' : `?group=${encodeURIComponent(options.group)}`
    return `/sre/_previews/${options.head ?? previewHeadSha}/${options.path ?? guidePath}${group}`
  }
  const column = (page: Page) => page.getByRole('complementary', { name: 'Reading context' })
  const tag = (page: Page) => page.locator('[data-preview-tag]')
  const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Preview path' })
  const sidebar = (page: Page) => page.getByRole('complementary', { name: 'SRE navigation' })
  const notices = (page: Page) => page.locator('.preview-notices')
  const revision = (details: Locator) => details.locator('.preview-fact').filter({ hasText: /^Revision/ }).locator('.preview-sha')
  const olderRevision = 'This is an older revision of this preview.'
  const catalogFailed = 'Preview details could not be loaded; this revision is shown as published.'

  /** Rewrites the real catalog: `pr:42` points at another head, and that head has a manifest and a document. */
  async function advancePullRequest(page: Page, options: { documents?: Array<Record<string, unknown>> } = {}) {
    const documents = options.documents ?? [{ path: guidePath, title: 'Local preview guide', format: 'markdown' }]
    await page.route('**/_previews/sre/catalog.json', async (route) => {
      const response = await route.fetch()
      const catalog = await response.json() as { groups: Array<{ id: string }> }
      catalog.groups = catalog.groups.map((group) => group.id === 'pr:42' ? { ...group, headSha: newerHead, documents } : group)
      await route.fulfill({ response, body: JSON.stringify(catalog) })
    })
    await page.route(`**/_previews/sre/revisions/${newerHead}/manifest.json`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1, site: 'sre', headSha: newerHead,
        defaultHeadSha: '1111111111111111111111111111111111111111', mergeBaseSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
        createdAt: '2026-10-01T00:00:00Z', bundleDigest: `sha256:${'0'.repeat(64)}`,
        files: documents.map(({ path }) => ({ path, sha256: 'a'.repeat(64), contentType: 'text/markdown; charset=utf-8' })),
        documents,
      }),
    }))
    await page.route(`**/_previews/sre/revisions/${newerHead}/files/**`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/markdown; charset=utf-8',
      body: '# Newer revision\n\nThe current preview.\n',
    }))
  }

  /** Serves a revision manifest with the given documents over the real one. */
  async function routeManifest(page: Page, documents: Array<Record<string, unknown>>) {
    await page.route(`**/_previews/sre/revisions/${previewHeadSha}/manifest.json`, async (route) => {
      const response = await route.fetch()
      const manifest = await response.json() as { files: Array<Record<string, unknown>>; documents: unknown }
      manifest.documents = documents
      await route.fulfill({ response, body: JSON.stringify(manifest) })
    })
  }

  test('a Markdown preview opens in the reader shell with the column, the palette and its identity', async ({ page }) => {
    await page.goto(guideUrl({ group: 'pr:42' }))
    await expect(previewTitle(page)).toHaveText('Local preview guide')
    await expect(page.locator('.preview-reader')).toHaveCount(0)
    await expect(sidebar(page)).toBeVisible()
    await expect(page.locator('.context-bar')).toBeVisible()
    await expect(tag(page)).toHaveText('Preview · PR #42')
    await expect(crumbs(page).getByRole('link')).toHaveText(['SRE', 'Previews', 'PR #42'])
    await expect(crumbs(page).getByRole('link', { name: 'Previews' })).toHaveAttribute('href', '/sre/_previews')
    await expect(crumbs(page).getByRole('link', { name: 'PR #42' })).toHaveAttribute('href', '/sre/_previews?group=pr%3A42')
    await expect(column(page)).toBeVisible()
    await expect(column(page).getByRole('heading', { name: 'Details' })).toBeVisible()
    await expect(column(page).getByRole('heading', { name: 'Contents' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Contents' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Jump to a page in SRE' }).click()
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('main#main-content article')).toContainText('Markdown document and its image')
  })

  test('an HTML preview opens in the same shell with the column beside its frame', async ({ page }) => {
    await page.goto(guideUrl({ group: 'pr:42', path: 'guides/preview.html' }))
    await expect(previewTitle(page)).toHaveText('Local preview HTML')
    await expect(page.locator('.preview-reader')).toHaveCount(0)
    await expect(sidebar(page)).toBeVisible()
    await expect(tag(page)).toHaveText('Preview · PR #42')
    const frame = page.locator('iframe[title="Local preview HTML"]')
    await expect(frame).toBeVisible()
    await expect(frame).toHaveAttribute('src', `/_previews/sre/revisions/${previewHeadSha}/files/guides/preview.html`)
    await expect(column(page)).toBeVisible()
    const [frameBox, columnBox] = await Promise.all([frame.boundingBox(), column(page).boundingBox()])
    expect(frameBox!.x + frameBox!.width).toBeLessThanOrEqual(columnBox!.x + 1)
    await expect(column(page).getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
    await expect(page.frameLocator('iframe[title="Local preview HTML"]').getByRole('heading', { name: 'Local preview HTML' })).toBeVisible()
  })

  test('Details of a PR preview list the PR, revision, build time, links, extra fields, path and the raw action', async ({ page }) => {
    await page.goto(guideUrl({ group: 'pr:42' }))
    const details = column(page)
    await expect(details.getByRole('link', { name: '#42 on GitHub' })).toHaveAttribute('href', 'https://github.com/acme/sre-docs/pull/42')
    await expect(details.getByRole('link', { name: '#42 on GitHub' })).toHaveAttribute('target', '_blank')
    await expect(revision(details)).toHaveAttribute('title', previewHeadSha)
    await expect(revision(details)).toContainText(previewHeadSha.slice(0, 12))
    // The full revision is the accessible name; the short form is what is drawn.
    await expect(revision(details).locator('[aria-hidden="true"]')).toHaveText(previewHeadSha.slice(0, 12))
    await expect(revision(details).locator('.page-text-visually-hidden')).toHaveText(previewHeadSha)
    const built = details.locator('time')
    await expect(built).toHaveAttribute('datetime', '2026-09-27T00:00:00.000Z')
    await expect(built).toHaveAttribute('title', '2026-09-27 00:00:00 UTC')
    await expect(details).toContainText('When this preview was built, not when the page was edited.')
    await expect(details.getByRole('link', { name: 'Preview list' })).toHaveAttribute('href', '/sre/_previews?group=pr%3A42')
    await expect(details.getByRole('link', { name: 'Published site' })).toHaveAttribute('href', '/sre')

    const more = details.locator('details.preview-more')
    await expect(more).not.toHaveAttribute('open', '')
    await expect(details.getByText('Default head')).toBeHidden()
    await more.getByText('More details').click()
    await expect(details.getByText('Default head')).toBeVisible()
    await expect(details.getByText('1111111111111111111111111111111111111111').first()).toBeAttached()
    await expect(details.getByText('Merge base')).toBeVisible()
    // The fixture manifest records no reason, so no "Included as" is invented.
    await expect(details.getByText('Included as')).toHaveCount(0)
    await expect(details.locator('.preview-path')).toHaveText(guidePath)
    await expect(details.getByText('Markdown', { exact: true })).toBeVisible()

    const raw = details.getByRole('link', { name: 'Open the raw file' })
    await expect(raw).toHaveAttribute('href', `/_previews/sre/revisions/${previewHeadSha}/files/${guidePath}`)
    await expect(raw).toHaveAttribute('target', '_blank')
    await expect(details).toContainText("Opens this revision's file on its own, outside the reader.")
    const popup = page.waitForEvent('popup')
    await raw.click()
    expect(new URL((await popup).url()).pathname).toBe(`/_previews/sre/revisions/${previewHeadSha}/files/${guidePath}`)
  })

  test('Details never show a production date, source or committer, and "Included as" appears only when the manifest says so', async ({ page }) => {
    await routeManifest(page, [
      { path: guidePath, title: 'Local preview guide', format: 'markdown', reason: 'dependency', changedResources: ['assets/preview.css'] },
    ])
    await page.goto(guideUrl({ group: 'pr:42' }))
    const details = column(page)
    await expect(details.getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
    for (const label of ['Updated', 'Source', 'Last committed by']) await expect(details.getByText(label, { exact: true })).toHaveCount(0)
    await details.getByText('More details').click()
    await expect(details.getByText('Included as')).toBeVisible()
    await expect(details.getByText('Resource dependency')).toBeVisible()
    await expect(details.getByText('Uses changed assets/preview.css')).toBeVisible()
  })

  test('a manual preview shows its tag and group, and no pull request', async ({ page }) => {
    await page.goto(guideUrl({ group: `head:${previewHeadSha}` }))
    await expect(tag(page)).toHaveText('Preview · manual')
    await expect(crumbs(page).getByRole('link').nth(2)).toHaveText(`Revision ${previewHeadSha.slice(0, 8)}`)
    const details = column(page)
    await expect(revision(details)).toBeVisible()
    await expect(details.getByText('Pull request')).toHaveCount(0)
    await expect(details.getByRole('link', { name: /on GitHub/ })).toHaveCount(0)
    await expect(details.getByRole('link', { name: 'Preview list' })).toHaveAttribute('href', `/sre/_previews?group=head%3A${previewHeadSha}`)
  })

  test('a link without a group resolves the manual group from the catalog and never a pull request', async ({ page }) => {
    await page.goto(guideUrl())
    await expect(previewTitle(page)).toHaveText('Local preview guide')
    // The same head also belongs to PR groups, which are not guessed.
    await expect(tag(page)).toHaveText('Preview · manual')
    await expect(column(page).getByText('Pull request')).toHaveCount(0)
    await expect(column(page).getByRole('link', { name: 'Preview list' })).toHaveAttribute('href', `/sre/_previews?group=head%3A${previewHeadSha}`)
    await expect(notices(page)).toHaveCount(0)
    await page.getByRole('navigation', { name: 'Preview documents' }).getByRole('link', { name: 'Local preview HTML' }).click()
    await expect(page).toHaveURL(guideUrl({ group: `head:${previewHeadSha}`, path: 'guides/preview.html' }))
  })

  test('the sidebar lists the preview documents, changed pages first, and links to the published site', async ({ page }) => {
    await routeManifest(page, [
      { path: 'guides/preview.html', title: 'Local preview HTML', format: 'html', reason: 'dependency', changedResources: ['assets/preview.css'] },
      { path: guidePath, title: 'Local preview guide', format: 'markdown', reason: 'changed' },
    ])
    await page.goto(guideUrl({ group: 'pr:42' }))
    const nav = page.getByRole('navigation', { name: 'Preview documents' })
    await expect(nav.getByRole('group', { name: 'Changed pages' }).getByRole('link')).toHaveText([/Local preview guide/])
    await expect(nav.getByRole('group', { name: 'Affected by a resource change' }).getByRole('link')).toHaveText(['Local preview HTML'])
    const labels = await nav.locator('.preview-side-group').allTextContents()
    expect(labels).toEqual(['Changed pages', 'Affected by a resource change'])
    await expect(nav.getByRole('link', { name: /Local preview guide/ })).toHaveAttribute('aria-current', 'page')
    await expect(nav.getByRole('link', { name: 'Local preview HTML' })).toHaveAttribute('href', guideUrl({ group: 'pr:42', path: 'guides/preview.html' }))
    const published = nav.getByRole('link', { name: 'Browse the published SRE' })
    await expect(published).toHaveAttribute('href', '/sre')
    // The published tree is not part of the preview.
    await expect(sidebar(page).getByText('Pinned')).toHaveCount(0)
    await expect(nav.getByText('Latency retrospective')).toHaveCount(0)
    await published.click()
    await expect(page).toHaveURL('/sre')
    await expect(page.locator('[data-preview-tag]')).toHaveCount(0)
  })

  test('an older revision says so, and opens the same document at the current head when it has it', async ({ page }) => {
    await advancePullRequest(page)
    await page.goto(guideUrl({ group: 'pr:42' }))
    await expect(previewTitle(page)).toHaveText('Local preview guide')
    await expect(notices(page)).toContainText(olderRevision)
    // An older revision is not the PR's current preview, so no PR number is stated anywhere.
    await expect(tag(page)).toHaveText(`Preview · ${previewHeadSha.slice(0, 8)}`)
    await expect(crumbs(page).getByRole('link').nth(2)).toHaveText(`Preview ${previewHeadSha.slice(0, 8)}`)
    await expect(crumbs(page).getByRole('link').nth(2)).toHaveAttribute('href', '/sre/_previews?group=pr%3A42')
    await expect(notices(page)).not.toContainText('#42')
    await expect(page.locator('main, aside').getByText('PR #42')).toHaveCount(0)
    await expect(column(page).getByText('Pull request')).toHaveCount(0)
    await expect(page.locator('main#main-content article')).toContainText('Markdown document and its image')
    const current = notices(page).getByRole('link', { name: 'Open the current preview' })
    await expect(current).toHaveAttribute('href', guideUrl({ group: 'pr:42', head: newerHead }))
    await current.click()
    await expect(page).toHaveURL(guideUrl({ group: 'pr:42', head: newerHead }))
    await expect(page.locator('main#main-content article')).toContainText('The current preview.')
    await expect(notices(page)).toHaveCount(0)
    await expect(column(page).getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
  })

  test('a group id the catalog does not know never names a PR', async ({ page }) => {
    await page.goto(guideUrl({ group: 'pr:777' }))
    await expect(previewTitle(page)).toHaveText('Local preview guide')
    await expect(tag(page)).toHaveText(`Preview · ${previewHeadSha.slice(0, 8)}`)
    await expect(crumbs(page).getByRole('link').nth(2)).toHaveText(`Preview ${previewHeadSha.slice(0, 8)}`)
    await expect(page.locator('main, aside').getByText('PR #777')).toHaveCount(0)
    await expect(column(page).getByText('Pull request')).toHaveCount(0)
    await expect(notices(page)).toHaveCount(0)
  })

  test('a catalog older than 30 seconds is reloaded before a revision is called current or verified', async ({ page }) => {
    await page.clock.install()
    let advanced = false
    await page.route('**/_previews/sre/catalog.json', async (route) => {
      const response = await route.fetch()
      const catalog = await response.json() as { groups: Array<{ id: string }> }
      if (advanced) {
        catalog.groups = catalog.groups.map((group) => group.id === 'pr:42' ? { ...group, headSha: newerHead, documents: [{ path: guidePath, title: 'Local preview guide', format: 'markdown' }] } : group)
      }
      await route.fulfill({ response, body: JSON.stringify(catalog) })
    })
    await page.route(`**/_previews/sre/revisions/${newerHead}/manifest.json`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1, site: 'sre', headSha: newerHead,
        defaultHeadSha: '1111111111111111111111111111111111111111', mergeBaseSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
        createdAt: '2026-10-01T00:00:00Z', bundleDigest: `sha256:${'0'.repeat(64)}`,
        files: [{ path: guidePath, sha256: 'a'.repeat(64), contentType: 'text/markdown; charset=utf-8' }],
        documents: [{ path: guidePath, title: 'Local preview guide', format: 'markdown' }],
      }),
    }))
    await page.route(`**/_previews/sre/revisions/${newerHead}/files/**`, (route) => route.fulfill({
      status: 200, contentType: 'text/markdown; charset=utf-8', body: '# Newer revision\n\nThe current preview.\n',
    }))
    const catalogRequests: string[] = []
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/_previews/sre/catalog.json') catalogRequests.push('x') })

    await page.goto(guideUrl({ group: 'pr:42' }))
    await expect(column(page).getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
    await expect(tag(page)).toHaveText('Preview · PR #42')
    expect(catalogRequests).toHaveLength(1)

    // The PR moves on. Within 30 s the loaded catalog is reused; after that it is reloaded first.
    advanced = true
    await page.getByRole('navigation', { name: 'Preview documents' }).getByRole('link', { name: 'Local preview HTML' }).click()
    await expect(previewTitle(page)).toHaveText('Local preview HTML')
    expect(catalogRequests).toHaveLength(1)
    await page.clock.fastForward(31_000)
    await page.getByRole('navigation', { name: 'Preview documents' }).getByRole('link', { name: /Local preview guide/ }).click()
    await expect(notices(page)).toContainText(olderRevision)
    expect(catalogRequests).toHaveLength(2)
    await expect(tag(page)).toHaveText(`Preview · ${previewHeadSha.slice(0, 8)}`)
    await expect(column(page).getByText('Pull request')).toHaveCount(0)

    await notices(page).getByRole('link', { name: 'Open the current preview' }).click()
    await expect(page).toHaveURL(guideUrl({ group: 'pr:42', head: newerHead }))
    await expect(page.locator('main#main-content article')).toContainText('The current preview.')
    await expect(notices(page)).toHaveCount(0)
    await expect(tag(page)).toHaveText('Preview · PR #42')
    await expect(column(page).getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
  })

  test('returning to a long-open tab revalidates a catalog older than 30 seconds', async ({ page }) => {
    await page.clock.install()
    let advanced = false
    await page.route('**/_previews/sre/catalog.json', async (route) => {
      const response = await route.fetch()
      const catalog = await response.json() as { groups: Array<{ id: string }> }
      if (advanced) catalog.groups = catalog.groups.map((group) => group.id === 'pr:42' ? { ...group, headSha: newerHead } : group)
      await route.fulfill({ response, body: JSON.stringify(catalog) })
    })
    await page.route(`**/_previews/sre/revisions/${newerHead}/manifest.json`, (route) => route.fulfill({ status: 404, body: 'gone' }))
    await page.goto(guideUrl({ group: 'pr:42' }))
    await expect(column(page).getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
    await expect(tag(page)).toHaveText('Preview · PR #42')

    // The head changes while the tab is hidden; coming back inside 30 s changes nothing.
    advanced = true
    const show = () => page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await show()
    await expect(tag(page)).toHaveText('Preview · PR #42')
    await expect(notices(page)).toHaveCount(0)

    await page.clock.fastForward(31_000)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await show()
    await expect(notices(page)).toContainText(olderRevision)
    await expect(tag(page)).toHaveText(`Preview · ${previewHeadSha.slice(0, 8)}`)
    await expect(column(page).getByText('Pull request')).toHaveCount(0)
  })

  test('an older revision falls back to the preview list when the current head lacks the document', async ({ page }) => {
    await advancePullRequest(page, { documents: [{ path: 'guides/other.md', title: 'Other page', format: 'markdown' }] })
    await page.goto(guideUrl({ group: 'pr:42' }))
    await expect(notices(page)).toContainText(olderRevision)
    const current = notices(page).getByRole('link', { name: 'Open the current preview' })
    await expect(current).toHaveAttribute('href', '/sre/_previews?group=pr%3A42')
    await current.click()
    await expect(page).toHaveURL('/sre/_previews?group=pr%3A42')
    await expect(page.getByRole('link', { name: /Other page/ })).toBeVisible()
  })

  test('a catalog failure keeps the revision readable, omits the PR row and recovers with Try again', async ({ page }) => {
    let fail = true
    await page.route('**/_previews/sre/catalog.json', (route) => (
      fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue()
    ))
    await page.goto(guideUrl({ group: 'pr:42' }))
    await expect(page.locator('main#main-content article')).toContainText('Markdown document and its image')
    await expect(notices(page)).toContainText(catalogFailed)
    await expect(tag(page)).toHaveText(`Preview · ${previewHeadSha.slice(0, 8)}`)
    await expect(crumbs(page).getByRole('link').nth(2)).toHaveText(`Preview ${previewHeadSha.slice(0, 8)}`)
    await expect(crumbs(page).getByRole('link').nth(2)).toHaveAttribute('href', '/sre/_previews?group=pr%3A42')
    await expect(column(page).getByRole('link', { name: 'Preview list' })).toHaveAttribute('href', '/sre/_previews?group=pr%3A42')
    await expect(page.locator('main, aside').getByText('PR #42')).toHaveCount(0)
    await expect(column(page).getByText('Pull request')).toHaveCount(0)
    await expect(revision(column(page))).toBeVisible()
    fail = false
    await notices(page).getByRole('button', { name: 'Try again' }).click()
    await expect(notices(page)).toHaveCount(0)
    await expect(column(page).getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
  })

  test('a missing or expired preview shows Preview unavailable inside the shell, without the column', async ({ page }) => {
    await page.goto('/sre/_previews/ffffffffffffffffffffffffffffffffffffffff/guides/missing.md?group=pr%3A99')
    await expect(page.getByRole('heading', { name: 'Preview unavailable' })).toBeVisible()
    await expect(page.getByRole('main').getByRole('link', { name: 'Preview list' })).toHaveAttribute('href', '/sre/_previews?group=pr%3A99')
    await expect(page.getByRole('main').getByRole('link', { name: 'Published site' })).toHaveAttribute('href', '/sre')
    await expect(column(page)).toHaveCount(0)
    await expect(sidebar(page)).toBeVisible()
    await expect(sidebar(page).getByRole('link', { name: 'Browse the published SRE' })).toBeVisible()
    await expect(tag(page)).toBeVisible()
  })

  test('an unsupported preview format keeps its message inside the shell', async ({ page }) => {
    await page.route(`**/_previews/sre/revisions/${previewHeadSha}/manifest.json`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ schemaVersion: 99, site: 'sre', headSha: previewHeadSha }),
    }))
    await page.goto(guideUrl({ group: 'pr:42' }))
    await expect(page.getByRole('heading', { name: 'This preview needs to be republished' })).toBeVisible()
    await expect(sidebar(page)).toBeVisible()
    await expect(column(page)).toHaveCount(0)
  })

  test('the Preview tag stays visible at a phone width, while scrolling, with the document title in the bar', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await routeLongGuide(page)
    await page.goto(guideUrl({ group: 'pr:42' }))
    await expect(tag(page)).toHaveText('Preview · PR #42')
    const inViewport = async () => {
      const box = (await tag(page).boundingBox())!
      return box.x >= 0 && box.x + box.width <= 390 && box.y >= 0
    }
    expect(await inViewport()).toBe(true)
    await page.locator('.markdown-scroll').evaluate((element) => { element.scrollTop = 900 })
    expect(await inViewport()).toBe(true)
    await expect(crumbs(page).locator('.breadcrumb-current')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await page.goto(guideUrl({ group: `head:${previewHeadSha}` }))
    await expect(tag(page)).toHaveText('Preview · manual')
  })

  async function routeLongGuide(page: Page) {
    await page.route(`**/_previews/sre/revisions/${previewHeadSha}/files/${guidePath}`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/markdown; charset=utf-8',
      body: `# Long guide\n\n${Array.from({ length: 60 }, (_, line) => `Paragraph ${line} of the long preview document.\n`).join('\n')}`,
    }))
  }

  test('below 1200 px Details opens as a panel with the preview metadata, and the narrow menu reaches it', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 })
    await page.goto(guideUrl({ group: 'pr:42' }))
    await expect(previewTitle(page)).toHaveText('Local preview guide')
    await expect(column(page)).toHaveCount(0)
    await page.getByRole('button', { name: 'Details' }).click()
    const panel = page.getByRole('complementary', { name: 'Details' })
    await expect(panel.getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
    await expect(panel.getByRole('link', { name: 'Open the raw file' })).toBeVisible()
    await expect(panel.getByText('Updated')).toHaveCount(0)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await clickToolbarAction(page, page.getByRole('button', { name: 'Details' }), 'Details')
    const narrowPanel = page.getByRole('complementary', { name: 'Details' })
    await expect(narrowPanel.getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
    await expect(narrowPanel.getByRole('link', { name: 'Preview list' })).toBeVisible()
    await expect(narrowPanel.getByText('Opens this revision\'s file on its own, outside the reader.')).toBeVisible()
  })

  test('an HTML page outside the preview keeps its raw behaviour and the notice says so', async ({ page }) => {
    const previewUrl = guideUrl({ group: 'pr:42', path: 'guides/preview.html' })
    await page.goto(previewUrl)
    await waitForPreviewBridge(page)
    await expect(notices(page)).toHaveCount(0)
    await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open the preview SVG resource' }).click()
    await expect(notices(page)).toContainText('This page is outside the preview.')
    await expect(page).toHaveURL(previewUrl)
    await expect(column(page)).toBeVisible()
    // Back moves the frame itself to the previous page: the notice goes, the reader's address never changed.
    await page.evaluate(() => window.history.back())
    await expect(notices(page)).toHaveCount(0)
    await expect(page).toHaveURL(previewUrl)
    await expect(page.frameLocator('iframe[title="Local preview HTML"]').getByRole('heading', { name: 'Local preview HTML' })).toBeVisible()
  })

  test('deep links, history, modifier clicks, reload and copied links keep the revision and group', async ({ context, page }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const url = guideUrl({ group: 'pr:42' })
    await page.goto(`${url}#local-preview-guide`)
    await expect(previewTitle(page)).toHaveText('Local preview guide')
    await page.reload()
    expect(new URL(page.url()).pathname + new URL(page.url()).search + new URL(page.url()).hash).toBe(`${url}#local-preview-guide`)
    await expect(tag(page)).toHaveText('Preview · PR #42')

    const htmlLink = page.getByRole('navigation', { name: 'Preview documents' }).getByRole('link', { name: 'Local preview HTML' })
    await expectModifiedClickKeptForBrowser(page, htmlLink)
    await htmlLink.click()
    await expect(page).toHaveURL(guideUrl({ group: 'pr:42', path: 'guides/preview.html' }))
    await expect(previewTitle(page)).toHaveText('Local preview HTML')
    await page.goBack()
    await expect(page).toHaveURL(`${url}#local-preview-guide`)
    await expect(previewTitle(page)).toHaveText('Local preview guide')
    await page.goForward()
    await expect(previewTitle(page)).toHaveText('Local preview HTML')

    await page.getByRole('button', { name: 'Copy artifact link' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Link copied to clipboard.' })).toBeVisible()
    const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()))
    expect(`${copied.pathname}${copied.search}`).toBe(guideUrl({ group: 'pr:42', path: 'guides/preview.html' }))
  })

  test('returning from a preview document to the list does not fetch the catalog again', async ({ page }) => {
    const catalogRequests: string[] = []
    page.on('request', (request) => {
      const { pathname } = new URL(request.url())
      if (pathname === '/_previews/sre/catalog.json') catalogRequests.push(pathname)
    })
    await page.goto('/sre/_previews')
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
    await page.getByRole('region', { name: 'Preview pr:42' }).getByRole('link', { name: /Local preview guide/ }).click()
    await expect(previewTitle(page)).toHaveText('Local preview guide')
    await expect(column(page).getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
    await column(page).getByRole('link', { name: 'Preview list' }).click()
    await expect(page).toHaveURL('/sre/_previews?group=pr%3A42')
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
    await page.goBack()
    await expect(previewTitle(page)).toHaveText('Local preview guide')
    expect(catalogRequests).toHaveLength(1)

    // A direct entry loads the catalog once for the reader; the list then reuses it.
    catalogRequests.length = 0
    await page.goto(guideUrl({ group: 'pr:42' }))
    await expect(column(page).getByRole('link', { name: '#42 on GitHub' })).toBeVisible()
    await column(page).getByRole('link', { name: 'Preview list' }).click()
    await expect(page.getByRole('region', { name: 'Preview pr:42' })).toBeVisible()
    expect(catalogRequests).toHaveLength(1)
  })
})
