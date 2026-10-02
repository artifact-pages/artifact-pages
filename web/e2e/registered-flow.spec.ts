import { expect, test } from '@playwright/test'

test('registered site with no artifact publish remains visible beside a healthy neighbor', async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_PREPUBLISH_CHECK !== '1', 'the registered-flow runner enables this check before first publish')
  const indexRequests: string[] = []
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (/^\/_indexes\/[^/]+\/index\.json$/u.test(pathname)) indexRequests.push(pathname)
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  const sreRow = page.getByRole('button', { name: /SRE registered flow/ })
  await expect(sreRow).toContainText('Registered · not published yet')
  await expect(sreRow).not.toContainText(/\d+ artifacts/u)
  await expect(page.getByRole('button', { name: /Neighbor site/ })).toBeVisible()
  expect(indexRequests).toEqual([])

  // Two sites are listed without a separate search trigger; ⌘ K / Ctrl K opens site search.
  await expect(page.getByRole('button', { name: 'Search sites' })).toHaveCount(0)
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('textbox', { name: 'Search artifacts, sites, commands, and headings' })
  await search.fill('Neighbor site')
  await expect(palette.getByRole('option', { name: /Neighbor site/ })).toBeVisible()
  await search.press('Enter')
  await expect(page).toHaveURL(/\/neighbor$/u)
  await expect(page.getByRole('heading', { name: 'Neighbor site', exact: true })).toBeVisible()
  expect(indexRequests).toEqual(['/_indexes/neighbor/index.json'])

  await page.goto('/sre')
  await expect(page.getByRole('heading', { name: 'Site registered, but not published yet' })).toBeVisible()
  expect(indexRequests).toEqual(['/_indexes/neighbor/index.json', '/_indexes/sre/index.json'])
})

test('generated registered projection supports discovery, deep links, relative resources and reload', async ({ page }) => {
  const registryResponse = await page.request.get('/_indexes/sites.json')
  expect(registryResponse.status()).toBe(200)
  const registry = await registryResponse.json()
  expect(registry.sites.map((site: { id: string }) => site.id)).toEqual(['neighbor', 'sre'])

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Neighbor site/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /SRE registered flow/ })).toBeVisible()
  await page.getByRole('button', { name: /SRE registered flow/ }).click()
  await expect(page).toHaveURL(/\/sre$/u)
  await expect(page.getByRole('heading', { name: 'SRE registered flow', exact: true })).toBeVisible()

  const stylesheet = page.waitForResponse((response) => new URL(response.url()).pathname === '/_artifacts/sre/assets/site.css')
  const image = page.waitForResponse((response) => new URL(response.url()).pathname === '/_artifacts/sre/assets/recovery.svg')
  const navigation = await page.goto('/sre/reports/recovery.html')
  expect(navigation?.status()).toBe(200)
  expect((await stylesheet).status()).toBe(200)
  expect((await image).status()).toBe(200)
  const recoveryFrame = page.frameLocator('iframe[title="Recovery review revision two"]')
  await expect(recoveryFrame.getByRole('heading', { name: 'Recovery review revision two' })).toBeVisible()
  await expect(recoveryFrame.locator('body')).toHaveCSS('background-color', 'rgb(223, 241, 230)')
  await expect.poll(() => recoveryFrame.locator('img').evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBeTruthy()

  await page.reload()
  await expect(recoveryFrame.getByRole('heading', { name: 'Recovery review revision two' })).toBeVisible()

  await page.goto('/sre/runbooks/recovery.md')
  const markdown = page.getByTestId('markdown-document')
  await expect(markdown.getByRole('heading', { level: 1, name: 'Recovery runbook' })).toBeVisible()
  const markdownImage = markdown.locator('img[alt="Recovery path"]')
  await expect.poll(() => markdownImage.evaluate((element: HTMLImageElement) => new URL(element.src).pathname)).toBe('/_artifacts/sre/assets/recovery.svg')
  await expect.poll(() => markdownImage.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBeTruthy()

  await page.goto('/sre/reports/updated.md')
  await expect(page.getByTestId('markdown-document').getByRole('heading', { level: 1, name: 'Updated runbook' })).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('markdown-document').getByRole('heading', { level: 1, name: 'Updated runbook' })).toBeVisible()
})

test('configured object-backed preview round-trips encoded document and resource names through nginx', async ({ page }) => {
  const previewURL = process.env.PLAYWRIGHT_PREVIEW_URL
  test.skip(!previewURL, 'the registered-flow runner provides the returned preview URL')
  if (!previewURL) return

  const documentURL = new URL(previewURL)
  expect(documentURL.pathname).toContain('/guides/review%20r%C3%A9sum%C3%A9%20%23%252F%20%2B%3F.html')
  await page.goto(previewURL)
  await expect(page).toHaveURL(previewURL)
  await expect(page.locator('.preview-reader-header h1')).toHaveText('Encoded local preview')

  const previewFrame = page.frameLocator('iframe[title="Encoded local preview"]')
  await expect(previewFrame.getByRole('heading', { name: 'Encoded preview document' })).toBeVisible()
  await expect(previewFrame.locator('body')).toHaveCSS('background-color', 'rgb(33, 72, 99)')
  await page.reload()
  await expect(previewFrame.getByRole('heading', { name: 'Encoded preview document' })).toBeVisible()
  await expect(previewFrame.locator('body')).toHaveCSS('background-color', 'rgb(33, 72, 99)')
})
