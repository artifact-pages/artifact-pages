#!/usr/bin/env node
// Compatibility gate (TD2 "Automated release and compatibility gates").
//
// Builds the CLI at a baseline (the previous release) and at the candidate, runs
// both on the same fixture sources, compares the schemaVersion of every
// published format and classifies the change:
//
//   compatible  no schemaVersion changed. The mixed-version suite must pass:
//               candidate web x baseline data, baseline web x candidate data,
//               one storage written by both CLIs, and each CLI republishing,
//               previewing, locking and registering over the other's output.
//   breaking    some schemaVersion changed. The candidate web must show the
//               republish state for baseline data, and the documented upgrade
//               procedure (registry register, app deploy --archive, republish
//               every site) must converge to a fully working storage.
//
// Usage:
//   node scripts/compat-gate.mjs [--baseline REF] [--candidate REF|worktree|DIR]
//                                [--tag vX.Y.Z] [--out FILE] [--keep]
//
//   --baseline   git ref of the previous release (default: latest v* tag below
//                --tag; with no release the gate exits 0 with "skipped").
//   --candidate  worktree (default: the current working tree), a git ref, or an
//                existing source directory.
//   --tag        version check mode: also fail when the verdict is breaking and
//                the version does not increase MAJOR (MINOR while 0.x).
//   --baseline-version  override the baseline's product version (for local proofs
//                when the baseline ref predates cli/internal/version).
//   --out        also write the JSON verdict to FILE.
//   --keep       keep .local/compat-gate/<run> for inspection.
//
// Exit status: 0 = gate passed (or skipped), 1 = failed, 2 = usage error.
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localRoot = path.join(projectRoot, '.local')
const SATELLITE_REPOSITORY = 'example/compat-satellite'
const PREVIEW_BASE_URL = 'http://127.0.0.1:8080'
const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/

// ---------------------------------------------------------------- arguments
function parseArguments(argv) {
  const options = { baseline: undefined, candidate: 'worktree', tag: undefined, baselineVersion: undefined, out: undefined, keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) usage(`${argument} requires a value`)
      index += 1
      return next
    }
    if (argument === '--baseline') options.baseline = value()
    else if (argument === '--candidate') options.candidate = value()
    else if (argument === '--tag') options.tag = value()
    else if (argument === '--baseline-version') options.baselineVersion = value()
    else if (argument === '--out') options.out = value()
    else if (argument === '--keep') options.keep = true
    else usage(`unknown argument ${argument}`)
  }
  if (options.tag !== undefined && !SEMVER.test(options.tag)) usage(`--tag must look like vX.Y.Z, got ${options.tag}`)
  return options
}

function usage(message) {
  console.error(`compat-gate: ${message}`)
  console.error('usage: node scripts/compat-gate.mjs [--baseline REF] [--candidate REF|worktree|DIR] [--tag vX.Y.Z] [--baseline-version X.Y.Z] [--out FILE] [--keep]')
  process.exit(2)
}

// ------------------------------------------------------------------ helpers
function sh(command, args, { cwd = projectRoot, env = {}, allowFail = false, stdio = 'pipe' } = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, encoding: 'utf8', stdio, maxBuffer: 256 << 20 })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFail) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}) in ${cwd}${detail ? `\n${detail}` : ''}`)
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const git = (cwd, args, env) => sh('git', args, { cwd, env }).stdout.trim()
const log = (message) => console.error(`[compat-gate] ${message}`)

function parseSemver(text) {
  const match = SEMVER.exec(text.startsWith('v') ? text : `v${text}`)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: `${match[1]}.${match[2]}.${match[3]}` }
}

function compareSemver(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return } catch { /* nginx may still be starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`the compat-gate server did not start at ${url}`)
}

// ------------------------------------------------- baseline / candidate trees
function latestReleaseTag(upperBound) {
  const tags = git(projectRoot, ['tag', '--list', 'v[0-9]*']).split('\n').filter(Boolean)
  const releases = tags.map((tag) => ({ tag, version: parseSemver(tag) })).filter((entry) => entry.version && entry.tag === `v${entry.version.text}`)
  const eligible = upperBound ? releases.filter((entry) => compareSemver(entry.version, upperBound) < 0) : releases
  eligible.sort((left, right) => compareSemver(right.version, left.version))
  return eligible[0]?.tag
}

function resolveCommit(ref) {
  const result = sh('git', ['rev-parse', '--verify', `${ref}^{commit}`], { allowFail: true })
  if (result.status !== 0) throw new Error(`cannot resolve git ref ${ref}`)
  return result.stdout.trim()
}

function productVersionAt(tree) {
  const file = path.join(tree, 'cli/internal/version/version.go')
  if (!existsSync(file)) return undefined
  return /const Product = "([^"]+)"/.exec(readFileSync(file, 'utf8'))?.[1]
}

function productVersionAtRef(sha) {
  const result = sh('git', ['show', `${sha}:cli/internal/version/version.go`], { allowFail: true })
  return result.status === 0 ? /const Product = "([^"]+)"/.exec(result.stdout)?.[1] : undefined
}

const cleanups = []

function prepareTree(label, spec, runRoot) {
  let dir
  let description
  if (spec === 'worktree') {
    dir = projectRoot
    description = { kind: 'worktree', ref: `${git(projectRoot, ['rev-parse', 'HEAD'])}+worktree` }
  } else if (existsSync(spec) && statSync(spec).isDirectory()) {
    dir = path.resolve(spec)
    description = { kind: 'directory', ref: dir }
  } else {
    const sha = resolveCommit(spec)
    dir = path.join(runRoot, `tree-${label}`)
    sh('git', ['worktree', 'add', '--detach', dir, sha])
    cleanups.push(() => { sh('git', ['worktree', 'remove', '--force', dir], { allowFail: true }) })
    description = { kind: 'ref', ref: spec, commit: sha }
  }
  if (dir !== projectRoot) {
    const modules = path.join(dir, 'node_modules')
    if (!existsSync(modules)) {
      symlinkSync(path.join(projectRoot, 'node_modules'), modules)
      cleanups.push(() => { try { unlinkSync(modules) } catch { /* already gone */ } })
    }
  }
  return { label, dir, description, version: productVersionAt(dir) }
}

function buildTree(tree, runRoot) {
  tree.cli = path.join(runRoot, 'bin', `artifact-pages-${tree.label}`)
  mkdirSync(path.dirname(tree.cli), { recursive: true })
  log(`building ${tree.label} CLI (${tree.description.ref})`)
  sh('go', ['build', '-o', tree.cli, './cli/cmd/artifact-pages'], { cwd: tree.dir })
  tree.web = path.join(runRoot, `web-${tree.label}`)
  log(`building ${tree.label} web`)
  sh(process.execPath, [path.join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'web/vite.config.ts', '--outDir', tree.web, '--emptyOutDir'], { cwd: tree.dir })
}

// ----------------------------------------------------------------- fixtures
const SITES = [
  { id: 'docs', title: 'Compat Docs', htmlPath: 'overview.html', htmlText: 'Docs overview', markdownPath: 'guide.md', markdownHeading: 'Docs guide', searchTerm: 'lighthouse', previews: true },
  { id: 'notes', title: 'Compat Notes', htmlPath: 'page.html', htmlText: 'Notes page', markdownPath: 'notes.md', markdownHeading: 'Notes log', searchTerm: 'lighthouse', previews: true },
]

function write(root, relative, contents) {
  const target = path.join(root, ...relative.split('/'))
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

function initRepository(dir, remote) {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '--initial-branch=main'])
  git(dir, ['remote', 'add', 'origin', remote])
  git(dir, ['config', 'user.name', 'Compat Gate'])
  git(dir, ['config', 'user.email', 'compat-gate@example.invalid'])
}

let commitCounter = 0
function commit(dir, message) {
  commitCounter += 1
  const date = `2026-09-27T00:${String(commitCounter).padStart(2, '0')}:00Z`
  git(dir, ['add', '--all'])
  git(dir, ['commit', '--message', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
}

function createFixtures(work, storages) {
  const admin = path.join(work, 'admin')
  const satellite = path.join(work, 'satellite')
  initRepository(admin, 'https://github.com/example/compat-admin.git')
  initRepository(satellite, `https://github.com/${SATELLITE_REPOSITORY}.git`)
  for (const [name, root] of Object.entries(storages)) {
    const lines = ['schemaVersion: 1', 'provider: local', 'local:', `  root: ${JSON.stringify(root)}`, 'sites:']
    for (const site of SITES) lines.push(`  ${site.id}:`, `    name: ${site.title}`, `    repository: ${SATELLITE_REPOSITORY}`, `    sourcePath: sites/${site.id}`)
    write(admin, `${name}.yaml`, `${lines.join('\n')}\n`)
  }
  commit(admin, 'add compat deployment configs')

  const html = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>The lighthouse keeps ${title} searchable.</p></main></body></html>\n`
  write(satellite, 'sites/docs/overview.html', html('Docs overview'))
  write(satellite, 'sites/docs/guide.md', '# Docs guide\n\nThe lighthouse guide explains the docs site.\n')
  write(satellite, 'sites/notes/page.html', html('Notes page'))
  write(satellite, 'sites/notes/notes.md', '# Notes log\n\nThe lighthouse notes record the latest changes.\n')
  commit(satellite, 'add compat site sources')
  git(satellite, ['checkout', '-b', 'preview-1'])
  for (const site of SITES) write(satellite, `sites/${site.id}/preview-only.md`, `# Preview only ${site.id}\n\nA lighthouse preview document.\n`)
  commit(satellite, 'add preview-only documents')
  git(satellite, ['checkout', 'main'])
  return { admin, satellite }
}

/** A later source revision, used to republish over the other CLI's output. */
function addSecondRevision(satellite) {
  git(satellite, ['checkout', 'main'])
  for (const site of SITES) write(satellite, `sites/${site.id}/revision-two.md`, `# Revision two ${site.id}\n\nA second lighthouse revision.\n`)
  commit(satellite, 'second revision')
  git(satellite, ['checkout', '-b', 'preview-2'])
  for (const site of SITES) write(satellite, `sites/${site.id}/preview-two.md`, `# Preview two ${site.id}\n\nA second lighthouse preview.\n`)
  commit(satellite, 'second preview')
  git(satellite, ['checkout', 'main'])
}

class Operator {
  constructor(fixtures) { this.fixtures = fixtures }

  cli(tree, cwd, args, label) {
    const result = sh(tree.cli, args, { cwd, allowFail: true })
    if (result.status !== 0) throw new Error(`${label} (${tree.label} CLI) failed with ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`)
    try { return JSON.parse(result.stdout) } catch { return { raw: result.stdout } }
  }

  config(name) { return path.join(this.fixtures.admin, `${name}.yaml`) }

  register(tree, name) {
    return this.cli(tree, this.fixtures.admin, ['registry', 'register', '--config', `${name}.yaml`, '--format', 'json'], `registry register ${name}`)
  }

  publish(tree, name, site) {
    git(this.fixtures.satellite, ['checkout', 'main'])
    return this.cli(tree, this.fixtures.satellite, [
      'site', 'publish', '--site', site, '--source', `sites/${site}`,
      '--config', path.relative(this.fixtures.satellite, this.config(name)), '--format', 'json',
    ], `site publish ${site} -> ${name}`)
  }

  preview(tree, name, site, branch) {
    git(this.fixtures.satellite, ['checkout', branch])
    try {
      return this.cli(tree, this.fixtures.satellite, [
        'preview', 'publish', '--site', site, '--source', `sites/${site}`, '--base-url', PREVIEW_BASE_URL,
        '--head', 'HEAD', '--default-ref', 'main',
        '--config', path.relative(this.fixtures.satellite, this.config(name)), '--format', 'json',
      ], `preview publish ${site} (${branch}) -> ${name}`)
    } finally {
      git(this.fixtures.satellite, ['checkout', 'main'])
    }
  }

  lockInspect(tree, name, site) {
    return this.cli(tree, this.fixtures.admin, ['lock', 'inspect', '--site', site, '--config', `${name}.yaml`, '--format', 'json'], `lock inspect ${site} ${name}`)
  }

  /** Register the sites, then publish and preview each with the CLI chosen per site. */
  generate(name, registrar, publishers, previewers) {
    this.register(registrar, name)
    for (const site of SITES) this.publish(publishers[site.id], name, site.id)
    for (const site of SITES) this.preview(previewers[site.id], name, site.id, 'preview-1')
  }
}

// ----------------------------------------------------------- format versions
function* walk(root, relative = '') {
  if (!existsSync(path.join(root, relative))) return
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) yield* walk(root, next)
    else if (entry.isFile()) yield next
  }
}

function formatOf(relative) {
  if (relative === '_indexes/sites.json') return 'registry'
  if (/^_indexes\/[^/]+\/meta\.json$/.test(relative)) return 'site-metadata'
  if (/^_indexes\/[^/]+\/index\.json$/.test(relative)) return 'artifact-index'
  if (/^_indexes\/[^/]+\/search\/manifest\.json$/.test(relative)) return 'full-text-manifest'
  if (/^_previews\/[^/]+\/catalog\.json$/.test(relative)) return 'preview-catalog'
  if (/^_previews\/[^/]+\/revisions\/[^/]+\/manifest\.json$/.test(relative)) return 'preview-manifest'
  if (/^_control\/locks\/.+\.json$/.test(relative)) return 'control-lock'
  if (relative === '_control/registry-cleanup.json') return 'control-registry-cleanup'
  if (/^_control\/site-cache\/.+\.json$/.test(relative)) return 'control-site-cache'
  return undefined
}

/** { format: sorted unique schemaVersion values } for everything a storage holds. */
function collectFormatVersions(storage) {
  const versions = {}
  for (const relative of walk(storage)) {
    const format = formatOf(relative)
    if (!format) continue
    let payload
    try { payload = JSON.parse(readFileSync(path.join(storage, relative), 'utf8')) } catch { continue }
    // The full-text manifest names its field `version` until its next breaking change.
    const value = payload.schemaVersion ?? (format === 'full-text-manifest' ? payload.version : undefined)
    ;(versions[format] ??= new Set()).add(value === undefined ? 'missing' : value)
  }
  return Object.fromEntries(Object.entries(versions).map(([format, set]) => [format, [...set].sort()]))
}

function compareFormats(baselineVersions, candidateVersions) {
  const names = [...new Set([...Object.keys(baselineVersions), ...Object.keys(candidateVersions)])].sort()
  return names.map((format) => {
    const baseline = baselineVersions[format]
    const candidate = candidateVersions[format]
    let status = 'same'
    if (!baseline) status = 'only-in-candidate'
    else if (!candidate) status = 'only-in-baseline'
    else if (JSON.stringify(baseline) !== JSON.stringify(candidate)) status = 'changed'
    return { format, baseline: baseline ?? null, candidate: candidate ?? null, status }
  })
}

// ------------------------------------------------------------ serve + smoke
// A web build is checked with the smoke spec from its own tree, so a later release
// may rename UI text or selectors without failing the older web's check. The
// environment contract (PLAYWRIGHT_BASE_URL, COMPAT_MODE, COMPAT_SITES,
// COMPAT_EXPECT) must stay stable across releases.
function smokeConfigFor(specTree) {
  const own = specTree && path.join(specTree, 'web/playwright.compat.config.ts')
  return own && existsSync(own) ? own : path.join(projectRoot, 'web/playwright.compat.config.ts')
}

async function serveAndSmoke(name, { web, storage, mode = 'smoke', expect = {}, specTree }, runRoot) {
  const port = await freePort()
  const project = `gap-compat-${path.basename(runRoot).slice(-8)}-${port}`.toLowerCase().replace(/[^a-z0-9-]/g, '')
  mkdirSync(path.join(storage, '_previews'), { recursive: true })
  // The gate compares data formats, not file modes: a baseline CLI may have
  // created its storage root 0700 (fixed after the first v0.1.0 candidate), which
  // nginx in the container cannot read on Linux. CLI tests cover the modes.
  chmodSync(storage, 0o755)
  const composeEnv = { WEB_PORT: String(port), WEB_ROOT: web, STORAGE_ROOT: storage, PREVIEW_ROOT: path.join(storage, '_previews'), COMPOSE_PROJECT_NAME: project }
  const compose = (args) => sh('docker', ['compose', '-f', path.join(projectRoot, 'docker-compose.yml'), '-p', project, ...args], { env: composeEnv, allowFail: true })
  log(`${name}: serving on ${port} (${mode})`)
  try {
    const up = compose(['up', '--detach'])
    if (up.status !== 0) throw new Error(`docker compose up failed: ${up.stderr}`)
    const baseURL = `http://127.0.0.1:${port}`
    await waitForServer(baseURL)
    const result = sh(process.execPath, [path.join(projectRoot, 'node_modules/@playwright/test/cli.js'), 'test', '--config', smokeConfigFor(specTree)], {
      env: {
        PLAYWRIGHT_BASE_URL: baseURL, COMPAT_MODE: mode, COMPAT_SITES: JSON.stringify(SITES), COMPAT_EXPECT: JSON.stringify(expect),
      },
      allowFail: true,
    })
    const summary = /(\d+) passed/.exec(result.stdout)?.[0]
    const failed = /(\d+) failed/.exec(result.stdout)?.[0]
    if (result.status !== 0) log(`${name}: smoke FAILED\n${result.stdout}\n${result.stderr}`)
    if (result.status !== 0) {
      // Enough context to tell a serving problem from a reader problem in CI logs.
      for (const url of ['/', '/_indexes/sites.json']) {
        const response = await fetch(baseURL + url).catch((error) => ({ status: String(error) }))
        log(`${name}: GET ${url} -> ${response.status}`)
      }
      log(sh('ls', ['-ld', web, storage, path.join(storage, '_indexes')], { allowFail: true }).stdout)
      log(sh('ls', ['-la', web], { allowFail: true }).stdout)
      log(compose(['logs', '--tail', '30']).stdout)
    }
    return { name, mode, status: result.status === 0 ? 'passed' : 'failed', detail: [summary, failed].filter(Boolean).join(', ') }
  } finally {
    compose(['down', '--remove-orphans'])
  }
}

// -------------------------------------------------------------- version check
function checkVersion({ tag, baselineVersion, verdict }) {
  const candidate = parseSemver(tag)
  const baseline = baselineVersion ? parseSemver(baselineVersion) : undefined
  if (!baseline) return { status: 'failed', tag, reason: `cannot determine the baseline version (${baselineVersion ?? 'unknown'})` }
  if (compareSemver(candidate, baseline) <= 0) {
    return { status: 'failed', tag, baseline: baseline.text, reason: `${tag} does not increase the version above ${baseline.text}` }
  }
  if (verdict === 'breaking') {
    const increasesBreakingPosition = baseline.major === 0
      ? candidate.major > 0 || candidate.minor > baseline.minor
      : candidate.major > baseline.major
    if (!increasesBreakingPosition) {
      const needed = baseline.major === 0 ? `MINOR (0.${baseline.minor + 1}.0 or later) while the product is 0.x` : `MAJOR (${baseline.major + 1}.0.0 or later)`
      return { status: 'failed', tag, baseline: baseline.text, reason: `the data formats changed (breaking), so ${tag} must increase ${needed}` }
    }
  }
  return { status: 'passed', tag, baseline: baseline.text, reason: verdict === 'breaking' ? 'breaking change with the required version increase' : 'compatible change; version increases' }
}

// ------------------------------------------------------------------- main
async function main() {
  const options = parseArguments(process.argv.slice(2))
  const upperBound = options.tag ? parseSemver(options.tag) : undefined
  const baselineSpec = options.baseline ?? latestReleaseTag(upperBound)
  if (!baselineSpec) {
    console.log('compat-gate: skipped: no release')
    writeVerdictFile(options.out, { verdict: 'skipped', reason: 'no release tag exists to compare against' })
    return 0
  }
  mkdirSync(localRoot, { recursive: true })
  const runRoot = mkdtempSync(path.join(localRoot, 'compat-gate-'))
  // mkdtemp creates the directory as 0700. nginx in the container runs as another
  // user, and on Linux bind mounts keep host permissions, so it could not read
  // the served web builds and storage (Docker Desktop on macOS hides this).
  chmodSync(runRoot, 0o755)
  const work = path.join(runRoot, 'work')
  mkdirSync(work, { recursive: true })
  let exitCode = 1
  try {
    const baseline = prepareTree('baseline', baselineSpec, runRoot)
    const candidate = prepareTree('candidate', options.candidate, runRoot)
    baseline.version = options.baselineVersion ?? baseline.version ?? productVersionAtRef(baseline.description.commit ?? resolveCommit(baselineSpec)) ?? parseSemver(baselineSpec)?.text
    buildTree(baseline, runRoot)
    buildTree(candidate, runRoot)

    const storages = { 'storage-baseline': path.join(runRoot, 'storage-baseline'), 'storage-candidate': path.join(runRoot, 'storage-candidate'), 'storage-mixed': path.join(runRoot, 'storage-mixed'), 'storage-upgrade': path.join(runRoot, 'storage-upgrade') }
    const fixtures = createFixtures(work, storages)
    const operator = new Operator(fixtures)
    const each = (tree) => Object.fromEntries(SITES.map((site) => [site.id, tree]))

    log('generating storage with the baseline CLI')
    operator.generate('storage-baseline', baseline, each(baseline), each(baseline))
    log('generating storage with the candidate CLI')
    operator.generate('storage-candidate', candidate, each(candidate), each(candidate))

    const formats = compareFormats(collectFormatVersions(storages['storage-baseline']), collectFormatVersions(storages['storage-candidate']))
    const changed = formats.filter((entry) => entry.status === 'changed')
    const verdict = changed.length > 0 ? 'breaking' : 'compatible'
    const report = {
      verdict,
      baseline: { ...baseline.description, version: baseline.version },
      candidate: { ...candidate.description, version: candidate.version },
      formats,
      changedFormats: changed.map((entry) => entry.format),
      combinations: [],
      checks: [],
    }
    log(`verdict: ${verdict}${changed.length ? ` (${report.changedFormats.join(', ')})` : ''}`)
    const record = (result) => { report.combinations.push(result); log(`${result.name}: ${result.status}${result.detail ? ` (${result.detail})` : ''}`) }

    if (verdict === 'compatible') {
      const mixedName = 'storage-mixed'
      log('building the mixed storage and exercising cross-CLI operations')
      try {
        operator.register(baseline, mixedName)
        operator.publish(baseline, mixedName, 'docs')
        operator.publish(candidate, mixedName, 'notes')
        operator.preview(baseline, mixedName, 'docs', 'preview-1')
        operator.preview(candidate, mixedName, 'notes', 'preview-1')
        addSecondRevision(fixtures.satellite)
        // Each CLI republishes, previews, registers and inspects locks over the other's output.
        operator.publish(candidate, mixedName, 'docs')
        operator.publish(baseline, mixedName, 'notes')
        operator.preview(candidate, mixedName, 'docs', 'preview-2')
        operator.preview(baseline, mixedName, 'notes', 'preview-2')
        operator.register(candidate, mixedName)
        operator.register(baseline, mixedName)
        for (const site of SITES) {
          operator.lockInspect(candidate, mixedName, site.id)
          operator.lockInspect(baseline, mixedName, site.id)
        }
        record({ name: 'cross-CLI republish, preview, register and lock inspect over the other CLI output', mode: 'operations', status: 'passed' })
      } catch (error) {
        record({ name: 'cross-CLI republish, preview, register and lock inspect over the other CLI output', mode: 'operations', status: 'failed', detail: error.message })
      }
      report.mixedFormats = collectFormatVersions(storages[mixedName])
      record(await serveAndSmoke('candidate web x baseline data', { web: candidate.web, storage: storages['storage-baseline'] }, runRoot))
      record(await serveAndSmoke('baseline web x candidate data', { web: baseline.web, storage: storages['storage-candidate'], specTree: baseline.dir }, runRoot))
      record(await serveAndSmoke('candidate web x mixed data', { web: candidate.web, storage: storages[mixedName] }, runRoot))
      record(await serveAndSmoke('baseline web x mixed data', { web: baseline.web, storage: storages[mixedName], specTree: baseline.dir }, runRoot))
    } else {
      const expect = {
        registry: changed.some((entry) => entry.format === 'registry'),
        site: changed.some((entry) => entry.format === 'site-metadata' || entry.format === 'artifact-index'),
      }
      record(await serveAndSmoke('candidate web shows the republish state for baseline data', { web: candidate.web, storage: storages['storage-baseline'], mode: 'republish-state', expect }, runRoot))
      log('running the upgrade procedure: registry register, app deploy --archive, republish every site')
      try {
        cpSync(storages['storage-baseline'], storages['storage-upgrade'], { recursive: true })
        const upgradeName = 'storage-upgrade'
        operator.register(candidate, upgradeName)
        const archive = packageCandidateWeb(candidate, runRoot)
        const deployed = operator.cli(candidate, fixtures.admin, ['app', 'deploy', '--archive', archive, '--config', `${upgradeName}.yaml`, '--format', 'json'], 'app deploy --archive')
        if (!['deployed', 'no-op'].includes(deployed.outcome)) throw new Error(`app deploy outcome was ${deployed.outcome}`)
        if (!existsSync(path.join(storages[upgradeName], 'index.html'))) throw new Error('app deploy did not write index.html to the target')
        for (const site of SITES) operator.publish(candidate, upgradeName, site.id)
        for (const site of SITES) operator.preview(candidate, upgradeName, site.id, 'preview-1')
        const upgraded = compareFormats(collectFormatVersions(storages['storage-candidate']), collectFormatVersions(storages[upgradeName]))
          .filter((entry) => entry.status === 'changed' || entry.status === 'only-in-baseline')
        if (upgraded.length > 0) throw new Error(`upgraded storage still differs from candidate-written formats: ${JSON.stringify(upgraded)}`)
        record({ name: 'upgrade procedure converges', mode: 'operations', status: 'passed' })
      } catch (error) {
        record({ name: 'upgrade procedure converges', mode: 'operations', status: 'failed', detail: error.message })
      }
      record(await serveAndSmoke('candidate web x upgraded storage', { web: candidate.web, storage: storages['storage-upgrade'] }, runRoot))
    }

    if (options.tag) {
      const versionCheck = checkVersion({ tag: options.tag, baselineVersion: baseline.version, verdict })
      report.versionCheck = versionCheck
      log(`version check: ${versionCheck.status}: ${versionCheck.reason}`)
    }
    const failures = [...report.combinations.filter((entry) => entry.status !== 'passed'), ...(report.versionCheck?.status === 'failed' ? [report.versionCheck] : [])]
    report.result = failures.length === 0 ? 'passed' : 'failed'
    console.log(JSON.stringify(report, null, 2))
    writeVerdictFile(options.out, report)
    exitCode = failures.length === 0 ? 0 : 1
    return exitCode
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup()
    sh('git', ['worktree', 'prune'], { allowFail: true })
    if (options.keep) log(`kept ${runRoot}`)
    else rmSync(runRoot, { recursive: true, force: true })
  }
}

function packageCandidateWeb(candidate, runRoot) {
  const label = `gate-${path.basename(runRoot).slice(-8)}`
  sh(process.execPath, [path.join(candidate.dir, 'scripts/package-web.mjs'), '--version', label], { cwd: candidate.dir })
  const releaseRoot = path.join(candidate.dir, '.local/releases')
  const archive = path.join(releaseRoot, `artifact-pages-web-v${label}.tar.gz`)
  // Keep a copy under the run root and remove the packaged files from the tree.
  const copyRoot = path.join(runRoot, 'archive')
  mkdirSync(copyRoot, { recursive: true })
  for (const suffix of ['', '.json', '.sha256']) {
    cpSync(archive + suffix, path.join(copyRoot, path.basename(archive) + suffix))
    rmSync(archive + suffix, { force: true })
  }
  return path.join(copyRoot, path.basename(archive))
}

function writeVerdictFile(out, report) {
  if (!out) return
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
}

main().then((code) => { process.exitCode = code }, (error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
