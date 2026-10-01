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
  await expect(page.getByRole('button', { name: 'Search sites' })).toBeVisible()
  await expect(page.getByRole('button', { name: /SRE/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Frontend/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /HTML Showcase/ })).toBeVisible()

  await page.getByRole('button', { name: /SRE/ }).click()
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

  await page.getByRole('button', { name: /SRE/ }).click()
  await expect(page).toHaveURL(/\/sre$/)
  const siteSearch = page.locator('.site-search')
  await expect(siteSearch.getByRole('searchbox', { name: 'Filter artifacts in SRE' })).toBeVisible()
  await expect(siteSearch.locator('kbd')).toBeHidden()
  await expect(page.locator('.site-search-help .search-help-keyboard')).toBeHidden()
  await expect(page.locator('.site-search-help .search-help-touch')).toBeVisible()
  await siteSearch.getByRole('searchbox', { name: 'Filter artifacts in SRE' }).fill('no-such-artifact')
  await expect(page.getByText('Use the site switcher to find another site.')).toBeVisible()
  await expect(page.getByText('Use ⌘ K, then @, to find another site.')).toBeHidden()

  const collapsedSearch = page.getByRole('button', { name: 'Search pages in SRE' })
  await expect(collapsedSearch).toBeVisible()
  await collapsedSearch.click()
  const pagePalette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(pagePalette.locator('.palette-scope')).toHaveText('SRE only')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Expand navigation' }).click()
  const sidebarSearch = page.getByRole('button', { name: 'Search pages in SRE' })
  await expect(sidebarSearch).toBeVisible()
  await expect(sidebarSearch.getByText('Search pages')).toBeVisible()
  await expect(sidebarSearch.locator('kbd')).toBeHidden()
  await page.getByRole('textbox', { name: 'Filter SRE navigation' }).fill('no-such-artifact')
  await expect(page.locator('.sidebar-empty .search-help-touch')).toBeVisible()
  await expect(page.locator('.sidebar-empty .search-help-keyboard')).toBeHidden()
  await page.getByRole('textbox', { name: 'Filter SRE navigation' }).fill('')
  await sidebarSearch.click()
  await expect(page.getByRole('dialog', { name: 'Command palette' }).locator('.palette-scope')).toHaveText('SRE only')
})

test('desktop search affordances keep keyboard shortcuts visible', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')

  const siteSearchTrigger = page.getByRole('button', { name: 'Search sites' })
  await expect(siteSearchTrigger.locator('kbd')).toBeVisible()
  await expect(siteSearchTrigger.getByText('Search sites...')).toBeVisible()

  await page.getByRole('button', { name: /SRE/ }).click()
  await expect(page).toHaveURL(/\/sre$/)
  const pageSearch = page.getByRole('searchbox', { name: 'Filter artifacts in SRE' })
  await expect(page.locator('.site-search kbd')).toBeVisible()
  await expect(page.locator('.site-search kbd')).toHaveText('⌘ K / Ctrl K')
  await expect(page.locator('.site-search-help .search-help-keyboard')).toBeVisible()
  await expect(page.locator('.site-search-help .search-help-touch')).toBeHidden()
  await pageSearch.fill('no-such-artifact')
  await expect(page.getByText('Use ⌘ K, then @, to find another site.')).toBeVisible()
  await expect(page.getByText('Use the site switcher to find another site.')).toBeHidden()
  await pageSearch.fill('')
  const sidebarSearch = page.getByRole('button', { name: 'Search pages in SRE' })
  await expect(sidebarSearch.locator('kbd')).toBeVisible()
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
  await expect(page.getByRole('button', { name: /Frontend registered/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /SRE registered/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /HTML Showcase/ })).toHaveCount(0)
  expect(metadataRequests.sort()).toEqual(['/_indexes/frontend/meta.json', '/_indexes/sre/meta.json'])
  expect(indexRequests).toEqual([])
  expect(directoryRequests).toEqual([])

  await page.getByRole('button', { name: /SRE registered/ }).click()
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
  const emptySite = page.getByRole('button', { name: /Empty registered/ })
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
  await expect(page.getByRole('heading', { name: 'Artifact not found' })).toBeVisible()
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
  const frontendBeforePublish = page.getByRole('button', { name: /Frontend registered/ })
  await expect(frontendBeforePublish).toContainText('Registered · not published yet')
  await expect(frontendBeforePublish).not.toContainText(/\d+ artifacts/u)
  await expect(page.getByRole('button', { name: /SRE registered/ })).toContainText('6 artifacts')
  expect(indexRequests).toEqual([])

  await frontendBeforePublish.click()
  await expect(page.getByRole('heading', { name: 'Site registered, but not published yet' })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('This site is registered and will appear here after its first publish.')
  expect(indexRequests).toEqual(['/_indexes/frontend/index.json'])

  await page.goto('/')
  await page.getByRole('button', { name: 'Search sites' }).click()
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
  const frontendAfterPublish = page.getByRole('button', { name: /Frontend registered/ })
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
    const frontend = page.getByRole('button', { name: /Frontend registered/ })
    await expect(frontend).toContainText('Registered · details unavailable')
    await expect(frontend).not.toContainText(/\d+ artifacts/u)
    await expect(frontend.locator('.site-picker-description')).toHaveText('Incident response runbooks, service ownership guidance, reliability reviews, deployment health reports, and recovery procedures for production teams.')
    await expect(frontend.locator('.site-picker-meta')).toContainText('/frontend')
    const sre = page.getByRole('button', { name: /SRE registered/ })
    await expect(sre).toContainText('6 artifacts')
    await expect(sre.locator('.site-picker-description')).toHaveCount(0)
    await expect(sre.locator('.site-picker-meta')).toContainText('/sre')

    await page.getByRole('button', { name: 'Search sites' }).click()
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
  await expect(page.getByRole('button', { name: /SRE first name/ })).toBeVisible()

  registryState = 'renamed'
  await page.reload()
  await expect(page.getByRole('button', { name: /SRE renamed/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /SRE first name/ })).toHaveCount(0)
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

  const paletteButton = page.getByRole('button', { name: 'Search pages in SRE' })
  await paletteButton.click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('Button guidelines')
  await expect(palette.getByRole('option')).toHaveCount(0)
  await search.fill('@front')
  await expect(palette.getByRole('option', { name: /Frontend/ })).toBeVisible()
  await expect.poll(() => [...indexRequests]).toEqual(['/_indexes/sre/index.json'])
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
  await expect(page.locator('.sidebar-panel .sidebar-section-label', { hasText: 'Recently updated' })).toBeVisible()
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

test('the command palette supports Ctrl+J/K navigation and opens the selected result', async ({ page }) => {
  await page.goto('/sre')
  await page.getByRole('button', { name: 'Search pages in SRE' }).click()

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
  await page.getByRole('button', { name: 'Search pages in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('platform')
  await expect(palette.getByRole('option').first()).toBeVisible()
  await expect(palette.getByRole('option', { name: /Platform topology/ }).first()).toBeVisible()
})

test('recent reads persist across reloads and remain scoped while the query is retained', async ({ page }) => {
  await page.goto('/sre')

  const openPalette = async () => {
    await page.getByRole('button', { name: 'Search pages in SRE' }).click()
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

  palette = await openPalette()
  search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  const recentScope = palette.getByRole('button', { name: /Recently read pages/ })
  await recentScope.click()
  const platform = palette.getByRole('option', { name: /Platform topology/ })
  const checkout = palette.getByRole('option', { name: /Checkout latency incident review/ })
  await expect(platform).toBeVisible()
  await expect(checkout).toBeVisible()
  await expect(checkout.locator('.palette-entry-badge')).toContainText('Current page')

  await page.keyboard.press('Escape')
  await page.reload()
  palette = await openPalette()
  search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await palette.getByRole('button', { name: /Recently read pages/ }).click()
  await expect(palette.getByRole('option', { name: /Platform topology/ })).toBeVisible()

  await search.fill('platform')
  await expect(palette.getByRole('option', { name: /Platform topology/ })).toBeVisible()
  await palette.getByRole('button', { name: /All pages/ }).click()
  await expect(search).toHaveValue('platform')
  await expect(palette.getByRole('option').first()).toContainText('Platform topology')
})

test('palette includes the current page in blank All, Recent, and Pinned results after reload', async ({ page }) => {
  const currentPath = 'architecture/platform-topology/index.html'
  await page.goto(`/sre/${currentPath}`)

  const currentRow = page.locator(`.browse-tree .tree-artifact[data-tree-path="${currentPath}"][aria-current="page"]`).locator('xpath=..')
  await currentRow.getByRole('button', { name: 'Actions for Platform topology' }).click()
  await page.getByRole('menu', { name: 'Platform topology actions' }).getByRole('menuitem', { name: 'Pin' }).click()
  await page.reload()
  await expect(page.locator('.pinned-tree .tree-artifact')).toContainText('Platform topology')

  await page.getByRole('button', { name: 'Search pages in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  const currentResult = palette.getByRole('option', { name: /Platform topology/ })

  await expect(currentResult).toBeVisible()
  await expect(currentResult.locator('.palette-entry-badge')).toContainText('Current page')

  const recentScope = palette.getByRole('button', { name: /Recently read pages/ })
  await expect(recentScope.locator('span')).toHaveText('1')
  await recentScope.click()
  await expect(currentResult).toBeVisible()
  await expect(currentResult.locator('.palette-entry-badge')).toContainText('Current page')

  const pinnedScope = palette.getByRole('button', { name: /Pinned pages/ })
  await expect(pinnedScope.locator('span')).toHaveText('1')
  await pinnedScope.click()
  await expect(currentResult).toBeVisible()
  await expect(currentResult.locator('.palette-entry-badge')).toContainText('Current page')
  await expect(palette.getByText('No pinned pages are available in this site.')).toHaveCount(0)

  await search.fill('Platform topology')
  await expect(currentResult).toBeVisible()
  await expect(currentResult.locator('.palette-entry-badge')).toContainText('Current page')
})

test('normal page search stays on the current site while @ and > select explicit scopes', async ({ page }) => {
  await page.goto('/sre')
  await page.getByRole('button', { name: 'Search pages in SRE' }).click()

  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await expect(search).toHaveAttribute('placeholder', 'Search pages, headings, and commands...')
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

test('site search updates correctly for sequential typing, backspace, and a new query', async ({ page }) => {
  await page.goto('/sre')
  await page.getByRole('button', { name: 'Search pages in SRE' }).click()

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
  await page.getByRole('button', { name: 'Search pages in SRE' }).click()

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

  await page.getByRole('button', { name: 'Contents', exact: true }).click()
  const citationHeadings = contents.getByRole('button', { name: 'Citation', exact: true })
  await expect(citationHeadings).toHaveCount(2)
  await citationHeadings.last().click()
  await expect(page).toHaveURL(/#md-citation-2$/)
  await expect(reader.locator('h2#md-citation-2')).toBeInViewport()

  await page.getByRole('button', { name: 'Contents', exact: true }).click()
  const collisionHeadings = contents.getByRole('button', { name: 'Collision', exact: true })
  await expect(collisionHeadings).toHaveCount(2)
  await collisionHeadings.last().click()
  const secondCollisionHeading = reader.locator('#md-collision-2')
  await expect(page).toHaveURL(/#md-collision-2$/)
  await expect(secondCollisionHeading).toBeInViewport()
  await expect.poll(() => scrollport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Contents', exact: true }).click()
  const widgetHeadings = contents.getByRole('button', { name: 'Widget', exact: true })
  await expect(widgetHeadings).toHaveCount(2)
  await widgetHeadings.last().click()
  const secondWidgetHeading = reader.locator('#md-widget-2')
  await expect(page).toHaveURL(/#md-widget-2$/)
  await expect(secondWidgetHeading).toBeInViewport()

  await page.getByRole('button', { name: 'Contents', exact: true }).click()
  await contents.getByRole('button', { name: 'before after', exact: true }).click()
  const imageHeading = reader.locator('#md-before--after')
  await expect(page).toHaveURL(/#md-before--after$/)
  await expect(imageHeading).toBeInViewport()
  await expect.poll(() => scrollport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Search pages in SRE' }).click()
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
  await page.getByRole('textbox', { name: 'Filter SRE navigation' }).fill('設計')
  await expect(page.locator('.sidebar-body .tree-artifact[data-tree-path="guides/設計-note.md"] .tree-label').first()).toHaveText('設計 Note')

  await page.getByRole('button', { name: 'Search pages in SRE' }).click()
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
  await page.getByRole('textbox', { name: 'Filter SRE navigation' }).fill('Service recovery')
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
  await page.getByRole('button', { name: 'Search pages in SRE' }).click()

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

  await page.getByRole('button', { name: 'Search pages in SRE' }).click()
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

  await page.getByRole('button', { name: 'Search pages in SRE' }).click()
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

  await page.getByRole('button', { name: 'Search pages in SRE' }).click()
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

test('artifact breadcrumb menus show nearby files and keep sidebar reveal available', async ({ page }) => {
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

  const fileTrigger = breadcrumb.getByRole('button', { name: /Open sibling artifacts for Cloud spend review/ })
  await fileTrigger.click()
  menu = page.getByRole('menu', { name: /Artifacts beside Cloud spend review/ })
  await expect(menu.getByRole('menuitem', { name: /Cloud spend review.*current artifact/ })).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(fileTrigger).toBeFocused()

  await fileTrigger.click()
  menu = page.getByRole('menu', { name: /Artifacts beside Cloud spend review/ })
  await menu.getByRole('menuitem', { name: /Cloud spend review.*current artifact/ }).click()
  await expect(menu).toHaveCount(0)
  await expect(fileTrigger).toBeFocused()
})

test('breadcrumb menus close after browser history navigates to another artifact', async ({ page }) => {
  await page.goto('/showcase')

  const searchForArtifact = async (query: string) => {
    await page.getByRole('button', { name: 'Search pages in HTML Showcase' }).click()
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
  await breadcrumb.getByRole('button', { name: /Open sibling artifacts for Cloud spend review/ }).click()
  const menu = page.getByRole('menu', { name: /Artifacts beside Cloud spend review/ })
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
  const currentFile = breadcrumb.getByRole('button', { name: /Open sibling artifacts for Cloud spend review/ })
  await currentFile.tap()

  const menu = page.getByRole('menu', { name: /Artifacts beside Cloud spend review/ })
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
  await page.getByRole('menu', { name: /Artifacts beside Cloud spend review/ })
    .getByRole('menuitem', { name: /Follow-up 01/ }).click()
  await expect(page).toHaveURL(/\/showcase\/reports\/cloud-spend-review\/follow-up-01\.html$/)

  await page.goBack()
  await expect(page).toHaveURL(/\/showcase\/reports\/cloud-spend-review\/index\.html$/)
  await currentFile.tap()
  const reopenedMenu = page.getByRole('menu', { name: /Artifacts beside Cloud spend review/ })
  await reopenedMenu.getByRole('menuitem', { name: /Follow-up 28/ }).tap()
  await expect(page).toHaveURL(/\/showcase\/reports\/cloud-spend-review\/follow-up-28\.html$/)
  await expect(reopenedMenu).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Artifact path' }).getByRole('button', { name: /Open sibling artifacts for Follow-up 28/ })).toBeVisible()
  await page.close()
})

test('site home search and navigation filter stay distinct and navigation clears after artifact selection', async ({ page }) => {
  await page.goto('/sre')

  const navigationFilter = page.getByRole('textbox', { name: 'Filter SRE navigation' })
  const siteSearch = page.getByRole('searchbox', { name: 'Filter artifacts in SRE' })
  await expect(page.getByText('Typing filters artifacts in this site.', { exact: false })).toBeVisible()
  await expect(page.getByText('⌘ K / Ctrl K opens full search.')).toBeVisible()
  await navigationFilter.fill('latency')
  await expect(page.locator('.sidebar-section-label', { hasText: 'Matches' })).toBeVisible()

  await siteSearch.fill('topology')
  await expect(page.locator('.site-home .artifact-list-row')).toHaveCount(1)
  await expect(page.locator('.site-home .artifact-list-row')).toContainText('Platform topology')
  await expect(page.getByText('Press Enter to open this match.', { exact: false })).toBeVisible()
  await expect(navigationFilter).toHaveValue('latency')

  await siteSearch.press('Enter')
  await expect(page).toHaveURL(/\/sre\/architecture\/platform-topology\/index\.html$/)
  await expect(navigationFilter).toHaveValue('')
  await expect(page.locator('.browse-tree .tree-artifact[aria-current="page"]')).toBeVisible()

  await navigationFilter.fill('no-such-artifact')
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const paletteSearch = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await paletteSearch.fill('Checkout latency incident review')
  const checkoutResult = palette.getByRole('option', { name: /Checkout latency incident review/ })
  await expect(checkoutResult).toBeVisible()
  await expect(checkoutResult).toHaveAttribute('aria-selected', 'true')
  await paletteSearch.press('Enter')
  await expect(page).toHaveURL(/\/sre\/incidents\/checkout-latency\/index\.html$/)
  await expect(navigationFilter).toHaveValue('')
  await expect(page.locator('.browse-tree .tree-artifact[aria-current="page"]')).toBeVisible()
})

test('site home search keeps multi, empty, Escape, and IME Enter behavior predictable', async ({ page }) => {
  await page.goto('/sre')

  const siteSearch = page.getByRole('searchbox', { name: 'Filter artifacts in SRE' })
  await siteSearch.fill('latency')
  await expect(page.locator('.site-home .artifact-list-row')).toHaveCount(2)
  await expect(page.getByText('Use Tab to focus a match, then press Enter to open it.', { exact: false })).toBeVisible()
  await siteSearch.press('Enter')
  await expect(page).toHaveURL(/\/sre$/)

  await siteSearch.press('Tab')
  await expect(page.locator('.site-home .artifact-list-row').first()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/sre\/reports\/latency-retrospective\.md$/)

  await page.goto('/sre')
  await siteSearch.fill('topology')
  await siteSearch.evaluate((input) => {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
    }))
  })
  await expect(page).toHaveURL(/\/sre$/)

  await siteSearch.press('Escape')
  await expect(siteSearch).toHaveValue('')
  await expect(siteSearch).not.toBeFocused()
  await expect(page.locator('.site-home .browse-section')).toBeVisible()

  await siteSearch.fill('no-such-artifact')
  await expect(page.locator('.site-home .artifact-list-row')).toHaveCount(0)
  await expect(page.getByText('No matches to open.', { exact: false })).toBeVisible()
  await siteSearch.press('Enter')
  await expect(page).toHaveURL(/\/sre$/)
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

test('unknown sites show a clear not-found state and safe recovery action', async ({ page }) => {
  await page.goto('/unknown-site')

  await expect(page.getByRole('heading', { name: 'Site not found' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('We could not find a site named “unknown-site”.')
  await expect(page.locator('.status-content')).not.toContainText('/_indexes/')

  await page.getByRole('button', { name: '← All sites' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
})

test('invalid site IDs also use the not-found state', async ({ page }) => {
  await page.goto('/unknown_site')

  await expect(page.getByRole('heading', { name: 'Site not found' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('We could not find a site named “unknown_site”.')
  await expect(page.locator('.status-content')).not.toContainText('/_indexes/')
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
  await expect(page.getByRole('heading', { name: 'Site not found' })).toHaveCount(0)
  await expect(page.locator('.status-content')).not.toContainText('/_indexes/')
  expect(indexRequests).toEqual(['/_indexes/sre/index.json'])

  await page.getByRole('button', { name: '← All sites' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
})

const previewHeadSha = '0123456789abcdef0123456789abcdef01234567'

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
  expect(previewRequests).toEqual([])

  const siteSearch = page.getByRole('searchbox', { name: 'Filter artifacts in HTML Showcase' })
  await siteSearch.fill(previewOnlyTitle)
  await expect(page.getByText(/Nothing in this site matches your search/)).toBeVisible()
  await expect(page.locator('.site-home .tree-artifact')).toHaveCount(0)
  await siteSearch.fill('')

  await page.getByRole('button', { name: 'View previews' }).click()
  await expect(page).toHaveURL('/showcase/_previews')
  await expect(page.getByRole('region', { name: 'Preview pr:701' })).toBeVisible()
  await expect(page.getByRole('link', { name: previewOnlyTitle })).toBeVisible()
  expect(previewRequests).toContain('/_previews/showcase/catalog.json')
  expect(previewRequests).toContain(`/_previews/showcase/revisions/${previewHeadSha}/manifest.json`)

  await page.getByRole('link', { name: '← showcase' }).click()
  await expect(page).toHaveURL('/showcase')
  await expect(recent).toBeVisible()
  await expect(browse).toBeVisible()
  await expect(recent).not.toContainText(previewOnlyTitle)
  await expect(browse).not.toContainText(previewOnlyTitle)

  previewRequests.length = 0
  await page.getByRole('button', { name: 'Search pages in HTML Showcase' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const paletteSearch = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await paletteSearch.fill(previewOnlyTitle)
  await expect(palette.getByRole('option')).toHaveCount(0)
  await expect(palette.getByText('Nothing matches. Try > for commands, @ for sites, or # for headings.')).toBeVisible()
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
    await route.fulfill({ response, body: JSON.stringify({ ...manifest, schemaVersion: 99 }) })
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

  await page.goto('/sre')
  await page.getByRole('button', { name: 'Search pages in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('button', { name: 'Previews' }).click()
  await expect(palette.getByRole('status').filter({ hasText: 'Some preview records did not match their revision manifests.' })).toBeVisible()
  await expect(palette.getByRole('option')).toHaveCount(0)
  await expect(palette.getByText('There are no available previews for this site.')).toBeVisible()
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
  await page.getByRole('link', { name: '← sre' }).click()
  await expect(page).toHaveURL('/sre')
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
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
    await page.getByRole('link', { name: '← sre' }).click()
    await expect(page).toHaveURL('/sre')
    await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
  } finally {
    releaseCatalog()
  }
  await catalogResponse
})

test('preview palette loading, empty, and error states leave normal site navigation available', async ({ page }) => {
  let catalogState: 'missing' | 'error' | 'delayed' = 'missing'
  let releaseCatalog!: () => void
  let signalDelayedCatalog!: () => void
  const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve })
  const delayedCatalogStarted = new Promise<void>((resolve) => { signalDelayedCatalog = resolve })
  await page.route('**/_previews/sre/catalog.json', async (route) => {
    if (catalogState === 'missing') return route.fulfill({ status: 404, body: 'not found' })
    if (catalogState === 'error') return route.fulfill({ status: 503, body: 'temporarily unavailable' })
    signalDelayedCatalog()
    await catalogGate
    return route.fulfill({ status: 503, body: 'temporarily unavailable' })
  })

  await page.goto('/sre')
  await page.getByRole('button', { name: 'Search pages in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const allPages = palette.getByRole('button', { name: 'All pages' })
  const previewTab = palette.getByRole('button', { name: 'Previews' })
  await previewTab.click()
  await expect(palette.getByText('There are no available previews for this site.')).toBeVisible()

  catalogState = 'error'
  await allPages.click()
  await previewTab.click()
  await expect(palette.getByRole('alert')).toHaveText('The preview list could not be loaded.')
  await allPages.click()
  await expect(palette.getByRole('option', { name: /Platform topology/ })).toBeVisible()

  catalogState = 'delayed'
  const delayedCatalogResponse = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/_previews/sre/catalog.json' && response.status() === 503
  ))
  await previewTab.click()
  await delayedCatalogStarted
  await expect(palette.getByRole('status')).toHaveText('Loading previews…')
  try {
    await allPages.click()
    await expect(palette.getByRole('option', { name: /Platform topology/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
    await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
  } finally {
    releaseCatalog()
  }
  await delayedCatalogResponse
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

test('the in-site palette has a lazy Previews tab scoped to the active site', async ({ page }) => {
  const previewRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.includes('/_previews/')) previewRequests.push(pathname)
  })

  await page.goto('/sre')
  await page.getByRole('button', { name: 'Search pages in SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  expect(previewRequests).toEqual([])
  await palette.getByRole('button', { name: 'Previews' }).click()
  await expect(palette.getByRole('option', { name: /Local preview guide/ }).first()).toBeVisible()
  await expect.poll(() => previewRequests.some((pathname) => pathname === '/_previews/sre/catalog.json')).toBe(true)
  expect(previewRequests.every((pathname) => pathname.startsWith('/_previews/sre/'))).toBeTruthy()
  expect(previewRequests).not.toContain('/_previews/frontend/catalog.json')
  await expect(palette.getByText('PR #42', { exact: true })).toBeVisible()
  await palette.getByRole('option', { name: /Local preview guide/ }).first().click()
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

  await frame.getByRole('link', { name: 'Open the changed Markdown document with query and fragment' }).click()
  await expect(page).toHaveURL(`/sre/_previews/${previewHeadSha}/guides/preview-guide.md?group=pr%3A42&tab=summary#local-preview-guide`)
  await expect(page.getByRole('link', { name: 'Return to PR #42 ↗' })).toBeVisible()

  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`)
  const externalFrame = page.frameLocator('iframe[title="Local preview HTML"]')
  await externalFrame.getByRole('link', { name: 'Open external HTTPS documentation' }).click()
  await expect(externalFrame.getByRole('heading', { name: 'External guide' })).toBeVisible()
  await expect(page).toHaveURL(`/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`)

  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`)
  const changedFrame = page.frameLocator('iframe[title="Local preview HTML"]')
  await changedFrame.getByRole('link', { name: 'Open the changed Markdown document', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/sre/_previews/${previewHeadSha}/guides/preview-guide\\.md\\?group=pr%3A42$`))
  await expect(page.getByRole('link', { name: 'Return to PR #42 ↗' })).toBeVisible()

  await page.goto(`/sre/_previews/${previewHeadSha}/guides/preview.html?group=pr%3A42`)
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
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Jump to missing target' }).click()
  await expect(page).toHaveURL(`${previewUrl}#missing-target`)
  await expect.poll(frameHash).toBe('#missing-target')
  await expect(page.getByRole('link', { name: 'Return to PR #42 ↗' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(iframe).toBeVisible()

  await page.goto(previewUrl)
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open a changed HTML document with fragment' }).click()
  const changedPreviewUrl = `/sre/_previews/${previewHeadSha}/guides/preview-target.html?group=pr%3A42&source=fixture#changed-target`
  await expect(page).toHaveURL(changedPreviewUrl)
  const changedPreviewFrame = page.locator('iframe[title="Preview fragment target"]')
  await expect.poll(() => changedPreviewFrame.evaluate((element) => (element as HTMLIFrameElement).contentWindow?.location.hash ?? null)).toBe('#changed-target')
  await expect(page.frameLocator('iframe[title="Preview fragment target"]').getByRole('heading', { name: 'Changed HTML target' })).toBeInViewport()
  await expect(page.getByRole('link', { name: 'Return to PR #42 ↗' })).toBeVisible()
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
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open the preview PDF resource' }).click()
  const pdfResponse = await pdfResponsePromise
  expect(pdfResponse.status()).toBe(200)
  expect(pdfResponse.headers()['content-type']).toContain('application/pdf')
  expect(pdfResponse.request().frame().parentFrame()).toBe(page.mainFrame())
  expect(page.url()).toBe(parentUrl)

  await page.goto(previewUrl)
  const downloadPromise = page.waitForEvent('download')
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Download the preview SVG resource' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('preview-mark.svg')
  expect(page.url()).toBe(parentUrl)
  await expect(page.getByRole('heading', { name: 'Local preview HTML' })).toBeVisible()

  await page.goto(previewUrl)
  const targetPopupPromise = page.waitForEvent('popup')
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open the preview SVG in a new tab' }).click()
  const targetPopup = await targetPopupPromise
  await expect(targetPopup).toHaveURL(`${new URL(parentUrl).origin}${filesPrefix}/assets/mark.svg?target=tab`)
  await expect(targetPopup.locator('svg')).toBeVisible()
  expect(page.url()).toBe(parentUrl)
  await targetPopup.close()

  await page.goto(previewUrl)
  await page.frameLocator('iframe[title="Local preview HTML"]').getByRole('link', { name: 'Open the preview SVG with a modifier' }).click({ modifiers: ['ControlOrMeta'] })
  const modifiedResourceUrl = `${new URL(parentUrl).origin}${filesPrefix}/assets/mark.svg?modifier=tab`
  await expect.poll(() => (
    page.frames().some((candidate) => candidate.url() === modifiedResourceUrl) ||
    page.context().pages().some((candidate) => candidate !== page && candidate.url() === modifiedResourceUrl)
  )).toBe(true)
  expect(page.url()).toBe(parentUrl)

  await page.goto(previewUrl)
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
