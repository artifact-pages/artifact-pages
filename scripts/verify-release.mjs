#!/usr/bin/env node
// Post-publication verification (TD2): the CLI built at the tag deploys the
// published web bundle into a clean local target with `app deploy` and no flags
// beyond --config, the deployed bytes equal the release archive, and a repeat
// deployment is a no-op.
//
//   node scripts/verify-release.mjs --cli PATH --assets DIR --version X.Y.Z
//        [--archive FILE]   (local proof only: deploy this archive instead of downloading)
//
// DIR holds the three release assets downloaded from the GitHub release.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function fail(message) {
  console.error(`release verification failed: ${message}`)
  process.exitCode = 1
}

const cli = option('cli') && path.resolve(option('cli'))
const assets = option('assets') && path.resolve(option('assets'))
const version = option('version')
if (!cli || !assets || !version) {
  console.error('usage: verify-release.mjs --cli PATH --assets DIR --version X.Y.Z [--archive FILE]')
  process.exit(2)
}

const archiveName = `artifact-pages-web-v${version}.tar.gz`
const manifest = JSON.parse(readFileSync(path.join(assets, `${archiveName}.json`), 'utf8'))
const scratch = mkdtempSync(path.join(os.tmpdir(), 'verify-release-'))
try {
  const admin = path.join(scratch, 'admin')
  const target = path.join(scratch, 'target')
  mkdirSync(admin, { recursive: true })
  const installed = spawnSync(cli, ['version', '--format', 'json'], { encoding: 'utf8' })
  if (installed.status !== 0) throw new Error('cannot read verifier CLI version')
  const cliVersion = JSON.parse(installed.stdout).version
  writeFileSync(path.join(admin, 'artifact-pages.yaml'), `schemaVersion: 1\ncli:\n  version: ${cliVersion}\nweb:\n  version: ${version}\nprovider: local\nlocal:\n  root: ${JSON.stringify(target)}\n`)


  const deploy = (extra = []) => {
    const result = spawnSync(cli, ['app', 'deploy', '--config', 'artifact-pages.yaml', '--format', 'json', ...extra], { cwd: admin, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`app deploy failed (${result.status}): ${result.stderr.trim() || result.stdout.trim()}`)
    return JSON.parse(result.stdout)
  }
  const extra = option('archive') ? ['--archive', path.resolve(option('archive'))] : []

  const first = deploy(extra)
  if (first.outcome !== 'deployed') throw new Error(`first deploy outcome was ${first.outcome}, want deployed`)
  if (first.version !== version) throw new Error(`deployed version ${first.version} does not equal ${version}`)

  const extracted = path.join(scratch, 'archive')
  mkdirSync(extracted)
  const tar = spawnSync('tar', ['-xzf', path.join(assets, archiveName), '-C', extracted], { encoding: 'utf8' })
  if (tar.status !== 0) throw new Error(`cannot extract the release archive: ${tar.stderr}`)

  const walk = (root, relative = '') => readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const next = relative ? `${relative}/${entry.name}` : entry.name
    return entry.isDirectory() ? walk(root, next) : [next]
  })
  const archived = walk(extracted).sort()
  if (archived.some((file) => file.startsWith('_control/'))) throw new Error('release archive contains private control objects')
  // Local deployment keeps locking and publish-state bookkeeping alongside
  // the public projection. Those private files are deliberately not part of
  // the web archive and therefore do not participate in the public byte
  // comparison below.
  const deployed = walk(target).filter((file) => !file.startsWith('_control/')).sort()
  if (JSON.stringify(archived) !== JSON.stringify([...manifest.files].sort())) throw new Error('archive contents do not match the release manifest')
  if (JSON.stringify(deployed) !== JSON.stringify(archived)) throw new Error(`deployed files differ from the archive: deployed=${deployed.length} archive=${archived.length}`)
  for (const file of archived) {
    if (!readFileSync(path.join(target, file)).equals(readFileSync(path.join(extracted, file)))) throw new Error(`deployed bytes differ from the archive: ${file}`)
  }

  const second = deploy(extra)
  if (second.outcome !== 'no-op') throw new Error(`repeat deploy outcome was ${second.outcome}, want no-op`)
  console.log(`release verification passed: ${archived.length} files deployed byte-identically from v${version}; repeat deploy was a no-op`)
} catch (error) {
  fail(error.message)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
