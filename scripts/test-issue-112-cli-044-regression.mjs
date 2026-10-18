#!/usr/bin/env node
// Black-box regression for a released CLI 0.4.4 encountering an AWS-style
// encoded site index. Download the released binary separately, then pass it
// with --cli or ARTIFACT_PAGES_CLI_044; this script never accesses a provider.
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

function commit(cwd) {
  git(cwd, ['add', '--all'])
  git(cwd, ['commit', '--quiet', '--message', 'seed ISSUE-112 regression fixture'], {
    GIT_AUTHOR_DATE: '2026-10-18T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-18T00:00:00Z',
  })
}

async function treeSnapshot(root) {
  const entries = []
  async function walk(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(filename, name)
      else if (entry.isFile()) entries.push([name, hash(await fs.readFile(filename))])
      else throw new Error(`unexpected fixture entry: ${filename}`)
    }
  }
  try { await walk(root) } catch (error) { if (error.code !== 'ENOENT') throw error }
  return entries.sort(([a], [b]) => a.localeCompare(b))
}

async function replaceStoredRepresentation(storageRoot, key, bytes, metadataUpdates) {
  const objectPath = path.join(storageRoot, ...key.split('/'))
  await fs.writeFile(objectPath, bytes)
  const metadataKey = hash(Buffer.from(key))
  const metadataPath = path.join(`${storageRoot}.metadata`, `${metadataKey}.json`)
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
  Object.assign(metadata, metadataUpdates)
  metadata.bodySha256 = hash(bytes)
  if (metadata.metadata) metadata.metadata['artifact-pages-sha256'] = hash(bytes)
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`)
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
  try {
    await Promise.all([initRepository(admin, 'https://github.com/example/issue112-admin.git'), initRepository(satellite, 'https://github.com/example/issue112-site.git')])
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

    const indexKey = '_indexes/sre/index.json'
    const stateKey = '_control/sites/sre/publish-state.json.gz'
    const indexPath = path.join(storage, ...indexKey.split('/'))
    const statePath = path.join(storage, ...stateKey.split('/'))
    const indexPlain = await fs.readFile(indexPath)
    const indexGzip = gzipSync(indexPlain, { level: 9, mtime: 0 })
    const state = JSON.parse(gunzipSync(await fs.readFile(statePath)).toString('utf8'))
    const row = state.committed.objects.find((object) => object.key === indexKey)
    if (!row) throw new Error('seeded publish state does not contain the site index row')
    row.sha256 = hash(indexGzip)
    row.size = indexGzip.length
    row.contentEncoding = 'gzip'
    const stateGzip = gzipSync(Buffer.from(JSON.stringify(state)), { level: 9, mtime: 0 })
    await replaceStoredRepresentation(storage, indexKey, indexGzip, { contentEncoding: 'gzip' })
    await replaceStoredRepresentation(storage, stateKey, stateGzip, {})

    const before = [
      await treeSnapshot(path.join(storage, '_artifacts', 'sre')),
      await treeSnapshot(path.join(storage, '_indexes', 'sre')),
    ]
    const result = run(releasedCLI, [
      'site', 'sync', '--site', 'sre', '--source', 'docs/artifacts', '--config', path.join(admin, 'artifact-pages.yaml'), '--format', 'json',
    ], { cwd: satellite, allowFailure: true })
    if (result.status === 0) throw new Error(`released CLI 0.4.4 unexpectedly accepted gzip committed state:\n${result.stdout}`)
    const detail = `${result.stdout}\n${result.stderr}`
    if (!/(encoding|gzip|JSON|index)/i.test(detail)) throw new Error(`released CLI failed for an unrelated reason:\n${detail}`)
    const after = [
      await treeSnapshot(path.join(storage, '_artifacts', 'sre')),
      await treeSnapshot(path.join(storage, '_indexes', 'sre')),
    ]
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('released CLI 0.4.4 changed site content before rejecting encoded state')
    console.log('PASS: released CLI 0.4.4 rejected encoded committed site-index state before artifact/index writes')
    console.log(`fixture: ${path.relative(repository, scratch)}`)
    console.log(`failure: ${detail.trim().split('\n').at(-1)}`)
  } catch (error) {
    console.error(`fixture retained at ${scratch}`)
    throw error
  }
}

await main()
