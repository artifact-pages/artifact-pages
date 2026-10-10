import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { terraformModules } from './build-terraform-package-repos.mjs'

const syncScript = fileURLToPath(new URL('./sync-terraform-package-repos.sh', import.meta.url))
const sourceCommit = 'a'.repeat(40)

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function createRemote(base, repository) {
  const bare = path.join(base, `${repository}.git`)
  const seed = path.join(base, `${repository}-seed`)
  mkdirSync(base, { recursive: true })
  git(base, 'init', '--bare', '-q', bare)
  git(base, 'init', '-q', '--initial-branch=main', seed)
  git(seed, 'config', 'user.name', 'Package fixture')
  git(seed, 'config', 'user.email', 'package-fixture@example.invalid')
  writeFileSync(path.join(seed, 'README.md'), 'empty generated-package fixture\n')
  git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'Seed package repository')
  git(seed, 'remote', 'add', 'origin', bare)
  git(seed, 'push', '-q', '-u', 'origin', 'main')
  return { bare, seed, main: git(seed, 'rev-parse', 'HEAD') }
}

function writePackage(root, module, version, { readme = 'generated module\n', license = 'license\n', sourceCommit: commit = sourceCommit } = {}) {
  const definition = terraformModules[module]
  const repository = `artifact-pages/${definition.repository}`
  mkdirSync(path.join(root, 'examples/registry-consumer'), { recursive: true })
  writeFileSync(path.join(root, 'release.json'), `${JSON.stringify({
    schemaVersion: 1, version, repository,
    sourceTag: `terraform-${module}/v${version}`,
    sourceCommit: commit,
  }, null, 2)}\n`)
  writeFileSync(path.join(root, 'examples/registry-consumer/main.tf'), `module "artifact_pages" {\n  source  = "${definition.registryAddress}"\n  version = "${version}"\n}\n`)
  writeFileSync(path.join(root, 'README.md'), readme)
  writeFileSync(path.join(root, 'LICENSE'), license)
}

function runSync({ built, module = 'cloudflare', version = '0.1.0', base, extraEnv = {}, extraArgs = [] }) {
  return spawnSync('bash', [syncScript, built, module, version, ...extraArgs], {
    env: { ...process.env, TERRAFORM_PACKAGE_REPO_URL_BASE: base, ...extraEnv },
    encoding: 'utf8',
  })
}

test('sync dry-run reports the target plan and changes neither package repository', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'terraform-sync-dry-run-'))
  try {
    const base = path.join(root, 'remotes')
    const cloudflare = createRemote(base, terraformModules.cloudflare.repository)
    const aws = createRemote(base, terraformModules.aws.repository)
    const built = path.join(root, 'built')
    mkdirSync(built)
    writePackage(path.join(built, terraformModules.cloudflare.repository), 'cloudflare', '0.1.0')

    const result = runSync({ built, base, extraArgs: ['--dry-run'] })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /terraform-cloudflare-artifact-pages: dry-run planned main [0-9a-f]{40} and tag v0\.1\.0 from terraform-cloudflare\/v0\.1\.0/)
    assert.equal(git(cloudflare.bare, 'rev-parse', 'refs/heads/main'), cloudflare.main)
    assert.equal(git(aws.bare, 'rev-parse', 'refs/heads/main'), aws.main)
    assert.equal(git(cloudflare.bare, 'tag', '--list').trim(), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sync publishes only the selected repository, retries identical tags, and rejects immutable or unchanged releases', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'terraform-sync-git-fixture-'))
  try {
    const base = path.join(root, 'remotes')
    const cloudflare = createRemote(base, terraformModules.cloudflare.repository)
    const aws = createRemote(base, terraformModules.aws.repository)
    const built = path.join(root, 'built')
    mkdirSync(built)
    const packageDir = path.join(built, terraformModules.cloudflare.repository)
    writePackage(packageDir, 'cloudflare', '0.1.0')

    let result = runSync({ built, base })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /published v0\.1\.0/)
    const firstCommit = git(cloudflare.bare, 'rev-parse', 'refs/tags/v0.1.0^{commit}')
    assert.equal(git(cloudflare.bare, 'rev-parse', 'refs/heads/main'), firstCommit)
    assert.equal(git(aws.bare, 'rev-parse', 'refs/heads/main'), aws.main, 'the other provider repository is untouched')
    assert.equal(git(cloudflare.bare, 'show', 'v0.1.0:release.json').includes('"version": "0.1.0"'), true)

    result = runSync({ built, base })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /already published with identical content/)
    assert.equal(git(cloudflare.bare, 'rev-parse', 'refs/heads/main'), firstCommit)

    writePackage(packageDir, 'cloudflare', '0.1.0', { readme: 'mutated immutable tag\n' })
    result = runSync({ built, base })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /already exists with different content; published tags are immutable/)
    assert.equal(git(cloudflare.bare, 'rev-parse', 'refs/heads/main'), firstCommit)

    writePackage(packageDir, 'cloudflare', '0.1.1')
    result = runSync({ built, base, version: '0.1.1' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unchanged since v0\.1\.0/)
    assert.equal(git(cloudflare.bare, 'tag', '--list').split('\n').includes('v0.1.1'), false)

    writePackage(packageDir, 'cloudflare', '0.1.1', { license: 'updated license\n', sourceCommit: 'b'.repeat(40) })
    result = runSync({ built, base, version: '0.1.1' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /published v0\.1\.1/)
    assert.equal(git(cloudflare.bare, 'rev-parse', 'refs/heads/main'), git(cloudflare.bare, 'rev-parse', 'refs/tags/v0.1.1^{commit}'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sync validates selected module metadata, plain SemVer, and source commit before cloning', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'terraform-sync-invalid-'))
  try {
    const base = path.join(root, 'no-remotes')
    const built = path.join(root, 'built')
    mkdirSync(built)
    writePackage(path.join(built, terraformModules.cloudflare.repository), 'cloudflare', '0.1.0')
    writePackage(path.join(built, terraformModules.aws.repository), 'cloudflare', '0.1.0')

    for (const version of ['v0.1.0', '0.1.0-rc.1', '0.1.0+build.3', '01.2.3']) {
      const result = runSync({ built, base, version })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /plain X\.Y\.Z/)
    }
    let result = runSync({ built, base, module: 'aws', version: '0.1.0' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /release\.json does not match/)
    result = runSync({ built, base, extraEnv: { SOURCE_SHA: 'b'.repeat(40) } })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /SOURCE_SHA does not match/)
    result = runSync({ built, base: '', extraEnv: { TERRAFORM_PACKAGE_REPO_URL_BASE: '', TERRAFORM_PACKAGE_REPO_TOKEN: '' } })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /TERRAFORM_PACKAGE_REPO_TOKEN or TERRAFORM_PACKAGE_REPO_URL_BASE is required/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
