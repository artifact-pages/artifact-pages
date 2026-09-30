import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localRoot = path.join(projectRoot, '.local')

function run(command, args, { cwd = projectRoot, env = process.env } = {}) {
  const childEnv = { ...env }
  // A workstation-level default must never leak into this clean-room run.
  delete childEnv.ARTIFACT_PAGES_CONFIG
  const result = spawnSync(command, args, {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'no exit status'}).${detail ? `\n${detail}` : ''}`)
  }
  return result.stdout.trim()
}

function invoke(command, args, { cwd, env = process.env } = {}) {
  const childEnv = { ...env }
  delete childEnv.ARTIFACT_PAGES_CONFIG
  const result = spawnSync(command, args, {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function writeFile(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split('/'))
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, contents)
}

function git(cwd, args) {
  return run('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_DATE: '2026-09-27T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-09-27T00:00:00Z',
    },
  }).trim()
}

async function initializeRepository(root, repositoryURL) {
  await fs.mkdir(root, { recursive: true })
  git(root, ['init', '--initial-branch=main'])
  git(root, ['remote', 'add', 'origin', repositoryURL])
  git(root, ['config', 'user.name', 'Artifact Pages Clean-room'])
  git(root, ['config', 'user.email', 'artifact-pages-clean-room@example.invalid'])
}

function commit(root, message) {
  git(root, ['add', '--all'])
  git(root, ['commit', '--message', message])
}

function parseJSON(result, label) {
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${label} did not return JSON (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function localDeploymentConfig(storageRoot, includeSRE = true) {
  const sites = [
    {
      id: 'neighbor',
      name: 'Neighbor documentation',
      repository: 'acme/sre-docs',
      sourcePath: 'sites/neighbor/content',
    },
  ]
  if (includeSRE) {
    sites.push({
      id: 'sre',
      name: 'SRE operations',
      repository: 'acme/sre-docs',
      sourcePath: 'sites/sre/content',
    })
  }
  const lines = [
    'schemaVersion: 1',
    'provider: local',
    'local:',
    `  root: ${JSON.stringify(storageRoot)}`,
    'sites:',
  ]
  for (const site of sites) {
    lines.push(
      `  ${site.id}:`,
      `    name: ${site.name}`,
      `    repository: ${site.repository}`,
      `    sourcePath: ${site.sourcePath}`,
    )
  }
  return `${lines.join('\n')}\n`
}

async function snapshotTree(directory) {
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
        const bytes = await fs.readFile(absolute)
        snapshot.set(nextRelative, createHash('sha256').update(bytes).digest('hex'))
      } else {
        throw new Error(`Unexpected object-target entry: ${absolute}`)
      }
    }
  }
  await walk(directory)
  return [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))
}

async function snapshotPrefixes(root, prefixes) {
  const snapshot = new Map()
  for (const prefix of prefixes) {
    for (const [relativePath, digest] of await snapshotTree(path.join(root, prefix))) {
      snapshot.set(`${prefix}/${relativePath}`, digest)
    }
  }
  return [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))
}

function assertSnapshotEqual(expected, actual, label) {
  assert(JSON.stringify(expected) === JSON.stringify(actual), `${label}: object bytes changed unexpectedly`)
}

async function makeBundle(root, version, marker) {
  const payloadRoot = path.join(root, `payload-${version}`)
  const archiveName = `artifact-pages-web-v${version}.tar.gz`
  const archivePath = path.join(root, archiveName)
  const files = {
    'assets/app.js': `window.cleanRoomRelease = ${JSON.stringify(marker)};\n`,
    'index.html': `<!doctype html><html><body><main>${marker}</main><script src="/assets/app.js"></script></body></html>\n`,
  }

  for (const [relativePath, contents] of Object.entries(files)) {
    await writeFile(payloadRoot, relativePath, contents)
  }
  run('tar', ['-czf', archivePath, '-C', payloadRoot, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })

  const bytes = await fs.readFile(archivePath)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const manifest = {
    schemaVersion: 1,
    product: 'artifact-pages',
    component: 'web',
    version,
    archive: archiveName,
    archiveSha256: checksum,
    sourceCommit: '0000000000000000000000000000000000000000',
    sourceDirty: true,
    files: Object.keys(files).sort(),
  }
  await fs.writeFile(`${archivePath}.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  await fs.writeFile(`${archivePath}.sha256`, `${checksum}  ${archiveName}\n`)
  return { archivePath, files }
}

function cli(binary, args, cwd) {
  const result = invoke(binary, [...args, '--format', 'json'], { cwd })
  const json = parseJSON(result, args.slice(0, 2).join(' '))
  return { ...result, json }
}

function assertCLI(result, operation, outcome, label) {
  assert(result.exitCode === 0, `${label}: command exited ${result.exitCode}: ${result.stderr}`)
  assert(result.json.operation === operation, `${label}: operation was ${result.json.operation}`)
  assert(result.json.outcome === outcome, `${label}: outcome was ${result.json.outcome}`)
}

async function assertAppVersion(storageRoot, bundle, marker, label) {
  const index = await fs.readFile(path.join(storageRoot, 'index.html'), 'utf8')
  const asset = await fs.readFile(path.join(storageRoot, 'assets', 'app.js'), 'utf8')
  assert(index === bundle.files['index.html'] && index.includes(marker), `${label}: index.html is not the selected app version`)
  assert(asset === bundle.files['assets/app.js'] && asset.includes(marker), `${label}: app asset is not the selected app version`)
}

async function assertPrefixEmpty(storageRoot, prefix, label) {
  assert((await snapshotTree(path.join(storageRoot, prefix))).length === 0, `${label}: ${prefix} was not removed`)
}

async function exerciseLockRecovery(binary, satelliteRoot, satelliteConfig, storageRoot, scratchRoot) {
  const lockPath = path.join(storageRoot, '_control/locks/sites/sre.json')
  const heldRecord = (owner, acquiredAt) => `${JSON.stringify({
    schemaVersion: 1,
    site: 'sre',
    state: 'held',
    owner,
    acquiredAt,
  })}\n`

  // Model a process that exited without releasing its retained lock.
  await writeFile(storageRoot, '_control/locks/sites/sre.json', heldRecord('simulated-interrupted-run', '2026-09-27T00:00:00Z'))
  const inspectArgs = ['lock', 'inspect', '--site', 'sre', '--config', satelliteConfig, '--format', 'json']
  const firstInspection = cli(binary, inspectArgs.slice(0, -2), satelliteRoot)
  assertCLI(firstInspection, 'lock inspect', 'inspected', 'inspect simulated stale lock')
  assert(firstInspection.json.lock?.state === 'held', 'lock inspect did not report the retained lock as held')
  const staleETag = firstInspection.json.lock.etag
  assert(typeof staleETag === 'string' && staleETag.length > 0, 'lock inspect did not return an ETag')

  // A changed lock record must reject an ETag captured by an earlier inspect.
  await writeFile(storageRoot, '_control/locks/sites/sre.json', heldRecord('replacement-interrupted-run', '2026-09-27T00:01:00Z'))
  const staleRecovery = invoke(binary, [
    'lock', 'recover', '--site', 'sre', '--config', satelliteConfig,
    '--observed-etag', staleETag, '--format', 'json',
  ], { cwd: satelliteRoot })
  assert(staleRecovery.exitCode !== 0, 'lock recovery accepted an ETag from a changed lock record')
  const stillHeld = cli(binary, ['lock', 'inspect', '--site', 'sre', '--config', satelliteConfig], satelliteRoot)
  assertCLI(stillHeld, 'lock inspect', 'inspected', 'reinspect replacement lock')
  assert(stillHeld.json.lock?.state === 'held' && stillHeld.json.lock.owner === 'replacement-interrupted-run', 'stale recovery changed the replacement lock')

  const guardedRecovery = cli(binary, [
    'lock', 'recover', '--site', 'sre', '--config', satelliteConfig,
    '--observed-etag', stillHeld.json.lock.etag,
  ], satelliteRoot)
  assertCLI(guardedRecovery, 'lock recover', 'recovered', 'recover confirmed stale lock')
  assert(guardedRecovery.json.lock?.state === 'free', 'successful lock recovery did not report a free lock')
  const recovered = cli(binary, ['lock', 'inspect', '--site', 'sre', '--config', satelliteConfig], satelliteRoot)
  assertCLI(recovered, 'lock inspect', 'inspected', 'verify recovered lock')
  assert(recovered.json.lock?.state === 'free', 'lock remains held after guarded recovery')
  await fs.writeFile(path.join(scratchRoot, 'lock-recovery-evidence.json'), JSON.stringify({
    staleETagRejected: true,
    recoveredETag: recovered.json.lock.etag,
    state: recovered.json.lock.state,
  }, null, 2))
}

async function main() {
  await fs.mkdir(localRoot, { recursive: true })
  const scratchRoot = await fs.mkdtemp(path.join(localRoot, 'clean-room-adoption-'))
  const adminRoot = path.join(scratchRoot, 'platform-admin')
  const satelliteRoot = path.join(scratchRoot, 'sre-docs')
  const storageRoot = path.join(scratchRoot, 'local-object-target')
  const releaseRoot = path.join(scratchRoot, 'local-app-fixtures')
  const binaryPath = path.join(scratchRoot, 'artifact-pages')
  const configPath = path.join(adminRoot, 'artifact-pages.yaml')
  const satelliteConfig = path.relative(satelliteRoot, configPath)
  let success = false

  try {
    await Promise.all([
      initializeRepository(adminRoot, 'https://github.com/acme/platform-admin.git'),
      initializeRepository(satelliteRoot, 'https://github.com/acme/sre-docs.git'),
      fs.mkdir(releaseRoot, { recursive: true }),
    ])

    await writeFile(adminRoot, 'artifact-pages.yaml', localDeploymentConfig(storageRoot))
    await writeFile(satelliteRoot, 'sites/sre/content/reports/recovery.html', [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8"><title>Recovery review revision one</title>',
      '<link rel="stylesheet" href="../assets/site.css"></head>',
      '<body><main><h1>Recovery review revision one</h1><img src="../assets/recovery.svg" alt="Recovery path"></main></body></html>',
      '',
    ].join('\n'))
    await writeFile(satelliteRoot, 'sites/sre/content/runbooks/recovery.md', '# Recovery runbook\n\nA local clean-room publication.\n')
    await writeFile(satelliteRoot, 'sites/sre/content/stale.html', '<!doctype html><title>Remove me on update</title>\n')
    await writeFile(satelliteRoot, 'sites/sre/content/assets/site.css', 'body { color: #153d35; }\n')
    await writeFile(satelliteRoot, 'sites/sre/content/assets/recovery.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#176b62"/></svg>\n')
    await writeFile(satelliteRoot, 'sites/neighbor/content/index.html', '<!doctype html><title>Neighbor remains</title><h1>Neighbor remains</h1>\n')
    await writeFile(satelliteRoot, 'sites/neighbor/content/neighbor.css', 'h1 { color: teal; }\n')
    commit(adminRoot, 'Add unified admin target and site config')
    commit(satelliteRoot, 'Add independent registered site sources')

    assert(!(await fs.stat(path.join(satelliteRoot, 'sites.yaml')).then(() => true, () => false)), 'satellite unexpectedly contains a separate sites.yaml file')
    assert(!(await fs.stat(path.join(satelliteRoot, 'artifact-pages.yaml')).then(() => true, () => false)), 'the satellite unexpectedly owns a deployment config; this walkthrough selects the admin config explicitly')
    assert(git(adminRoot, ['status', '--porcelain']) === '', 'temporary admin repository was not clean after its initial commit')
    assert(git(satelliteRoot, ['status', '--porcelain']) === '', 'temporary satellite repository was not clean after its initial commit')

    run('go', ['build', '-trimpath', '-o', binaryPath, './cli/cmd/artifact-pages'])

    const registryPlan = cli(binaryPath, [
      'registry', 'register', '--config', 'artifact-pages.yaml', '--dry-run',
    ], adminRoot)
    assertCLI(registryPlan, 'registry register', 'planned', 'plan admin registry register with explicit config')
    assert(!(await fs.stat(storageRoot).then(() => true, () => false)), 'registry dry-run created the local object target')

    // The apply omits --config on purpose: the committed admin checkout config is discovered.
    const registryApply = cli(binaryPath, ['registry', 'register'], adminRoot)
    assertCLI(registryApply, 'registry register', 'registered', 'register sites from admin checkout config')
    assert((await fs.readFile(path.join(storageRoot, '_indexes/sites.json'), 'utf8')).includes('acme/sre-docs'), 'registry projection does not contain the satellite repository identity')

    const beforeSitePlan = await snapshotTree(storageRoot)
    const satellitePlan = cli(binaryPath, [
      'site', 'publish', '--site', 'sre', '--source', 'sites/sre/content', '--config', satelliteConfig, '--dry-run',
    ], satelliteRoot)
    assertCLI(satellitePlan, 'site publish', 'planned', 'plan explicit satellite site with shared admin config')
    assert((await snapshotTree(storageRoot)).length > 0, 'registry apply did not create any objects')
    assertSnapshotEqual(beforeSitePlan, await snapshotTree(storageRoot), 'site publish dry-run')

    const neighborPublish = cli(binaryPath, [
      'site', 'publish', '--site', 'neighbor', '--source', 'sites/neighbor/content', '--config', satelliteConfig,
    ], satelliteRoot)
    assertCLI(neighborPublish, 'site publish', 'published', 'publish neighbor site explicitly')
    const initialSitePublish = cli(binaryPath, [
      'site', 'publish', '--site', 'sre', '--source', 'sites/sre/content', '--config', satelliteConfig,
    ], satelliteRoot)
    assertCLI(initialSitePublish, 'site publish', 'published', 'publish SRE site explicitly')

    const neighborArtifactsBefore = await snapshotTree(path.join(storageRoot, '_artifacts/neighbor'))
    const neighborIndexBefore = await snapshotTree(path.join(storageRoot, '_indexes/neighbor'))
    assert(neighborArtifactsBefore.length > 0 && neighborIndexBefore.length > 0, 'neighbor publication did not create artifact and index objects')

    await exerciseLockRecovery(binaryPath, satelliteRoot, satelliteConfig, storageRoot, scratchRoot)
    const recoveredPublish = cli(binaryPath, [
      'site', 'publish', '--site', 'sre', '--source', 'sites/sre/content', '--config', satelliteConfig,
    ], satelliteRoot)
    assertCLI(recoveredPublish, 'site publish', 'no-op', 'publish after stale-lock recovery')

    // Build two local fixture releases with unique bytes. app deploy verifies each archive,
    // manifest, and checksum; the fixtures do not represent public release assets.
    const releaseOne = await makeBundle(releaseRoot, 'clean-room-one', 'release-one')
    const releaseTwo = await makeBundle(releaseRoot, 'clean-room-two', 'release-two')
    const beforeAppPlan = await snapshotTree(storageRoot)
    const appPlan = cli(binaryPath, [
      'app', 'deploy', '--archive', releaseOne.archivePath, '--config', 'artifact-pages.yaml', '--dry-run',
    ], adminRoot)
    assertCLI(appPlan, 'app deploy', 'planned', 'plan initial application deployment')
    assertSnapshotEqual(beforeAppPlan, await snapshotTree(storageRoot), 'app deploy dry-run')

    const corruptedRoot = path.join(scratchRoot, 'corrupted-release')
    await fs.mkdir(corruptedRoot, { recursive: true })
    const corruptedArchive = path.join(corruptedRoot, path.basename(releaseOne.archivePath))
    await fs.copyFile(releaseOne.archivePath, corruptedArchive)
    await fs.copyFile(`${releaseOne.archivePath}.json`, `${corruptedArchive}.json`)
    await fs.copyFile(`${releaseOne.archivePath}.sha256`, `${corruptedArchive}.sha256`)
    await fs.appendFile(corruptedArchive, Buffer.from('tampered'))
    const beforeCorruptDeploy = await snapshotTree(storageRoot)
    const corruptResult = invoke(binaryPath, [
      'app', 'deploy', '--archive', corruptedArchive, '--config', 'artifact-pages.yaml', '--format', 'json',
    ], { cwd: adminRoot })
    assert(corruptResult.exitCode !== 0, 'app deploy accepted an archive whose checksum no longer matched')
    assertSnapshotEqual(beforeCorruptDeploy, await snapshotTree(storageRoot), 'rejected corrupted app bundle')

    const contentBeforeAppDeploy = await snapshotPrefixes(storageRoot, ['_indexes', '_artifacts', '_previews'])
    for (const [bundle, marker, label] of [
      [releaseOne, 'release-one', 'initial application deploy'],
      [releaseTwo, 'release-two', 'application upgrade'],
      [releaseOne, 'release-one', 'application rollback'],
    ]) {
      const deployment = cli(binaryPath, [
        'app', 'deploy', '--archive', bundle.archivePath, '--config', 'artifact-pages.yaml',
      ], adminRoot)
      assertCLI(deployment, 'app deploy', 'deployed', label)
      assert(deployment.json.version === JSON.parse(await fs.readFile(`${bundle.archivePath}.json`, 'utf8')).version, `${label}: selected version was not reported`)
      await assertAppVersion(storageRoot, bundle, marker, label)
      assertSnapshotEqual(contentBeforeAppDeploy, await snapshotPrefixes(storageRoot, ['_indexes', '_artifacts', '_previews']), label)
    }
    assert(git(adminRoot, ['status', '--porcelain']) === '', 'registry or app deployment modified the committed admin checkout')
    assert(git(satelliteRoot, ['status', '--porcelain']) === '', 'site publication modified the satellite checkout')

    await writeFile(satelliteRoot, 'sites/sre/content/reports/recovery.html', [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8"><title>Recovery review revision two</title>',
      '<link rel="stylesheet" href="../assets/site.css"></head>',
      '<body><main><h1>Recovery review revision two</h1><img src="../assets/recovery.svg" alt="Recovery path"></main></body></html>',
      '',
    ].join('\n'))
    await fs.rm(path.join(satelliteRoot, 'sites/sre/content/stale.html'))
    await writeFile(satelliteRoot, 'sites/sre/content/reports/updated.md', '# Updated runbook\n\nRevision two is published.\n')
    commit(satelliteRoot, 'Update registered SRE site and remove stale artifact')
    const targetBeforeUpdatePlan = await snapshotTree(storageRoot)
    const updatePlan = cli(binaryPath, [
      'site', 'publish', '--site', 'sre', '--source', 'sites/sre/content', '--config', satelliteConfig, '--dry-run',
    ], satelliteRoot)
    assertCLI(updatePlan, 'site publish', 'planned', 'plan site update')
    assertSnapshotEqual(targetBeforeUpdatePlan, await snapshotTree(storageRoot), 'site update dry-run')
    const updateApply = cli(binaryPath, [
      'site', 'publish', '--site', 'sre', '--source', 'sites/sre/content', '--config', satelliteConfig,
    ], satelliteRoot)
    assertCLI(updateApply, 'site publish', 'published', 'apply site update')
    assert((await fs.readFile(path.join(storageRoot, '_artifacts/sre/reports/recovery.html'), 'utf8')).includes('revision two'), 'updated site HTML was not published')
    assert(!(await fs.stat(path.join(storageRoot, '_artifacts/sre/stale.html')).then(() => true, () => false)), 'site update did not remove a stale artifact')
    assertSnapshotEqual(neighborArtifactsBefore, await snapshotTree(path.join(storageRoot, '_artifacts/neighbor')), 'updating SRE changed the neighbor artifacts')
    assertSnapshotEqual(neighborIndexBefore, await snapshotTree(path.join(storageRoot, '_indexes/neighbor')), 'updating SRE changed the neighbor index')

    // The unified admin config removes the site first; unregister then withdraws
    // discovery and cleans only that site's object prefixes.
    await writeFile(storageRoot, '_previews/sre/revisions/0123456789abcdef0123456789abcdef01234567/files/reports/review.html', '<h1>SRE preview to remove</h1>\n')
    await writeFile(storageRoot, '_previews/neighbor/revisions/abcdef0123456789abcdef0123456789abcdef01/files/reports/neighbor.html', '<h1>Neighbor preview to preserve</h1>\n')
    const neighborPreviewBefore = await snapshotTree(path.join(storageRoot, '_previews/neighbor'))

    await writeFile(adminRoot, 'artifact-pages.yaml', localDeploymentConfig(storageRoot, false))
    commit(adminRoot, 'Remove SRE from the desired registry')
    const beforeUnregisterPlan = await snapshotTree(storageRoot)
    const unregisterPlan = cli(binaryPath, [
      'registry', 'unregister', '--site', 'sre', '--config', 'artifact-pages.yaml', '--dry-run',
    ], adminRoot)
    assertCLI(unregisterPlan, 'registry unregister', 'planned', 'plan explicit SRE unregister')
    assertSnapshotEqual(beforeUnregisterPlan, await snapshotTree(storageRoot), 'unregister dry-run')
    const unregisterApply = cli(binaryPath, [
      'registry', 'unregister', '--site', 'sre', '--config', 'artifact-pages.yaml',
    ], adminRoot)
    assertCLI(unregisterApply, 'registry unregister', 'unregistered', 'unregister SRE explicitly')

    const registry = JSON.parse(await fs.readFile(path.join(storageRoot, '_indexes/sites.json'), 'utf8'))
    assert(registry.sites.map((site) => site.id).join(',') === 'neighbor', 'unregister did not retain only the neighbor registration')
    assertSnapshotEqual(neighborArtifactsBefore, await snapshotTree(path.join(storageRoot, '_artifacts/neighbor')), 'unregister changed neighbor artifacts')
    assertSnapshotEqual(neighborIndexBefore, await snapshotTree(path.join(storageRoot, '_indexes/neighbor')), 'unregister changed neighbor index')
    assertSnapshotEqual(neighborPreviewBefore, await snapshotTree(path.join(storageRoot, '_previews/neighbor')), 'unregister changed neighbor previews')
    for (const prefix of ['_artifacts/sre', '_indexes/sre', '_previews/sre']) {
      await assertPrefixEmpty(storageRoot, prefix, 'SRE unregister')
    }
    const lockAfterUnregister = cli(binaryPath, ['lock', 'inspect', '--site', 'sre', '--config', 'artifact-pages.yaml'], adminRoot)
    assertCLI(lockAfterUnregister, 'lock inspect', 'inspected', 'inspect retained lock after unregister')
    assert(lockAfterUnregister.json.lock?.state === 'free', 'unregister removed or left held the retained site lock')

    // The wrappers execute the same CLI contract from the adopter checkout. This
    // separate smoke has its own temporary repositories and remains credential-free.
    run(process.execPath, [path.join(projectRoot, 'scripts/test-actions-parity.mjs')])

    success = true
    console.log('Clean-room adoption passed: independent temporary admin and satellite Git repositories selected the admin local target, published and updated explicit sites, deployed/upgraded/rolled back checksum-verified app fixture bundles without changing site objects, rejected stale lock recovery ETags, recovered the confirmed lock, and unregistered SRE while preserving the neighbor. Action/CLI local parity also passed. No AWS credentials, public release, or provider behavior were exercised.')
  } finally {
    if (success) {
      await fs.rm(scratchRoot, { recursive: true, force: true })
    } else {
      console.error(`Clean-room adoption scratch state retained for inspection at ${scratchRoot}`)
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
