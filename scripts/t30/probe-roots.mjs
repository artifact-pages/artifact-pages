#!/usr/bin/env node
// T30 root-class probe: measures sites/meta/index (and the search manifest control)
// as fresh / expired / prime requests over a new TLS connection each time.
import https from 'node:https'
import { appendFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'https://artifact-pages.stream' },
    label: { type: 'string', default: 'run' },
    samples: { type: 'string', default: '50' },
    out: { type: 'string', default: 't30-roots.jsonl' },
    sites: { type: 'string', default: 'smoke,verify-scale-1000' },
    'expire-wait-ms': { type: 'string', default: '6000' },
  },
})
const base = opts.base.replace(/\/+$/u, '')
const samples = Number(opts.samples)
const expireWait = Number(opts['expire-wait-ms'])
const sites = opts.sites.split(',').map((s) => s.trim()).filter(Boolean)

const targets = [{ cls: 'sites', site: '', url: `${base}/_indexes/sites.json` }]
for (const site of sites) {
  targets.push({ cls: 'meta', site, url: `${base}/_indexes/${site}/meta.json` })
  targets.push({ cls: 'index', site, url: `${base}/_indexes/${site}/index.json` })
  targets.push({ cls: 'manifest', site, url: `${base}/_indexes/${site}/search/manifest.json` })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const lastRequestAt = new Map()

function request(url) {
  return new Promise((resolve) => {
    const u = new URL(url)
    const agent = new https.Agent({ keepAlive: false })
    const t = { start: performance.now() }
    let bytes = 0
    const done = (extra) => {
      agent.destroy()
      const end = performance.now()
      const ms = (a, b) => (a != null && b != null ? +(b - a).toFixed(1) : null)
      resolve({
        dnsMs: ms(t.start, t.lookup),
        connectMs: ms(t.lookup, t.connect),
        tlsMs: ms(t.connect, t.secure),
        ttfbMs: ms(t.start, t.firstByte),
        totalMs: ms(t.start, end),
        bytes,
        ...extra,
      })
    }
    const req = https.request(
      { host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', agent, headers: { 'accept-encoding': 'gzip, br', 'user-agent': 't30-probe' } },
      (res) => {
        t.firstByte = performance.now()
        const h = res.headers
        const ray = h['cf-ray'] || ''
        res.on('data', (c) => { bytes += c.length })
        res.on('end', () =>
          done({
            status: res.statusCode,
            contentEncoding: h['content-encoding'] ?? null,
            age: h.age ?? null,
            cfCacheStatus: h['cf-cache-status'] ?? null,
            etag: h.etag ?? null,
            lastModified: h['last-modified'] ?? null,
            cacheControl: h['cache-control'] ?? null,
            cfRay: ray || null,
            colo: ray ? ray.slice(-3) : null,
          }),
        )
        res.on('error', (e) => done({ error: String(e.message) }))
      },
    )
    req.on('socket', (s) => {
      s.on('lookup', () => { t.lookup = performance.now() })
      s.on('connect', () => { t.connect = performance.now() })
      s.on('secureConnect', () => { t.secure = performance.now() })
    })
    req.on('error', (e) => done({ error: String(e.message) }))
    req.setTimeout(30000, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

async function measure(target, kind, sample) {
  const r = await request(target.url)
  lastRequestAt.set(target.url, performance.now())
  const line = { label: opts.label, ts: new Date().toISOString(), sample, kind, class: target.cls, site: target.site, url: target.url, ...r }
  appendFileSync(opts.out, JSON.stringify(line) + '\n')
  return line
}

async function waitGap(target) {
  const last = lastRequestAt.get(target.url)
  if (last == null) return
  const wait = expireWait - (performance.now() - last)
  if (wait > 0) await sleep(wait)
}

writeFileSync(opts.out, '')
for (let i = 0; i < samples; i++) {
  // prime then fresh, back to back per URL (fresh follows within well under 1 s).
  for (const t of targets) {
    await waitGap(t) // prime only after the previous entry has had time to expire
    await measure(t, 'prime', i)
    await measure(t, 'fresh', i)
  }
  // expired: wait until each URL has been idle for the expiry wait, in the same order.
  for (const t of targets) {
    await waitGap(t)
    await measure(t, 'expired', i)
  }
  console.error(`sample ${i + 1}/${samples} done`)
}
