import { createHash } from 'node:crypto'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

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

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local HTTP port.')
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000
  let lastResult = 'not reachable'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      lastResult = `HTTP ${response.status}`
      if (response.ok) return
    } catch (error) {
      lastResult = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Local nginx did not become available at ${url} (${lastResult}).`)
}

async function waitForOriginContent(url, expected, label) {
  const deadline = Date.now() + 15_000
  let last = 'not reachable'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      const body = await response.text()
      last = `HTTP ${response.status}, Cache-Control=${JSON.stringify(response.headers.get('cache-control'))}, body=${JSON.stringify(body)}`
      if (response.ok && body.includes(expected)) return
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${label}: nginx did not serve the expected updated content at ${url} (${last}).`)
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
    'assets/app-AbC123xY.js': 'window.artifactPagesHashedProbe = true;\n',
    'index.html': `<!doctype html><html><body><main>${marker}</main><script src="/assets/app.js"></script><script src="/assets/app-AbC123xY.js"></script></body></html>\n`,
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
  const hashedAsset = await fs.readFile(path.join(storageRoot, 'assets', 'app-AbC123xY.js'), 'utf8')
  if (index !== bundle.files['index.html'] || asset !== bundle.files['assets/app.js'] || hashedAsset !== bundle.files['assets/app-AbC123xY.js'] || !index.includes(marker) || !asset.includes(marker)) {
    throw new Error(`${label}: app-plane objects do not match bundle marker ${marker}`)
  }
}

async function assertBrowserVersion(page, marker, label, pageErrors) {
  try {
    await page.waitForFunction((expected) => window.artifactPagesRelease === expected, marker, { timeout: 5_000 })
  } catch {
    const observed = await page.evaluate(() => ({
      marker: window.artifactPagesRelease,
      shell: document.querySelector('main')?.textContent,
      scripts: [...document.scripts].map((script) => script.src),
    })).catch(() => null)
    throw new Error(`${label}: expected browser marker ${marker}; observed=${JSON.stringify(observed)}; pageErrors=${JSON.stringify(pageErrors)}`)
  }
  const executed = await page.evaluate(() => ({
    marker: window.artifactPagesRelease,
    hashedProbe: window.artifactPagesHashedProbe,
    shell: document.querySelector('main')?.textContent,
  }))
  if (executed.marker !== marker || executed.hashedProbe !== true || executed.shell !== marker) {
    throw new Error(`${label}: browser executed ${JSON.stringify(executed)}, want marker ${marker}`)
  }
}

async function main() {
  await fs.mkdir(localRoot, { recursive: true })
  const scratchRoot = await fs.mkdtemp(path.join(localRoot, 'app-deploy-rollback-'))
  const projectName = `artifact-pages-app-cache-${process.pid}`
  let composeStarted = false
  let browser
  try {
    const adminRoot = path.join(scratchRoot, 'clean-admin-checkout')
    const storageRoot = path.join(scratchRoot, 'origin')
    const binaryPath = path.join(scratchRoot, 'artifact-pages')
    const bundlesRoot = path.join(scratchRoot, 'pinned-assets')
    await fs.mkdir(adminRoot, { recursive: true })
    await fs.mkdir(bundlesRoot, { recursive: true })
    await fs.mkdir(storageRoot, { recursive: true })

    run('go', ['build', '-o', binaryPath, './cli/cmd/artifact-pages'])

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

    const releaseOne = await makeBundle(bundlesRoot, 'rollback-one', 'release-one-v1')
    const releaseTwo = await makeBundle(bundlesRoot, 'upgrade-two', 'release-two-upgrade-with-longer-payload')
    const pinnedAssets = [releaseOne.archivePath, releaseOne.archivePath + '.json', releaseOne.archivePath + '.sha256', releaseTwo.archivePath, releaseTwo.archivePath + '.json', releaseTwo.archivePath + '.sha256']

    const firstDeploy = deploy(binaryPath, adminRoot, releaseOne.archivePath)
    assertDeployment(firstDeploy, 'rollback-one', 'deployed', 'initial deploy')
    await assertAppVersion(storageRoot, releaseOne, 'release-one-v1', 'initial deploy')

    const port = await freePort()
    const baseURL = `http://127.0.0.1:${port}`
    const composeEnv = {
      ...process.env,
      COMPOSE_PROJECT_NAME: projectName,
      WEB_PORT: String(port),
      WEB_ROOT: storageRoot,
      STORAGE_ROOT: path.join(projectRoot, 'fixtures/storage'),
      PREVIEW_ROOT: path.join(projectRoot, 'fixtures/storage/_previews'),
    }
    composeStarted = true
    run('docker', ['compose', '-p', projectName, 'up', '--detach', 'web'], { env: composeEnv })
    await waitForServer(baseURL)

    browser = await chromium.launch({ headless: true })
    const browserContext = await browser.newContext()
    const page = await browserContext.newPage()
    const assetURL = `${baseURL}/assets/app.js`
    const hashedAssetURL = `${baseURL}/assets/app-AbC123xY.js`
    const shellResponses = []
    const fixedAssetResponses = []
    const hashedAssetResponses = []
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('response', (response) => {
      if (response.url() === baseURL || response.url() === `${baseURL}/` || response.url() === `${baseURL}/index.html`) {
        shellResponses.push(response.allHeaders().then((headers) => ({ url: response.url(), status: response.status(), headers })))
      } else if (response.url() === assetURL) {
        fixedAssetResponses.push(Promise.all([response.allHeaders(), response.text().catch(() => '<body unavailable>')]).then(([headers, body]) => ({ status: response.status(), headers, body })))
      } else if (response.url() === hashedAssetURL) {
        hashedAssetResponses.push(response.allHeaders().then((headers) => ({ status: response.status(), headers })))
      }
    })

    const initialNavigation = await page.goto(baseURL)
    if (!initialNavigation?.ok()) throw new Error(`Initial browser navigation returned HTTP ${initialNavigation?.status() ?? 'no response'}.`)
    const initialShellHeaders = await initialNavigation.allHeaders()
    if (initialShellHeaders['cache-control'] !== 'no-cache, max-age=0, must-revalidate') {
      throw new Error(`Initial browser document Cache-Control = ${JSON.stringify(initialShellHeaders['cache-control'])}, want revalidation.`)
    }
    await assertBrowserVersion(page, 'release-one-v1', 'initial browser load', pageErrors)
    assertContentPreserved(contentBefore, await snapshotContentPlanes(storageRoot), 'initial deploy')

    const upgrade = deploy(binaryPath, adminRoot, releaseTwo.archivePath)
    assertDeployment(upgrade, 'upgrade-two', 'deployed', 'upgrade')
    await assertAppVersion(storageRoot, releaseTwo, 'release-two-upgrade-with-longer-payload', 'upgrade')
    await waitForOriginContent(baseURL, 'release-two-upgrade-with-longer-payload', 'upgrade shell')
    await waitForOriginContent(assetURL, 'release-two-upgrade-with-longer-payload', 'upgrade fixed-name asset')
    const upgradeNavigation = await page.reload()
    try {
      await assertBrowserVersion(page, 'release-two-upgrade-with-longer-payload', 'browser upgrade', pageErrors)
    } catch (error) {
      const navigationHeaders = await upgradeNavigation?.allHeaders().catch(() => ({}))
      throw new Error(`${error.message}; navigation=${JSON.stringify({ status: upgradeNavigation?.status(), headers: navigationHeaders })}; shellResponses=${JSON.stringify(await Promise.all(shellResponses))}; fixedAssetResponses=${JSON.stringify(await Promise.all(fixedAssetResponses))}`)
    }
    assertContentPreserved(contentBefore, await snapshotContentPlanes(storageRoot), 'upgrade')

    const rollback = deploy(binaryPath, adminRoot, releaseOne.archivePath)
    assertDeployment(rollback, 'rollback-one', 'deployed', 'intentional rollback')
    await assertAppVersion(storageRoot, releaseOne, 'release-one-v1', 'intentional rollback')
    await waitForOriginContent(baseURL, 'release-one-v1', 'rollback shell')
    await waitForOriginContent(assetURL, 'release-one-v1', 'rollback fixed-name asset')
    await page.reload()
    await assertBrowserVersion(page, 'release-one-v1', 'browser rollback', pageErrors)
    assertContentPreserved(contentBefore, await snapshotContentPlanes(storageRoot), 'intentional rollback')

    const fixedResponses = await Promise.all(fixedAssetResponses)
    const fixedCache = fixedResponses.map((response) => response.headers['cache-control'])
    if (fixedResponses.length !== 3 || fixedCache.some((cache) => cache !== 'no-cache, max-age=0, must-revalidate')) {
      throw new Error(`Browser fixed-name asset responses = ${JSON.stringify(fixedResponses)}, want three revalidated responses.`)
    }
    const hashedResponses = await Promise.all(hashedAssetResponses)
    const hashedCache = hashedResponses.map((response) => response.headers['cache-control'])
    if (hashedResponses.length < 1 || hashedCache.some((cache) => cache !== 'public, max-age=31536000, immutable')) {
      throw new Error(`Browser content-hashed asset responses = ${JSON.stringify(hashedResponses)}, want the immutable one-year policy.`)
    }

    if (run('git', ['status', '--porcelain'], { cwd: adminRoot }) !== '') {
      throw new Error('app deploy modified the clean admin checkout')
    }
    for (const assetPath of pinnedAssets) {
      await fs.access(assetPath)
    }
    console.log('App deploy browser-cache rollback passed: one Chromium context executed fixed-name asset v1 → v2 → v1, observed revalidation headers, and preserved content-plane objects byte-for-byte.')
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (composeStarted) {
      try {
        run('docker', ['compose', '-p', projectName, 'down', '--remove-orphans'], {
          env: { ...process.env, COMPOSE_PROJECT_NAME: projectName },
        })
      } catch (error) {
        console.error(`Could not stop the app-cache test nginx container: ${error instanceof Error ? error.message : error}`)
      }
    }
    await fs.rm(scratchRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
