import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${file} ${args.join(' ')} failed with ${result.status}`)
  }
  return result.stdout.trim()
}

function startNode(scriptPath, args, projectRoot, environment = {}) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  return { child, getOutput: () => stdout, getError: () => stderr }
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }

  return new Promise((resolve, reject) => {
    const onExit = (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error(`Process ${child.pid} did not exit within ${timeoutMs} ms`))
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath)
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

async function createProject(projectRoot) {
  const scriptsRoot = path.join(projectRoot, 'scripts')
  await fs.mkdir(path.join(projectRoot, 'dist', 'assets'), { recursive: true })
  await fs.mkdir(scriptsRoot, { recursive: true })

  for (const script of [
    'package-web.mjs',
    'package-web-release.mjs',
    'web-release-lock.mjs',
    'web-release-version.mjs',
    'web-bundle-paths.mjs',
  ]) {
    await fs.copyFile(path.join(repositoryRoot, 'scripts', script), path.join(scriptsRoot, script))
  }

  await fs.writeFile(
    path.join(scriptsRoot, 'generate-third-party-notices.mjs'),
    `import { promises as fs } from 'node:fs'\nimport path from 'node:path'\nawait fs.writeFile(path.join(process.cwd(), 'dist', 'THIRD_PARTY_NOTICES.txt'), 'Fixture notices\\n')\n`,
  )
  await fs.writeFile(
    path.join(scriptsRoot, 'test-npm-cli.mjs'),
    `import { promises as fs } from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
if (args.join(' ') !== 'run build') throw new Error('Unexpected npm invocation: ' + args.join(' '))
await fs.writeFile(process.env.GAP_PACKAGE_WEB_BUILD_MARKER, 'started')
if (process.env.GAP_PACKAGE_WEB_BUILD_RELEASE) {
  while (true) {
    try { await fs.access(process.env.GAP_PACKAGE_WEB_BUILD_RELEASE); break }
    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise((resolve) => setTimeout(resolve, 10)) }
  }
}
const dist = path.join(process.cwd(), 'dist')
await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>' + process.env.GAP_PACKAGE_WEB_PAYLOAD + '</title>')
await fs.writeFile(path.join(dist, 'preview-bridge.js'), 'console.log("preview")')
await fs.writeFile(path.join(dist, 'LICENSE'), 'Fixture license')
await fs.writeFile(path.join(dist, 'assets', 'app.js'), 'window.payload = ' + JSON.stringify(process.env.GAP_PACKAGE_WEB_PAYLOAD))
`,
  )
  await fs.writeFile(
    path.join(scriptsRoot, 'test-tar-shim.mjs'),
    `import { promises as fs } from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
const archivePath = args[args.indexOf('-czf') + 1]
const payloadRoot = args[args.indexOf('-C') + 1]
if (!archivePath || !payloadRoot) throw new Error('Unexpected tar arguments: ' + args.join(' '))
if (process.env.GAP_PACKAGE_WEB_TAR_MARKER) await fs.writeFile(process.env.GAP_PACKAGE_WEB_TAR_MARKER, 'started')
if (process.env.GAP_PACKAGE_WEB_TAR_RELEASE) {
  while (true) {
    try { await fs.access(process.env.GAP_PACKAGE_WEB_TAR_RELEASE); break }
    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise((resolve) => setTimeout(resolve, 10)) }
  }
}
async function collect(directory, relative = '') {
  const files = {}
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name)
    if (entry.isDirectory()) Object.assign(files, await collect(directory, child))
    else files[child] = await fs.readFile(path.join(directory, child), 'utf8')
  }
  return files
}
await fs.writeFile(archivePath, JSON.stringify({ files: await collect(payloadRoot) }))
`,
  )

  run('git', ['init', '--quiet'], { cwd: projectRoot })
  run(
    'git',
    [
      '-c',
      'user.name=Packaging Fixture',
      '-c',
      'user.email=packaging-fixture@example.test',
      'commit',
      '--allow-empty',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: projectRoot },
  )
}

test('competing public package:web operations cannot mix or replace one immutable release', { timeout: 30_000 }, async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-pages-web-release-'))
  const projectRoot = path.join(temporaryRoot, 'project')
  const children = []

  try {
    await createProject(projectRoot)
    const scriptsRoot = path.join(projectRoot, 'scripts')
    const buildRelease = path.join(temporaryRoot, 'release-build')
    const tarRelease = path.join(temporaryRoot, 'release-tar')
    const firstBuildMarker = path.join(temporaryRoot, 'first-build-started')
    const secondBuildMarker = path.join(temporaryRoot, 'second-build-started')
    const tarMarker = path.join(temporaryRoot, 'tar-started')
    const version = 'parallel-1'
    const commonEnvironment = {
      npm_execpath: path.join(scriptsRoot, 'test-npm-cli.mjs'),
      npm_node_execpath: process.execPath,
      ARTIFACT_PAGES_TEST_TAR_SHIM: path.join(scriptsRoot, 'test-tar-shim.mjs'),
    }
    const first = startNode(
      path.join(scriptsRoot, 'package-web.mjs'),
      ['--version', version],
      projectRoot,
      {
        ...commonEnvironment,
        GAP_PACKAGE_WEB_BUILD_MARKER: firstBuildMarker,
        GAP_PACKAGE_WEB_BUILD_RELEASE: buildRelease,
        GAP_PACKAGE_WEB_PAYLOAD: 'winner-payload',
        GAP_PACKAGE_WEB_TAR_MARKER: tarMarker,
        GAP_PACKAGE_WEB_TAR_RELEASE: tarRelease,
      },
    )
    children.push(first)
    try {
      await waitForFile(firstBuildMarker)
    } catch (error) {
      const state = await waitForExit(first.child, 1_000).catch(() => ({ code: null, signal: null }))
      throw new Error(`${error.message}; first operation exited ${JSON.stringify(state)}; stdout=${first.getOutput()}; stderr=${first.getError()}`)
    }

    const competitor = startNode(
      path.join(scriptsRoot, 'package-web.mjs'),
      ['--version', version],
      projectRoot,
      {
        ...commonEnvironment,
        GAP_PACKAGE_WEB_BUILD_MARKER: secondBuildMarker,
        GAP_PACKAGE_WEB_PAYLOAD: 'loser-payload',
      },
    )
    children.push(competitor)
    const competitorExit = await waitForExit(competitor.child, 2_000)
    assert.notEqual(competitorExit.code, 0, 'the competing operation must fail instead of building or publishing')
    assert.match(competitor.getError(), /artifact-pages-web-package\.lock already exists/)
    await assert.rejects(fs.access(secondBuildMarker), { code: 'ENOENT' })

    await fs.writeFile(buildRelease, 'continue')
    await waitForFile(tarMarker)
    await fs.writeFile(
      path.join(projectRoot, 'dist', 'index.html'),
      '<!doctype html><title>late-dist-mutation</title>',
    )
    await fs.writeFile(tarRelease, 'continue')
    const firstExit = await waitForExit(first.child, 10_000)
    assert.equal(firstExit.code, 0, `winning operation failed: ${first.getError()}`)

    const releaseRoot = path.join(projectRoot, '.local', 'releases')
    await assert.rejects(fs.access(path.join(releaseRoot, 'artifact-pages-web-package.lock')), {
      code: 'ENOENT',
    })
    const archiveName = `artifact-pages-web-v${version}.tar.gz`
    const archivePath = path.join(releaseRoot, archiveName)
    const manifestPath = `${archivePath}.json`
    const checksumPath = `${archivePath}.sha256`
    const publishedBeforeRetry = await Promise.all([
      fs.readFile(archivePath),
      fs.readFile(manifestPath),
      fs.readFile(checksumPath),
    ])
    const archiveDigest = createHash('sha256').update(publishedBeforeRetry[0]).digest('hex')
    const manifest = JSON.parse(publishedBeforeRetry[1].toString('utf8'))
    const archivedPayload = JSON.parse(publishedBeforeRetry[0].toString('utf8'))
    assert.equal(manifest.version, version)
    assert.equal(manifest.archive, archiveName)
    assert.equal(manifest.archiveSha256, archiveDigest)
    assert.ok(manifest.files.includes('THIRD_PARTY_NOTICES.txt'))
    assert.equal(publishedBeforeRetry[2].toString('utf8'), `${archiveDigest}  ${archiveName}\n`)
    assert.equal(
      archivedPayload.files['index.html'],
      '<!doctype html><title>winner-payload</title>',
      'the archive must use the build protected by the lock, not a later dist mutation',
    )

    const retryBuildMarker = path.join(temporaryRoot, 'retry-build-started')
    const retry = startNode(
      path.join(scriptsRoot, 'package-web.mjs'),
      ['--version', version],
      projectRoot,
      {
        ...commonEnvironment,
        GAP_PACKAGE_WEB_BUILD_MARKER: retryBuildMarker,
        GAP_PACKAGE_WEB_PAYLOAD: 'retry-payload',
      },
    )
    children.push(retry)
    const retryExit = await waitForExit(retry.child)
    assert.notEqual(retryExit.code, 0, 'an existing immutable version must not be republished')
    assert.match(retry.getError(), /Refusing to overwrite an existing release file/)
    await assert.rejects(fs.access(retryBuildMarker), { code: 'ENOENT' })
    const publishedAfterRetry = await Promise.all([
      fs.readFile(archivePath),
      fs.readFile(manifestPath),
      fs.readFile(checksumPath),
    ])
    assert.deepEqual(publishedAfterRetry, publishedBeforeRetry)

    const interruptedVersion = 'interrupted-1'
    const interruptedArchive = `artifact-pages-web-v${interruptedVersion}.tar.gz`
    const packageLock = path.join(releaseRoot, 'artifact-pages-web-package.lock')
    const interruptedPartialArchive = path.join(releaseRoot, interruptedArchive)
    await fs.writeFile(packageLock, 'pid=stopped\nversion=interrupted-1\ntoken=stale\n')
    await fs.writeFile(interruptedPartialArchive, 'partial archive')
    const interrupted = startNode(
      path.join(scriptsRoot, 'package-web-release.mjs'),
      ['--version', interruptedVersion],
      projectRoot,
      commonEnvironment,
    )
    children.push(interrupted)
    const interruptedExit = await waitForExit(interrupted.child)
    assert.notEqual(interruptedExit.code, 0)
    assert.match(interrupted.getError(), /artifact-pages-web-package\.lock already exists/)
    assert.equal(await fs.readFile(interruptedPartialArchive, 'utf8'), 'partial archive')
    assert.equal(await fs.readFile(packageLock, 'utf8'), 'pid=stopped\nversion=interrupted-1\ntoken=stale\n')
    await fs.rm(packageLock)

    const partialVersion = 'partial-1'
    const partialArchive = path.join(releaseRoot, `artifact-pages-web-v${partialVersion}.tar.gz`)
    await fs.writeFile(partialArchive, 'partial archive without lock')
    const partial = startNode(
      path.join(scriptsRoot, 'package-web-release.mjs'),
      ['--version', partialVersion],
      projectRoot,
      commonEnvironment,
    )
    children.push(partial)
    const partialExit = await waitForExit(partial.child)
    assert.notEqual(partialExit.code, 0)
    assert.match(partial.getError(), /Refusing to overwrite an existing release file/)
    assert.equal(await fs.readFile(partialArchive, 'utf8'), 'partial archive without lock')

    const danglingVersion = 'dangling-1'
    const danglingArchive = `artifact-pages-web-v${danglingVersion}.tar.gz`
    const danglingManifest = path.join(releaseRoot, `${danglingArchive}.json`)
    let danglingLinkCreated = false
    try {
      await fs.symlink('missing-manifest-target', danglingManifest)
      danglingLinkCreated = true
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        throw error
      }
    }

    if (danglingLinkCreated) {
      const dangling = startNode(
        path.join(scriptsRoot, 'package-web-release.mjs'),
        ['--version', danglingVersion],
        projectRoot,
        commonEnvironment,
      )
      children.push(dangling)
      const danglingExit = await waitForExit(dangling.child)
      assert.notEqual(danglingExit.code, 0)
      assert.match(dangling.getError(), /Refusing to overwrite an existing release file/)
      assert.equal((await fs.lstat(danglingManifest)).isSymbolicLink(), true)
      assert.equal(await fs.readlink(danglingManifest), 'missing-manifest-target')
    }
  } finally {
    await fs.writeFile(path.join(temporaryRoot, 'release-build'), 'continue').catch(() => {})
    await fs.writeFile(path.join(temporaryRoot, 'release-tar'), 'continue').catch(() => {})
    for (const process of children) {
      if (process.child.exitCode !== null || process.child.signalCode !== null) continue
      try {
        await waitForExit(process.child, 5_000)
      } catch {
        process.child.kill('SIGKILL')
        await waitForExit(process.child, 2_000).catch(() => {})
      }
    }
    await fs.rm(temporaryRoot, { recursive: true, force: true })
  }
})
