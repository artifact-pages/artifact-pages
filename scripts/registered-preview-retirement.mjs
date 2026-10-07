import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'

// A second scenario of the registered-flow runner, using its repository/CLI
// helpers and the existing object-backed nginx profile rather than HTTP stubs.
export async function previewRetirement({ projectRoot, localRoot, run, git, initRepository, commit, writeFile, freePort, assert }) {
  await fs.mkdir(localRoot, { recursive: true })
  const scratch = await fs.mkdtemp(path.join(localRoot, 'preview-retirement-'))
  const project = `artifact-pages-retirement-${path.basename(scratch).split('-').at(-1).toLowerCase()}`
  const ports = new Set()
  async function uniquePort() {
    let port
    do { port = await freePort() } while (ports.has(port))
    ports.add(port)
    return port
  }
  const edgePort = await uniquePort()
  const originPort = await uniquePort()
  const baseURL = `http://127.0.0.1:${edgePort}`
  const origin = `http://127.0.0.1:${originPort}`
  const admin = path.join(scratch, 'admin')
  const satellite = path.join(scratch, 'satellite')
  const binary = path.join(scratch, 'artifact-pages')
  const composeEnv = { ...process.env, EDGE_STATE_DIR: scratch, EDGE_PORT: String(edgePort), GCS_PORT: String(originPort) }
  // Config selects only gcp-local. Strip cloud credentials/endpoint overrides
  // so inherited operator settings cannot influence this disposable scenario.
  const commandEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AWS_|CF_|GOOGLE_|GCP_|EDGE_|ARTIFACT_PAGES_)/u.test(key)))
  const composeArgs = ['compose', '-f', path.join(projectRoot, 'docker-compose.edge.yml'), '-p', project, '--profile', 'gcp']
  function compose(...args) { return run('docker', [...composeArgs, ...args], { env: composeEnv, stdio: 'inherit' }) }
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) })
    assert(response.ok, `${options.method ?? 'GET'} ${url}: HTTP ${response.status}`)
    return response
  }
  async function ready(url, status) {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).status === status) return } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error(`Local server did not become ready: ${url}`)
  }
  const objectURL = (key) => `${origin}/storage/v1/b/artifact-pages/o/${encodeURIComponent(key)}`
  const mediaURL = (key) => `${objectURL(key)}?alt=media`
  async function snapshot() {
    const objects = []
    let token = ''
    do {
      const query = new URLSearchParams({ maxResults: '1000' })
      if (token) query.set('pageToken', token)
      const page = await (await request(`${origin}/storage/v1/b/artifact-pages/o?${query}`)).json()
      for (const metadata of page.items ?? []) {
        const bytes = Buffer.from(await (await request(mediaURL(metadata.name))).arrayBuffer())
        // Include generation, timestamps, ETag, MIME/cache and custom metadata:
        // comparing hashes alone would miss an otherwise identical rewrite.
        objects.push({ key: metadata.name, metadata, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
      token = page.nextPageToken ?? ''
    } while (token)
    return objects.sort((a, b) => a.key.localeCompare(b.key))
  }
  const equal = (a, b, message) => assert(JSON.stringify(a) === JSON.stringify(b), message)
  const catalogKey = '_previews/sre/catalog.json'
  const catalog = async () => (await request(mediaURL(catalogKey))).json()
  async function evidence(name, data) { await writeFile(scratch, `${name}.json`, `${JSON.stringify(data, null, 2)}\n`) }
  function cli(cwd, args) {
    const result = run(binary, [...args, '--config', cwd === admin ? 'artifact-pages.yaml' : '../admin/artifact-pages.yaml', '--format', 'json'], { cwd, env: commandEnv })
    return JSON.parse(result.stdout)
  }
  const publish = (extra = []) => cli(satellite, ['site', 'sync', '--site', 'sre', '--source', 'sites/sre/content', ...extra])
  let browser
  let context
  let cleanupPromise
  let started = false
  let completed = false
  function cleanup() {
    cleanupPromise ??= (async () => {
      try {
        if (context) await context.tracing.stop({ path: path.join(scratch, 'browser-trace.zip') })
      } finally {
        try { if (browser) await browser.close() } finally {
          if (started) compose('down', '--remove-orphans')
        }
      }
    })()
    return cleanupPromise
  }
  const interrupt = () => {
    cleanup().then(() => process.exit(130), (error) => { console.error(error); process.exit(1) })
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    await initRepository(admin, 'https://github.com/example/registered-admin.git')
    await initRepository(satellite, 'https://github.com/example/registered-satellite.git')
    await writeFile(admin, 'artifact-pages.yaml', `schemaVersion: 1\nprovider: gcp-local\ngcpLocal:\n  endpoint: ${origin}\n  bucket: artifact-pages\nsites:\n  neighbor:\n    name: Neighbor site\n    repository: example/registered-satellite\n    sourcePath: sites/neighbor/content\n  sre:\n    name: SRE registered flow\n    repository: example/registered-satellite\n    sourcePath: sites/sre/content\n`)
    await writeFile(satellite, 'sites/sre/content/index.html', '<!doctype html><title>Production preserved</title><h1>Production preserved</h1>\n')
    await writeFile(satellite, 'sites/sre/content/assets/site.css', 'body { background-color: rgb(223, 241, 230); }\n')
    await writeFile(satellite, 'sites/neighbor/content/index.html', '<!doctype html><title>Neighbor preserved</title><h1>Neighbor preserved</h1>\n')
    commit(admin, 'register isolated retirement sites')
    commit(satellite, 'add production and neighbor sources')
    run('go', ['build', '-o', binary, './cli/cmd/artifact-pages'])
    await fs.mkdir(path.join(scratch, 'gcs'), { recursive: true })
    started = true
    // Skip fixture seeding: the empty bucket and every projection are created
    // through the API/actual CLI. The edge only mounts the app and nginx config.
    compose('up', '--detach', 'fake-gcs')
    await ready(`${origin}/storage/v1/b`, 200)
    await request(`${origin}/storage/v1/b?project=local`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'artifact-pages' }) })
    compose('up', '--detach', '--no-deps', 'edge-gcp')
    await ready(`${baseURL}/health`, 204)
    const inspection = JSON.parse(run('docker', ['inspect', run('docker', [...composeArgs, 'ps', '-q', 'edge-gcp'], { env: composeEnv }).stdout.trim()]).stdout)[0]
    assert(inspection.Mounts.length === 2 && inspection.Mounts.every((mount) => ['/usr/share/nginx/html', '/etc/nginx/conf.d/default.conf'].includes(mount.Destination)), 'edge has unexpected dynamic storage mount')
    assert(cli(admin, ['registry', 'sync']).outcome === 'synced', 'registry did not sync')
    assert(cli(satellite, ['site', 'sync', '--site', 'neighbor', '--source', 'sites/neighbor/content']).outcome === 'synced', 'neighbor did not sync')
    assert(publish().outcome === 'synced', 'production site did not sync')
    const previews = []
    for (const [branch, title] of [['retire', 'Retired review'], ['live', 'Live review']]) {
      git(satellite, ['checkout', '-b', branch, 'main'])
      await writeFile(satellite, `sites/sre/content/${branch}.html`, `<!doctype html><title>${title}</title><link rel="stylesheet" href="assets/site.css"><h1>${title}</h1>\n`)
      commit(satellite, `add ${branch} review`)
      const sha = git(satellite, ['rev-parse', 'HEAD'])
      const result = cli(satellite, ['preview', 'publish', '--site', 'sre', '--source', 'sites/sre/content', '--head', 'HEAD', '--default-ref', 'main', '--base-url', baseURL])
      assert(result.outcome === 'published' && result.documents.length === 1 && result.documents[0].path === `${branch}.html`, 'preview did not publish the selected changed document')
      previews.push({ sha, title, url: result.documents[0].url, prefix: `_previews/sre/revisions/${sha}/` })
      await evidence(`publish-${branch}`, result)
    }
    git(satellite, ['checkout', 'main'])
    const [retired, live] = previews
    const before = await snapshot()
    await evidence('before-deletion', before)
    const initialCatalog = await catalog()
    assert(initialCatalog.groups.length === 2, 'initial catalog does not contain both previews')
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext()
    await context.tracing.start({ screenshots: true, snapshots: true })
    const list = await context.newPage()
    const document = await context.newPage()
    await list.goto(`${baseURL}/sre/_previews`)
    for (const preview of previews) {
      await expect(list.getByRole('region', { name: `Preview head:${preview.sha}`, exact: true })).toBeVisible()
      await expect(list.getByRole('link', { name: new RegExp(preview.title) })).toBeVisible()
    }
    await document.goto(retired.url)
    await expect(document.frameLocator('iframe').getByRole('heading', { name: retired.title })).toBeVisible()
    await expect(document.frameLocator('iframe').locator('body')).toHaveCSS('background-color', 'rgb(223, 241, 230)')
    const deleted = before.filter((object) => object.key.startsWith(retired.prefix))
    assert(deleted.some((object) => object.key === `${retired.prefix}manifest.json`) && deleted.some((object) => object.key.endsWith('/files/retire.html')) && deleted.some((object) => object.key.endsWith('/files/assets/site.css')), 'selected revision is missing expected files/manifest')
    for (const object of deleted) await request(objectURL(object.key), { method: 'DELETE' })
    const afterDeletion = await snapshot()
    equal(afterDeletion, before.filter((object) => !object.key.startsWith(retired.prefix)), 'deletion touched objects outside the exact revision')
    assert((await catalog()).groups.some((group) => group.headSha === retired.sha), 'catalog reference disappeared before ordinary publish')
    await evidence('deletion', { deletedKeys: deleted.map((object) => object.key), staleCatalogReferencePresent: true, remaining: afterDeletion })
    function checkPlan(result) {
      equal(result.changes, [], 'unchanged main-source publish reports production changes')
      equal(result.previewChanges.map(({ action, headSha, reason }) => ({ action, headSha, reason })).sort((a, b) => a.action.localeCompare(b.action)), [
        { action: 'keep', headSha: live.sha, reason: 'manifest-present' },
        { action: 'remove', headSha: retired.sha, reason: 'manifest-missing' },
      ], 'reconciliation did not select exactly the missing manifest')
      equal(result.invalidationPaths, ['/_previews/sre/catalog.json'], 'unexpected invalidation scope')
    }
    const dryRun = publish(['--dry-run'])
    assert(dryRun.outcome === 'planned', 'dry-run did not report planned reconciliation')
    checkPlan(dryRun)
    equal(await snapshot(), afterDeletion, 'dry-run wrote bytes or object metadata')
    await evidence('dry-run', dryRun)
    const reconciled = publish()
    assert(reconciled.outcome === 'published', 'main publish did not reconcile')
    checkPlan(reconciled)
    const afterPublish = await snapshot()
    const preserved = (objects) => objects.filter((object) => object.key !== catalogKey && !object.key.startsWith('_control/'))
    equal(preserved(afterPublish), preserved(afterDeletion), 'main publish changed production, neighbor or live revision bytes/metadata')
    const finalCatalog = await catalog()
    equal(finalCatalog.groups, initialCatalog.groups.filter((group) => group.headSha === live.sha), 'reconciliation changed retained catalog metadata')
    assert(finalCatalog.groups.length === 1 && finalCatalog.groups[0].headSha === live.sha, 'main publish did not prune exactly the retired group')
    await evidence('reconciliation', { result: reconciled, catalog: finalCatalog, objects: afterPublish })
    await list.reload()
    await expect(list.getByRole('heading', { name: 'Previews', exact: true })).toBeVisible()
    await expect(list.getByRole('region', { name: `Preview head:${live.sha}`, exact: true })).toBeVisible()
    await expect(list.getByRole('region', { name: `Preview head:${retired.sha}`, exact: true })).toHaveCount(0)
    await expect(list.getByRole('link', { name: new RegExp(retired.title) })).toHaveCount(0)
    await document.reload()
    await expect(document.getByRole('heading', { name: 'Preview unavailable', exact: true })).toBeVisible()
    await expect(document.locator('iframe')).toHaveCount(0)
    const shell = await (await request(`${baseURL}/index.html`)).text()
    for (const key of [`${retired.prefix}files/retire.html`, `${retired.prefix}manifest.json`]) {
      const response = await fetch(`${baseURL}/${key}`)
      assert(response.status === 404 && await response.text() !== shell, `${key} is not a real edge 404`)
      assert((await fetch(objectURL(key))).status === 404, `${key} is not absent at the origin API`)
    }
    await list.screenshot({ path: path.join(scratch, 'list-after.png') })
    await document.screenshot({ path: path.join(scratch, 'document-after.png') })
    // A provider may expire the catalog too. Its absence is a converged no-op,
    // never a fabricated removal or a reason to delete live revision objects.
    await request(objectURL(catalogKey), { method: 'DELETE' })
    const missingCatalogBefore = await snapshot()
    const absentDryRun = publish(['--dry-run'])
    equal(await snapshot(), missingCatalogBefore, 'missing-catalog dry-run wrote bytes or metadata')
    const absentPublish = publish()
    for (const result of [absentDryRun, absentPublish]) {
      assert(result.outcome === 'no-op', 'missing catalog did not converge to no-op')
      equal(result.changes, [], 'missing catalog caused production changes')
      equal(result.previewChanges ?? [], [], 'missing catalog fabricated preview removal')
    }
    const contentObjects = (objects) => objects.filter((object) => !object.key.startsWith('_control/'))
    equal(contentObjects(await snapshot()), contentObjects(missingCatalogBefore), 'missing catalog no-op changed or recreated content objects')
    assert((await fetch(objectURL(catalogKey))).status === 404, 'missing catalog no-op recreated the catalog')
    await evidence('missing-catalog', { dryRun: absentDryRun, publish: absentPublish })
    await evidence('summary', { passed: true, executedAt: new Date().toISOString(), baseURL, origin, previews, objectsDeleted: deleted.length, checks: ['API-only exact revision deletion', 'dry-run bytes/metadata unchanged', 'main publish catalog-only pruning', 'production/neighbor/live bytes and metadata preserved', 'warm list/document reload withdrawal', 'raw origin and nginx 404', 'missing catalog no-op'] })
    completed = true
    console.log(`Preview retirement passed; local evidence: ${scratch}`)
  } finally {
    try {
      await cleanup()
      console.log(`${completed ? 'Completed' : 'Failed'} local retirement state retained at ${scratch}; Compose containers removed.`)
    } finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', interrupt)
    }
  }
}
