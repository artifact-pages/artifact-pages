#!/usr/bin/env node
// Generates GitHub release notes (TD2): whether the web bundle changed since the
// previous release (file-by-file digests, not the archive hash), the
// compatibility verdict of the gate, and the upgrade procedure when breaking.
//
//   node scripts/release-notes.mjs --version X.Y.Z --archive NEW.tar.gz
//        [--previous-archive OLD.tar.gz --previous-tag vA.B.C]
//        [--verdict compat-verdict.json] --out notes.md
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function digests(archive) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'release-notes-'))
  try {
    const result = spawnSync('tar', ['-xzf', archive, '-C', root], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`cannot extract ${archive}: ${result.stderr}`)
    const files = new Map()
    const walk = (relative) => {
      for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const next = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(next)
        else files.set(next, createHash('sha256').update(readFileSync(path.join(root, next))).digest('hex'))
      }
    }
    walk('')
    return files
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

export function compareBundles(previous, next) {
  const added = [...next.keys()].filter((file) => !previous.has(file)).sort()
  const removed = [...previous.keys()].filter((file) => !next.has(file)).sort()
  const modified = [...next.keys()].filter((file) => previous.has(file) && previous.get(file) !== next.get(file)).sort()
  return { added, removed, modified, unchanged: added.length + removed.length + modified.length === 0 }
}

const list = (files) => files.slice(0, 12).map((file) => `  - \`${file}\``).join('\n') + (files.length > 12 ? `\n  - ... and ${files.length - 12} more` : '')

export function buildNotes({ version, bundle, previousTag, verdict, component = 'web' }) {
  const prerelease = version.startsWith('0.')
  const lines = [`Artifact Pages ${component} v${version}${prerelease ? ' (pre-release)' : ''}`, '', `This release contains only the ${component} component. CLI, web and Actions have independent release series.`, '']
  if (component === 'cli') {
    lines.push('## Compatibility', '', verdict?.reasonCode === 'pre-1.0-compatibility-not-guaranteed'
      ? 'Cross-version compatibility is not guaranteed before 1.0.0, so the compatibility gate was skipped. The candidate still passed the normal release verification suite.'
      : `Compatibility verdict: ${verdict?.verdict ?? 'no earlier CLI release'}.`, '', '## Assets', '', `Per-platform binaries, checksums, Go dependency notices and \`artifact-pages_v${version}_compatibility.json\`.`, '', `Install: \`go install github.com/artifact-pages/artifact-pages/cli/cmd/artifact-pages@v${version}\`.`)
    if (verdict?.verdict === 'breaking') lines.push('', '## Upgrade procedure', '', 'Review the changed-format report before upgrading. Update the deployment config to compatible CLI and web releases; run `artifact-pages registry sync --accept-breaking`, then `artifact-pages app deploy --accept-breaking`, republish every site and preview. Changed formats:', '', (verdict.changedFormats ?? []).map((format) => `- \`${format}\``).join('\n'))
    return `${lines.join('\n')}\n`
  }
  lines.push('## Web bundle', '')
  if (!bundle) {
    lines.push('First release: there is no previous web bundle to compare with.')
  } else if (bundle.unchanged) {
    lines.push(`**Unchanged** since ${previousTag}: every file in the web bundle has identical contents. \`app deploy\` reports no-op for an admin repository that already deployed ${previousTag}.`)
  } else {
    lines.push(`**Changed** since ${previousTag}: ${bundle.modified.length} modified, ${bundle.added.length} added, ${bundle.removed.length} removed. Run \`artifact-pages app deploy\` to update the application plane.`)
    for (const [label, files] of [['Modified', bundle.modified], ['Added', bundle.added], ['Removed', bundle.removed]]) {
      if (files.length) lines.push('', `${label}:`, list(files))
    }
  }
  lines.push('', '## Compatibility', '')
  if (!verdict) {
    lines.push('No earlier release exists, so there is nothing to be compatible with.')
  } else if (verdict.verdict === 'skipped' && verdict.reasonCode === 'pre-1.0-compatibility-not-guaranteed') {
    lines.push('Cross-version compatibility is not guaranteed before 1.0.0, so the compatibility gate was skipped. The candidate still passed the normal release verification suite.')
  } else if (verdict.verdict === 'skipped' && verdict.reasonCode === 'no-baseline') {
    lines.push('No earlier release exists, so there is nothing to be compatible with.')
  } else if (verdict.verdict === 'skipped') {
    lines.push(`Compatibility checks were skipped: ${verdict.reason ?? 'no comparison was available'}.`)
  } else if (verdict.verdict === 'compatible') {
    lines.push(`**Compatible** with ${verdict.baseline?.ref ?? previousTag}: The reader manifest preserves every format version accepted by the previous web release.`, '', 'No operator action is required. Republish a site to use a new feature.')
  } else {
    lines.push(`**Breaking** relative to ${verdict.baseline?.ref ?? previousTag}: reader support was removed for ${(verdict.changedFormats ?? []).map((format) => `\`${format}\``).join(', ')}.`, '', 'The new web shows "This site needs to be republished" for data written by the previous version until the upgrade below is done. The reader manifest no longer accepts every format version accepted by the previous web release.', '', '### Upgrade procedure', '', `1. Update the deployment config to the required CLI and web releases.`, '2. `artifact-pages registry sync --accept-breaking` (admin repository).', '3. `artifact-pages app deploy --accept-breaking` (admin repository).', '4. Sync every site with the new CLI: `artifact-pages site sync --site ID` and, for sites with previews, `artifact-pages preview publish`.')
  }
  lines.push('', '## Assets', '', `- \`artifact-pages-web-v${version}.tar.gz\` with its \`.json\` manifest and \`.sha256\` checksum, built from the tagged commit.`)
  return `${lines.join('\n')}\n`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = option('version')
  const archive = option('archive')
  const out = option('out')
  if (!version || !out || (option('component') !== 'cli' && !archive)) {
    console.error('usage: release-notes.mjs --version X.Y.Z --archive NEW.tar.gz [--previous-archive OLD --previous-tag vA.B.C] [--verdict FILE] --out FILE')
    process.exit(2)
  }
  const previousArchive = option('previous-archive')
  const bundle = previousArchive ? compareBundles(digests(previousArchive), digests(archive)) : undefined
  const verdictFile = option('verdict')
  const verdict = verdictFile ? JSON.parse(readFileSync(verdictFile, 'utf8')) : undefined
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  writeFileSync(out, buildNotes({ version, bundle, previousTag: option('previous-tag'), verdict, component: option('component') ?? 'web' }))
  console.log(`wrote ${out}${bundle ? ` (web bundle ${bundle.unchanged ? 'unchanged' : 'changed'})` : ''}`)
}
