import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localRoot = path.join(projectRoot, '.local')
const e2eProjectPrefix = 'git-artifact-pages-registered-flow'

function run(command, args, { cwd = projectRoot, env = process.env, stdio = 'pipe' } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'no exit status'}).${detail ? `\n${detail}` : ''}`)
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function writeFile(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split('/'))
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, contents)
}

function git(cwd, args, extraEnv = {}) {
  return run('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  }).stdout.trim()
}

async function initRepository(cwd, remoteURL) {
  await fs.mkdir(cwd, { recursive: true })
  git(cwd, ['init', '--initial-branch=main'])
  git(cwd, ['remote', 'add', 'origin', remoteURL])
  git(cwd, ['config', 'user.name', 'Registered Flow Test'])
  git(cwd, ['config', 'user.email', 'registered-flow@example.invalid'])
}

function commit(cwd, message) {
  git(cwd, ['add', '--all'])
  git(cwd, ['commit', '--message', message], {
    GIT_AUTHOR_DATE: '2026-09-27T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-09-27T00:00:00Z',
  })
}

async function treeSnapshot(directory) {
  const snapshot = new Map()
  async function walk(current, relative = '') {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute, nextRelative)
      } else if (entry.isFile()) {
        const contents = await fs.readFile(absolute)
        snapshot.set(nextRelative, createHash('sha256').update(contents).digest('hex'))
      } else {
        throw new Error(`Unexpected generated storage entry: ${absolute}`)
      }
    }
  }
  await walk(directory)
  return [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate an E2E port.')
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // nginx may take a moment to start after Compose returns.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`The registered-site browser server did not start at ${url}.`)
}

function parseResult(result, label) {
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${label} did not return JSON: ${result.stdout}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  await fs.mkdir(localRoot, { recursive: true })
  const scratchRoot = await fs.mkdtemp(path.join(localRoot, 'registered-flow-'))
  const e2eProject = `${e2eProjectPrefix}-${path.basename(scratchRoot).slice(-6)}`.toLowerCase()
  const adminRoot = path.join(scratchRoot, 'admin')
  const satelliteRoot = path.join(scratchRoot, 'satellite')
  const storageRoot = path.join(scratchRoot, 'storage')
  const emptyPreviewRoot = path.join(scratchRoot, 'previews')
  const binaryPath = path.join(scratchRoot, 'artifact-pages')
  const configPath = path.join(adminRoot, '.artifact-pages.yaml')
  let composeStarted = false
  let success = false
  let port

  try {
    await Promise.all([
      fs.mkdir(adminRoot, { recursive: true }),
      fs.mkdir(satelliteRoot, { recursive: true }),
      fs.mkdir(emptyPreviewRoot, { recursive: true }),
    ])
    await initRepository(adminRoot, 'https://github.com/example/registered-admin.git')
    await initRepository(satelliteRoot, 'https://github.com/example/registered-satellite.git')

    await writeFile(adminRoot, '.artifact-pages.yaml', `schemaVersion: 1\nprovider: local\nlocal:\n  root: ${JSON.stringify(storageRoot)}\n`)
    await writeFile(adminRoot, 'sites.yaml', [
      'schemaVersion: 1',
      'sites:',
      '  neighbor:',
      '    name: Neighbor site',
      '    repository: example/registered-satellite',
      '    sourcePath: sites/neighbor/content',
      '  sre:',
      '    name: SRE registered flow',
      '    repository: example/registered-satellite',
      '    sourcePath: sites/sre/content',
      '',
    ].join('\n'))

    await writeFile(satelliteRoot, 'sites/sre/content/reports/recovery.html', [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8"><title>Recovery review revision one</title>',
      '<link rel="stylesheet" href="../assets/site.css"></head>',
      '<body><main><h1>Recovery review revision one</h1><img src="../assets/recovery.svg" alt="Recovery path"></main></body></html>',
      '',
    ].join('\n'))
    await writeFile(satelliteRoot, 'sites/sre/content/runbooks/recovery.md', [
      '# Recovery runbook',
      '',
      'The site publishes Markdown and its relative SVG resource.',
      '',
      '![Recovery path](../assets/recovery.svg)',
      '',
    ].join('\n'))
    await writeFile(satelliteRoot, 'sites/sre/content/stale.html', '<!doctype html><title>Stale artifact</title><h1>Stale artifact</h1>\n')
    await writeFile(satelliteRoot, 'sites/sre/content/assets/site.css', 'body { background: rgb(223, 241, 230); }\n')
    await writeFile(satelliteRoot, 'sites/sre/content/assets/recovery.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#176b62"/></svg>\n')
    await writeFile(satelliteRoot, 'sites/neighbor/content/index.html', '<!doctype html><title>Neighbor preserved</title><h1>Neighbor preserved</h1>\n')
    await writeFile(satelliteRoot, 'sites/neighbor/content/neighbor.css', 'h1 { color: teal; }\n')
    commit(adminRoot, 'add registered site manifest and shared local target')
    commit(satelliteRoot, 'add two registered site sources')

    run('go', ['build', '-o', binaryPath, './cmd/artifact-pages'])

    const adminDryRun = parseResult(run(binaryPath, [
      'registry', 'publish', '--manifest', 'sites.yaml', '--config', '.artifact-pages.yaml', '--dry-run', '--format', 'json',
    ], { cwd: adminRoot }), 'registry publish dry-run')
    assert(adminDryRun.outcome === 'planned', 'registry publish dry-run did not return a planned outcome')
    assert(!(await fs.stat(storageRoot).then(() => true, () => false)), 'admin dry-run created the local object root')
    run(binaryPath, ['registry', 'publish', '--manifest', 'sites.yaml', '--config', '.artifact-pages.yaml', '--format', 'json'], { cwd: adminRoot })

    const satelliteConfig = path.relative(satelliteRoot, configPath)
    for (const [site, source] of [
      ['neighbor', 'sites/neighbor/content'],
      ['sre', 'sites/sre/content'],
    ]) {
      const result = parseResult(run(binaryPath, [
        'site', 'publish', '--site', site, '--source', source, '--config', satelliteConfig, '--format', 'json',
      ], { cwd: satelliteRoot }), `${site} initial publish`)
      assert(result.outcome === 'published', `${site} initial publish returned ${result.outcome}`)
    }

    const neighborBefore = await treeSnapshot(path.join(storageRoot, '_artifacts', 'neighbor'))
    const neighborIndexBefore = await treeSnapshot(path.join(storageRoot, '_indexes', 'neighbor'))
    assert(neighborBefore.length > 0 && neighborIndexBefore.length > 0, 'neighbor site did not publish both artifacts and index metadata')

    await writeFile(satelliteRoot, 'sites/sre/content/reports/recovery.html', [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8"><title>Recovery review revision two</title>',
      '<link rel="stylesheet" href="../assets/site.css"></head>',
      '<body><main><h1>Recovery review revision two</h1><img src="../assets/recovery.svg" alt="Recovery path"></main></body></html>',
      '',
    ].join('\n'))
    await fs.rm(path.join(satelliteRoot, 'sites/sre/content/stale.html'))
    await writeFile(satelliteRoot, 'sites/sre/content/reports/updated.md', '# Updated runbook\n\nThe second revision is published.\n')
    commit(satelliteRoot, 'update registered SRE site and remove stale artifact')

    const storageBeforeDryRun = await treeSnapshot(storageRoot)
    const updateDryRun = parseResult(run(binaryPath, [
      'site', 'publish', '--site', 'sre', '--source', 'sites/sre/content', '--config', satelliteConfig, '--dry-run', '--format', 'json',
    ], { cwd: satelliteRoot }), 'site publish dry-run')
    assert(updateDryRun.outcome === 'planned', `update dry-run returned ${updateDryRun.outcome}`)
    assert(JSON.stringify(await treeSnapshot(storageRoot)) === JSON.stringify(storageBeforeDryRun), 'site publish dry-run changed the local object tree')

    const updateResult = parseResult(run(binaryPath, [
      'site', 'publish', '--site', 'sre', '--source', 'sites/sre/content', '--config', satelliteConfig, '--format', 'json',
    ], { cwd: satelliteRoot }), 'site publish update')
    assert(updateResult.outcome === 'published', `site update returned ${updateResult.outcome}`)
    assert((await fs.readFile(path.join(storageRoot, '_artifacts/sre/reports/recovery.html'), 'utf8')).includes('revision two'), 'updated HTML bytes were not published')
    assert(!(await fs.stat(path.join(storageRoot, '_artifacts/sre/stale.html')).then(() => true, () => false)), 'stale artifact was not removed')
    assert(JSON.stringify(await treeSnapshot(path.join(storageRoot, '_artifacts/neighbor'))) === JSON.stringify(neighborBefore), 'updating SRE changed neighbor artifact objects')
    assert(JSON.stringify(await treeSnapshot(path.join(storageRoot, '_indexes/neighbor'))) === JSON.stringify(neighborIndexBefore), 'updating SRE changed neighbor index objects')

    port = await freePort()
    const composeEnv = {
      ...process.env,
      COMPOSE_PROJECT_NAME: e2eProject,
      WEB_PORT: String(port),
      WEB_ROOT: path.join(projectRoot, 'dist'),
      STORAGE_ROOT: storageRoot,
      PREVIEW_ROOT: emptyPreviewRoot,
    }
    composeStarted = true
    run('docker', ['compose', '-p', e2eProject, 'up', '--detach'], { env: composeEnv, stdio: 'inherit' })
    const baseURL = `http://127.0.0.1:${port}`
    await waitForServer(baseURL)

    run(process.execPath, [
      path.join(projectRoot, 'node_modules/@playwright/test/cli.js'),
      'test', 'e2e/registered-flow.spec.ts',
    ], {
      env: { ...composeEnv, PLAYWRIGHT_BASE_URL: baseURL, PLAYWRIGHT_REGISTERED_FLOW: '1' },
      stdio: 'inherit',
    })

    run('go', [
      'test', '-race', '-count=1', './internal/publisher',
      '-run', '^(TestPublishSiteRetriesAfterMetadataUploadFailureBeforeStaleDeletion|TestPublishSiteRetriesPartialStaleDeletionToConvergence|TestUnregisterSiteRetriesForcedCleanupWhenRegistrationIsAlreadyAbsent)$',
    ])

    // Keep these as immutable revision objects rather than catalogs: the flow
    // verifies unregister's whole-prefix cleanup without making the preceding
    // site-publish reconciliation consume synthetic preview catalog state.
    await writeFile(storageRoot, '_previews/sre/revisions/0123456789abcdef0123456789abcdef01234567/files/reports/review.html', '<h1>SRE preview fixture</h1>\n')
    await writeFile(storageRoot, '_previews/neighbor/revisions/abcdef0123456789abcdef0123456789abcdef01/files/reports/neighbor.html', '<h1>Neighbor preview fixture</h1>\n')
    const neighborPreviewBefore = await treeSnapshot(path.join(storageRoot, '_previews', 'neighbor'))
    assert(neighborPreviewBefore.length > 0, 'neighbor preview fixture was not created')

    await writeFile(adminRoot, 'sites.yaml', [
      'schemaVersion: 1',
      'sites:',
      '  neighbor:',
      '    name: Neighbor site',
      '    repository: example/registered-satellite',
      '    sourcePath: sites/neighbor/content',
      '',
    ].join('\n'))
    commit(adminRoot, 'unregister SRE from desired registry')
    const storageBeforeUnregisterDryRun = await treeSnapshot(storageRoot)
    const unregisterDryRun = parseResult(run(binaryPath, [
      'registry', 'unregister', '--site', 'sre', '--manifest', 'sites.yaml', '--config', '.artifact-pages.yaml', '--dry-run', '--format', 'json',
    ], { cwd: adminRoot }), 'registry unregister dry-run')
    assert(unregisterDryRun.outcome === 'planned', `unregister dry-run returned ${unregisterDryRun.outcome}`)
    assert(JSON.stringify(await treeSnapshot(storageRoot)) === JSON.stringify(storageBeforeUnregisterDryRun), 'registry unregister dry-run changed the local object tree')
    run(binaryPath, [
      'registry', 'unregister', '--site', 'sre', '--manifest', 'sites.yaml', '--config', '.artifact-pages.yaml', '--format', 'json',
    ], { cwd: adminRoot })

    const registry = JSON.parse(await fs.readFile(path.join(storageRoot, '_indexes/sites.json'), 'utf8'))
    assert(registry.sites.map((site) => site.id).join(',') === 'neighbor', 'unregister left SRE discoverable or removed the neighbor')
    assert(JSON.stringify(await treeSnapshot(path.join(storageRoot, '_artifacts/neighbor'))) === JSON.stringify(neighborBefore), 'unregister changed neighbor artifact objects')
    assert(JSON.stringify(await treeSnapshot(path.join(storageRoot, '_indexes/neighbor'))) === JSON.stringify(neighborIndexBefore), 'unregister changed neighbor index objects')
    assert(JSON.stringify(await treeSnapshot(path.join(storageRoot, '_previews/neighbor'))) === JSON.stringify(neighborPreviewBefore), 'unregister changed neighbor preview objects')
    assert((await treeSnapshot(path.join(storageRoot, '_artifacts/sre'))).length === 0, 'unregister left SRE artifact objects')
    assert((await treeSnapshot(path.join(storageRoot, '_indexes/sre'))).length === 0, 'unregister left SRE index objects')
    assert((await treeSnapshot(path.join(storageRoot, '_previews/sre'))).length === 0, 'unregister left SRE preview objects')

    success = true
    console.log('Registered local flow passed: separate admin/satellite repositories, dry-run, two-site publish, update/removal, browser routes/resources/reload, retry tests, and scoped artifact/index/preview unregister.')
  } finally {
    if (composeStarted) {
      try {
        run('docker', ['compose', '-p', e2eProject, 'down', '--remove-orphans'], {
          env: { ...process.env, COMPOSE_PROJECT_NAME: e2eProject, WEB_PORT: String(port) },
          stdio: 'inherit',
        })
      } catch (error) {
        success = false
        process.exitCode = 1
        console.error(`Docker Compose cleanup failed: ${error instanceof Error ? error.message : error}`)
      }
    }
    if (success) {
      await fs.rm(scratchRoot, { recursive: true, force: true })
    } else {
      console.error(`Registered-flow scratch state retained for inspection at ${scratchRoot}`)
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
