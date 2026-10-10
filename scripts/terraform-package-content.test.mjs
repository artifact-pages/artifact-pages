import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertTerraformPackageChanged,
  previousGeneratedTerraformPackageTag,
  terraformPackageDirectoryHash,
  terraformPackagePayloadHash,
} from './terraform-package-content.mjs'

const contentScript = fileURLToPath(new URL('./terraform-package-content.mjs', import.meta.url))
const repository = 'artifact-pages/terraform-cloudflare-artifact-pages'

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function makePackage(root, { version = '0.1.0', sourceTag = `terraform-cloudflare/v${version}`, sourceCommit = 'a'.repeat(40), readme = 'module README\n', license = 'license text\n', workflow = 'name: generated workflow\n', mode = 0o644 } = {}) {
  mkdirSync(path.join(root, 'examples/registry-consumer'), { recursive: true })
  mkdirSync(path.join(root, '.github/workflows'), { recursive: true })
  writeFileSync(path.join(root, 'release.json'), `${JSON.stringify({ schemaVersion: 1, version, repository, sourceTag, sourceCommit }, null, 2)}\n`)
  writeFileSync(path.join(root, 'examples/registry-consumer/main.tf'), `module "artifact_pages" {\n  source  = "artifact-pages/artifact-pages/cloudflare"\n  version = "${version}"\n}\n`)
  writeFileSync(path.join(root, 'README.md'), readme)
  writeFileSync(path.join(root, 'LICENSE'), license)
  writeFileSync(path.join(root, '.github/workflows/close-generated-pull-requests.yml'), workflow, { mode })
  chmodSync(path.join(root, '.github/workflows/close-generated-pull-requests.yml'), mode)
}

function initializeRepository(root) {
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'Terraform package test')
  git(root, 'config', 'user.email', 'terraform-package-test@example.invalid')
}

test('payload guard normalizes only version/source metadata and the exact consumer version', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'terraform-package-payload-'))
  try {
    const baseline = path.join(root, 'baseline'), candidate = path.join(root, 'candidate')
    mkdirSync(baseline); mkdirSync(candidate)
    makePackage(baseline, { version: '0.1.0', sourceCommit: 'a'.repeat(40) })
    makePackage(candidate, { version: '0.1.1', sourceCommit: 'b'.repeat(40) })
    assert.equal(terraformPackagePayloadHash(baseline), terraformPackagePayloadHash(candidate))
    assert.notEqual(terraformPackageDirectoryHash(baseline), terraformPackageDirectoryHash(candidate))
    assert.throws(() => assertTerraformPackageChanged(candidate, baseline, 'v0.1.0'), /unchanged since v0\.1\.0/)

    for (const [filename, contents] of [
      ['README.md', 'changed readme\n'],
      ['LICENSE', 'changed license\n'],
      ['.github/workflows/close-generated-pull-requests.yml', 'name: changed workflow\n'],
    ]) {
      const changed = path.join(root, `changed-${filename.replaceAll('/', '-')}`)
      mkdirSync(changed)
      makePackage(changed, { version: '0.1.1', sourceCommit: 'b'.repeat(40) })
      writeFileSync(path.join(changed, filename), contents)
      assert.notEqual(terraformPackagePayloadHash(changed), terraformPackagePayloadHash(baseline), `${filename} is part of package payload`)
      assert.doesNotThrow(() => assertTerraformPackageChanged(changed, baseline, 'v0.1.0'))
    }

    const modeChanged = path.join(root, 'mode-changed')
    mkdirSync(modeChanged)
    makePackage(modeChanged, { version: '0.1.1', sourceCommit: 'b'.repeat(40), mode: 0o755 })
    assert.notEqual(terraformPackagePayloadHash(modeChanged), terraformPackagePayloadHash(baseline), 'executable mode is package content')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('previous generated tag selection ignores legacy tags and picks the highest lower valid package version', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'terraform-package-tags-'))
  try {
    initializeRepository(root)
    writeFileSync(path.join(root, 'README.md'), 'legacy package\n')
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'legacy package'); git(root, 'tag', 'v0.0.9')
    writeFileSync(path.join(root, 'release.json'), `${JSON.stringify({ schemaVersion: 1, version: '0.1.0', repository, sourceTag: 'terraform-cloudflare/v0.1.0', sourceCommit: 'a'.repeat(40) })}\n`)
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'first generated package'); git(root, 'tag', 'v0.1.0')
    writeFileSync(path.join(root, 'release.json'), `${JSON.stringify({ schemaVersion: 1, version: '0.1.2', repository, sourceTag: 'terraform-cloudflare/v0.1.2', sourceCommit: 'b'.repeat(40) })}\n`)
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'second generated package'); git(root, 'tag', 'v0.1.2')
    writeFileSync(path.join(root, 'release.json'), `${JSON.stringify({ schemaVersion: 1, version: '8.0.0', repository: 'wrong/repository' })}\n`)
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'unrelated package metadata'); git(root, 'tag', 'v8.0.0')

    assert.equal(previousGeneratedTerraformPackageTag(root, '0.1.3', repository), 'v0.1.2')
    assert.equal(previousGeneratedTerraformPackageTag(root, '0.1.2', repository), 'v0.1.0')
    assert.equal(previousGeneratedTerraformPackageTag(root, '0.1.0', repository), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('content CLI skips when no generated predecessor exists and fails for a normalized no-op', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'terraform-package-content-cli-'))
  try {
    const repo = path.join(root, 'repo'), current = path.join(root, 'current')
    mkdirSync(repo); mkdirSync(current)
    initializeRepository(repo)
    makePackage(current)
    let result = spawnSync(process.execPath, [contentScript, '--current', current, '--repository-dir', repo, '--version', '0.1.0', '--repository', repository], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /no prior generated module release exists/)

    makePackage(repo, { version: '0.1.0' })
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'generated package'); git(repo, 'tag', 'v0.1.0')
    makePackage(current, { version: '0.1.1', sourceCommit: 'b'.repeat(40) })
    result = spawnSync(process.execPath, [contentScript, '--current', current, '--repository-dir', repo, '--version', '0.1.1', '--repository', repository], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unchanged since v0\.1\.0/)

    writeFileSync(path.join(current, 'LICENSE'), 'updated license\n')
    result = spawnSync(process.execPath, [contentScript, '--current', current, '--repository-dir', repo, '--version', '0.1.1', '--repository', repository], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /package changed since v0\.1\.0/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
