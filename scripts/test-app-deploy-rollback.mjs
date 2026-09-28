import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localRoot = path.join(projectRoot, '.local')

function run(command, args, { cwd = projectRoot, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
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

async function writeFile(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split('/'))
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, contents)
}

async function makeBundle(root, version, marker) {
  const payloadRoot = path.join(root, `payload-${version}`)
  const archiveName = `artifact-pages-web-v${version}.tar.gz`
  const archivePath = path.join(root, archiveName)
  const files = {
    'assets/app.js': `window.artifactPagesRelease = ${JSON.stringify(marker)};\n`,
    'index.html': `<!doctype html><html><body><main>${marker}</main><script src="/assets/app.js"></script></body></html>\n`,
  }

  for (const [relativePath, contents] of Object.entries(files)) {
    await writeFile(payloadRoot, relativePath, contents)
  }

  run('tar', ['-czf', archivePath, '-C', payloadRoot, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  const archiveBytes = await fs.readFile(archivePath)
  const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex')
  const manifest = {
    schemaVersion: 1,
    product: 'artifact-pages',
    component: 'web',
    version,
    archive: archiveName,
    archiveSha256,
    sourceCommit: '0000000000000000000000000000000000000000',
    sourceDirty: false,
    files: Object.keys(files).sort(),
  }
  await fs.writeFile(`${archivePath}.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  await fs.writeFile(`${archivePath}.sha256`, `${archiveSha256}  ${archiveName}\n`)
  return { archivePath, files }
}

async function snapshotContentPlanes(storageRoot) {
  const snapshot = new Map()
  for (const prefix of ['_indexes', '_artifacts', '_previews']) {
    const prefixRoot = path.join(storageRoot, prefix)
    async function walk(directory, relativeDirectory = '') {
      let entries
      try {
        entries = await fs.readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
        const absolutePath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          await walk(absolutePath, relativePath)
        } else if (entry.isFile()) {
          snapshot.set(`${prefix}/${relativePath}`, await fs.readFile(absolutePath))
        } else {
          throw new Error(`Unexpected content-plane entry: ${absolutePath}`)
        }
      }
    }
    await walk(prefixRoot)
  }
  return snapshot
}

function assertContentPreserved(before, after, label) {
  if (before.size !== after.size) {
    throw new Error(`${label}: content-plane file count changed from ${before.size} to ${after.size}`)
  }
  for (const [relativePath, expected] of before) {
    const actual = after.get(relativePath)
    if (!actual || !actual.equals(expected)) {
      throw new Error(`${label}: content-plane object changed: ${relativePath}`)
    }
  }
}

function deploy(binaryPath, adminRoot, archivePath) {
  const result = spawnSync(binaryPath, ['app', 'deploy', '--archive', archivePath, '--format', 'json'], {
    cwd: adminRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  let json
  try {
    json = JSON.parse(result.stdout)
  } catch {
    throw new Error(`app deploy did not return JSON (exit ${result.status}): ${result.stdout}\n${result.stderr}`)
  }
  return { exitCode: result.status, result: json, stderr: result.stderr }
}

function assertDeployment(deployment, version, expectedOutcome, label) {
  const { exitCode, result, stderr } = deployment
  if (exitCode !== 0 || result.operation !== 'app deploy' || result.outcome !== expectedOutcome || result.version !== version) {
    throw new Error(`${label}: unexpected deployment result (exit=${exitCode}): ${JSON.stringify(result)}\n${stderr}`)
  }
}

async function assertAppVersion(storageRoot, bundle, marker, label) {
  const index = await fs.readFile(path.join(storageRoot, 'index.html'), 'utf8')
  const asset = await fs.readFile(path.join(storageRoot, 'assets', 'app.js'), 'utf8')
  if (index !== bundle.files['index.html'] || asset !== bundle.files['assets/app.js'] || !index.includes(marker) || !asset.includes(marker)) {
    throw new Error(`${label}: app-plane objects do not match bundle marker ${marker}`)
  }
}

async function main() {
  await fs.mkdir(localRoot, { recursive: true })
  const scratchRoot = await fs.mkdtemp(path.join(localRoot, 'app-deploy-rollback-'))
  try {
    const adminRoot = path.join(scratchRoot, 'clean-admin-checkout')
    const storageRoot = path.join(scratchRoot, 'origin')
    const binaryPath = path.join(scratchRoot, 'artifact-pages')
    const bundlesRoot = path.join(scratchRoot, 'pinned-assets')
    await fs.mkdir(adminRoot, { recursive: true })
    await fs.mkdir(bundlesRoot, { recursive: true })
    await fs.mkdir(storageRoot, { recursive: true })

    run('go', ['build', '-o', binaryPath, './cmd/artifact-pages'])

    await writeFile(adminRoot, '.artifact-pages.yaml', [
      'schemaVersion: 1',
      'provider: local',
      'local:',
      `  root: ${JSON.stringify(storageRoot)}`,
      '',
    ].join('\n'))
    run('git', ['init', '--initial-branch=main'], { cwd: adminRoot })
    run('git', ['config', 'user.name', 'Artifact Pages Acceptance Test'], { cwd: adminRoot })
    run('git', ['config', 'user.email', 'artifact-pages-test@example.invalid'], { cwd: adminRoot })
    run('git', ['add', '.artifact-pages.yaml'], { cwd: adminRoot })
    run('git', ['commit', '-m', 'Add local deployment target'], { cwd: adminRoot })
    if (run('git', ['status', '--porcelain'], { cwd: adminRoot }) !== '') {
      throw new Error('temporary admin checkout is not clean before deployment')
    }

    const contentSeed = {
      '_indexes/sites.json': '{"sites":[{"id":"sre"}]}\n',
      '_indexes/sre/index.json': '{"site":"sre","artifacts":["report.html"]}\n',
      '_artifacts/sre/report.html': '<!doctype html><h1>Preserve this report</h1>\n',
      '_previews/sre/catalog.json': '{"site":"sre","groups":["live-preview"]}\n',
      '_previews/sre/groups/live-preview/manifest.json': '{"headSha":"0123456789abcdef0123456789abcdef01234567"}\n',
    }
    for (const [relativePath, contents] of Object.entries(contentSeed)) {
      await writeFile(storageRoot, relativePath, contents)
    }
    const contentBefore = await snapshotContentPlanes(storageRoot)

    const releaseOne = await makeBundle(bundlesRoot, 'rollback-one', 'release-one')
    const releaseTwo = await makeBundle(bundlesRoot, 'upgrade-two', 'release-two')
    const pinnedAssets = [releaseOne.archivePath, releaseOne.archivePath + '.json', releaseOne.archivePath + '.sha256', releaseTwo.archivePath, releaseTwo.archivePath + '.json', releaseTwo.archivePath + '.sha256']

    const firstDeploy = deploy(binaryPath, adminRoot, releaseOne.archivePath)
    assertDeployment(firstDeploy, 'rollback-one', 'deployed', 'initial deploy')
    await assertAppVersion(storageRoot, releaseOne, 'release-one', 'initial deploy')
    assertContentPreserved(contentBefore, await snapshotContentPlanes(storageRoot), 'initial deploy')

    const upgrade = deploy(binaryPath, adminRoot, releaseTwo.archivePath)
    assertDeployment(upgrade, 'upgrade-two', 'deployed', 'upgrade')
    await assertAppVersion(storageRoot, releaseTwo, 'release-two', 'upgrade')
    assertContentPreserved(contentBefore, await snapshotContentPlanes(storageRoot), 'upgrade')

    const rollback = deploy(binaryPath, adminRoot, releaseOne.archivePath)
    assertDeployment(rollback, 'rollback-one', 'deployed', 'intentional rollback')
    await assertAppVersion(storageRoot, releaseOne, 'release-one', 'intentional rollback')
    assertContentPreserved(contentBefore, await snapshotContentPlanes(storageRoot), 'intentional rollback')

    if (run('git', ['status', '--porcelain'], { cwd: adminRoot }) !== '') {
      throw new Error('app deploy modified the clean admin checkout')
    }
    for (const assetPath of pinnedAssets) {
      await fs.access(assetPath)
    }
    console.log('App deploy rollback smoke passed: clean temporary admin checkout resolved its committed local config, deployed pinned local bundles v1 → v2 → v1, and preserved indexes, artifacts, and preview objects byte-for-byte.')
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
