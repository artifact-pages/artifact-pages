#!/usr/bin/env node
// Aggregates probe-roots / probe-reader JSONL into JSON and a markdown table.
// Usage: node summarize.mjs --json out.json --md out.md file1.jsonl [file2.jsonl ...]
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: opts, positionals: files } = parseArgs({
  allowPositionals: true,
  options: { json: { type: 'string' }, md: { type: 'string' } },
})

const lines = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))

function stats(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return { n: 0, mean: null, p50: null, p95: null, stddev: null }
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  const pct = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))] // nearest rank
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0
  const r = (x) => +x.toFixed(1)
  return { n: v.length, mean: r(mean), p50: r(pct(0.5)), p95: r(pct(0.95)), stddev: r(sd) }
}
const tally = (items) => {
  const t = {}
  for (const i of items) t[i ?? 'none'] = (t[i ?? 'none'] ?? 0) + 1
  return t
}
const fmtTally = (t) => Object.entries(t).sort().map(([k, v]) => `${k}:${v}`).join(' ')

const rootsRows = new Map()
const readerRows = new Map()
for (const l of lines) {
  if (l.kind) {
    const key = [l.label, l.class + (l.site ? `/${l.site}` : ''), l.kind].join('\t')
    if (!rootsRows.has(key)) rootsRows.set(key, [])
    rootsRows.get(key).push(l)
  } else if (l.step) {
    const key = [l.label, l.step].join('\t')
    if (!readerRows.has(key)) readerRows.set(key, [])
    readerRows.get(key).push(l)
  }
}

const roots = [...rootsRows].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, rows]) => {
  const [label, urlClass, kind] = key.split('\t')
  const ok = rows.filter((r) => !r.error)
  return {
    label, urlClass, kind, count: rows.length, errors: rows.length - ok.length,
    ttfbMs: stats(ok.map((r) => r.ttfbMs)),
    totalMs: stats(ok.map((r) => r.totalMs)),
    cfCacheStatus: tally(ok.map((r) => r.cfCacheStatus)),
    status: tally(ok.map((r) => r.status)),
  }
})
const reader = [...readerRows].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, rows]) => {
  const [label, step] = key.split('\t')
  const ok = rows.filter((r) => !r.error)
  // cf-cache-status of root JSON responses seen during this step, per root class.
  const cls = (u) => (u.endsWith('sites.json') ? 'sites' : u.endsWith('meta.json') ? 'meta' : u.endsWith('index.json') ? 'index' : 'manifest')
  const perClass = {}
  for (const r of rows) for (const x of r.roots ?? []) (perClass[cls(x.url)] ??= []).push(x.cfCacheStatus)
  return {
    label, step, count: rows.length, errors: rows.length - ok.length, ms: stats(ok.map((r) => r.ms)),
    rootCfCacheStatus: Object.fromEntries(Object.entries(perClass).map(([k, v]) => [k, tally(v)])),
  }
})

const summary = { roots, reader }
if (opts.json) writeFileSync(opts.json, JSON.stringify(summary, null, 2) + '\n')

const f = (x) => (x == null ? '-' : x)
let md = ''
if (roots.length) {
  md += '## Roots (ms)\n\n| label | URL class | kind | n | err | TTFB mean | p50 | p95 | sd | total mean | p50 | p95 | sd | cf-cache-status |\n|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|\n'
  for (const r of roots) {
    const a = r.ttfbMs, b = r.totalMs
    md += `| ${r.label} | ${r.urlClass} | ${r.kind} | ${r.count} | ${r.errors} | ${f(a.mean)} | ${f(a.p50)} | ${f(a.p95)} | ${f(a.stddev)} | ${f(b.mean)} | ${f(b.p50)} | ${f(b.p95)} | ${f(b.stddev)} | ${fmtTally(r.cfCacheStatus)} |\n`
  }
  md += '\n'
}
if (reader.length) {
  md += '## Reader steps (ms)\n\n| label | step | n | err | mean | p50 | p95 | sd | root cf-cache-status |\n|---|---|--:|--:|--:|--:|--:|--:|---|\n'
  for (const r of reader) {
    const m = r.ms
    const cf = Object.entries(r.rootCfCacheStatus).map(([k, v]) => `${k}{${fmtTally(v)}}`).join(' ') || '-'
    md += `| ${r.label} | ${r.step} | ${r.count} | ${r.errors} | ${f(m.mean)} | ${f(m.p50)} | ${f(m.p95)} | ${f(m.stddev)} | ${cf} |\n`
  }
}
if (opts.md) writeFileSync(opts.md, md)
else process.stdout.write(md)
