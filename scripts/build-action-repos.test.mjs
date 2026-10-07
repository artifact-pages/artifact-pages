import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkActionChanges } from './check-action-releases.mjs'
import { releaseSeries, previousRelease } from './release-series.mjs'

import { actionNames, buildActionRepos, readProductVersion, repositoryActionYml, repositoryName } from './build-action-repos.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = readProductVersion()

function scratch(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'action-repos-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('each Action repository is self-contained and carries the CLI release record', (t) => {
  const out = scratch(t)
  const built = buildActionRepos({ out, version })
  assert.deepEqual(built.map((entry) => entry.repository), ['publish-action', 'preview-action', 'registry-action', 'app-deploy-action'])
  for (const entry of built) {
    const files = readdirSync(entry.directory).sort()
    assert.deepEqual(files, ['LICENSE', 'README.md', 'action.yml', 'release.json', 'scripts'])
    const release = JSON.parse(readFileSync(path.join(entry.directory, 'release.json'), 'utf8'))
    assert.deepEqual(release, { schemaVersion: 1, version, repository: 'artifact-pages/artifact-pages' })
    const action = readFileSync(path.join(entry.directory, 'action.yml'), 'utf8')
    assert.doesNotMatch(action, /\.\.|\/shared\//, `${entry.repository} must not refer outside its repository`)
    assert.match(action, /^name: Artifact Pages \S/m)
    for (const [, script] of action.matchAll(/\$GITHUB_ACTION_PATH\/scripts\/([\w-]+\.mjs)/g)) {
      assert.ok(existsSync(path.join(entry.directory, 'scripts', script)), `${entry.repository} lacks scripts/${script}`)
    }
    for (const script of readdirSync(path.join(entry.directory, 'scripts'))) {
      assert.doesNotMatch(script, /\.test\.mjs$/)
      const source = readFileSync(path.join(entry.directory, 'scripts', script), 'utf8')
      for (const [, dependency] of source.matchAll(/from '\.\/([\w-]+\.mjs)'/g)) {
        assert.ok(existsSync(path.join(entry.directory, 'scripts', dependency)), `${entry.repository}/scripts/${script} imports a missing ${dependency}`)
      }
      assert.equal(spawnSync(process.execPath, ['--check', path.join(entry.directory, 'scripts', script)]).status, 0)
    }
    assert.match(readFileSync(path.join(entry.directory, 'README.md'), 'utf8'), /^> This repository is generated from/)
  }
  // Only the preview Action carries the pull-request scripts.
  assert.ok(existsSync(path.join(built[1].directory, 'scripts', 'verify-preview-pr.mjs')))
  assert.ok(!existsSync(path.join(built[0].directory, 'scripts', 'verify-preview-pr.mjs')))
  assert.deepEqual(actionNames.map(repositoryName), built.map((entry) => entry.repository))
})

test('generation is deterministic and Action versions are independent of the CLI pin', (t) => {
  const first = scratch(t)
  const second = scratch(t)
  buildActionRepos({ out: first, version })
  buildActionRepos({ out: second, version })
  const diff = spawnSync('diff', ['-r', first, second], { encoding: 'utf8' })
  assert.equal(diff.status, 0, diff.stdout)
  const independent = buildActionRepos({ out: first, version: '9.9.9', names: ['publish'] })
  assert.equal(independent.length, 1)
  assert.equal(JSON.parse(readFileSync(path.join(independent[0].directory, 'release.json'), 'utf8')).version, version)
  assert.throws(() => buildActionRepos({ out: first, version: 'v0.1.0' }), /must look like X\.Y\.Z/)
  assert.throws(() => repositoryActionYml('run: ../x'), /parent directory/)
})

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function sync(built, base, extra = {}, releaseVersion = version) {
  return spawnSync('bash', [path.join(projectRoot, 'scripts', 'sync-action-repos.sh'), built, releaseVersion], {
    encoding: 'utf8',
    env: { ...process.env, ACTION_REPO_URL_BASE: base, SOURCE_SHA: 'abc1234', ...extra },
  })
}

test('the 0.x sync publishes content and a tag, repeats as a no-op and replaces a changed pre-release tag', (t) => {
  const root = scratch(t)
  const remotes = path.join(root, 'remotes')
  mkdirSync(remotes)
  for (const name of actionNames) git(root, 'init', '--quiet', '--bare', '--initial-branch=main', path.join(remotes, repositoryName(name)))
  const built = path.join(root, 'built')
  buildActionRepos({ out: built, version })
  const base = `file://${remotes}`

  const first = sync(built, base)
  assert.equal(first.status, 0, first.stderr)
  const publishRemote = path.join(remotes, 'publish-action')
  assert.match(git(publishRemote, 'tag', '--list'), new RegExp(`^v${version.replaceAll('.', '\\.')}$`))
  assert.equal(JSON.parse(git(publishRemote, 'show', `v${version}:release.json`)).version, version)
  const head = git(publishRemote, 'rev-parse', 'main')
  assert.equal(git(publishRemote, 'rev-parse', `v${version}^{commit}`), head)
  assert.match(git(publishRemote, 'log', '-1', '--format=%s', 'main'), /^Sync v.* at abc1234$/)

  const repeat = sync(built, base)
  assert.equal(repeat.status, 0, repeat.stderr)
  assert.match(repeat.stdout, /already published with identical content/)
  assert.equal(git(publishRemote, 'rev-parse', 'main'), head)

  writeFileSync(path.join(built, 'publish-action', 'README.md'), 'changed\n')
  const moved = sync(built, base)
  assert.equal(moved.status, 0, moved.stderr)
  assert.notEqual(git(publishRemote, 'rev-parse', `v${version}^{commit}`), head)
  assert.equal(git(publishRemote, 'show', `v${version}:README.md`), 'changed')
})

test('a partially failed sync is completed by a re-run', (t) => {
  const root = scratch(t)
  const remotes = path.join(root, 'remotes')
  mkdirSync(remotes)
  // The repository that sorts last (registry-action) is missing at first: the run publishes three and fails on it.
  for (const name of actionNames.filter((candidate) => candidate !== 'registry')) git(root, 'init', '--quiet', '--bare', '--initial-branch=main', path.join(remotes, repositoryName(name)))
  const built = path.join(root, 'built')
  buildActionRepos({ out: built, version })
  const base = `file://${remotes}`
  const failed = sync(built, base)
  assert.notEqual(failed.status, 0)
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', path.join(remotes, repositoryName('registry')))
  const rerun = sync(built, base)
  assert.equal(rerun.status, 0, rerun.stderr)
  assert.match(rerun.stdout, /already published with identical content/)
  for (const name of actionNames) assert.match(git(path.join(remotes, repositoryName(name)), 'tag', '--list'), /^v\d/)
})


test('stable Action tags refuse replacement', (t) => {
  const root = scratch(t), remotes = path.join(root, 'remotes'), built = path.join(root, 'built')
  mkdirSync(remotes)
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', path.join(remotes, 'publish-action'))
  buildActionRepos({ out: built, version: '1.0.0', names: ['publish'] })
  const base = `file://${remotes}`
  assert.equal(sync(built, base, {}, '1.0.0').status, 0)
  const head = git(path.join(remotes, 'publish-action'), 'rev-parse', 'v1.0.0^{commit}')
  writeFileSync(path.join(built, 'publish-action', 'README.md'), 'changed\n')
  const rejected = sync(built, base, {}, '1.0.0')
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /stable tags are never moved/)
  assert.equal(git(path.join(remotes, 'publish-action'), 'rev-parse', 'v1.0.0^{commit}'), head)
})

test('all release patterns select only their component and CLI alone is latest', (t) => {
  assert.deepEqual(releaseSeries('v0.1.0'), { component: 'cli', version: '0.1.0', prefix: '', action: undefined, makeLatest: true })
  assert.equal(releaseSeries('web/v0.1.0').component, 'web')
  assert.equal(releaseSeries('web/v0.1.0').makeLatest, false)
  for (const name of actionNames) {
    const series = releaseSeries(`${name}-action/v0.1.0`)
    assert.equal(series.action, name)
    assert.equal(series.makeLatest, false)
    const built = buildActionRepos({ out: scratch(t), version: series.version, names: [series.action] })
    assert.deepEqual(built.map((entry) => entry.repository), [`${name}-action`])
  }
  for (const tag of ['v01.0.0', 'web/v1.2.3-beta', 'unknown-action/v1.0.0', 'terraform-aws/v1.0.0']) assert.throws(() => releaseSeries(tag))
  const tags = ['v0.2.0', 'v0.1.0', 'web/v0.1.0', 'web/v0.3.0', 'publish-action/v0.2.0']
  assert.equal(previousRelease(tags, 'v0.3.0'), 'v0.2.0')
  assert.equal(previousRelease(tags, 'web/v0.2.0'), 'web/v0.1.0')
  assert.equal(previousRelease(tags, 'preview-action/v0.3.0'), undefined)
})

test('generated-content checks reject unchanged tags and shared changes warn for every untagged affected Action', (t) => {
  const current = scratch(t), baseline = scratch(t)
  for (const directory of [current, baseline]) {
    cpSync(path.join(projectRoot, 'actions'), path.join(directory, 'actions'), { recursive: true })
    mkdirSync(path.join(directory, 'cli/internal/version'), { recursive: true })
    cpSync(path.join(projectRoot, 'cli/internal/version/version.go'), path.join(directory, 'cli/internal/version/version.go'))
    cpSync(path.join(projectRoot, 'LICENSE'), path.join(directory, 'LICENSE'))
  }
  const args = { sourceRoot: current, tags: actionNames.map((name) => `${name}-action/v0.1.0`), selected: 'publish', currentTag: 'publish-action/v0.2.0', baselineRoot: () => baseline }
  let report = checkActionChanges(args)
  assert.equal(report.find((row) => row.action === 'publish').level, 'error')
  const shared = path.join(current, 'actions/shared/prebuilt-cli.mjs')
  writeFileSync(shared, readFileSync(shared, 'utf8') + '\n// Shared behavior update.\n')
  report = checkActionChanges(args)
  assert.ok(report.every((row) => row.changed))
  assert.equal(report.find((row) => row.action === 'publish').level, 'ok')
  assert.equal(report.filter((row) => row.level === 'warning').length, 3)
  cpSync(path.join(baseline, 'actions/shared/prebuilt-cli.mjs'), shared)
  // A version-only Action bump is excluded; a different pinned CLI is real content.
  writeFileSync(path.join(current, 'cli/internal/version/version.go'), 'package version\nconst Product = "0.9.0"\n')
  assert.ok(checkActionChanges(args).every((row) => row.changed))
})


test('release preflight accepts all prefixed tags independently and rejects a mismatched root CLI tag', () => {
  for (const tag of ['web/v0.1.0', ...actionNames.map((name) => `${name}-action/v0.1.0`), `v${version}`]) {
    const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts/release-preflight.mjs'), '--tag', tag, '--main-ref', 'HEAD'], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${tag}: ${result.stderr}`)
  }
  const invalid = spawnSync(process.execPath, [path.join(projectRoot, 'scripts/release-preflight.mjs'), '--tag', 'v9.9.9', '--main-ref', 'HEAD'], { encoding: 'utf8' })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /does not equal the CLI version constant/)
})
