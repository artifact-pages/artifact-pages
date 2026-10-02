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

export function buildNotes({ version, bundle, previousTag, verdict }) {
  const lines = [`Artifact Pages v${version} (pre-release)`, '', 'One product version: the CLI, the composite Actions and the web bundle ship together. The CLI deploys the web bundle of its own version (`artifact-pages app deploy`).', '']
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
  if (!verdict || verdict.verdict === 'skipped') {
    lines.push('No earlier release exists, so there is nothing to be compatible with.')
  } else if (verdict.verdict === 'compatible') {
    lines.push(`**Compatible** with ${verdict.baseline?.ref ?? previousTag}: no published data format changed its \`schemaVersion\`. The mixed-version suite passed: this release's web reads data written by the previous CLI, the previous web reads data written by this CLI, and one storage written by both CLIs works, including republish, preview and lock operations over each other's output.`, '', 'No operator action is required. Republish a site to use a new feature.')
  } else {
    lines.push(`**Breaking** relative to ${verdict.baseline?.ref ?? previousTag}: the \`schemaVersion\` changed for ${(verdict.changedFormats ?? []).map((format) => `\`${format}\``).join(', ')}.`, '', 'The new web shows "This site needs to be republished" for data written by the previous version until the upgrade below is done. The upgrade procedure was exercised by the release gate and converged to a fully working storage.', '', '### Upgrade procedure', '', `1. Move your CLI (or the pinned Action ref) to v${version}.`, '2. `artifact-pages registry register` (admin repository).', '3. `artifact-pages app deploy` (admin repository).', '4. Republish every site with the new CLI: `artifact-pages site publish --site ID` and, for sites with previews, `artifact-pages preview publish`.')
  }
  lines.push('', '## Assets', '', `- \`artifact-pages-web-v${version}.tar.gz\` with its \`.json\` manifest and \`.sha256\` checksum, built from the tagged commit.`, '- Go CLI: `go install github.com/tasuku43/git-artifact-pages/cli/cmd/artifact-pages@v' + version + '`.')
  return `${lines.join('\n')}\n`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = option('version')
  const archive = option('archive')
  const out = option('out')
  if (!version || !archive || !out) {
    console.error('usage: release-notes.mjs --version X.Y.Z --archive NEW.tar.gz [--previous-archive OLD --previous-tag vA.B.C] [--verdict FILE] --out FILE')
    process.exit(2)
  }
  const previousArchive = option('previous-archive')
  const bundle = previousArchive ? compareBundles(digests(previousArchive), digests(archive)) : undefined
  const verdictFile = option('verdict')
  const verdict = verdictFile ? JSON.parse(readFileSync(verdictFile, 'utf8')) : undefined
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  writeFileSync(out, buildNotes({ version, bundle, previousTag: option('previous-tag'), verdict }))
  console.log(`wrote ${out}${bundle ? ` (web bundle ${bundle.unchanged ? 'unchanged' : 'changed'})` : ''}`)
}
