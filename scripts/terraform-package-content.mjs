import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, lstatSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const plainVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

function git(root, args, { encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding })
  if (result.status !== 0) throw new Error(result.stderr?.toString().trim() || `git ${args.join(' ')} failed`)
  return result.stdout
}

function allFiles(root, relative = '') {
  const files = []
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name
    if (entryRelative === '.git') continue
    const absolute = path.join(root, entryRelative)
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) throw new Error(`package contains an unsupported symlink: ${entryRelative}`)
    if (stat.isDirectory()) files.push(...allFiles(root, entryRelative))
    else if (stat.isFile()) files.push(entryRelative)
    else throw new Error(`package contains an unsupported file: ${entryRelative}`)
  }
  return files
}

function normalizedContents(directory, relative) {
  let contents = readFileSync(path.join(directory, relative))
  if (relative === 'release.json') {
    const release = JSON.parse(contents.toString('utf8'))
    for (const key of ['version', 'sourceTag', 'sourceCommit']) release[key] = `<${key}>`
    contents = Buffer.from(`${JSON.stringify(release, null, 2)}\n`)
  } else if (relative === 'examples/registry-consumer/main.tf') {
    const text = contents.toString('utf8')
    const matches = [...text.matchAll(/^([ \t]*version[ \t]*=[ \t]*")[^"]*("[ \t]*)$/gm)]
    assert.equal(matches.length, 1, `${relative} must contain one exact Registry version`)
    contents = Buffer.from(text.replace(/^([ \t]*version[ \t]*=[ \t]*")[^"]*("[ \t]*)$/m, (_line, before, after) => `${before}<version>${after}`))
  }
  return contents
}

export function terraformPackagePayloadHash(directory) {
  const digest = createHash('sha256')
  const files = allFiles(directory)
  if (!files.includes('release.json') || !files.includes('examples/registry-consumer/main.tf')) {
    throw new Error('package is missing release.json or examples/registry-consumer/main.tf')
  }
  for (const relative of files) {
    const executable = (lstatSync(path.join(directory, relative)).mode & 0o111) !== 0
    digest.update(relative)
    digest.update('\0')
    digest.update(executable ? '100755' : '100644')
    digest.update('\0')
    digest.update(normalizedContents(directory, relative))
    digest.update('\0')
  }
  return digest.digest('hex')
}

export function terraformPackageDirectoryHash(directory) {
  const digest = createHash('sha256')
  for (const relative of allFiles(directory)) {
    const file = path.join(directory, relative)
    digest.update(relative)
    digest.update('\0')
    digest.update((lstatSync(file).mode & 0o111) !== 0 ? '100755' : '100644')
    digest.update('\0')
    digest.update(readFileSync(file))
    digest.update('\0')
  }
  return digest.digest('hex')
}

export function previousGeneratedTerraformPackageTag(repositoryDirectory, version, repository) {
  if (!plainVersion.test(version)) throw new Error(`invalid package version ${version}`)
  const tags = git(repositoryDirectory, ['tag', '--list', 'v*']).toString().trim().split('\n').filter(Boolean)
  const releases = []
  for (const tag of tags) {
    const match = /^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/.exec(tag)
    if (!match || compareVersions(match[1], version) >= 0) continue
    const record = spawnSync('git', ['show', `${tag}:release.json`], { cwd: repositoryDirectory, encoding: 'utf8' })
    if (record.status !== 0) continue // Legacy tags predate generated package metadata.
    try {
      const release = JSON.parse(record.stdout)
      if (release.schemaVersion === 1 && release.version === match[1] && release.repository === repository
        && typeof release.sourceCommit === 'string' && typeof release.sourceTag === 'string') {
        releases.push({ tag, version: match[1] })
      }
    } catch { /* Ignore non-generated historical release metadata. */ }
  }
  return releases.sort((a, b) => compareVersions(b.version, a.version))[0]?.tag
}

export function assertTerraformPackageChanged(currentDirectory, previousDirectory, previousTag) {
  if (terraformPackagePayloadHash(currentDirectory) === terraformPackagePayloadHash(previousDirectory)) {
    throw new Error(`generated module package is unchanged since ${previousTag}; do not publish a new version for an unchanged package`)
  }
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let temporary
  try {
    const current = option('current')
    const repositoryDirectory = option('repository-dir')
    const version = option('version')
    const repository = option('repository')
    if (!current || !repositoryDirectory || !version || !repository) throw new Error('--current, --repository-dir, --version and --repository are required')
    const previousTag = previousGeneratedTerraformPackageTag(repositoryDirectory, version, repository)
    if (!previousTag) {
      console.log('no prior generated module release exists; package content-change check skipped')
    } else {
      temporary = mkdtempSync(path.join(os.tmpdir(), 'terraform-package-baseline-'))
      const archive = git(repositoryDirectory, ['archive', previousTag], { encoding: null })
      const extraction = spawnSync('tar', ['-x', '-C', temporary], { input: archive })
      if (extraction.status !== 0) throw new Error(extraction.stderr.toString().trim() || `cannot extract ${previousTag}`)
      assertTerraformPackageChanged(current, temporary, previousTag)
      console.log(`generated module package changed since ${previousTag}`)
    }
  } catch (error) {
    console.error(`terraform-package-content failed: ${error.message}`)
    process.exitCode = 1
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
  }
}
