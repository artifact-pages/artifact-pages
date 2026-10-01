import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
const ms = (value) => value.toFixed(1)
export function renderSummary(report) {
  const lines = ['# Local full-text load results', '', `Browser: ${report.browserVersion}`, '', `URL: ${report.url}/search-lab.html`, '', '## Projection', '', '| Site | Pages | Artifact pages MB | Navigation index raw MB | Search stored MB | Root KB | Metadata build ms | Search build ms |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
  for (const s of report.build.sites) lines.push(`| ${s.site} | ${s.count} | ${(s.artifactBytes / 1e6).toFixed(2)} | ${(s.metadataRawBytes / 1e6).toFixed(2)} | ${(s.searchBytes / 1e6).toFixed(3)} | ${(s.rootBytes / 1000).toFixed(1)} | ${ms(s.metadataBuildMs)} | ${ms(s.searchBuildMs)} |`)
  lines.push('', '## Cold and warm searches', '', '| Site | Profile | Samples | Cold paint p50 / p95 ms | Warm paint p50 ms | Cold payload KB range | Retained heap delta MB range |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |')
  for (const s of report.build.sites) for (const profile of ['local', 'constrained']) {
    const rows = report.cold.filter((r) => r.site === s.site && r.profile === profile)
    const warm = report.warm.filter((r) => r.site === s.site && r.profile === profile)
    if (!rows.length) continue
    const bytes = rows.map((r) => r.payloadBytes / 1000), heap = rows.map((r) => r.heapDeltaBytes / 1e6)
    lines.push(`| ${s.site} | ${profile} | ${rows.length} | ${ms(percentile(rows.map((r) => r.inputToPaintMs), .5))} / ${ms(percentile(rows.map((r) => r.inputToPaintMs), .95))} | ${warm.length ? ms(percentile(warm.map((r) => r.inputToPaintMs), .5)) : '—'} | ${ms(Math.min(...bytes))}–${ms(Math.max(...bytes))} | ${Math.min(...heap).toFixed(2)}–${Math.max(...heap).toFixed(2)} |`)
  }
  lines.push('', 'Constrained: 80 ms added latency, 2.5 Mbps download, 4× CPU slowdown. Percentiles pool four queries; with 12 samples, nearest-rank p95 is the observed maximum. Two-animation-frame paint proxy; not a device paint timestamp or production SLA.', '', 'Payload uses Resource Timing encodedBodySize, includes the lazy decoder and root/leaf data, excludes the already loaded lab shell and subsequent reader navigation. GC heap delta includes cached decoded data. observedHeapMax is a sampled absolute JS heap reading, not a guaranteed peak.', '', '## Concurrent wave', '', '| Clients | Setup + searches wall ms | Search paint min–max ms |', '| ---: | ---: | ---: |')
  for (const c of report.concurrent) lines.push(`| ${c.clients} | ${ms(c.wallMs)} | ${ms(Math.min(...c.samples.map((s) => s.inputToPaintMs)))}–${ms(Math.max(...c.samples.map((s) => s.inputToPaintMs)))} |`)
  lines.push('', `Reader verified: ${Boolean(report.readerVerified)}. Controls verified: ${Boolean(report.controlsVerified)}.`, '', 'This is one concurrent wave on one host, not a saturation or RPS limit test. See results.json for queries, per-request bytes, timing samples, and source corpus hashes.', '')
  return lines.join('\n')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = path.resolve(process.argv[2]), output = path.join(path.dirname(input), 'summary.md')
  writeFileSync(output, renderSummary(JSON.parse(readFileSync(input, 'utf8'))))
  console.log(output)
}
