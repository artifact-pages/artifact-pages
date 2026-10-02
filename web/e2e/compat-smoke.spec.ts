import { expect, test } from '@playwright/test'

// Browser smoke for the release compatibility gate (scripts/compat-gate.mjs).
// The gate generates storage with specific CLI versions, serves it with a
// specific web build and describes the content here through the environment:
//   COMPAT_MODE    smoke | republish-state
//   COMPAT_SITES   [{ id, title, htmlText, markdownHeading, searchTerm, previews }]
//   COMPAT_EXPECT  (republish-state) { registry: boolean, site: boolean }
type Site = { id: string; title: string; htmlPath: string; htmlText: string; markdownPath: string; markdownHeading: string; searchTerm: string; previews: boolean }
const mode = process.env.COMPAT_MODE ?? 'smoke'
const sites: Site[] = JSON.parse(process.env.COMPAT_SITES ?? '[]')
const expected = JSON.parse(process.env.COMPAT_EXPECT ?? '{}') as { registry?: boolean; site?: boolean }

test.skip(sites.length === 0, 'COMPAT_SITES is provided by scripts/compat-gate.mjs')

if (mode === 'smoke') {
  test('site picker lists every site', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
    for (const site of sites) await expect(page.getByRole('link', { name: new RegExp(site.title) }).first()).toBeVisible()
  })

  for (const site of sites) {
    test(`${site.id}: HTML artifact renders`, async ({ page }) => {
      await page.goto(`/${site.id}/${site.htmlPath}`)
      await expect(page.frameLocator('iframe').first().getByText(site.htmlText).first()).toBeVisible()
    })

    test(`${site.id}: Markdown artifact renders`, async ({ page }) => {
      await page.goto(`/${site.id}/${site.markdownPath}`)
      await expect(page.getByTestId('markdown-document').getByRole('heading', { level: 1, name: site.markdownHeading })).toBeVisible()
    })

    test(`${site.id}: page text search finds published pages`, async ({ page }) => {
      await page.goto(`/${site.id}?q=${encodeURIComponent(site.searchTerm)}`)
      await expect(page.locator('[data-hit-id]').first()).toBeVisible()
      expect(await page.locator('[data-hit-id]').count()).toBeGreaterThanOrEqual(2)
    })

    if (site.previews) {
      test(`${site.id}: preview list and document`, async ({ page }) => {
        await page.goto(`/${site.id}/_previews`)
        await expect(page.locator('.preview-group').first()).toBeVisible()
        await page.locator('.preview-document-list a').first().click()
        await expect(page.locator('.preview-reader-header h1')).toBeVisible()
      })
    }
  }
} else {
  // The candidate web reads data written by the baseline CLI after a breaking
  // change: it must say what is needed instead of failing or misreading.
  test('the picker shows the matching republish state without crashing', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    if (expected.registry) {
      await expect(page.getByRole('heading', { name: 'This library needs to be updated' })).toBeVisible()
    } else {
      await expect(page.getByRole('heading', { name: 'Choose a site' })).toBeVisible()
      if (expected.site) {
        for (const site of sites) await expect(page.getByRole('link', { name: new RegExp(site.title) }).first()).toContainText('needs to be republished')
      }
    }
    expect(errors).toEqual([])
  })

  if (expected.site) {
    for (const site of sites) {
      test(`${site.id}: the site route says it needs to be republished`, async ({ page }) => {
        await page.goto(`/${site.id}/${site.htmlPath}`)
        await expect(page.getByRole('heading', { name: 'This site needs to be republished' })).toBeVisible()
        await expect(page.getByRole('heading', { name: 'Unable to load this site' })).toHaveCount(0)
      })
    }
  }
}
