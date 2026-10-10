import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkPublishedTerraformVersion, previousRelease, releaseSeries } from './release-series.mjs'

const preflightScript = fileURLToPath(new URL('./release-preflight.mjs', import.meta.url))
const sourceCommit = 'a'.repeat(40)

test('Terraform release tags are independent per-provider plain SemVer series', () => {
  const cloudflare = releaseSeries('terraform-cloudflare/v0.1.0')
  const aws = releaseSeries('terraform-aws/v1.2.3')
  assert.deepEqual(cloudflare, {
    component: 'terraform-cloudflare', version: '0.1.0', prefix: 'terraform-cloudflare/',
    terraformModule: 'cloudflare', repository: 'terraform-cloudflare-artifact-pages',
    prerelease: true, makeLatest: false,
  })
  assert.equal(aws.terraformModule, 'aws')
  assert.equal(aws.repository, 'terraform-aws-artifact-pages')
  assert.equal(aws.prerelease, false)
  for (const tag of [
    'terraform-gcp/v0.1.0', 'terraform-cloudflare/v0.1', 'terraform-cloudflare/v0.1.0-rc.1',
    'terraform-aws/v1.2.3+build.7', 'terraform-aws/v01.2.3',
  ]) assert.throws(() => releaseSeries(tag), /unsupported release tag/)
  assert.equal(previousRelease(['terraform-cloudflare/v0.1.0', 'terraform-cloudflare/v0.1.2', 'terraform-aws/v0.8.0'], 'terraform-cloudflare/v0.2.0'), 'terraform-cloudflare/v0.1.2')
})

test('module tags trigger only the separate Terraform release workflow', () => {
  const terraformWorkflow = readFileSync(new URL('../.github/workflows/release-terraform.yml', import.meta.url), 'utf8')
  const productWorkflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.match(terraformWorkflow, /terraform-cloudflare\/v\*/)
  assert.match(terraformWorkflow, /terraform-aws\/v\*/)
  assert.match(terraformWorkflow, /workflow_dispatch:/)
  assert.match(terraformWorkflow, /Manual dispatch is always a dry-run/)
  assert.match(terraformWorkflow, /actions\/create-github-app-token/)
  assert.doesNotMatch(productWorkflow, /terraform-(?:cloudflare|aws)\/v\*/)
  assert.match(productWorkflow, /tags: \["v\*"/)
})

test('published module versions start at 0.1.0, move forward, and allow exact-tag retries', () => {
  const first = releaseSeries('terraform-cloudflare/v0.1.0')
  assert.doesNotThrow(() => checkPublishedTerraformVersion(first, []))
  assert.throws(() => checkPublishedTerraformVersion(releaseSeries('terraform-cloudflare/v0.1.1'), []), /first terraform-cloudflare version must be 0\.1\.0/)
  assert.doesNotThrow(() => checkPublishedTerraformVersion(releaseSeries('terraform-cloudflare/v0.1.1'), ['v0.1.0']))
  assert.doesNotThrow(() => checkPublishedTerraformVersion(releaseSeries('terraform-cloudflare/v0.1.0'), ['v0.1.0', 'v0.2.0']))
  assert.throws(() => checkPublishedTerraformVersion(releaseSeries('terraform-cloudflare/v0.1.9'), ['v0.2.0']), /must exceed published 0\.2\.0/)
  assert.doesNotThrow(() => checkPublishedTerraformVersion(releaseSeries('terraform-cloudflare/v1.0.0'), ['bad', 'v0.9.9', 'v0.9.9-rc.1', 'v0.9.9+build.2']))
  assert.equal(sourceCommit.length, 40)
})

test('release preflight checks main ancestry and the matching public package-repository tag inventory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'terraform-release-preflight-'))
  try {
    const git = path.join(dir, 'git')
    writeFileSync(git, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'ls-remote') {
  if (args[2] !== process.env.EXPECTED_REPOSITORY) process.exit(88)
  if (process.env.INVENTORY_FAILURE) process.exit(1)
  const tags = (process.env.PUBLISHED_TAGS === undefined ? 'v0.1.0' : process.env.PUBLISHED_TAGS).split(',').filter(Boolean)
  for (const tag of tags) console.log('abc123\\trefs/tags/' + tag)
  console.log('abc123\\trefs/tags/v0.1.0^{}')
  process.exit(0)
}
if (args[0] === 'cat-file') {
  if (process.env.MISSING_LOCAL_TAG) process.exit(1)
  console.log(process.env.LIGHTWEIGHT_TAG ? 'commit' : 'tag')
  process.exit(0)
}
if (args[0] === 'rev-parse') {
  console.log(args[2]?.startsWith('refs/tags/') ? (process.env.TAG_COMMIT || '${sourceCommit}') : '${sourceCommit}')
  process.exit(0)
}
if (args[0] === 'merge-base') process.exit(process.env.NOT_ANCESTOR ? 1 : 0)
process.exit(91)
`)
    chmodSync(git, 0o755)
    const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }
    const run = (tag, extra = {}) => {
      const repository = `https://github.com/artifact-pages/${tag.startsWith('terraform-aws/') ? 'terraform-aws-artifact-pages' : 'terraform-cloudflare-artifact-pages'}.git`
      return spawnSync(process.execPath, [preflightScript, '--tag', tag, '--sha', sourceCommit, '--main-ref', 'origin/main'], {
        env: { ...env, EXPECTED_REPOSITORY: repository, ...extra },
        encoding: 'utf8',
      })
    }

    let result = run('terraform-cloudflare/v0.1.1')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /selects terraform-cloudflare/)
    result = run('terraform-aws/v0.1.0', { EXPECTED_REPOSITORY: 'https://github.com/artifact-pages/terraform-aws-artifact-pages.git', PUBLISHED_TAGS: '' })
    assert.equal(result.status, 0, result.stderr)
    result = run('terraform-cloudflare/v0.1.0', { PUBLISHED_TAGS: '' })
    assert.equal(result.status, 0, result.stderr, 'first-version dry-run must work before the package tag exists')
    result = run('terraform-cloudflare/v0.1.1', { LIGHTWEIGHT_TAG: '1' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must exist as an annotated tag/)
    result = run('terraform-cloudflare/v0.1.1', { MISSING_LOCAL_TAG: '1' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must exist as an annotated tag/)
    result = run('terraform-cloudflare/v0.1.1', { TAG_COMMIT: 'b'.repeat(40) })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /does not point to selected commit/)
    result = run('terraform-cloudflare/v0.1.1', { PUBLISHED_TAGS: 'v0.2.0' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must exceed published 0\.2\.0/)
    result = run('terraform-cloudflare/v0.2.0', { INVENTORY_FAILURE: '1' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /cannot read published terraform-cloudflare-artifact-pages tags/)
    result = run('terraform-cloudflare/v0.1.1', { NOT_ANCESTOR: '1' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /is not on origin\/main/)
    assert.notEqual(run('terraform-cloudflare/v0.1.1-rc.1').status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
