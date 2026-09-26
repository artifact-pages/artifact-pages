import { expect, test, type Page } from '@playwright/test'

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

test('nginx index listing discovers sites and opens a site home', async ({ page }) => {
  const listing = await page.request.get('/_indexes/')
  expect(listing.ok()).toBeTruthy()
  const directoryListing = await listing.text()
  expect(directoryListing).toContain('sre/')
  expect(directoryListing).toContain('frontend/')
  expect(directoryListing).toContain('showcase/')

  const metadataResponse = await page.request.get('/_indexes/sre/meta.json')
  expect(metadataResponse.ok()).toBeTruthy()
  const metadata = await metadataResponse.json()
  expect(metadata).toMatchObject({
    site: { id: 'sre', title: 'SRE' },
    artifactIndexUrl: '/_indexes/sre/index.json',
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Search sites (⌘ K)' })).toBeVisible()
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

test('site discovery loads lightweight metadata for all sites but detailed indexes on demand', async ({ page }) => {
  const indexRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (/^\/_indexes\/[^/]+\/index\.json$/u.test(pathname)) indexRequests.push(pathname)
  })

  await page.goto('/sre')
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
  await expect.poll(() => [...indexRequests]).toEqual(['/_indexes/sre/index.json'])

  const paletteButton = page.getByRole('button', { name: 'Open command palette (⌘ K)' })
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

test('site discovery cannot change the switcher destination under keyboard selection', async ({ page }) => {
  let finishDiscovery = () => {}
  let discoveryStarted = () => {}
  const discoveryGate = new Promise<void>((resolve) => { finishDiscovery = resolve })
  const discoveryStartedGate = new Promise<void>((resolve) => { discoveryStarted = resolve })
  await page.route('**/_indexes/', async (route) => {
    discoveryStarted()
    await discoveryGate
    await route.continue()
  })

  await page.goto('/sre')
  await expect(page.getByRole('heading', { name: 'SRE', exact: true })).toBeVisible()
  await discoveryStartedGate

  await page.getByRole('button', { name: 'Switch site. Current site: SRE' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await expect(palette.getByRole('option')).toHaveCount(1)
  await search.press('ArrowDown')
  await expect(palette.getByRole('option', { selected: true })).toHaveCount(1)

  finishDiscovery()
  await expect(palette.getByRole('option')).toHaveCount(3)
  await expect(palette.getByRole('option', { selected: true })).toHaveCount(0)
  await search.press('Enter')
  await expect(palette).toBeVisible()
  await expect(page).toHaveURL(/\/sre$/)
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
  await page.getByRole('button', { name: 'Open command palette (⌘ K)' }).click()

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
  await page.getByRole('button', { name: 'Open command palette (⌘ K)' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('platform')
  await expect(palette.getByRole('option').first()).toBeVisible()
  await expect(palette.getByRole('option', { name: /Platform topology/ }).first()).toBeVisible()
})

test('recent reads persist across reloads and remain scoped while the query is retained', async ({ page }) => {
  await page.goto('/sre')

  const openPalette = async () => {
    await page.getByRole('button', { name: 'Open command palette (⌘ K)' }).click()
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
  await expect(platform).toBeVisible()
  await expect(palette.getByRole('option', { name: /Checkout latency incident review/ })).toHaveCount(0)

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

test('normal page search stays on the current site while @ and > select explicit scopes', async ({ page }) => {
  await page.goto('/sre')
  await page.getByRole('button', { name: 'Open command palette (⌘ K)' }).click()

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
  await page.getByRole('button', { name: 'Open command palette (⌘ K)' }).click()

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
  await page.getByRole('button', { name: 'Open command palette (⌘ K)' }).click()

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

test('HTML heading navigation keeps the URL and iframe section in sync with one history step', async ({ page }) => {
  await page.goto('/showcase/editorial/field-notes/index.html')

  const artifact = page.frameLocator('iframe[title="Designing for resilience"]')
  const practiceHeading = artifact.getByRole('heading', { name: 'Practice over prediction' })
  await expect(artifact.getByRole('heading', { name: 'Designing for resilience' })).toBeVisible()
  await page.getByRole('button', { name: 'Contents', exact: true }).click()
  await page.getByRole('complementary', { name: 'Contents' })
    .getByRole('button', { name: 'Practice over prediction' }).click()

  await expect(page).toHaveURL(/#practice$/)
  await expect.poll(() => artifact.locator('body').evaluate((body) => body.ownerDocument.defaultView?.location.hash)).toBe('#practice')
  await expect(practiceHeading).toBeInViewport()

  await page.goBack()
  await expect(page).toHaveURL(/\/showcase\/editorial\/field-notes\/index\.html$/)
  await expect.poll(() => artifact.locator('body').evaluate((body) => body.ownerDocument.defaultView?.location.hash)).toBe('')
  await expect(artifact.getByRole('heading', { name: 'Designing for resilience' })).toBeInViewport()

  await page.goForward()
  await expect(page).toHaveURL(/#practice$/)
  await expect.poll(() => artifact.locator('body').evaluate((body) => body.ownerDocument.defaultView?.location.hash)).toBe('#practice')
  await expect(practiceHeading).toBeInViewport()

  await page.reload()
  await expect(page).toHaveURL(/#practice$/)
  await expect.poll(() => artifact.locator('body').evaluate((body) => body.ownerDocument.defaultView?.location.hash)).toBe('#practice')
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
  const dimensions = await reader.evaluate((element) => {
    const table = element.querySelector('table')!
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      tableClientWidth: table.clientWidth,
      tableScrollWidth: table.scrollWidth,
      readerClientWidth: element.clientWidth,
    }
  })
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth)
  expect(dimensions.tableScrollWidth).toBeGreaterThan(dimensions.tableClientWidth)
  expect(dimensions.readerClientWidth).toBeLessThanOrEqual(dimensions.viewportWidth)

  const initialHeadingColor = await reader.locator('h2').first().evaluate((element) => getComputedStyle(element).color)
  await page.getByRole('button', { name: /Color theme:/ }).click()
  await page.getByRole('menuitemradio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const darkHeadingColor = await reader.locator('h2').first().evaluate((element) => getComputedStyle(element).color)
  expect(darkHeadingColor).not.toBe(initialHeadingColor)
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
  await page.getByRole('button', { name: 'Open command palette (⌘ K)' }).click()

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

  await page.getByRole('button', { name: 'Search artifacts and pages' }).click()
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

  await page.getByRole('button', { name: 'Search artifacts and pages' }).click()
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

  await page.getByRole('button', { name: 'Search artifacts and pages' }).click()
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
    await page.getByRole('button', { name: 'Open command palette (⌘ K)' }).click()
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
  const siteSearch = page.getByRole('searchbox', { name: 'Search artifacts in SRE' })
  await navigationFilter.fill('latency')
  await expect(page.locator('.sidebar-section-label', { hasText: 'Matches' })).toBeVisible()

  await siteSearch.fill('topology')
  await expect(page.locator('.site-home .artifact-list-row')).toHaveCount(1)
  await expect(page.locator('.site-home .artifact-list-row')).toContainText('Platform topology')
  await expect(navigationFilter).toHaveValue('latency')

  await page.locator('.site-home .artifact-list-row').click()
  await expect(page).toHaveURL(/\/sre\/architecture\/platform-topology\/index\.html$/)
  await expect(navigationFilter).toHaveValue('')
  await expect(page.locator('.browse-tree .tree-artifact[aria-current="page"]')).toBeVisible()

  await navigationFilter.fill('no-such-artifact')
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const paletteSearch = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await paletteSearch.fill('Checkout latency incident review')
  await paletteSearch.press('Enter')
  await expect(page).toHaveURL(/\/sre\/incidents\/checkout-latency\/index\.html$/)
  await expect(navigationFilter).toHaveValue('')
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
  await page.route('**/_indexes/sre/index.json', (route) => route.fulfill({ status: 503, body: 'temporarily unavailable' }))
  await page.goto('/sre')

  await expect(page.getByRole('heading', { name: 'Unable to load this site' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('The site could not be loaded (HTTP 503). Please try again in a moment.')
  await expect(page.getByRole('heading', { name: 'Site not found' })).toHaveCount(0)
  await expect(page.locator('.status-content')).not.toContainText('/_indexes/')
})
