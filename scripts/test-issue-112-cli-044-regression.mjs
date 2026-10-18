#!/usr/bin/env node
// Black-box regression for a released CLI 0.4.4 encountering AWS-style
// encoded site state. Download the released binary separately, then pass it
// with --cli or ARTIFACT_PAGES_CLI_044; this script never accesses a provider.
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localRoot = path.join(repository, '.local')
const cliOption = process.argv.indexOf('--cli')
const releasedCLI = path.resolve(cliOption >= 0 ? process.argv[cliOption + 1] ?? '' : process.env.ARTIFACT_PAGES_CLI_044 ?? '')
if (!releasedCLI || releasedCLI === path.resolve(repository)) {
  throw new Error('Set ARTIFACT_PAGES_CLI_044 or pass --cli PATH to the released 0.4.4 binary (download: gh release download v0.4.4 --repo artifact-pages/artifact-pages --pattern artifact-pages_v0.4.4_darwin_arm64 --dir .local/issue112-cli044)')
}

function run(command, args, { cwd = repository, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'no exit status'}).${detail ? `\n${detail}` : ''}`)
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const quote = (value) => JSON.stringify(value)
const metadataPath = (storageRoot, key) => path.join(`${storageRoot}.metadata`, `${hash(Buffer.from(key))}.json`)
const objectPath = (storageRoot, key) => path.join(storageRoot, ...key.split('/'))

async function writeFile(root, relative, contents) {
  const filename = path.join(root, ...relative.split('/'))
  await fs.mkdir(path.dirname(filename), { recursive: true })
  await fs.writeFile(filename, contents)
  return filename
}

function git(cwd, args) { return run('git', args, { cwd }).stdout.trim() }

async function initRepository(cwd, remoteURL) {
  await fs.mkdir(cwd, { recursive: true })
  git(cwd, ['init', '--initial-branch=main'])
  git(cwd, ['remote', 'add', 'origin', remoteURL])
  git(cwd, ['config', 'user.name', 'ISSUE-112 regression'])
  git(cwd, ['config', 'user.email', 'issue-112@example.invalid'])
}

function commit(cwd, message = 'seed ISSUE-112 regression fixture') {
  run('git', ['add', '--all'], { cwd })
  run('git', ['commit', '--quiet', '--message', message], { cwd })
}

async function objectKeys(root, prefix) {
  const directory = path.join(root, ...prefix.split('/'))
  const keys = []
  async function walk(current, relative = '') {
    let entries
    try { entries = await fs.readdir(current, { withFileTypes: true }) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name
      const filename = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(filename, next)
      else if (entry.isFile()) keys.push(`${prefix}/${next}`)
      else throw new Error(`unexpected fixture entry: ${filename}`)
    }
  }
  await walk(directory)
  return keys.sort()
}

async function captureFixture(storageRoot, prefixes, stateKey) {
  const keys = [...new Set([...(await Promise.all(prefixes.map((prefix) => objectKeys(storageRoot, prefix)))).flat(), stateKey])].sort()
  const objects = []
  for (const key of keys) {
    objects.push({
      key,
      bytes: await fs.readFile(objectPath(storageRoot, key)),
      metadata: await fs.readFile(metadataPath(storageRoot, key)),
    })
  }
  return objects
}

async function clearStoredPrefix(storageRoot, prefix) {
  const keys = await objectKeys(storageRoot, prefix)
  await Promise.all(keys.map((key) => fs.rm(metadataPath(storageRoot, key), { force: true })))
  await fs.rm(path.join(storageRoot, ...prefix.split('/')), { recursive: true, force: true })
}

async function restoreFixture(storageRoot, fixture, prefixes, stateKey) {
  await Promise.all(prefixes.map((prefix) => clearStoredPrefix(storageRoot, prefix)))
  await fs.rm(objectPath(storageRoot, stateKey), { force: true })
  await fs.rm(metadataPath(storageRoot, stateKey), { force: true })
  for (const entry of fixture) {
    await writeFile(storageRoot, entry.key, entry.bytes)
    await fs.mkdir(path.dirname(metadataPath(storageRoot, entry.key)), { recursive: true })
    await fs.writeFile(metadataPath(storageRoot, entry.key), entry.metadata)
  }
}

async function replaceStoredRepresentation(storageRoot, key, bytes, metadataUpdates = {}) {
  await fs.writeFile(objectPath(storageRoot, key), bytes)
  const sidecar = metadataPath(storageRoot, key)
  const metadata = JSON.parse(await fs.readFile(sidecar, 'utf8'))
  Object.assign(metadata, metadataUpdates)
  metadata.bodySha256 = hash(bytes)
  if (metadata.metadata?.['artifact-pages-sha256']) metadata.metadata['artifact-pages-sha256'] = hash(bytes)
  await fs.writeFile(sidecar, `${JSON.stringify(metadata)}\n`)
}

async function snapshotKeys(storageRoot, keys) {
  const result = []
  for (const key of [...keys].sort()) {
    const bytes = await fs.readFile(objectPath(storageRoot, key))
    const storedMetadata = JSON.parse(await fs.readFile(metadataPath(storageRoot, key), 'utf8'))
    result.push({
      key,
      bytes: hash(bytes),
      http: {
        contentType: storedMetadata.contentType,
        contentEncoding: storedMetadata.contentEncoding,
        contentDisposition: storedMetadata.contentDisposition,
        cacheControl: storedMetadata.cacheControl,
        metadata: storedMetadata.metadata ?? null,
      },
    })
  }
  return result
}

async function snapshotPrefixes(storageRoot, prefixes) {
  const keys = (await Promise.all(prefixes.map((prefix) => objectKeys(storageRoot, prefix)))).flat()
  return snapshotKeys(storageRoot, keys)
}

async function assertPreserved(storageRoot, beforeContent, beforeState, prefixes, stateKey, label) {
  const afterContent = await snapshotPrefixes(storageRoot, prefixes)
  const afterState = await snapshotKeys(storageRoot, [stateKey])
  if (JSON.stringify(beforeContent) !== JSON.stringify(afterContent)) {
    throw new Error(`${label}: released CLI 0.4.4 changed site content bytes or HTTP metadata`)
  }
  if (JSON.stringify(beforeState) !== JSON.stringify(afterState)) {
    throw new Error(`${label}: released CLI 0.4.4 changed committed publish-state bytes or metadata`)
  }
}

async function encodeCommittedRow(storageRoot, stateKey, key) {
  const statePath = objectPath(storageRoot, stateKey)
  const state = JSON.parse(gunzipSync(await fs.readFile(statePath)).toString('utf8'))
  const row = state.committed.objects.find((object) => object.key === key)
  if (!row) throw new Error(`seeded publish state does not contain ${key}`)
  const stored = await fs.readFile(objectPath(storageRoot, key))
  const gzip = gzipSync(stored, { level: 9, mtime: 0 })
  row.sha256 = hash(gzip)
  row.size = gzip.length
  row.contentEncoding = 'gzip'
  await replaceStoredRepresentation(storageRoot, key, gzip, { contentEncoding: 'gzip' })
  await replaceStoredRepresentation(storageRoot, stateKey, gzipSync(Buffer.from(JSON.stringify(state)), { level: 9, mtime: 0 }))
}

async function setPolicyRootMismatch(storageRoot, stateKey) {
  const statePath = objectPath(storageRoot, stateKey)
  const state = JSON.parse(gunzipSync(await fs.readFile(statePath)).toString('utf8'))
  const distinctRoot = hash(Buffer.from('ISSUE-112 policy-root-mismatch simulation'))
  state.committed.inputRoot = distinctRoot
  const stateBytes = gzipSync(Buffer.from(JSON.stringify(state)), { level: 9, mtime: 0 })
  await replaceStoredRepresentation(storageRoot, stateKey, stateBytes, {})
  const sidecar = metadataPath(storageRoot, stateKey)
  const metadata = JSON.parse(await fs.readFile(sidecar, 'utf8'))
  metadata.metadata['artifact-pages-publish-input-root'] = distinctRoot
  await fs.writeFile(sidecar, `${JSON.stringify(metadata)}\n`)
}

async function checkoutForCase(sourceRepository, target, shallow) {
  const remote = shallow ? pathToFileURL(sourceRepository).href : sourceRepository
  const args = ['clone', '--quiet']
  if (shallow) args.push('--depth=1')
  args.push(remote, target)
  run('git', args)
  git(target, ['remote', 'set-url', 'origin', 'https://github.com/example/issue112-site.git'])
  if (shallow && git(target, ['rev-parse', '--is-shallow-repository']) !== 'true') {
    throw new Error('the depth-1 file:// checkout is not shallow')
  }
}

async function main() {
  const binaryVersion = JSON.parse(run(releasedCLI, ['version', '--format', 'json']).stdout).version
  if (binaryVersion !== '0.4.4') throw new Error(`provided CLI reports ${binaryVersion}; expected released 0.4.4`)
  await fs.mkdir(localRoot, { recursive: true })
  const scratch = await fs.mkdtemp(path.join(localRoot, 'issue112-cli044-'))
  const admin = path.join(scratch, 'admin')
  const satellite = path.join(scratch, 'satellite')
  const storage = path.join(scratch, 'storage')
  const currentCLI = path.join(scratch, 'artifact-pages-current')
  const configPath = path.join(admin, 'artifact-pages.yaml')
  const indexKey = '_indexes/sre/index.json'
  const manifestKey = '_indexes/sre/search/manifest.json'
  const stateKey = '_control/sites/sre/publish-state.json.gz'
  const contentPrefixes = ['_artifacts/sre', '_indexes/sre']
  try {
    await Promise.all([
      initRepository(admin, 'https://github.com/example/issue112-admin.git'),
      initRepository(satellite, 'https://github.com/example/issue112-site.git'),
    ])
    const config = [
      'schemaVersion: 1', 'provider: local', 'local:', `  root: ${quote(storage)}`, 'sites:', '  sre:',
      '    name: ISSUE-112 regression site', '    repository: example/issue112-site', '    sourcePath: docs/artifacts', '',
    ].join('\n')
    await writeFile(admin, 'artifact-pages.yaml', config)
    await writeFile(satellite, 'artifact-pages.yaml', config)
    await writeFile(satellite, 'docs/artifacts/guide.md', '# ISSUE-112 regression fixture\n\nA small local site for the released writer compatibility check.\n')
    commit(admin)
    commit(satellite)

    run('go', ['build', '-o', currentCLI, './cli/cmd/artifact-pages'])
    run(currentCLI, ['registry', 'sync', '--config', 'artifact-pages.yaml', '--format', 'json'], { cwd: admin })
    run(currentCLI, ['site', 'sync', '--site', 'sre', '--source', 'docs/artifacts', '--config', configPath, '--format', 'json'], { cwd: satellite })

    const fixture = await captureFixture(storage, contentPrefixes, stateKey)
    const initialState = JSON.parse(gunzipSync(await fs.readFile(objectPath(storage, stateKey))).toString('utf8'))
    if (!initialState.committed.objects.some((object) => object.key === indexKey) ||
        !initialState.committed.objects.some((object) => object.key === manifestKey)) {
      throw new Error('seeded state is missing the generated index or full-text manifest')
    }

    const cases = [
      { name: 'matching-root unchanged full-checkout no-op', shallow: false, changeSource: false, rootMismatch: false, reconcile: false, expectNoOp: true },
      { name: 'changed full-checkout input', shallow: false, changeSource: true, rootMismatch: false, reconcile: false },
      { name: 'policy-root-mismatch simulation', shallow: false, changeSource: false, rootMismatch: true, reconcile: false },
      { name: 'shallow unchanged input', shallow: true, changeSource: false, rootMismatch: false, reconcile: false, shallowFailure: true },
      { name: 'shallow changed input', shallow: true, changeSource: true, rootMismatch: false, reconcile: false, shallowFailure: true },
      { name: 'explicit reconciliation', shallow: false, changeSource: false, rootMismatch: false, reconcile: true },
    ]

    for (const encodedKey of [indexKey, manifestKey]) {
      for (const testCase of cases) {
        await restoreFixture(storage, fixture, contentPrefixes, stateKey)
        await encodeCommittedRow(storage, stateKey, encodedKey)
        if (testCase.rootMismatch) await setPolicyRootMismatch(storage, stateKey)

        const working = path.join(scratch, `checkout-${hash(Buffer.from(`${encodedKey}-${testCase.name}`)).slice(0, 12)}`)
        await checkoutForCase(satellite, working, testCase.shallow)
        if (testCase.changeSource) {
          await fs.appendFile(path.join(working, 'docs/artifacts/guide.md'), '\nChanged for the ISSUE-112 0.4.4 regression.\n')
          commit(working, 'change source for ISSUE-112 regression')
        }

        const beforeContent = await snapshotPrefixes(storage, contentPrefixes)
        const beforeState = await snapshotKeys(storage, [stateKey])
        const args = ['site', 'sync', '--site', 'sre', '--source', 'docs/artifacts', '--config', configPath]
        if (testCase.reconcile) args.push('--reconcile')
        args.push('--format', 'json')
        const result = run(releasedCLI, args, { cwd: working, allowFailure: true })
        const detail = `${result.stdout}\n${result.stderr}`

        if (testCase.expectNoOp) {
          if (result.status !== 0) throw new Error(`${testCase.name} (${encodedKey}) failed:\n${detail}`)
          const report = JSON.parse(result.stdout)
          if (report.outcome !== 'no-op' || report.buildSkipped !== true || !Array.isArray(report.changes) || report.changes.length !== 0) {
            throw new Error(`${testCase.name} (${encodedKey}) returned unexpected JSON: ${result.stdout}`)
          }
        } else {
          if (result.status === 0) throw new Error(`${testCase.name} (${encodedKey}) unexpectedly succeeded:\n${detail}`)
          const expectedPolicyError = `key "${encodedKey}" has unknown HTTP policy`
          if (!detail.includes(expectedPolicyError)) {
            throw new Error(`${testCase.name} (${encodedKey}) failed without the expected policy error ${JSON.stringify(expectedPolicyError)}:\n${detail}`)
          }
          if (testCase.shallowFailure && !detail.includes('read deployed site state for shallow checkout')) {
            throw new Error(`${testCase.name} (${encodedKey}) did not fail in shallow prior-state loading:\n${detail}`)
          }
        }
        await assertPreserved(storage, beforeContent, beforeState, contentPrefixes, stateKey, `${testCase.name} (${encodedKey})`)
        console.log(`PASS: ${testCase.name}; encoded row ${encodedKey}${testCase.expectNoOp ? ' (successful no-op, content preserved)' : ' (rejected before content mutation)'}`)
      }
    }
    console.log(`fixture: ${path.relative(repository, scratch)}`)
  } catch (error) {
    console.error(`fixture retained at ${scratch}`)
    throw error
  }
}

await main()
