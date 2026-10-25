#!/usr/bin/env node
// T30 reader probe: drives the real SPA in Chromium (fresh context per sample)
// and times cold open, a 3-page session, a normal reload and a full-text search.
import { appendFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'https://artifact-pages.stream' },
    label: { type: 'string', default: 'run' },
    samples: { type: 'string', default: '20' },
    out: { type: 'string', default: 't30-reader.jsonl' },
    site: { type: 'string', default: 'verify-scale-1000' },
    term: { type: 'string', default: 'searchable' },
  },
})
const base = opts.base.replace(/\/+$/u, '')
const samples = Number(opts.samples)
const site = opts.site
const home = `${base}/${site}`
const TIMEOUT = 30000
// Fixture pages: "Verification page 00002/00003 for <site>" render inside an iframe.
const docTitle = (n) => `Verification page ${String(n).padStart(5, '0')} for ${site}`

const rootRe = /\/_indexes\/(sites\.json|[^/]+\/(meta\.json|index\.json|search\/manifest\.json))$/u
const browser = await chromium.launch()
writeFileSync(opts.out, '')

async function runSample(i) {
  const context = await browser.newContext() // fresh context = cold HTTP cache
  const page = await context.newPage()
  let step = 'init'
  let roots = []
  page.on('response', (res) => {
    const u = new URL(res.url())
    if (!rootRe.test(u.pathname)) return
    const h = res.headers()
    roots.push({ url: u.pathname, status: res.status(), cfCacheStatus: h['cf-cache-status'] ?? null, age: h.age ?? null, etag: h.etag ?? null, cacheControl: h['cache-control'] ?? null, fromServiceWorker: res.fromServiceWorker() })
  })
  const results = []
  const timed = async (name, fn) => {
    step = name
    roots = []
    const t0 = performance.now()
    let error = null
    try { await fn() } catch (e) { error = String(e.message).split('\n')[0] }
    const ms = +(performance.now() - t0).toFixed(1)
    // Let in-flight root responses of this step land before attributing them.
    await page.waitForTimeout(200)
    const line = { label: opts.label, ts: new Date().toISOString(), sample: i, step, ms, error, roots: roots.slice() }
    results.push(line)
    appendFileSync(opts.out, JSON.stringify(line) + '\n')
  }
  const docList = () => page.getByRole('link', { name: new RegExp(docTitle(2)) }).first().waitFor({ timeout: TIMEOUT })
  const docBody = (n) => page.frameLocator('iframe').first().getByRole('heading', { name: docTitle(n) }).waitFor({ timeout: TIMEOUT })
  try {
    // (a) cold open
    await timed('a_cold_open', async () => { await page.goto(home); await docList() })
    // (b) three-step SPA session
    await timed('b1_open_doc', async () => { await page.getByRole('link', { name: new RegExp(docTitle(2)) }).first().click(); await docBody(2) })
    await timed('b2_back_home', async () => { await page.goBack(); await docList() })
    await timed('b3_open_doc2', async () => { await page.getByRole('link', { name: new RegExp(docTitle(3)) }).first().click(); await docBody(3) })
    // (c) normal reload of the site home (browser cache applies)
    await page.goto(home)
    await docList()
    await timed('c_reload', async () => { await page.reload(); await docList() })
    // (d) search: open palette, type, submit, wait for result rows
    await timed('d_search', async () => {
      await page.getByRole('button', { name: /Search pages in|Jump to a page/ }).first().click()
      const input = page.getByRole('dialog', { name: 'Command palette' }).getByRole('textbox', { name: /Search artifacts/ })
      await input.fill(opts.term)
      await input.press('Enter')
      // The first rows can be partial; the count line ("99 pages contain ...") appears when the full-text result is complete.
      await page.locator('.search-page-count-text').filter({ hasText: /\d+ pages? contain/u }).waitFor({ timeout: TIMEOUT })
    })
  } finally {
    await context.close()
  }
}

for (let i = 0; i < samples; i++) {
  await runSample(i)
  console.error(`sample ${i + 1}/${samples} done`)
}
await browser.close()
