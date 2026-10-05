import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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

test('generation is deterministic and refuses a version that is not the CLI constant', (t) => {
  const first = scratch(t)
  const second = scratch(t)
  buildActionRepos({ out: first, version })
  buildActionRepos({ out: second, version })
  const diff = spawnSync('diff', ['-r', first, second], { encoding: 'utf8' })
  assert.equal(diff.status, 0, diff.stdout)
  assert.throws(() => buildActionRepos({ out: first, version: '9.9.9' }), /does not equal the CLI version constant/)
  assert.throws(() => buildActionRepos({ out: first, version: 'v0.1.0' }), /must look like X\.Y\.Z/)
  assert.throws(() => repositoryActionYml('run: ../x'), /parent directory/)
})

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function sync(built, base, extra = {}) {
  return spawnSync('bash', [path.join(projectRoot, 'scripts', 'sync-action-repos.sh'), built, version], {
    encoding: 'utf8',
    env: { ...process.env, ACTION_REPO_URL_BASE: base, SOURCE_SHA: 'abc1234', ...extra },
  })
}

test('the sync publishes content and a tag once, repeats as a no-op and never moves a tag', (t) => {
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
  assert.notEqual(moved.status, 0)
  assert.match(moved.stderr, /already exists with different content; tags are never moved/)
  assert.equal(git(publishRemote, 'rev-parse', `v${version}^{commit}`), head)
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
