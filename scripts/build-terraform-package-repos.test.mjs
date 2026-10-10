import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildTerraformPackageRepos, terraformModules } from './build-terraform-package-repos.mjs'
import { terraformPackageDirectoryHash } from './terraform-package-content.mjs'

const script = fileURLToPath(new URL('./build-terraform-package-repos.mjs', import.meta.url))
const sourceCommit = 'a'.repeat(40)

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function write(root, relative, contents, mode) {
  const filename = path.join(root, relative)
  mkdirSync(path.dirname(filename), { recursive: true })
  writeFileSync(filename, contents)
  if (mode) chmodSync(filename, mode)
  return filename
}

function fixture(root, module, { missing = [], extra = [] } = {}) {
  git(root, 'init', '-q')
  const moduleRoot = path.join(root, 'terraform', 'modules', module)
  const files = [
    'README.md', 'LICENSE', 'main.tf', 'variables.tf', 'outputs.tf', 'versions.tf',
    'examples/registry-consumer/main.tf', 'examples/registry-consumer/README.md',
    '.terraform.lock.hcl', 'scripts/validate.sh', ...extra,
  ].filter((relative) => !missing.includes(relative))
  for (const relative of files) {
    const contents = relative === 'examples/registry-consumer/main.tf'
      ? 'module "artifact_pages" {\n  source  = "../../.."\n  version = "0.1.0"\n}\n'
      : `${relative}\n`
    write(moduleRoot, relative, contents, relative === 'scripts/validate.sh' ? 0o755 : undefined)
  }
  git(root, 'add', '-A')
  return moduleRoot
}

test('generator emits deterministic Registry package trees for both providers', async (t) => {
  for (const module of ['cloudflare', 'aws']) {
    await t.test(`${module} package`, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), `terraform-generator-${module}-`))
      try {
        const excluded = [...terraformModules[module].excluded]
        fixture(root, module, { extra: [...excluded, 'docs/example.md', 'modules/delivery/main.tf', 'tests/cli-contract/main.tf'] })
        const out = path.join(root, 'out')
        const args = { sourceRoot: root, out, module, version: '0.1.0', sourceTag: `terraform-${module}/v0.1.0`, sourceCommit }
        const [built] = buildTerraformPackageRepos(args)
        const firstHash = terraformPackageDirectoryHash(built.directory)
        buildTerraformPackageRepos(args)
        assert.equal(terraformPackageDirectoryHash(built.directory), firstHash)

        const metadata = JSON.parse(readFileSync(path.join(built.directory, 'release.json'), 'utf8'))
        assert.deepEqual(metadata, {
          schemaVersion: 1,
          version: '0.1.0',
          repository: `artifact-pages/${terraformModules[module].repository}`,
          sourceTag: `terraform-${module}/v0.1.0`,
          sourceCommit,
        })
        const consumer = readFileSync(path.join(built.directory, 'examples/registry-consumer/main.tf'), 'utf8')
        assert.match(consumer, new RegExp(`source\\s*=\\s*"${terraformModules[module].registryAddress.replaceAll('/', '\\/')}"`))
        assert.match(consumer, /version\s*=\s*"0\.1\.0"/)
        assert.match(readFileSync(path.join(built.directory, 'README.md'), 'utf8'), /generated from \[artifact-pages\/artifact-pages\]/)
        assert.match(readFileSync(path.join(built.directory, '.github/workflows/close-generated-pull-requests.yml'), 'utf8'), /pull_request_target/)
        assert.equal(lstatSync(path.join(built.directory, 'scripts/validate.sh')).mode & 0o111, 0o111)
        for (const relative of ['main.tf', 'LICENSE', '.terraform.lock.hcl', 'examples/registry-consumer/main.tf', 'tests/cli-contract/main.tf']) {
          assert.equal(readdirContains(built.directory, relative), true, `${module} package includes ${relative}`)
        }
        if (module === 'cloudflare') assert.equal(readdirContains(built.directory, 'modules/delivery/main.tf'), true)
        for (const relative of excluded) assert.equal(readdirContains(built.directory, relative), false, `${module} excluded ${relative}`)

        // Untracked or ignored worktree files are never release payload.
        write(path.join(root, 'terraform', 'modules', module), '.terraform/local-state', 'must not ship')
        const [afterUntracked] = buildTerraformPackageRepos(args)
        assert.equal(readdirContains(afterUntracked.directory, '.terraform/local-state'), false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})

function readdirContains(root, relative) {
  try {
    lstatSync(path.join(root, relative))
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

test('generator rejects missing files, unsupported versions, wrong tag/sha, and malformed Registry example', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'terraform-generator-invalid-'))
  try {
    const moduleRoot = fixture(root, 'cloudflare', { missing: ['outputs.tf'] })
    const base = { sourceRoot: root, out: path.join(root, 'out'), module: 'cloudflare', version: '0.1.0', sourceCommit }
    assert.throws(() => buildTerraformPackageRepos(base), /missing required tracked file outputs\.tf/)

    fixture(root, 'aws')
    for (const version of ['v0.1.0', '0.1.0-rc.1', '0.1.0+build.5', '01.2.3']) {
      assert.throws(() => buildTerraformPackageRepos({ ...base, module: 'aws', version }), /plain X\.Y\.Z/)
    }
    assert.throws(() => buildTerraformPackageRepos({ ...base, module: 'aws', sourceTag: 'terraform-aws/v0.1.1' }), /source tag must be/)
    assert.throws(() => buildTerraformPackageRepos({ ...base, module: 'aws', sourceCommit: 'abc' }), /full 40-character SHA/)
    assert.throws(() => buildTerraformPackageRepos({ ...base, module: 'gcp' }), /unknown Terraform module/)
    assert.throws(() => buildTerraformPackageRepos({ ...base, module: 'aws', out: undefined }), /--out is required/)

    const registryExample = path.join(root, 'terraform/modules/aws/examples/registry-consumer/main.tf')
    writeFileSync(registryExample, 'module "artifact_pages" {\n  source = "local"\n}\n')
    git(root, 'add', 'terraform/modules/aws/examples/registry-consumer/main.tf')
    assert.throws(() => buildTerraformPackageRepos({ ...base, module: 'aws' }), /one module source and one exact version/)

    assert.ok(moduleRoot)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generator rejects a tracked symlink and a CLI call without --out leaves the working directory intact', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'terraform-generator-symlink-'))
  const cliCwd = mkdtempSync(path.join(os.tmpdir(), 'terraform-generator-cli-'))
  try {
    fixture(root, 'cloudflare')
    symlinkSync('README.md', path.join(root, 'terraform/modules/cloudflare/linked.md'))
    git(root, 'add', 'terraform/modules/cloudflare/linked.md')
    assert.throws(() => buildTerraformPackageRepos({ sourceRoot: root, out: path.join(root, 'out'), module: 'cloudflare', version: '0.1.0', sourceCommit }), /unsupported symlink/)

    writeFileSync(path.join(cliCwd, 'keep.txt'), 'keep')
    const result = spawnSync(process.execPath, [script, '--module', 'aws', '--version', '0.1.0'], { cwd: cliCwd, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--out is required/)
    assert.deepEqual(readdirSync(cliCwd), ['keep.txt'])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cliCwd, { recursive: true, force: true })
  }
})
