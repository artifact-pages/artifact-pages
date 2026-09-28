import { expect, test } from '@playwright/test'

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
