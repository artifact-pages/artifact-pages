#!/usr/bin/env node
// Compare generated payloads, including the transitive shared-script closure.
// Action version alone is not content; the CLI pin and all published files are.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { actionNames, buildActionRepos } from './build-action-repos.mjs'
import { previousRelease, releaseSeries } from './release-series.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function payload(directory) {
  const rows = []
  function walk(relative) {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) walk(name)
      else {
        let bytes = readFileSync(path.join(directory, name))
        if (name === 'release.json') {
          const release = JSON.parse(bytes)
          delete release.actionVersion
          delete release.version
          bytes = Buffer.from(JSON.stringify(release))
        }
        rows.push([name, bytes.toString('base64')])
      }
    }
  }
  walk('')
  return JSON.stringify(rows.sort((a, b) => a[0].localeCompare(b[0])))
}
export function checkActionChanges({ sourceRoot = root, tags, selected, currentTag, baselineRoot, allowFixtureFallback = false }) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'action-release-check-'))
  try {
    const result = []
    for (const name of actionNames) {
      // On unrelated component releases compare against the newest Action tag.
      const tag = name === selected ? currentTag : `${name}-action/v999999.0.0`
      const previous = previousRelease(tags, tag)
      const candidate = buildActionRepos({ sourceRoot, out: path.join(temporary, 'current'), version: '0.1.0', names: [name] })[0]
      let changed = true
      if (previous) {
        const source = baselineRoot(previous)
        const out = path.join(temporary, 'previous')
        const historical = path.join(source, 'scripts/build-action-repos.mjs')
        let baseline
        if (existsSync(historical)) {
          const generated = spawnSync(process.execPath, [realpathSync(historical), '--out', out, '--version', '0.1.0', '--action', name], { encoding: 'utf8' })
          if (generated.status !== 0) throw new Error(`cannot generate historical ${previous}: ${generated.stderr}`)
          baseline = { directory: path.join(out, `${name}-action`) }
        } else {
          if (!allowFixtureFallback) throw new Error(`historical ${previous} has no Action repository generator`)
          // Small unit fixtures omit scripts/. Real Git archives must carry their
          // own generator so historical bootstrap/range metadata stays accurate.
          baseline = buildActionRepos({ sourceRoot: source, out, version: '0.1.0', names: [name] })[0]
        }
        changed = payload(candidate.directory) !== payload(baseline.directory)
      }
      result.push({ action: name, previous, changed, level: name === selected && !changed ? 'error' : name !== selected && changed ? 'warning' : 'ok' })
    }
    return result
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[process.argv.indexOf('--tag') + 1]
  const run = (args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 128 << 20 }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim() }
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'action-baselines-'))
  try {
    const series = releaseSeries(tag)
    const roots = new Map()
    const baselineRoot = (ref) => {
      if (!roots.has(ref)) {
        const directory = path.join(scratch, String(roots.size))
        const archive = spawnSync('git', ['archive', ref], { cwd: root, maxBuffer: 128 << 20 })
        if (archive.status !== 0) throw new Error(`cannot archive ${ref}`)
        const mkdir = spawnSync('mkdir', ['-p', directory]); if (mkdir.status !== 0) throw new Error('cannot create baseline directory')
        const unpack = spawnSync('tar', ['-xf', '-', '-C', directory], { input: archive.stdout }); if (unpack.status !== 0) throw new Error(`cannot unpack ${ref}`)
        roots.set(ref, directory)
      }
      return roots.get(ref)
    }
    const report = checkActionChanges({ tags: run(['tag', '--list']).split('\n'), selected: series.action, currentTag: tag, baselineRoot })
    for (const item of report) console.log(`${item.level === 'ok' ? '' : `::${item.level}::`}${item.action}-action: generated content ${item.changed ? 'changed' : 'unchanged'}${item.previous ? ` since ${item.previous}` : ' (first component release)'}`)
    if (report.some((item) => item.level === 'error')) process.exitCode = 1
  } catch (error) { console.error(error.message); process.exitCode = 1 } finally { rmSync(scratch, { recursive: true, force: true }) }
}
