import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const composeFile = path.join(projectRoot, 'docker-compose.edge.yml')
const profileRoot = path.resolve(projectRoot, process.env.EDGE_PROFILE_STATE_ROOT ?? '.local/edge-profiles')
const validProfiles = new Set(['aws', 'cloudflare', 'gcp'])

function run(command, args, { env = process.env, stdio = 'inherit' } = {}) {
  const result = spawnSync(command, args, { cwd: projectRoot, env, encoding: 'utf8', stdio })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'no exit status'}).${detail ? `\n${detail}` : ''}`)
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function profileEnv(profile, stateDir, ports) {
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: `artifact-pages-edge-${profile}`,
    EDGE_STATE_DIR: stateDir,
    EDGE_PORT: String(ports.edge),
    MINIO_PORT: String(ports.minio),
    GCS_PORT: String(ports.gcs),
    CF_API_PORT: String(ports.cloudflareAPI),
  }
}

function composeArgs(profile, env, command, ...args) {
  return ['compose', '-f', composeFile, '--project-name', `artifact-pages-edge-${profile}`, '--profile', profile, command, ...args]
}

async function waitFor(url, expectedStatus, label) {
  const deadline = Date.now() + 120_000
  let lastStatus = 'not reachable'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      lastStatus = `HTTP ${response.status}`
      if (response.status === expectedStatus) return
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`${label} did not become ready at ${url} (last result: ${lastStatus}).`)
}

async function writeDeploymentConfig(profile, configPath, ports) {
  let contents
  if (profile === 'aws') {
    contents = [
      'schemaVersion: 1', 'provider: aws', 'previewRetentionDays: 30', 'aws:',
      '  region: us-east-1', '  bucket: artifact-pages', '',
    ].join('\n')
  } else if (profile === 'cloudflare') {
    contents = [
      'schemaVersion: 1', 'provider: cloudflare', 'previewRetentionDays: 30', 'cloudflare:',
      '  accountId: 0123456789abcdef0123456789abcdef', '  bucket: artifact-pages',
      '  zoneId: abcdef0123456789abcdef0123456789', '  publicBaseURL: https://pages.example.test',
      `  r2Endpoint: http://127.0.0.1:${ports.minio}`,
      `  apiBaseURL: http://127.0.0.1:${ports.cloudflareAPI}/client/v4`,
      '  accessKeyIdEnv: CF_R2_ACCESS_KEY_ID', '  secretAccessKeyEnv: CF_R2_SECRET_ACCESS_KEY',
      '  sessionTokenEnv: CF_R2_SESSION_TOKEN', '  apiTokenEnv: CF_API_TOKEN', '',
    ].join('\n')
  } else {
    contents = [
      'schemaVersion: 1', 'provider: gcp-local', 'previewRetentionDays: 30', 'gcpLocal:',
      `  endpoint: http://127.0.0.1:${ports.gcs}`, '  bucket: artifact-pages', '',
    ].join('\n')
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, contents, { mode: 0o600 })
}

async function writeRegistryProbeManifest(manifestPath) {
  const contents = [
    'schemaVersion: 1',
    'sites:',
    '  frontend:',
    '    name: Frontend',
    '    repository: tasuku43/git-artifact-pages',
    '    sourcePath: fixtures/storage/_artifacts/frontend',
    '  showcase:',
    '    name: HTML Showcase',
    '    repository: tasuku43/git-artifact-pages',
    '    sourcePath: fixtures/storage/_artifacts/showcase',
    '  sre:',
    '    name: SRE',
    '    repository: tasuku43/git-artifact-pages',
    '    sourcePath: fixtures/storage/_artifacts/sre',
    '  edge-probe:',
    '    name: Edge Probe',
    '    repository: tasuku43/git-artifact-pages',
    '    sourcePath: fixtures/storage/_artifacts/sre/edge-probe',
    '',
  ].join('\n')
  await fs.writeFile(manifestPath, contents, { mode: 0o600 })
}

async function writeRegistryUnregisterManifest(manifestPath) {
  const contents = [
    'schemaVersion: 1',
    'sites:',
    '  frontend:',
    '    name: Frontend',
    '    repository: tasuku43/git-artifact-pages',
    '    sourcePath: fixtures/storage/_artifacts/frontend',
    '  showcase:',
    '    name: HTML Showcase',
    '    repository: tasuku43/git-artifact-pages',
    '    sourcePath: fixtures/storage/_artifacts/showcase',
    '  edge-probe:',
    '    name: Edge Probe',
    '    repository: tasuku43/git-artifact-pages',
    '    sourcePath: fixtures/storage/_artifacts/sre/edge-probe',
    '',
  ].join('\n')
  await fs.writeFile(manifestPath, contents, { mode: 0o600 })
}

async function publishUnregisterProbe(configPath, commandEnv, siteID, sourceDir, probeName, marker) {
  const sourcePath = path.join(projectRoot, sourceDir, probeName)
  const artifactKey = `_artifacts/${siteID}/${probeName}`
  await fs.writeFile(sourcePath, `<!doctype html><title>${siteID} unregister probe</title><p>${marker}</p>\n`, { flag: 'wx' })
  try {
    const result = run('go', [
      'run', './cmd/artifact-pages', 'site', 'publish', '--config', configPath,
      '--site', siteID, '--source', sourceDir, '--format=json',
    ], { env: commandEnv, stdio: 'pipe' })
    process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    let published
    try {
      published = JSON.parse(result.stdout)
    } catch {
      throw new Error(`${siteID} site publish did not return JSON: ${result.stdout}`)
    }
    if (published.outcome !== 'published' || published.filesPublished < 1) {
      throw new Error(`${siteID} site publish did not write its unregister probe through the object API.`)
    }
  } finally {
    await fs.rm(sourcePath, { force: true })
  }
  return artifactKey
}

async function runCloudflareUnregisterObjectAssertions(profile, env, mode, probeKey) {
  run('docker', composeArgs(profile, env, 'run', '--rm', '--no-deps', '--entrypoint', '/bin/sh', 'seed-s3',
    '/scripts/assert-cloudflare-unregister.sh', mode, probeKey), { env })
}

async function resetCloudflarePurgeRequests(profile, env, port) {
  let lastError = 'no response'
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/reset`, { method: 'POST' })
      if (response.status === 204) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const composeStatus = run('docker', composeArgs(profile, env, 'ps', '--format', 'json'), { env, stdio: 'pipe' }).stdout.trim()
  throw new Error(`Cloudflare purge mock reset failed after retries (${lastError}). Compose services: ${composeStatus || 'none listed'}`)
}

async function assertCloudflareUnregisterPurgeRequests(port) {
  const response = await fetch(`http://127.0.0.1:${port}/requests`)
  const requests = await response.json().catch(() => null)
  const endpoint = '/client/v4/zones/abcdef0123456789abcdef0123456789/purge_cache'
  if (!response.ok || !Array.isArray(requests) || requests.length !== 2) {
    throw new Error(`Cloudflare purge mock recorded ${Array.isArray(requests) ? requests.length : 'an invalid number of'} unregister requests.`)
  }
  const expected = {
    prefixes: [
      'pages.example.test/_artifacts/sre/',
      'pages.example.test/_indexes/sre/',
      'pages.example.test/_previews/sre/',
      'pages.example.test/sre/',
    ],
    files: [
      'https://pages.example.test/_indexes/sites.json',
      'https://pages.example.test/sre',
    ],
  }
  const observed = new Map()
  for (const request of requests) {
    if (request.url !== endpoint || !request.payload || Object.keys(request.payload).length !== 1) {
      throw new Error(`Cloudflare purge mock recorded an unexpected request: ${JSON.stringify(request)}`)
    }
    const [kind] = Object.keys(request.payload)
    if (!Object.hasOwn(expected, kind) || observed.has(kind) || !Array.isArray(request.payload[kind])) {
      throw new Error(`Cloudflare purge mock recorded an unexpected request group: ${JSON.stringify(request)}`)
    }
    observed.set(kind, [...request.payload[kind]].sort())
  }
  for (const [kind, entries] of Object.entries(expected)) {
    if (JSON.stringify(observed.get(kind)) !== JSON.stringify([...entries].sort())) {
      throw new Error(`Cloudflare unregister ${kind} purge paths = ${JSON.stringify(observed.get(kind))}, want ${JSON.stringify(entries)}`)
    }
  }
}

async function assertCloudflareAppDeployPurgeRequest(port) {
  const response = await fetch(`http://127.0.0.1:${port}/requests`)
  const requests = await response.json().catch(() => null)
  if (!response.ok || !Array.isArray(requests) || requests.length !== 1) {
    throw new Error(`Cloudflare app-deploy purge mock recorded ${Array.isArray(requests) ? requests.length : 'an invalid number of'} requests.`)
  }
  const request = requests[0]
  const endpoint = '/client/v4/zones/abcdef0123456789abcdef0123456789/purge_cache'
  if (request.url !== endpoint || JSON.stringify(request.payload) !== JSON.stringify({ files: ['https://pages.example.test/index.html'] })) {
    throw new Error(`Cloudflare app-deploy purge request = ${JSON.stringify(request)}, want only the stable application shell URL.`)
  }
}

function localProfileEnv(profile, ports) {
  const env = { ...process.env }
  delete env.AWS_PROFILE
  delete env.AWS_DEFAULT_PROFILE
  if (profile === 'aws') {
    Object.assign(env, {
      AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${ports.minio}`,
      AWS_ACCESS_KEY_ID: 'minioadmin', AWS_SECRET_ACCESS_KEY: 'minioadmin',
      AWS_DEFAULT_REGION: 'us-east-1', AWS_REGION: 'us-east-1', AWS_EC2_METADATA_DISABLED: 'true',
    })
  } else if (profile === 'cloudflare') {
    Object.assign(env, {
      CF_R2_ACCESS_KEY_ID: 'minioadmin', CF_R2_SECRET_ACCESS_KEY: 'minioadmin',
      CF_API_TOKEN: 'edge-test-token',
    })
  } else {
    env.EDGE_GCS_ENDPOINT = `http://127.0.0.1:${ports.gcs}`
  }
  env.ARTIFACT_PAGES_EDGE_PROFILE = profile
  env.EDGE_R2_ENDPOINT = `http://127.0.0.1:${ports.minio}`
  env.EDGE_CF_API_BASE_URL = `http://127.0.0.1:${ports.cloudflareAPI}/client/v4`
  return env
}

async function stop(profile, env) {
  run('docker', composeArgs(profile, env, 'down', '--remove-orphans'), { env })
}

function reseed(profile, env) {
  const seedService = profile === 'gcp' ? 'seed-gcs' : 'seed-s3'
  run('docker', composeArgs(profile, env, 'run', '--rm', seedService), { env })
}

function assertEdgeHasNoDynamicStorageMount(profile, env, service) {
  const containerID = run('docker', composeArgs(profile, env, 'ps', '-q', service), { env, stdio: 'pipe' }).stdout.trim()
  if (!containerID) throw new Error(`Could not inspect the ${service} edge container.`)
  const inspected = JSON.parse(run('docker', ['inspect', containerID], { env, stdio: 'pipe' }).stdout)[0]
  const mounts = inspected?.Mounts ?? []
  const dynamicMount = mounts.find((mount) => (
    mount.Destination === '/data' || mount.Source.includes(`${path.sep}.local${path.sep}edge-profiles${path.sep}`)
  ))
  if (dynamicMount) {
    throw new Error(`The ${service} edge has a dynamic storage mount: ${dynamicMount.Source} -> ${dynamicMount.Destination}`)
  }
  for (const destination of ['/usr/share/nginx/html', '/etc/nginx/conf.d/default.conf']) {
    if (!mounts.some((mount) => mount.Destination === destination)) {
      throw new Error(`The ${service} edge is missing its expected static mount at ${destination}.`)
    }
  }
}

async function startProfile(profile, env, edgeService) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      run('docker', composeArgs(profile, env, 'up', '--build', '--detach', edgeService), { env })
      return
    } catch (error) {
      if (attempt === 3) throw error
      console.warn(`Compose startup attempt ${attempt} for ${profile} did not complete; retrying after the local origin settles.`)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
}

async function prepareS3Origin(profile, env, stateDir) {
  run('docker', composeArgs(profile, env, 'build', 'minio'), { env })
  const containerName = `artifact-pages-edge-${profile}-minio-format`
  const dataPath = path.join(stateDir, 'minio')
  run('docker', [
    'run', '--detach', '--name', containerName,
    '--mount', `type=bind,source=${dataPath},target=/data`,
    '--env', 'MINIO_ROOT_USER=minioadmin', '--env', 'MINIO_ROOT_PASSWORD=minioadmin',
    `artifact-pages-edge-${profile}-minio`, 'server', '/data', '--console-address', ':9001',
  ], { env, stdio: 'pipe' })

  try {
    const deadline = Date.now() + 120_000
    let lastError = 'not ready'
    while (Date.now() < deadline) {
      const health = spawnSync('docker', [
        'exec', containerName, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:9000/minio/health/ready',
      ], { cwd: projectRoot, env, encoding: 'utf8', stdio: 'ignore' })
      if (health.status === 0) return
      const state = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', containerName], {
        cwd: projectRoot, env, encoding: 'utf8', stdio: 'pipe',
      })
      if (state.status !== 0 || state.stdout.trim() !== 'true') {
        const logs = run('docker', ['logs', containerName], { env, stdio: 'pipe' })
        lastError = [logs.stdout, logs.stderr].filter(Boolean).join('\n')
        throw new Error(`Temporary MinIO origin initialization exited before readiness.${lastError ? `\n${lastError}` : ''}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error(`Temporary MinIO origin initialization timed out (${lastError}).`)
  } finally {
    const stopped = spawnSync('docker', ['stop', containerName], { cwd: projectRoot, env, encoding: 'utf8', stdio: 'ignore' })
    if (stopped.status === 0) {
      spawnSync('docker', ['rm', containerName], { cwd: projectRoot, env, encoding: 'utf8', stdio: 'ignore' })
    }
  }
}

async function main() {
  const [actionOrProfile, maybeProfile] = process.argv.slice(2)
  const isDown = actionOrProfile === 'down'
  const profile = isDown ? maybeProfile : actionOrProfile
  if (!validProfiles.has(profile)) {
    throw new Error('Usage: node scripts/run-edge-profile.mjs <aws|cloudflare|gcp> | down <aws|cloudflare|gcp>')
  }

  const ports = {
    edge: Number(process.env.EDGE_PORT ?? 8081),
    minio: Number(process.env.MINIO_PORT ?? 19000),
    gcs: Number(process.env.GCS_PORT ?? 14443),
    cloudflareAPI: Number(process.env.CF_API_PORT ?? 18787),
  }
  if (Object.values(ports).some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('EDGE_PORT, MINIO_PORT, GCS_PORT, and CF_API_PORT must be valid TCP ports.')
  }

  const stateDir = path.join(profileRoot, profile)
  const env = profileEnv(profile, stateDir, ports)
  if (isDown) {
    await stop(profile, env)
    console.log(`Stopped the ${profile} local edge profile; its generated state remains under ${path.relative(projectRoot, stateDir)}.`)
    return
  }

  let profileStartAttempted = false
  try {
    await stop(profile, env)
    const originDataDir = path.join(stateDir, profile === 'gcp' ? 'gcs' : 'minio')
    if (profile === 'gcp') {
      // Preserve fake-gcs-server's bucket metadata across container restarts;
      // its filesystem backend can race a deleted/recreated bind mount. The
      // API seeder clears objects before restoring fixtures on every run.
      await fs.mkdir(originDataDir, { recursive: true })
    } else {
      await fs.rm(stateDir, { recursive: true, force: true })
      await fs.mkdir(originDataDir, { recursive: true })
    }
    const configPath = path.join(stateDir, 'deployment.yaml')
    await writeDeploymentConfig(profile, configPath, ports)

    run('npm', ['run', 'build'], { env })
    if (profile === 'aws' || profile === 'cloudflare') await prepareS3Origin(profile, env, stateDir)
    const edgeService = `edge-${profile}`
    profileStartAttempted = true
    await startProfile(profile, env, edgeService)
    assertEdgeHasNoDynamicStorageMount(profile, env, edgeService)

    if (profile === 'aws' || profile === 'cloudflare') {
      await waitFor(`http://127.0.0.1:${ports.minio}/minio/health/ready`, 200, `${profile} S3 origin`)
    } else {
      await waitFor(`http://127.0.0.1:${ports.gcs}/storage/v1/b`, 200, 'GCP local JSON API origin')
    }
    if (profile === 'cloudflare') {
      await waitFor(`http://127.0.0.1:${ports.cloudflareAPI}/health`, 204, 'Cloudflare API mock')
    }
    await waitFor(`http://127.0.0.1:${ports.edge}/health`, 204, `${profile} nginx edge`)

    const commandEnv = localProfileEnv(profile, ports)
    let frontendProbeKey = ''
    let sreProbeKey = ''
    const frontendProbeMarker = `edge-unregister-${process.pid}-${Date.now()}`
    if (profile === 'cloudflare') {
      const sitePublishEnv = { ...commandEnv }
      delete sitePublishEnv.CF_API_TOKEN
      const probeName = `${frontendProbeMarker}.html`
      sreProbeKey = await publishUnregisterProbe(configPath, sitePublishEnv, 'sre', 'fixtures/storage/_artifacts/sre', probeName, `${frontendProbeMarker}-sre`)
      frontendProbeKey = await publishUnregisterProbe(configPath, sitePublishEnv, 'frontend', 'fixtures/storage/_artifacts/frontend', probeName, `${frontendProbeMarker}-frontend`)
    } else {
      const publish = run('go', [
        'run', './cmd/artifact-pages', 'site', 'publish', '--config', configPath,
        '--site', 'sre', '--source', 'fixtures/storage/_artifacts/sre', '--format=json',
      ], { env: commandEnv, stdio: 'pipe' })
      process.stdout.write(publish.stdout)
      if (publish.stderr) process.stderr.write(publish.stderr)
      let publishResult
      try {
        publishResult = JSON.parse(publish.stdout)
      } catch {
        throw new Error(`site publish did not return JSON: ${publish.stdout}`)
      }
      if (publishResult.outcome !== 'published' || publishResult.filesPublished < 1) {
        throw new Error('site publish did not write a changed projection through the object API.')
      }
    }

    const registryManifestPath = path.join(stateDir, 'registry-probe.yaml')
    await writeRegistryProbeManifest(registryManifestPath)
    const registryPublish = run('go', [
      'run', './cmd/artifact-pages', 'registry', 'publish', '--config', configPath,
      '--manifest', registryManifestPath, '--format=json',
    ], { env: commandEnv, stdio: 'pipe' })
    process.stdout.write(registryPublish.stdout)
    if (registryPublish.stderr) process.stderr.write(registryPublish.stderr)
    let registryResult
    try {
      registryResult = JSON.parse(registryPublish.stdout)
    } catch {
      throw new Error(`registry publish did not return JSON: ${registryPublish.stdout}`)
    }
    if (registryResult.outcome !== 'published' || registryResult.registryUpdated !== true) {
      throw new Error('registry publish did not publish a changed site catalog through the object API.')
    }

    const catalogResponse = await fetch(`http://127.0.0.1:${ports.edge}/_indexes/sites.json`)
    const catalog = await catalogResponse.json().catch(() => null)
    if (!catalogResponse.ok || !catalog?.sites?.some((site) => site.id === 'edge-probe')) {
      throw new Error(`Edge did not serve the changed site catalog from the object API (HTTP ${catalogResponse.status}).`)
    }
    const indexResponse = await fetch(`http://127.0.0.1:${ports.edge}/_indexes/sre/index.json`)
    const index = await indexResponse.json().catch(() => null)
    if (!indexResponse.ok || !index?.artifacts?.some((artifact) => artifact.source?.repository === 'tasuku43/git-artifact-pages')) {
      throw new Error(`Edge did not serve the newly published site index from the object API (HTTP ${indexResponse.status}).`)
    }
    const artifactProbe = await fetch(`http://127.0.0.1:${ports.edge}/_artifacts/sre/incidents/checkout-latency/index.html`)
    if (!artifactProbe.ok || !(await artifactProbe.text()).includes('Checkout latency')) {
      throw new Error(`Edge did not serve the seeded artifact from the object API (HTTP ${artifactProbe.status}).`)
    }

    run('go', ['test', './internal/publisher', '-run', '^TestLocalEdgeConformance$', '-count=1'], {
      env: commandEnv,
    })

    if (profile === 'cloudflare') {
      const previewProbePaths = [
        '/_previews/sre/catalog.json',
        '/_previews/sre/revisions/0123456789abcdef0123456789abcdef01234567/manifest.json',
        '/_previews/sre/revisions/0123456789abcdef0123456789abcdef01234567/files/guides/preview-guide.md',
        '/_previews/sre/revisions/0123456789abcdef0123456789abcdef01234567/files/guides/preview.html',
      ]
      for (const previewPath of previewProbePaths) {
        const response = await fetch(`http://127.0.0.1:${ports.edge}${previewPath}`)
        if (response.status !== 200 || !response.headers.get('cache-control')?.includes('no-store')) {
          throw new Error(`Cloudflare local edge preview probe ${previewPath} returned HTTP ${response.status} with cache ${response.headers.get('cache-control') ?? '<missing>'}; want 200 and no-store.`)
        }
      }
      const missingPreviewPath = '/_previews/sre/revisions/ffffffffffffffffffffffffffffffffffffffff/manifest.json'
      const missingPreview = await fetch(`http://127.0.0.1:${ports.edge}${missingPreviewPath}`)
      const missingPreviewBody = (await missingPreview.text()).toLowerCase()
      if (missingPreview.status !== 404 || missingPreviewBody.includes('<div id="root">')) {
        throw new Error(`Cloudflare local edge missing preview ${missingPreviewPath} returned HTTP ${missingPreview.status} or the SPA shell.`)
      }
      for (const previewNamespaceRoot of ['/_previews', '/_previews/']) {
        const response = await fetch(`http://127.0.0.1:${ports.edge}${previewNamespaceRoot}`)
        const body = (await response.text()).toLowerCase()
        if (response.status !== 404 || body.includes('<div id="root">')) {
          throw new Error(`Cloudflare local edge preview namespace ${previewNamespaceRoot} returned HTTP ${response.status} or the SPA shell, want a real 404.`)
        }
      }

      await resetCloudflarePurgeRequests(profile, env, ports.cloudflareAPI)
      run('go', ['test', './cmd/artifact-pages', '-run', '^TestCloudflareAppDeployConformance$', '-count=1'], {
        env: commandEnv,
      })
      await assertCloudflareAppDeployPurgeRequest(ports.cloudflareAPI)

      await runCloudflareUnregisterObjectAssertions(profile, env, 'before', sreProbeKey)
      await resetCloudflarePurgeRequests(profile, env, ports.cloudflareAPI)

      const unregisterManifestPath = path.join(stateDir, 'registry-unregister-probe.yaml')
      await writeRegistryUnregisterManifest(unregisterManifestPath)
      const unregister = run('go', [
        'run', './cmd/artifact-pages', 'registry', 'unregister', '--config', configPath,
        '--manifest', unregisterManifestPath, '--site', 'sre', '--format=json',
      ], { env: commandEnv, stdio: 'pipe' })
      process.stdout.write(unregister.stdout)
      if (unregister.stderr) process.stderr.write(unregister.stderr)
      let unregisterResult
      try {
        unregisterResult = JSON.parse(unregister.stdout)
      } catch {
        throw new Error(`registry unregister did not return JSON: ${unregister.stdout}`)
      }
      if (unregisterResult.outcome !== 'unregistered' || unregisterResult.site !== 'sre'
        || unregisterResult.registryUpdated !== true || unregisterResult.filesRemoved < 1) {
        throw new Error(`registry unregister did not withdraw and clean SRE: ${JSON.stringify(unregisterResult)}`)
      }

      await runCloudflareUnregisterObjectAssertions(profile, env, 'after', frontendProbeKey)
      await assertCloudflareUnregisterPurgeRequests(ports.cloudflareAPI)

      const withdrawnCatalogResponse = await fetch(`http://127.0.0.1:${ports.edge}/_indexes/sites.json`)
      const withdrawnCatalog = await withdrawnCatalogResponse.json().catch(() => null)
      if (!withdrawnCatalogResponse.ok || withdrawnCatalog?.sites?.some((site) => site.id === 'sre')
        || !withdrawnCatalog?.sites?.some((site) => site.id === 'frontend')) {
        throw new Error(`Edge did not preserve the neighboring frontend registration after unregister (HTTP ${withdrawnCatalogResponse.status}).`)
      }
      for (const removedPath of [
        '/_indexes/sre/index.json',
        '/_artifacts/sre/incidents/checkout-latency/index.html',
        '/_previews/sre/catalog.json',
        '/_previews/sre/revisions/0123456789abcdef0123456789abcdef01234567/manifest.json',
        '/_previews/sre/revisions/0123456789abcdef0123456789abcdef01234567/files/guides/preview.html',
      ]) {
        const response = await fetch(`http://127.0.0.1:${ports.edge}${removedPath}`)
        const body = (await response.text()).toLowerCase()
        if (response.status !== 404 || body.includes('<div id="root">')) {
          throw new Error(`Unregistered path ${removedPath} returned HTTP ${response.status} or the SPA shell, want a real 404.`)
        }
      }
      const frontendIndex = await fetch(`http://127.0.0.1:${ports.edge}/_indexes/frontend/index.json`)
      if (!frontendIndex.ok) throw new Error(`Neighboring frontend index returned HTTP ${frontendIndex.status} after unregister.`)
      const frontendArtifact = await fetch(`http://127.0.0.1:${ports.edge}/${frontendProbeKey}`)
      if (!frontendArtifact.ok || !(await frontendArtifact.text()).includes(`${frontendProbeMarker}-frontend`)) {
        throw new Error(`Neighboring frontend artifact returned HTTP ${frontendArtifact.status} after unregister.`)
      }
      console.log(`Cloudflare local unregister preserved frontend artifact ${frontendProbeKey} and removed SRE artifact/index/preview prefixes.`)
      console.log('Cloudflare purge mock received the exact SRE unregister file and prefix paths.')
    }

    // Restore fixtures after the publish and storage probes so E2E assertions
    // observe the committed metadata and preview catalog.
    reseed(profile, env)

    run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'e2e/local-serving.spec.ts', '--workers=1'], {
      env: { ...commandEnv, PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${ports.edge}` },
    })
    console.log(`\n${profile} local edge conformance passed. Edge: http://127.0.0.1:${ports.edge}`)
    console.log(`Origin profile state is under ${path.relative(projectRoot, stateDir)}. Stop services with: node scripts/run-edge-profile.mjs down ${profile}`)
  } catch (error) {
    if (profileStartAttempted && (profile === 'aws' || profile === 'cloudflare')) {
      try {
        reseed(profile, env)
      } catch (cleanupError) {
        console.error(`Could not restore ${profile} fixture objects during failure cleanup: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`)
      }
    }
    try {
      await stop(profile, env)
      if (profileStartAttempted) console.error(`Stopped the ${profile} edge profile after a failed conformance run.`)
    } catch (cleanupError) {
      console.error(`Could not stop the ${profile} edge profile after failure: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`)
    }
    throw error
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
