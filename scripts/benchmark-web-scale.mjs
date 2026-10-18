// Web reader measurements at several site sizes (T25).
//
// Generates synthetic sites under .local/web-scale/, publishes them to a local target with the
// production CLI built from this checkout (registry sync + site sync), serves the built SPA and the
// storage through the repository's nginx Compose setup, and measures the production reader with
// Playwright Chromium. It reports what was measured; it does not judge the results.
//
//   env NODE_OPTIONS= npm run benchmark:web-scale -- --counts 1000,5000,10000,50000 --iterations 3
//
// Flags: --counts, --iterations, --port (4194), --seed, --regenerate, --skip-build, --generate-only, --profiles
// (unthrottled,constrained), --only (comma list of measurement groups), --run-dir, --keep.
// --remote <origin> measures an already published deployment instead of local nginx: no generation, no
// Docker, sites named bench-<count/1000>k (publish them first with `site sync`; see the report).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { chromium } from '@playwright/test'

const repository = path.resolve(import.meta.dirname, '..')
const labRoot = path.join(repository, '.local', 'web-scale')
const project = 'claude-web-scale'

const options = {
  counts: [1000, 5000, 10000, 50000],
  iterations: 3,
  port: 4194,
  seed: 20261014,
  regenerate: false,
  'skip-build': false,
  'generate-only': false,
  keep: false,
  profiles: ['unthrottled', 'constrained'],
  only: [],
  'run-dir': '',
  remote: '',
}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const key = argv[i].replace(/^--/, '')
  if (!(key in options)) throw new Error(`Unknown option: ${argv[i]}`)
  if (typeof options[key] === 'boolean') { options[key] = true; continue }
  const value = argv[++i]
  if (value === undefined) throw new Error(`Missing value for --${key}`)
  if (key === 'counts') options.counts = value.split(',').map(Number)
  else if (key === 'profiles' || key === 'only') options[key] = value.split(',').filter(Boolean)
  else if (key === 'run-dir' || key === 'remote') options[key] = value
  else options[key] = Number(value)
}
assert(options.counts.every((n) => Number.isInteger(n) && n >= 100), 'counts must be integers of at least 100')
assert(new Set(options.counts).size === options.counts.length, 'counts must be unique')
options.counts.sort((a, b) => a - b)

const siteIdOf = (count) => (options.remote ? `bench-${count / 1000}k` : `scale-${count}`)
const dataRoot = path.resolve(labRoot, options['run-dir'] || `data-${options.seed}`)
// prepareData() deletes dataRoot; refuse anything that is not a strict child of the lab directory.
if (!options.remote && (path.dirname(dataRoot) !== labRoot || dataRoot === labRoot)) {
  throw new Error(`--run-dir must name a directory directly inside ${path.relative(repository, labRoot)}; got ${options['run-dir']}`)
}
const binary = path.join(labRoot, 'bin', 'artifact-pages')
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts)

// ---------------------------------------------------------------------------------------------
// Synthetic content
// ---------------------------------------------------------------------------------------------

const WORDS = (
  'alert archive audit backup balance batch binary bucket buffer build cache capacity certificate chart checklist cluster commit ' +
  'config connection container cost counter cursor dashboard database deadline decision deploy dependency diagram digest disk document ' +
  'domain draft endpoint environment error escalation event export failover feature field firewall flag folder gateway graph guide ' +
  'handler header health history host incident index ingress inspection instance interface inventory issue journal kernel key label ' +
  'latency layer ledger library limit listener lock log mapping memory message metric migration monitor namespace network node notice ' +
  'object offset operator outage owner package pager parser partition patch pipeline plan policy pool port postmortem priority process ' +
  'profile proxy quota queue rate readiness record region release replica report request resolver resource response restore retention ' +
  'review rollback route runbook sample schedule schema secret segment server service session shard signal snapshot source spec ' +
  'stack status storage stream summary switch table target template thread threshold timeout token topology trace traffic transfer ' +
  'trigger upgrade usage validation vendor version volume warning worker workflow zone alpha bravo charlie delta echo foxtrot golf ' +
  'hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu ' +
  'amber basalt cedar dune ember fjord glacier harbor island jungle kelp lagoon meadow nectar orchard prairie quarry ridge summit tundra ' +
  'valley willow yarrow zenith anchor beacon compass dock engine ferry gauge helm inlet jetty keel lantern mast needle oar pier quay rudder sail'
).split(' ')
const JAPANESE = [
  '障害調査ではログと応答時間を確認する。',
  '再試行の回数を設定して、失敗時の動作を記録する。',
  'この手順書は運用チームが毎月見直している。',
  'デプロイ後にヘルスチェックの結果を確認してください。',
  '容量の見積もりはピーク時の利用状況を基準にしている。',
  'バックアップから復元する前に、現在の状態を保存する。',
  '監視の通知は担当者のページャーに送られる。',
  '設定を変更したら、変更履歴に理由を書き残す。',
  'ネットワークの遅延が増えたときは、経路を切り替える。',
  'リリースノートには利用者に影響する変更だけを載せる。',
  '一時的なエラーは自動で再実行されるが、上限を超えると停止する。',
  '全文検索の対象は本文であり、見出しだけではない。',
]
const COMMON_ENGLISH = 'latency'
const COMMON_JAPANESE = '再試行'
const RARE_TERM = 'quokkaflux'
const NO_HIT_TERM = 'zzqxnohit'

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Splits a site of `count` pages between the root, the README folder, the flat folder and nested areas. */
export function siteLayout(count) {
  const rootPages = 5
  const handbook = Math.min(500, Math.floor(count / 10))
  const flat = Math.min(5000, count - rootPages - handbook - Math.floor(count / 5))
  const nested = count - rootPages - handbook - flat
  return { rootPages, handbook, flat, nested }
}

function generateSite(count, contentRoot) {
  const random = mulberry32(options.seed ^ count)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const { rootPages, handbook, flat, nested } = siteLayout(count)
  const rareStep = Math.max(1, Math.floor(count / 7))
  let written = 0
  const files = []
  function page(relativePath, kind, title, { mermaid = false, generationProbe = false, longBody = false } = {}) {
    const number = written++
    const words = Array.from({ length: 120 }, () => pick(WORDS))
    const japanese = [pick(JAPANESE), pick(JAPANESE)].join('')
    const rare = number % rareStep === 3 && number < rareStep * 7 ? ` ${RARE_TERM}` : ''
    const unique = `body-only-${String(number).padStart(6, '0')}`
    const probes = `${generationProbe ? ' vanishedgenerationprobe generationprobe' : ''}${longBody ? ` ${'longbodyprobe '.repeat(20_000)}` : ''}`
    const text = `${words.join(' ')}${rare} ${unique}${probes}`
    let bytes
    if (relativePath.endsWith('.md')) {
      const diagram = mermaid
        ? '\n\n## Routing diagram\n\n```mermaid\nflowchart LR\n  reader[Reader] --> app[Web reader]\n  app --> storage[Static projection]\n```\n'
        : ''
      bytes = longBody
        ? `# ${title}\n\n## Near 256 KiB\n\n${text}\n\n${japanese}\n`
        : `# ${title}\n\n## Summary\n\n${text.slice(0, text.length >> 1)}\n\n## Details\n\n${text.slice(text.length >> 1)}\n\n${japanese}${diagram}\n`
    } else {
      bytes = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><h2>Summary</h2><p>${text.slice(0, text.length >> 1)}</p><h2>Details</h2><p>${text.slice(text.length >> 1)}</p><p>${japanese}</p></main></body></html>\n`
    }
    files.push([relativePath, bytes])
  }
  const ext = () => (random() < 0.7 ? 'html' : 'md')
  const title = (n, label) => `Report ${String(n).padStart(6, '0')} ${label} ${pick(WORDS)} ${pick(WORDS)}`

  for (let i = 0; i < rootPages; i++) {
    const extension = ext()
    page(`overview-${i}.${i === 0 ? 'md' : extension}`, 'root', title(written, 'overview'), { mermaid: i === 0 })
  }
  // A folder with a README: its children are listed compactly, ten rows first.
  files.push(['handbook/README.md', `# Handbook\n\nThe handbook folder has a README and ${handbook} pages listed above it.\n\n${COMMON_ENGLISH} ${COMMON_JAPANESE}\n`])
  for (let i = 0; i < handbook; i++) page(`handbook/chapter-${String(i).padStart(5, '0')}.${ext()}`, 'handbook', title(written, 'handbook'))
  // One large flat folder without a README.
  for (let i = 0; i < flat; i++) {
    const largeBody = count >= 50000 && i === 0
    const extension = ext()
    page(`big-flat/page-${String(i).padStart(6, '0')}.${largeBody ? 'md' : extension}`, 'flat', title(written, 'flat'), { longBody: largeBody })
  }
  // Nested areas and sections; some have a README, some do not.
  const areas = Math.min(20, Math.max(2, Math.ceil(nested / 50)))
  const leaves = Math.ceil(nested / 50)
  let generationPages = count >= 50000 ? 525 : 0
  for (let leaf = 0, remaining = nested; leaf < leaves; leaf++) {
    const area = leaf % areas, section = Math.floor(leaf / areas)
    const base = `area-${String(area).padStart(2, '0')}/section-${String(section).padStart(3, '0')}`
    if (section === 0 && area % 2 === 0) files.push([`area-${String(area).padStart(2, '0')}/README.md`, `# Area ${area}\n\nOverview of area ${area}.\n`])
    if (leaf % 3 === 0) files.push([`${base}/README.md`, `# Section ${area}.${section}\n\nOverview of section ${section} in area ${area}.\n`])
    const here = Math.min(50, remaining)
    remaining -= here
    for (let i = 0; i < here; i++) {
      const extension = ext()
      if (generationPages > 0) {
        const target = 525 - generationPages
        page(`000-generation/target-${String(target).padStart(3, '0')}.md`, 'generation', title(written, 'generation'), {
          generationProbe: true,
        })
        generationPages--
      } else {
        page(`${base}/note-${String(i).padStart(3, '0')}.${extension}`, 'nested', title(written, 'note'))
      }
    }
  }
  const folders = new Map()
  let htmlPages = 0, mdPages = 0, totalBytes = 0, pageBytes = 0, jpChars = 0, textChars = 0
  for (const [relativePath, bytes] of files) {
    const parts = relativePath.split('/')
    for (let depth = 1; depth < parts.length; depth++) folders.set(parts.slice(0, depth).join('/'), folders.get(parts.slice(0, depth).join('/')) ?? false)
    if (parts.at(-1) === 'README.md') folders.set(parts.slice(0, -1).join('/'), true)
    totalBytes += Buffer.byteLength(bytes)
    if (parts.at(-1) === 'README.md') continue
    pageBytes += Buffer.byteLength(bytes)
    if (relativePath.endsWith('.md')) mdPages++; else htmlPages++
    const plain = bytes.replace(/<[^>]*>/g, ' ')
    textChars += [...plain].length
    jpChars += [...plain].filter((c) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(c)).length
  }
  const readmeFolders = [...folders.values()].filter(Boolean).length
  const shape = {
    htmlPages, mdPages, folders: folders.size, readmeFolders, foldersWithoutReadme: folders.size - readmeFolders,
    maxFolderDepth: Math.max(...[...folders.keys()].map((f) => f.split('/').length)),
    japaneseShareOfCharacters: jpChars / textChars, averagePageBytes: pageBytes / written, sourceBytes: totalBytes,
  }
  assert.equal(written, count, `site layout wrote ${written} pages instead of ${count}`)
  for (const [relativePath, bytes] of files) {
    const target = path.join(contentRoot, relativePath)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, bytes)
  }
  return { pages: written, files: files.length, shape, layout: { rootPages, handbook, flat, nested, areas, leaves } }
}

// ---------------------------------------------------------------------------------------------
// Generation and publication with the production CLI
// ---------------------------------------------------------------------------------------------

function run(command, args, { cwd = repository, env = process.env, maxBuffer = 1 << 28 } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
const git = (cwd, args, env = {}) => run('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } }).trim()

function yamlConfig(root, ids) {
  const lines = ['schemaVersion: 1', 'provider: local', 'local:', `  root: ${JSON.stringify(root)}`, 'sites:']
  for (const id of ids) {
    const count = Number(id.replace('scale-', ''))
    lines.push(`  ${id}:`, `    name: Scale ${count.toLocaleString('en-US')} pages`, `    description: Synthetic site of ${count.toLocaleString('en-US')} pages for web reader measurements.`,
      '    repository: example/web-scale-satellite', `    sourcePath: sites/${id}/content`)
  }
  return `${lines.join('\n')}\n`
}

function dirSize(dir) {
  let bytes = 0, files = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { const inner = dirSize(full); bytes += inner.bytes; files += inner.files }
    else { bytes += statSync(full).size; files += 1 }
  }
  return { bytes, files }
}

function timed(fn) {
  const started = performance.now()
  const value = fn()
  return { value, ms: performance.now() - started }
}

function prepareData() {
  const manifestFile = path.join(dataRoot, 'prepare.json')
  if (!options.regenerate && existsSync(manifestFile)) {
    const previous = JSON.parse(readFileSync(manifestFile, 'utf8'))
    if (JSON.stringify(previous.counts) === JSON.stringify(options.counts) && previous.seed === options.seed && previous.generatorVersion === 2) {
      log(`Reusing generated data in ${path.relative(repository, dataRoot)}`)
      return previous
    }
  }
  rmSync(dataRoot, { recursive: true, force: true })
  mkdirSync(dataRoot, { recursive: true })
  const satellite = path.join(dataRoot, 'satellite'), admin = path.join(dataRoot, 'admin')
  mkdirSync(satellite, { recursive: true }); mkdirSync(admin, { recursive: true })
  const report = { counts: options.counts, seed: options.seed, generatorVersion: 2, sites: {}, combined: {} }

  for (const count of options.counts) {
    const generated = timed(() => generateSite(count, path.join(satellite, 'sites', siteIdOf(count), 'content')))
    report.sites[siteIdOf(count)] = { ...generated.value, generateMs: generated.ms }
    log(`${siteIdOf(count)}: wrote ${generated.value.pages} pages in ${(generated.ms / 1000).toFixed(1)} s`)
  }
  for (const [cwd, remote] of [[satellite, 'https://github.com/example/web-scale-satellite.git'], [admin, 'https://github.com/example/web-scale-admin.git']]) {
    git(cwd, ['init', '--initial-branch=main'])
    git(cwd, ['remote', 'add', 'origin', remote])
    git(cwd, ['config', 'user.name', 'Web Scale Benchmark'])
    git(cwd, ['config', 'user.email', 'web-scale@example.invalid'])
  }
  // One config per measured site (its own storage root), plus one with every site.
  const allIds = options.counts.map(siteIdOf)
  const configs = [...allIds.map((id) => ({ name: id, ids: [id] })), { name: 'all', ids: allIds }]
  for (const config of configs) writeFileSync(path.join(admin, `artifact-pages-${config.name}.yaml`), yamlConfig(path.join(dataRoot, `storage-${config.name}`), config.ids))
  const env = { GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' }
  const commit = timed(() => {
    git(satellite, ['add', '--all']); git(satellite, ['commit', '--quiet', '--message', 'synthetic sites'], env)
    git(admin, ['add', '--all']); git(admin, ['commit', '--quiet', '--message', 'configs'], env)
  })
  log(`git commit of generated sources: ${(commit.ms / 1000).toFixed(1)} s`)
  report.commitMs = commit.ms

  const sync = (cwd, args) => JSON.parse(run(binary, [...args, '--format', 'json'], { cwd }))
  for (const config of configs) {
    const configPath = path.join(admin, `artifact-pages-${config.name}.yaml`)
    const registry = timed(() => sync(admin, ['registry', 'sync', '--config', `artifact-pages-${config.name}.yaml`]))
    assert.equal(registry.value.outcome, 'synced', `registry sync ${config.name}`)
    const entry = { registrySyncMs: registry.ms, sites: {} }
    for (const id of config.ids) {
      const published = timed(() => sync(satellite, ['site', 'sync', '--site', id, '--source', `sites/${id}/content`, '--config', path.relative(satellite, configPath)]))
      assert.equal(published.value.outcome, 'synced', `site sync ${id}: ${published.value.outcome}`)
      const indexes = path.join(dataRoot, `storage-${config.name}`, '_indexes', id)
      const search = existsSync(path.join(indexes, 'search')) ? dirSize(path.join(indexes, 'search')) : { bytes: 0, files: 0 }
      entry.sites[id] = {
        siteSyncMs: published.ms,
        indexJsonBytes: statSync(path.join(indexes, 'index.json')).size,
        indexJsonGzipBytes: gzipSync(readFileSync(path.join(indexes, 'index.json'))).length,
        metaJsonBytes: statSync(path.join(indexes, 'meta.json')).size,
        searchBytes: search.bytes,
        searchFiles: search.files,
      }
      log(`${config.name}: site sync ${id} in ${(published.ms / 1000).toFixed(1)} s; index.json ${(entry.sites[id].indexJsonBytes / 1e6).toFixed(2)} MB; search ${search.files} files ${(search.bytes / 1e6).toFixed(2)} MB`)
    }
    report.combined[config.name] = entry
  }
  writeFileSync(manifestFile, JSON.stringify(report, null, 2))
  return report
}

function generateSourcesOnly() {
  rmSync(dataRoot, { recursive: true, force: true })
  const satellite = path.join(dataRoot, 'satellite')
  mkdirSync(satellite, { recursive: true })
  const sites = {}
  for (const count of options.counts) {
    const generated = generateSite(count, path.join(satellite, 'sites', siteIdOf(count), 'content'))
    sites[siteIdOf(count)] = generated
    log(`${siteIdOf(count)}: wrote ${generated.pages} pages (${generated.files} source files)`)
  }
  git(satellite, ['init', '--initial-branch=main'])
  git(satellite, ['remote', 'add', 'origin', 'https://github.com/example/web-scale-satellite.git'])
  git(satellite, ['config', 'user.name', 'Web Scale Benchmark'])
  git(satellite, ['config', 'user.email', 'web-scale@example.invalid'])
  git(satellite, ['add', '--all'])
  git(satellite, ['commit', '--quiet', '--message', 'synthetic sites'], {
    GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z',
  })
  return { counts: options.counts, seed: options.seed, generatorVersion: 2, sites }
}

/** Build the changed search generation once; the browser suite swaps only its immutable search files. */
function prepareGenerationVariant(siteId) {
  if (options.remote) throw new Error('search-cases requires local nginx')
  const satellite = path.join(dataRoot, 'satellite')
  const admin = path.join(dataRoot, 'admin')
  const sourceFile = path.join(satellite, 'sites', siteId, 'content', '000-generation', 'target-000.md')
  git(satellite, ['checkout', '--', `sites/${siteId}/content/000-generation/target-000.md`])
  const originalSource = readFileSync(sourceFile, 'utf8')
  assert.match(originalSource, /vanishedgenerationprobe/, 'generation probe must exist in target-000.md')

  const baseSearch = path.join(dataRoot, `storage-${siteId}`, '_indexes', siteId, 'search')
  const baseSearchCopy = path.join(dataRoot, 'search-generation-a', siteId)
  const baselineRoot = path.join(dataRoot, 'storage-generation-a-build')
  const baselineConfigName = 'artifact-pages-generation-a.yaml'
  const baselineConfigPath = path.join(admin, baselineConfigName)
  const baselineSearch = path.join(baselineRoot, '_indexes', siteId, 'search')
  const changedRoot = path.join(dataRoot, 'storage-generation-b')
  const changedConfigName = 'artifact-pages-generation-b.yaml'
  const changedConfigPath = path.join(admin, changedConfigName)
  const changedSearch = path.join(changedRoot, '_indexes', siteId, 'search')
  const liveSearch = baseSearch
  rmSync(baselineRoot, { recursive: true, force: true })
  rmSync(changedRoot, { recursive: true, force: true })
  rmSync(path.dirname(baseSearchCopy), { recursive: true, force: true })
  writeFileSync(baselineConfigPath, yamlConfig(baselineRoot, [siteId]))
  const baselineConfigArg = path.relative(satellite, baselineConfigPath)
  const baselineRegistry = JSON.parse(run(binary, ['registry', 'sync', '--config', baselineConfigName, '--format', 'json'], { cwd: admin }))
  assert.equal(baselineRegistry.outcome, 'synced', 'registry sync generation A')
  const baselinePublished = JSON.parse(run(binary, ['site', 'sync', '--site', siteId, '--source', `sites/${siteId}/content`, '--config', baselineConfigArg, '--format', 'json'], { cwd: satellite }))
  assert.equal(baselinePublished.outcome, 'synced', `site sync generation A: ${baselinePublished.outcome}`)
  assert.ok(existsSync(path.join(baselineSearch, 'manifest.json')), 'generation A manifest was not published')
  cpSync(baselineSearch, baseSearchCopy, { recursive: true })
  replaceSearchGeneration({ liveSearch }, baseSearchCopy)
  rmSync(baselineRoot, { recursive: true, force: true })
  const baseManifest = JSON.parse(readFileSync(path.join(baseSearchCopy, 'manifest.json'), 'utf8'))
  assert.ok(Array.isArray(baseManifest.texts) && baseManifest.texts.length > 0, 'search manifest should include text packs')
  const maxTextPackRawBytes = Math.max(0, ...baseManifest.texts.map((pack) => pack.rawBytes))
  // The long body exceeds the per-document cap, but at 50,000 pages the site snippet budget can omit it first.
  const limits = baseManifest.snippetLimits ?? {}
  const longBodySnippet = limits.truncatedDocuments?.includes('big-flat/page-000000.md') ? 'truncated'
    : limits.omittedDocuments?.includes('big-flat/page-000000.md') ? 'omitted' : 'included'
  writeFileSync(changedConfigPath, yamlConfig(changedRoot, [siteId]))

  const configArg = path.relative(satellite, changedConfigPath)
  const registry = JSON.parse(run(binary, ['registry', 'sync', '--config', changedConfigName, '--format', 'json'], { cwd: admin }))
  assert.equal(registry.outcome, 'synced', 'registry sync generation B')
  writeFileSync(sourceFile, originalSource.replaceAll('vanishedgenerationprobe', 'generationchanged'))
  try {
    const published = JSON.parse(run(binary, ['site', 'sync', '--site', siteId, '--source', `sites/${siteId}/content`, '--config', configArg, '--format', 'json'], { cwd: satellite }))
    assert.equal(published.outcome, 'synced', `site sync generation B: ${published.outcome}`)
  } finally {
    writeFileSync(sourceFile, originalSource)
  }
  assert.ok(existsSync(path.join(changedSearch, 'manifest.json')), 'generation B manifest was not published')
  const changedManifest = JSON.parse(readFileSync(path.join(changedSearch, 'manifest.json'), 'utf8'))
  assert.notEqual(changedManifest.generation, baseManifest.generation, 'generation B must have a different search generation')
  return {
    liveSearch, baseSearch: baseSearchCopy, changedSearch,
    stressInput: {
      longBodyPath: 'big-flat/page-000000.md',
      longBodyBytes: statSync(path.join(satellite, 'sites', siteId, 'content', 'big-flat', 'page-000000.md')).size,
      maxTextPackRawBytes,
      longBodySnippet,
      snippetOmittedDocuments: limits.omittedDocuments?.length ?? 0,
      snippetTruncatedDocuments: limits.truncatedDocuments?.length ?? 0,
      generationHitsBeforeChange: 525,
    },
  }
}

function replaceSearchGeneration(variant, source) {
  rmSync(variant.liveSearch, { recursive: true, force: true })
  cpSync(source, variant.liveSearch, { recursive: true })
}

// ---------------------------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------------------------

function compose(storageRoot, command) {
  if (options.remote) return ''
  mkdirSync(path.join(labRoot, 'previews'), { recursive: true })
  return execFileSync('docker', ['compose', '-p', project, '-f', path.join(repository, 'docker-compose.yml'), ...command], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, WEB_PORT: String(options.port), WEB_ROOT: path.join(repository, 'web', 'dist'), STORAGE_ROOT: storageRoot, PREVIEW_ROOT: path.join(labRoot, 'previews') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
let servedRoot = ''
async function serve(name) {
  if (options.remote) return
  const storageRoot = path.join(dataRoot, `storage-${name}`)
  if (servedRoot === storageRoot) return
  compose(storageRoot, ['up', '-d', '--force-recreate', '--quiet-pull'])
  servedRoot = storageRoot
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${options.port}/_indexes/sites.json`)
      if (response.ok) return
    } catch { /* nginx is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('nginx did not start')
}
const origin = () => (options.remote ? options.remote.replace(/\/$/, '') : `http://127.0.0.1:${options.port}`)

// ---------------------------------------------------------------------------------------------
// Browser measurement
// ---------------------------------------------------------------------------------------------

const PROFILES = {
  unthrottled: { cpuRate: 1, network: null },
  constrained: { cpuRate: 4, network: { offline: false, latency: 150, downloadThroughput: (1.6 * 1e6) / 8, uploadThroughput: (0.75 * 1e6) / 8 } },
}

// Installed before any page script: records when named selectors first appear (after two frames) and lets
// the harness time an action until a condition holds.
const INIT_SCRIPT = `(() => {
  const watched = { picker: '.site-picker-row', directory: '[data-testid="directory-page"]', workspace: '.sidebar-panel',
    results: '.search-page-result:not(.search-page-skeleton), .search-page-empty' }
  window.__t = {}
  window.__longTasks = []
  window.__longTasksSupported = false
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__longTasks.push({ startTime: entry.startTime, duration: entry.duration })
    }).observe({ type: 'longtask', buffered: true })
    window.__longTasksSupported = true
  } catch { /* Long Tasks API is not exposed in every Chromium build. */ }
  const seen = new Set()
  const check = () => {
    for (const [name, selector] of Object.entries(watched)) {
      if (seen.has(name) || !document.querySelector(selector)) continue
      seen.add(name)
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__t[name] = performance.now() }))
    }
  }
  new MutationObserver(check).observe(document, { childList: true, subtree: true })
  let fcp = null
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') fcp = e.startTime }).observe({ type: 'paint', buffered: true }) } catch { /* unsupported */ }
  window.__fcp = () => fcp ?? (performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null)
  window.__count = (selector) => document.querySelectorAll(selector).length
  window.__dom = () => document.getElementsByTagName('*').length
  // Runs \`act\`, then waits until \`ready()\` is true and two frames have been painted; resolves with the elapsed ms.
  window.__timed = (act, ready, timeout) => new Promise((resolve) => {
    const t0 = performance.now()
    act()
    const tick = () => {
      let ok = false
      try { ok = ready() } catch { ok = false }
      if (ok) requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ms: performance.now() - t0 })))
      else if (performance.now() - t0 > timeout) resolve({ ms: null, timeout: true })
      else requestAnimationFrame(tick)
    }
    tick()
  })
})()`

async function newSession(browser, profileName, { track = true } = {}) {
  const profile = PROFILES[profileName]
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await context.addInitScript(INIT_SCRIPT)
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false })
  await cdp.send('Runtime.enable')
  if (profile.network) await cdp.send('Network.emulateNetworkConditions', profile.network)
  if (profile.cpuRate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuRate })
  const requests = new Map()
  cdp.on('Network.requestWillBeSent', (event) => requests.set(event.requestId, { url: event.request.url, type: event.type, raw: 0, encoded: 0, status: 0, done: false, at: Date.now(), active: Date.now() }))
  cdp.on('Network.responseReceived', (event) => { const r = requests.get(event.requestId); if (r) { r.status = event.response.status; r.active = Date.now(); r.fromCache = event.response.fromDiskCache || event.response.fromPrefetchCache } })
  cdp.on('Network.dataReceived', (event) => { const r = requests.get(event.requestId); if (r) { r.raw += event.dataLength; r.active = Date.now() } })
  cdp.on('Network.loadingFinished', (event) => { const r = requests.get(event.requestId); if (r) { r.encoded = event.encodedDataLength; r.done = true; r.active = Date.now() } })
  cdp.on('Network.loadingFailed', (event) => { const r = requests.get(event.requestId); if (r) { r.failed = true; r.done = true } })
  let peak = 0, sampler = null
  const sample = async () => {
    try { const { usedSize } = await cdp.send('Runtime.getHeapUsage'); if (usedSize > peak) peak = usedSize } catch { /* page navigating */ }
  }
  if (track) sampler = setInterval(sample, 100)
  const session = {
    context, page, cdp, requests,
    /** Requests recorded since `since` (a length returned by `mark`). */
    mark: () => requests.size,
    since: (from) => [...requests.values()].slice(from),
    async waitForTti(from, quietMs = 5000, timeoutMs = SLOW_TIMEOUT) {
      const started = Date.now()
      for (;;) {
        const state = await page.evaluate(() => ({
          readyState: document.readyState,
          fcp: window.__fcp?.(),
          now: performance.now(),
          timeOrigin: performance.timeOrigin,
          lastLongTaskEnd: Math.max(0, ...(window.__longTasks ?? []).map((task) => task.startTime + task.duration)),
        }))
        const current = [...requests.values()].slice(from)
        const pending = current.filter((request) => !request.done).length
        const lastNetworkWall = Math.max(0, ...current.map((request) => request.active))
        const lastLongTaskWall = state.lastLongTaskEnd ? state.timeOrigin + state.lastLongTaskEnd : 0
        const quietSince = Math.max(lastNetworkWall, lastLongTaskWall)
        // Report when the quiet window began, not when it was confirmed (that would add quietMs to every value).
        if (state.readyState === 'complete' && state.fcp !== null && pending <= 2 && quietSince > 0 && Date.now() - quietSince >= quietMs) return Math.max(state.fcp, quietSince - state.timeOrigin)
        if (Date.now() - started > timeoutMs) throw new Error(`time to interactive proxy timed out after ${timeoutMs} ms`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    },
    async longTasks(fromTime = 0) {
      return page.evaluate((start) => {
        const end = performance.now()
        const tasks = (window.__longTasks ?? []).filter((task) => task.startTime + task.duration >= start && task.startTime <= end)
        return {
          supported: window.__longTasksSupported,
          count: tasks.length,
          durationMs: tasks.reduce((total, task) => total + task.duration, 0),
          maxMs: Math.max(0, ...tasks.map((task) => task.duration)),
        }
      }, fromTime)
    },
    heapPeak: () => peak,
    async heapAfterGC() {
      await cdp.send('HeapProfiler.collectGarbage')
      await cdp.send('HeapProfiler.collectGarbage')
      const { usedSize } = await cdp.send('Runtime.getHeapUsage')
      if (usedSize > peak) peak = usedSize
      return usedSize
    },
    async settle(quietMs = 800, maxMs = SETTLE_MAX_MS) {
      const started = Date.now()
      let lastChange = Date.now(), last = -1
      while (Date.now() - started < maxMs) {
        // A response whose body has been silent for 3 s (for example an aborted 404) no longer holds the network busy.
        const pending = [...requests.values()].filter((r) => !r.done && !(r.status && Date.now() - r.active > 3000)).length
        const signature = `${requests.size}:${pending}`
        if (signature !== last) { last = signature; lastChange = Date.now() }
        if (pending === 0 && Date.now() - lastChange >= quietMs) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`network did not settle; pending: ${[...requests.values()].filter((r) => !r.done).map((r) => r.url).join(', ')}`)
    },
    async close() { if (sampler) clearInterval(sampler); await context.close() },
  }
  return session
}

const median = (values) => {
  const sorted = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const maximum = (values) => {
  const list = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(v))
  return list.length ? Math.max(...list) : null
}
const sum = (list, key) => list.reduce((total, item) => total + (item[key] ?? 0), 0)
const pathOf = (url) => new URL(url).pathname

let remoteIndexHtml = ''
function entryScripts() {
  const html = options.remote ? remoteIndexHtml : readFileSync(path.join(repository, 'web', 'dist', 'index.html'), 'utf8')
  const found = new Set()
  for (const match of html.matchAll(/(?:src|href)="([^"]+\.js)"/g)) found.add(match[1])
  return found
}

const step = (name) => { if (process.env.WEB_SCALE_VERBOSE) log('  step:', name) }
const SLOW_TIMEOUT = Number(process.env.WEB_SCALE_TIMEOUT_MS) || 20 * 60 * 1000
const SETTLE_MAX_MS = Number(process.env.WEB_SCALE_SETTLE_MS) || 15 * 60 * 1000
const DIRECTORY_ROWS = '[data-testid="directory-page"] [data-directory-page], [data-testid="directory-page"] [data-directory-folder]'

async function timedAction(page, act, ready, args = {}) {
  return page.evaluate(({ act: actSource, ready: readySource, args: a, timeout }) => {
    const actions = {
      click: (selector) => () => document.querySelector(selector).click(),
      type: (selector, value) => () => {
        const input = document.querySelector(selector)
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      },
      navigate: (href) => () => { history.pushState({}, '', href); dispatchEvent(new PopStateEvent('popstate')) },
    }
    const eyebrowEnds = (suffix) => () => { const e = document.querySelector('[data-testid="directory-page"] .directory-eyebrow'); return !!e && e.textContent.endsWith(suffix) }
    const conditions = {
      count: (selector, min) => () => document.querySelectorAll(selector).length >= min,
      directoryOf: (folder, minRows, needsBody) => () => eyebrowEnds(`${folder}/`)() && document.querySelectorAll('[data-testid="directory-page"] [data-directory-page]').length >= minRows
        && (!needsBody || (document.querySelector('[data-testid="directory-page"] .directory-body')?.textContent ?? '').length > 0),
      siteRoot: () => () => !!document.querySelector('[data-testid="directory-page"] .site-home-heading, [data-testid="directory-page"] .directory-header') && document.querySelectorAll('[data-testid="directory-page"] [data-directory-folder]').length > 0,
      exists: (selector) => () => !!document.querySelector(selector),
    }
    return window.__timed(actions[actSource.name](...actSource.args), conditions[readySource.name](...readySource.args), timeout)
  }, { act, ready, args, timeout: SLOW_TIMEOUT })
}

async function clearInput(page, selector) {
  await page.evaluate((sel) => {
    const input = document.querySelector(sel)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, selector)
}

const entrySet = () => entryScripts()

/** Group 1: first load of `/`, cold (fresh context, empty HTTP cache) then warm (second visit in the same context). */
async function measureFirstLoad(browser, profile, siteId) {
  const session = await newSession(browser, profile, { track: false })
  const { page } = session
  const entries = entrySet()
  async function visit() {
    const from = session.mark()
    const started = Date.now()
    await page.goto(`${origin()}/`, { waitUntil: 'commit' })
    await page.waitForFunction(() => window.__t && window.__t.picker !== undefined, null, { timeout: SLOW_TIMEOUT })
    const t = await page.evaluate(() => ({ picker: window.__t.picker }))
    const bytesCompletedAtPicker = sum(session.since(from).filter((r) => r.done), 'encoded')
    await session.settle()
    t.tti = await session.waitForTti(from)
    t.fcp = await page.evaluate(() => window.__fcp())
    const all = session.since(from)
    const entryJs = all.filter((r) => entries.has(pathOf(r.url)))
    const indexes = all.filter((r) => pathOf(r.url).startsWith('/_indexes/'))
    return {
      fcpMs: t.fcp,
      siteListVisibleMs: t.picker,
      timeToInteractiveProxyMs: t.tti,
      completedBytesAtListVisible: bytesCompletedAtPicker,
      transferredBytesTotal: sum(all, 'encoded'),
      rawBytesTotal: sum(all, 'raw'),
      requests: all.length,
      requestsFromCache: all.filter((r) => r.fromCache).length,
      entryJsEncodedBytes: sum(entryJs, 'encoded'),
      entryJsRawBytes: sum(entryJs, 'raw'),
      indexFetches: indexes.map((r) => ({ path: pathOf(r.url), encoded: r.encoded, raw: r.raw })),
      indexBytesEncoded: sum(indexes, 'encoded'),
      indexBytesRaw: sum(indexes, 'raw'),
      settledMs: Date.now() - started,
      heapAfterGC: await session.heapAfterGC(),
    }
  }
  try {
    const cold = await visit()
    const warm = await visit()
    return { cold, warm }
  } finally { await session.close() }
}

/** First Mermaid SVG render from the generated Markdown artifact, cold and then warm in one context. */
async function measureMermaid(browser, profile, siteId) {
  if (options.remote) {
    const timeout = Math.min(SLOW_TIMEOUT, 15_000)
    const request = (url) => fetch(url, { signal: AbortSignal.timeout(timeout) })
    const unavailable = (reason) => ({ measurable: false, reason })
    let indexResponse
    try { indexResponse = await request(`${origin()}/_indexes/${siteId}/index.json`) }
    catch (error) { return unavailable(`site index unavailable: ${error.name}`) }
    if (!indexResponse.ok) return unavailable(`site index returned HTTP ${indexResponse.status}`)
    let index
    try { index = await indexResponse.json() }
    catch { return unavailable('site index was not valid JSON') }
    const artifacts = Array.isArray(index.artifacts) ? index.artifacts : []
    const artifact = artifacts.find((entry) => entry.path?.replace(/^\/+/, '') === 'overview-0.md')
    if (!artifact) return unavailable('overview-0.md is not published')
    const artifactUrl = artifact.artifactUrl ?? `/_artifacts/${siteId}/${artifact.path}`
    let artifactResponse
    try { artifactResponse = await request(new URL(artifactUrl, origin())) }
    catch (error) { return unavailable(`overview-0.md unavailable: ${error.name}`) }
    if (!artifactResponse.ok) return unavailable(`overview-0.md returned HTTP ${artifactResponse.status}`)
    let markdown
    try { markdown = await artifactResponse.text() }
    catch (error) { return unavailable(`overview-0.md unavailable: ${error.name}`) }
    if (!/```\s*mermaid\b/i.test(markdown)) return unavailable('overview-0.md has no Mermaid diagram')
  }
  const session = await newSession(browser, profile)
  const { page } = session
  const href = `${origin()}/${siteId}/overview-0.md`
  async function visit() {
    const from = session.mark()
    const started = Date.now()
    await page.goto(href, { waitUntil: 'commit' })
    // The reader can give up instead (site index deadline); record that rather than waiting for the timeout.
    await page.waitForFunction(() => !!document.querySelector('.markdown-diagram svg') || /Unable to load this site/.test(document.body?.innerText ?? ''), null, { timeout: SLOW_TIMEOUT })
    const failed = await page.evaluate(() => !document.querySelector('.markdown-diagram svg'))
    if (failed) {
      const current = session.since(from)
      return {
        failed: 'reader error: unable to load this site',
        failedAtMs: await page.evaluate(() => performance.now()),
        abortedRequests: current.filter((r) => r.failed).map((r) => pathOf(r.url)),
        totalEncodedBytes: sum(current, 'encoded'),
        requests: current.length,
        settledMs: Date.now() - started,
      }
    }
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const rendered = await page.evaluate(() => ({ renderMs: performance.now(), type: document.querySelector('.markdown-diagram')?.getAttribute('data-diagram-type') ?? null }))
    await session.settle()
    const current = session.since(from)
    const tasks = await session.longTasks(0)
    return {
      firstMermaidRenderMs: rendered.renderMs,
      diagramType: rendered.type,
      totalEncodedBytes: sum(current, 'encoded'),
      totalRawBytes: sum(current, 'raw'),
      requests: current.length,
      settledMs: Date.now() - started,
      mainThreadLongTasks: tasks,
    }
  }
  try {
    const cold = await visit()
    const warm = await visit()
    return { cold, warm }
  } finally { await session.close() }
}

/** Groups 2-5: open the site from a cold deep link, then sidebar and directory pages in the same session. */
async function measureSiteSession(browser, profile, siteId, layout) {
  const session = await newSession(browser, profile)
  const { page } = session
  const result = {}
  try {
    // Open the site.
    const openFrom = session.mark()
    await page.goto(`${origin()}/${siteId}`, { waitUntil: 'commit' })
    await page.waitForFunction(() => window.__t && window.__t.directory !== undefined, null, { timeout: SLOW_TIMEOUT })
    const opened = await page.evaluate(() => ({ directoryMs: window.__t.directory, workspaceMs: window.__t.workspace }))
    await session.settle()
    opened.fcp = await page.evaluate(() => window.__fcp())
    const fetched = session.since(openFrom)
    const find = (name) => fetched.find((r) => pathOf(r.url) === `/_indexes/${siteId}/${name}`)
    const index = find('index.json'), meta = find('meta.json')
    result.open = {
      siteHomeRenderedMs: opened.directoryMs,
      workspaceMountedMs: opened.workspaceMs,
      fcpMs: opened.fcp,
      indexJsonEncoded: index?.encoded ?? null, indexJsonRaw: index?.raw ?? null,
      metaJsonEncoded: meta?.encoded ?? null, metaJsonRaw: meta?.raw ?? null,
      totalEncoded: sum(fetched, 'encoded'),
      requests: fetched.length,
      dom: await page.evaluate(() => window.__dom()),
      rootRows: await page.evaluate((sel) => window.__count(sel), DIRECTORY_ROWS),
      sidebarRows: await page.evaluate(() => window.__count('.sidebar-panel a.tree-artifact, .sidebar-panel .tree-directory-link')),
      heapAfterGC: await session.heapAfterGC(),
    }

    step('sidebar expand')
    // Sidebar: expand the large folder, collapse it, then filter with a broad term.
    const expandSelector = 'button[data-tree-path="big-flat"]'
    const before = await page.evaluate(() => window.__count('.sidebar-panel a.tree-artifact'))
    const expand = await timedAction(page, { name: 'click', args: [expandSelector] }, { name: 'count', args: ['.sidebar-panel a.tree-artifact', before + 1] })
    result.sidebarExpand = { ms: expand.ms, timeout: expand.timeout ?? false, rows: await page.evaluate(() => window.__count('.sidebar-panel a.tree-artifact')) }
    await page.evaluate((sel) => document.querySelector(sel).click(), expandSelector)
    await page.waitForFunction((n) => document.querySelectorAll('.sidebar-panel a.tree-artifact').length === n, before, { timeout: SLOW_TIMEOUT })

    step('sidebar filter')
    const filter = await timedAction(page, { name: 'type', args: ['#sidebar-filter', 'report'] }, { name: 'count', args: ['.sidebar-panel .filter-results a.tree-artifact', 1] })
    // The filtered tree renders on the next commit; settle on a stable row count.
    let rows = -1
    for (let i = 0; i < 50; i++) {
      const now = await page.evaluate(() => window.__count('.sidebar-panel .filter-results a.tree-artifact'))
      if (now === rows) break
      rows = now
      await page.waitForTimeout(200)
    }
    result.sidebarFilter = { term: 'report', ms: filter.ms, timeout: filter.timeout ?? false, rows, dom: await page.evaluate(() => window.__dom()) }
    await clearInput(page, '#sidebar-filter')
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-panel .filter-results').length === 0, null, { timeout: SLOW_TIMEOUT })

    // Directory page of the large folder without a README (opened from the site root list).
    const flatRowsExpected = layout.flat
    step('directory without README')
    const flat = await timedAction(page, { name: 'click', args: ['a[data-directory-folder="big-flat"]'] }, { name: 'directoryOf', args: ['big-flat', 1, false] })
    result.directoryNoReadme = {
      folder: 'big-flat', pagesInFolder: flatRowsExpected,
      ms: flat.ms, timeout: flat.timeout ?? false,
      rows: await page.evaluate((sel) => window.__count(sel), DIRECTORY_ROWS),
      dom: await page.evaluate(() => window.__dom()),
      sidebarRows: await page.evaluate(() => window.__count('.sidebar-panel a.tree-artifact')),
    }

    // Directory page of a folder with a README, before and after "Show all".
    step('directory with README')
    const handbook = await timedAction(page, { name: 'click', args: ['a[data-tree-folder="handbook"]'] }, { name: 'directoryOf', args: ['handbook', 1, true] })
    const rowsBefore = await page.evaluate((sel) => window.__count(sel), DIRECTORY_ROWS)
    const domBefore = await page.evaluate(() => window.__dom())
    const total = layout.handbook
    step('show all')
    const showAll = await timedAction(page, { name: 'click', args: ['button.directory-more'] }, { name: 'count', args: [DIRECTORY_ROWS, total] })
    result.directoryReadme = {
      folder: 'handbook', pagesInFolder: total,
      renderMs: handbook.ms, renderTimeout: handbook.timeout ?? false, rowsBefore, domBefore,
      showAllMs: showAll.ms, showAllTimeout: showAll.timeout ?? false,
      rowsAfter: await page.evaluate((sel) => window.__count(sel), DIRECTORY_ROWS),
      domAfter: await page.evaluate(() => window.__dom()),
    }
    result.heapAfterSession = await session.heapAfterGC()
    result.heapPeak = session.heapPeak()
    // Warm: a second visit to the site in the same context (HTTP cache filled by the session above).
    const warmFrom = session.mark()
    await page.goto(`${origin()}/${siteId}`, { waitUntil: 'commit' })
    await page.waitForFunction(() => window.__t && window.__t.directory !== undefined, null, { timeout: SLOW_TIMEOUT })
    const warmOpened = await page.evaluate(() => ({ directoryMs: window.__t.directory, workspaceMs: window.__t.workspace }))
    await session.settle()
    warmOpened.fcp = await page.evaluate(() => window.__fcp())
    const warmFetched = session.since(warmFrom)
    const warmIndex = warmFetched.find((r) => pathOf(r.url) === `/_indexes/${siteId}/index.json`)
    result.openWarm = {
      siteHomeRenderedMs: warmOpened.directoryMs, workspaceMountedMs: warmOpened.workspaceMs, fcpMs: warmOpened.fcp,
      indexJsonEncoded: warmIndex?.encoded ?? null, indexJsonRaw: warmIndex?.raw ?? null,
      totalEncoded: sum(warmFetched, 'encoded'), requests: warmFetched.length, requestsFromCache: warmFetched.filter((r) => r.fromCache).length,
      heapAfterGC: await session.heapAfterGC(),
    }
    return result
  } finally { await session.close() }
}

/** Group 6: full-text search on the production results page, one cold load per query. */
async function measureSearch(browser, profile, siteId, query) {
  const session = await newSession(browser, profile)
  const { page } = session
  async function visit() {
    const from = session.mark()
    await page.goto(`${origin()}/${siteId}/_search?q=${encodeURIComponent(query)}`, { waitUntil: 'commit' })
    await page.waitForFunction(() => (window.__t && window.__t.results !== undefined) || document.querySelector('.search-page-message'), null, { timeout: SLOW_TIMEOUT })
    // An error message is not a result: the iteration is invalid and the run stops instead of recording it.
    const errorText = await page.evaluate(() => document.querySelector('.search-page-message')?.textContent ?? null)
    if (errorText !== null) throw new Error(`search page showed a message instead of results for "${query}" on ${siteId}: ${errorText}`)
    const t = await page.evaluate(() => ({ results: window.__t.results, workspace: window.__t.workspace }))
    const isSearch = (r) => pathOf(r.url).startsWith(`/_indexes/${siteId}/search/`)
    const atFirst = session.since(from).filter(isSearch).length
    await session.settle()
    const searchRequests = session.since(from).filter(isSearch)
    const kinds = {}
    for (const r of searchRequests) {
      const name = pathOf(r.url).split('/').pop(), kind = name === 'manifest.json' ? 'manifest' : name.split('-')[0]
      kinds[kind] ??= { count: 0, encoded: 0, raw: 0 }
      kinds[kind].count += 1; kinds[kind].encoded += r.encoded; kinds[kind].raw += r.raw
    }
    const summary = await page.evaluate(() => ({
      rows: window.__count('.search-page-result:not(.search-page-skeleton)'),
      empty: !!document.querySelector('.search-page-empty'),
      error: document.querySelector('.search-page-message')?.textContent ?? null,
      errorShown: !!document.querySelector('.search-page-message'),
      count: document.querySelector('.search-page-count-text')?.textContent ?? '',
      more: document.querySelector('.search-page-more')?.textContent ?? null,
      dom: window.__dom(),
    }))
    const total = Number((summary.count.match(/^([\d,]+) pages? contains?/) ?? [])[1]?.replace(/,/g, '') ?? (summary.empty ? 0 : NaN))
    return {
      query,
      firstResultsFromNavigationMs: t.results,
      workspaceMountedMs: t.workspace,
      searchPhaseMs: t.results - t.workspace,
      hitsTotal: Number.isNaN(total) ? null : total,
      rowsShown: summary.rows, noMatchesShown: summary.empty, error: summary.error, countText: summary.count, moreButton: summary.more,
      dom: summary.dom,
      searchFetches: searchRequests.length,
      searchFetchesAtFirstResults: atFirst,
      searchEncoded: sum(searchRequests, 'encoded'),
      searchRaw: sum(searchRequests, 'raw'),
      searchByKind: kinds,
      heapAfterGC: await session.heapAfterGC(),
    }
  }
  try {
    const cold = await visit()
    cold.heapPeak = session.heapPeak()
    const warm = await visit()
    return { cold, warm }
  } finally { await session.close() }
}

function summarizeSearchRequests(requests, siteId) {
  const search = requests.filter((request) => pathOf(request.url).startsWith(`/_indexes/${siteId}/search/`))
  const byKind = {}
  for (const request of search) {
    const name = pathOf(request.url).split('/').pop()
    const kind = name === 'manifest.json' ? 'manifest' : name.split('-')[0]
    byKind[kind] ??= { count: 0, encodedBytes: 0, rawBytes: 0 }
    byKind[kind].count += 1
    byKind[kind].encodedBytes += request.encoded
    byKind[kind].rawBytes += request.raw
  }
  return {
    requestCount: requests.length,
    encodedBytes: sum(requests, 'encoded'),
    rawBytes: sum(requests, 'raw'),
    searchRequestCount: search.length,
    searchEncodedBytes: sum(search, 'encoded'),
    searchRawBytes: sum(search, 'raw'),
    searchByKind: byKind,
  }
}

async function setSearchRoute(page, siteId, query, folder) {
  const params = new URLSearchParams({ q: query })
  if (folder) params.set('in', folder)
  const route = `/${siteId}/_search?${params}`
  const startedAt = await page.evaluate((href) => {
    const started = performance.now()
    history.pushState({}, '', href)
    dispatchEvent(new PopStateEvent('popstate'))
    return started
  }, route)
  await page.waitForFunction(({ query: value }) => {
    const count = document.querySelector('.search-page-count-text')?.textContent ?? ''
    const main = document.querySelector('.search-page-main')
    const hasResult = !!document.querySelector('.search-page-result:not(.search-page-skeleton), .search-page-empty, .search-page-partial')
    return count.includes(`“${value}”`) && main?.getAttribute('aria-busy') === 'false' && hasResult
  }, { query }, { polling: 'raf', timeout: SLOW_TIMEOUT })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const finishedAt = await page.evaluate(() => performance.now())
  const summary = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.search-page-result:not(.search-page-skeleton)')]
    const countText = document.querySelector('.search-page-count-text')?.textContent ?? ''
    const match = countText.match(/^([\d,]+) pages? (?:in [^ ]+\/ )?(?:contain|contains)/)
    return {
      rows: rows.length,
      countText,
      hitsTotal: match ? Number(match[1].replace(/,/g, '')) : null,
      firstPath: rows[0]?.querySelector('.search-page-result-path')?.textContent ?? null,
      visiblePaths: rows.map((row) => row.querySelector('.search-page-result-path')?.textContent ?? ''),
      hasMore: !!document.querySelector('.search-page-more'),
      moreText: document.querySelector('.search-page-more')?.textContent ?? null,
    }
  })
  return { startedAt, firstResultsMs: finishedAt - startedAt, ...summary }
}

async function measureQueryStage(session, siteId, label, query, folder) {
  const { page } = session
  const from = session.mark()
  const startedAt = await page.evaluate(() => performance.now())
  const first = await setSearchRoute(page, siteId, query, folder)
  const requestsAtFirst = session.since(from)
  await session.settle()
  const requests = session.since(from)
  const summary = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.search-page-result:not(.search-page-skeleton)')]
    const paths = rows.map((row) => row.querySelector('.search-page-result-path')?.textContent ?? '')
    return {
      rows: rows.length,
      paths,
      countText: document.querySelector('.search-page-count-text')?.textContent ?? '',
      moreText: document.querySelector('.search-page-more')?.textContent ?? null,
    }
  })
  const longTasks = await session.longTasks(startedAt)
  return {
    label, query, folder: folder ?? null,
    firstResultsMs: first.firstResultsMs,
    hitsTotal: first.hitsTotal,
    countText: first.countText,
    rowsAtFirstResults: first.rows,
    firstPath: first.firstPath,
    moreButtonAtFirstResults: first.moreText,
    requestsAtFirstResults: requestsAtFirst.length,
    searchRequestsAtFirstResults: requestsAtFirst.filter((request) => pathOf(request.url).startsWith(`/_indexes/${siteId}/search/`)).length,
    encodedBytesCompletedAtFirstResults: sum(requestsAtFirst.filter((request) => request.done), 'encoded'),
    searchEncodedBytesCompletedAtFirstResults: sum(requestsAtFirst.filter((request) => request.done && pathOf(request.url).startsWith(`/_indexes/${siteId}/search/`)), 'encoded'),
    ...summarizeSearchRequests(requests, siteId),
    mainThreadLongTasks: longTasks,
    settledRows: summary.rows,
    settledCountText: summary.countText,
    settledMoreButton: summary.moreText,
    settledFirstPath: summary.paths[0] ?? null,
  }
}

async function measureShowMore(session, siteId, label, expectedRows, { expectedCountText } = {}) {
  const { page } = session
  const before = await page.evaluate(() => ({
    rows: document.querySelectorAll('.search-page-result:not(.search-page-skeleton)').length,
    countText: document.querySelector('.search-page-count-text')?.textContent ?? '',
    moreText: document.querySelector('.search-page-more')?.textContent ?? null,
  }))
  const moreButton = page.locator('.search-page-more')
  if (!(await moreButton.count())) {
    const view = await page.evaluate(() => {
      const paths = [...document.querySelectorAll('.search-page-result:not(.search-page-skeleton) .search-page-result-path')].map((node) => node.textContent ?? '')
      return {
        rows: paths.length,
        paths,
        countText: document.querySelector('.search-page-count-text')?.textContent ?? '',
        moreText: document.querySelector('.search-page-more')?.textContent ?? null,
      }
    })
    return {
      label,
      timeMs: null,
      measurable: false,
      reason: 'show-more button is unavailable',
      rows: view.rows,
      countText: view.countText,
      moreButton: view.moreText,
      pathOrder: view.paths.every((value, index) => index === 0 || view.paths[index - 1] <= value),
      firstPaths: view.paths.slice(0, 3),
      lastPaths: view.paths.slice(-3),
      ...summarizeSearchRequests([], siteId),
      mainThreadLongTasks: { supported: false, count: 0, durationMs: 0, maxMs: 0 },
    }
  }
  const from = session.mark()
  const startedAt = await page.evaluate(() => performance.now())
  await moreButton.click()
  await page.waitForFunction(({ expectedRows: rows, expectedCountText: count, beforeRows, beforeCountText, beforeMoreText }) => {
    const visible = document.querySelectorAll('.search-page-result:not(.search-page-skeleton)').length
    const text = document.querySelector('.search-page-count-text')?.textContent ?? ''
    const button = document.querySelector('.search-page-more')
    const buttonText = button?.textContent ?? null
    const expected = visible >= rows && (!count || text.includes(count))
    const completedWithDifferentResult = button?.getAttribute('aria-disabled') !== 'true' &&
      (visible !== beforeRows || text !== beforeCountText || buttonText !== beforeMoreText)
    return expected || completedWithDifferentResult
  }, { expectedRows, expectedCountText, beforeRows: before.rows, beforeCountText: before.countText, beforeMoreText: before.moreText }, { polling: 'raf', timeout: SLOW_TIMEOUT })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await session.settle()
  const requests = session.since(from)
  const view = await page.evaluate(() => {
    const paths = [...document.querySelectorAll('.search-page-result:not(.search-page-skeleton) .search-page-result-path')].map((node) => node.textContent ?? '')
    const countText = document.querySelector('.search-page-count-text')?.textContent ?? ''
    return {
      rows: paths.length,
      paths,
      countText,
      moreText: document.querySelector('.search-page-more')?.textContent ?? null,
    }
  })
  const endedAt = await page.evaluate(() => performance.now())
  const longTasks = await session.longTasks(startedAt)
  const pathOrder = view.paths.every((path, index) => index === 0 || view.paths[index - 1] <= path)
  return {
    label,
    timeMs: endedAt - startedAt,
    rows: view.rows,
    countText: view.countText,
    moreButton: view.moreText,
    pathOrder,
    firstPaths: view.paths.slice(0, 3),
    lastPaths: view.paths.slice(-3),
    ...summarizeSearchRequests(requests, siteId),
    mainThreadLongTasks: longTasks,
  }
}

/** Search-specific interactions share one already-open reader session to isolate query/search work. */
async function measureSearchCases(browser, profile, siteId, generationVariant) {
  const session = await newSession(browser, profile)
  const { page } = session
  const result = { workspace: {}, cases: {} }
  try {
    const workspaceFrom = session.mark()
    const navigationStart = Date.now()
    await page.goto(`${origin()}/${siteId}/_search`, { waitUntil: 'commit' })
    await page.waitForFunction(() => window.__t?.workspace !== undefined && !!document.querySelector('#search-page-input'), null, { timeout: SLOW_TIMEOUT })
    const workspacePaintMs = await page.evaluate(() => window.__t.workspace)
    await session.settle()
    const workspaceRequests = session.since(workspaceFrom)
    result.workspace = {
      workspaceMountedMs: workspacePaintMs,
      settledMs: Date.now() - navigationStart,
      ...summarizeSearchRequests(workspaceRequests, siteId),
      requests: workspaceRequests.length,
      encodedBytes: sum(workspaceRequests, 'encoded'),
      rawBytes: sum(workspaceRequests, 'raw'),
    }

    // Many hits also exercises path order and the visible “Show more” page.
    result.cases.manyHitsAndPaging = await measureQueryStage(session, siteId, 'many hits', 'latency')
    result.cases.pagingSecondPage = await measureShowMore(session, siteId, 'ordinary second page', 40)

    result.cases.fewHits = await measureQueryStage(session, siteId, 'few hits', RARE_TERM)
    result.cases.japanese = await measureQueryStage(session, siteId, 'Japanese', COMMON_JAPANESE)
    result.cases.longBodyNearPackCap = await measureQueryStage(session, siteId, 'long body near 256 KiB pack cap', 'longbodyprobe')
    result.cases.folderFiltered = await measureQueryStage(session, siteId, 'folder filtered', 'generationprobe', '000-generation')

    result.cases.vanishedGeneration = await measureQueryStage(session, siteId, 'vanished generation', 'vanishedgenerationprobe')
    const initialTotal = result.cases.vanishedGeneration.hitsTotal
    result.cases.vanishedGeneration.expectations = {
      hitsTotal: { expected: '> 500', actual: initialTotal, ok: Number.isFinite(initialTotal) && initialTotal > 500 },
    }
    result.cases.vanishedGeneration.pageTwo = await measureShowMore(session, siteId, 'old generation page two', 40)
    replaceSearchGeneration(generationVariant, generationVariant.changedSearch)
    result.cases.vanishedGeneration.waitForCacheExpiryMs = 61000
    await page.waitForTimeout(61000)
    result.cases.vanishedGeneration.afterRepublish = await measureShowMore(
      session, siteId, 'page after search data changed', 60, { expectedCountText: `${initialTotal - 1} pages contain` },
    )
    const afterRepublish = result.cases.vanishedGeneration.afterRepublish
    const expectedCountText = `${initialTotal - 1} pages contain`
    const manifestFetches = afterRepublish.searchByKind.manifest?.count ?? 0
    afterRepublish.expectations = {
      rows: { expected: 60, actual: afterRepublish.rows, ok: afterRepublish.rows === 60 },
      countText: { expected: expectedCountText, actual: afterRepublish.countText, ok: afterRepublish.countText.includes(expectedCountText) },
      manifestFetches: { expected: '>= 1', actual: manifestFetches, ok: manifestFetches >= 1 },
    }
    return result
  } finally {
    replaceSearchGeneration(generationVariant, generationVariant.baseSearch)
    await session.close()
  }
}

/** Group 7: visit every site in sequence from the picker; heap after each. */
async function measureSequence(browser, profile, ids) {
  const session = await newSession(browser, profile)
  const { page } = session
  const steps = []
  try {
    await page.goto(`${origin()}/`, { waitUntil: 'commit' })
    await page.waitForFunction(() => window.__t && window.__t.picker !== undefined, null, { timeout: SLOW_TIMEOUT })
    await session.settle()
    const first = { site: '/', heapAfterGC: await session.heapAfterGC() }
    steps.push(first)
    for (const id of ids) {
      const before = session.mark()
      const opened = await timedAction(page, { name: 'navigate', args: [`/${id}`] }, { name: 'exists', args: [`[data-testid="directory-page"] [data-directory-folder]`] })
      await session.settle()
      const fetched = session.since(before)
      steps.push({ site: id, openMs: opened.ms, fetchedEncoded: sum(fetched, 'encoded'), requests: fetched.length, heapAfterGC: await session.heapAfterGC() })
      const back = await timedAction(page, { name: 'navigate', args: ['/'] }, { name: 'exists', args: ['.site-picker-row'] })
      steps.push({ site: `/ (after ${id})`, openMs: back.ms, heapAfterGC: await session.heapAfterGC() })
    }
    // Idle on the site list past the 30 s index cache TTL (ISSUE-094): is anything released without a re-read?
    await page.waitForTimeout(35000)
    steps.push({ site: '/ (after 35 s idle)', heapAfterGC: await session.heapAfterGC() })
    return { steps, heapPeak: session.heapPeak(), finalHeapAfterGC: steps.at(-1).heapAfterGC }
  } finally { await session.close() }
}

// ---------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------

/** Replaces every numeric leaf of the iteration objects by {median, max}. */
function aggregate(samples) {
  const first = samples[0]
  if (typeof first === 'number') return { median: median(samples), max: maximum(samples) }
  if (Array.isArray(first)) return first.map((_, i) => aggregate(samples.map((s) => s[i])))
  if (first && typeof first === 'object') {
    const keys = new Set(samples.flatMap((s) => Object.keys(s ?? {})))
    return Object.fromEntries([...keys].map((key) => [key, aggregate(samples.map((s) => s?.[key]).filter((v) => v !== undefined))]))
  }
  return samples.every((s) => s === first) ? first : samples
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function environmentInfo() {
  const sysctl = (name) => { try { return execFileSync('sysctl', ['-n', name], { encoding: 'utf8' }).trim() } catch { return null } }
  return {
    machine: os.arch(), uname: execFileSync('uname', ['-a'], { encoding: 'utf8' }).trim(),
    cpu: sysctl('machdep.cpu.brand_string') ?? os.cpus()[0]?.model, cores: os.cpus().length,
    ramBytes: os.totalmem(), node: process.version, go: execFileSync('go', ['version'], { encoding: 'utf8' }).trim(),
    commit: git(repository, ['rev-parse', 'HEAD']), dirty: git(repository, ['status', '--porcelain']) !== '',
    delivery: options.remote ? 'remote deployment (see report)' : 'nginx:1.29-alpine via docker-compose.yml (no gzip configured)',
  }
}

function writeSanitizedResults(results) {
  const sites = {}
  for (const [profile, value] of Object.entries(results.profiles)) {
    sites[profile] = {}
    for (const [siteId, bucket] of Object.entries(value.sites ?? {})) {
      const measured = { pages: bucket.pages }
      if (bucket.samples?.firstLoad?.length) measured.firstLoad = bucket.samples.firstLoad
      if (bucket.mermaid?.samples) measured.mermaid = bucket.mermaid.samples
      if (bucket.searchCases?.samples) measured.searchCases = bucket.searchCases.samples
      sites[profile][siteId] = measured
    }
  }
  const output = {
    schemaVersion: 1,
    measuredAt: { startedAt: results.startedAt, finishedAt: results.finishedAt },
    conditions: {
      pages: results.options.counts,
      profiles: results.options.profiles,
      iterations: results.options.iterations,
      firstLoadAndMermaid: 'fresh browser context, then a second visit in the same context',
      constrained: 'CPU x4, 150 ms RTT, 1.6 Mbps down, 0.75 Mbps up',
      delivery: 'local nginx 1.29, loopback, no compression',
      searchMethod: 'one open search workspace per iteration; query and show-more timings start after workspace paint',
    },
    environment: {
      platform: process.platform,
      architecture: results.environment.machine,
      cpu: results.environment.cpu,
      cores: results.environment.cores,
      ramBytes: results.environment.ramBytes,
      node: results.environment.node,
      go: results.environment.go,
      commit: results.environment.commit,
      chromium: results.environment.chromium,
      playwright: results.environment.playwright,
    },
    data: {
      generatorVersion: results.published.generatorVersion,
      seed: results.published.seed,
      sites: results.published.sites,
      searchStressInput: results.published.searchStressInput ?? null,
    },
    profiles: sites,
  }
  const serialized = JSON.stringify(output, null, 2)
  assert.ok(!/(?:^|["\s])(?:\/Users\/|\/private\/|\/home\/|[A-Za-z]:\\)/m.test(serialized), 'sanitized results must not contain absolute paths')
  const target = path.join(repository, 'docs', 'research', 'web-scale-benchmark-results.json')
  writeFileSync(target, `${serialized}\n`)
  return target
}

async function main() {
  mkdirSync(path.join(labRoot, 'bin'), { recursive: true })
  if (options['generate-only']) {
    const prepared = generateSourcesOnly()
    const target = path.join(dataRoot, 'prepare.json')
    writeFileSync(target, JSON.stringify(prepared, null, 2) + '\n')
    log(`Generated source fixtures only in ${path.relative(repository, dataRoot)}`)
    return
  }
  if (options.remote) remoteIndexHtml = await (await fetch(`${origin()}/`)).text()
  if (!options['skip-build'] && !options.remote) {
    log('Building the CLI from this checkout and the SPA…')
    execFileSync('go', ['build', '-o', binary, './cli/cmd/artifact-pages'], { cwd: repository, stdio: 'inherit' })
    execFileSync('env', ['NODE_OPTIONS=', 'npm', 'run', 'build'], { cwd: repository, stdio: ['ignore', 'ignore', 'inherit'] })
  }
  const prepared = options.remote ? { note: 'published beforehand; data shape is that of the local generator with the same seed', counts: options.counts, seed: options.seed } : prepareData()
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  const prefix = options.remote ? 'remote-' : ''
  const resultsFile = path.join(labRoot, `${prefix}results-${stamp}.json`)
  const rawFile = path.join(labRoot, `${prefix}results-${stamp}.samples.jsonl`)
  const results = { startedAt: new Date().toISOString(), options, environment: environmentInfo(), published: prepared, profiles: {} }
  const wants = (group) => options.only.length === 0 || options.only.includes(group)
  const wantsSearchCases = options.only.includes('search-cases') || (options.only.length === 0 && !options.remote)
  const save = () => writeFileSync(resultsFile, JSON.stringify(results, null, 2))
  const record = (profile, scope, group, iteration, value) => appendFileSync(rawFile, `${JSON.stringify({ profile, scope, group, iteration, value })}\n`)
  let browser
  let generationVariant
  let completed = false
  const QUERIES = [['common English', COMMON_ENGLISH], ['Japanese', COMMON_JAPANESE], ['rare', RARE_TERM], ['no hit', NO_HIT_TERM]]
  try {
    if (wantsSearchCases) {
      assert.ok(!options.remote, 'search-cases runs only against local nginx')
      assert.ok(options.counts.includes(50000), 'search-cases requires --counts to include 50000')
      generationVariant = prepareGenerationVariant('scale-50000')
      results.published.searchStressInput = generationVariant.stressInput
    }
    browser = await chromium.launch({ channel: 'chromium', args: ['--no-first-run'] })
    results.environment.chromium = browser.version()
    results.environment.playwright = JSON.parse(readFileSync(path.join(repository, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version
    log(`Chromium ${browser.version()}, results in ${path.relative(repository, resultsFile)}`)
    for (const profile of options.profiles) {
      results.profiles[profile] = { sites: {} }
      for (const count of options.counts) {
        const siteId = siteIdOf(count), layout = siteLayout(count)
        await serve(siteId)
        const bucket = (results.profiles[profile].sites[siteId] = { pages: count, layout, iterations: {} })
        const samples = { firstLoad: [], session: [], mermaid: [], searchCases: [], search: Object.fromEntries(QUERIES.map(([label]) => [label, []])) }
        for (let iteration = 1; iteration <= options.iterations; iteration++) {
          log(`${profile} ${siteId} iteration ${iteration}/${options.iterations}`)
          if (wants('first-load')) { const value = await measureFirstLoad(browser, profile, siteId); samples.firstLoad.push(value); record(profile, siteId, 'firstLoad', iteration, value) }
          if (wants('session')) { const value = await measureSiteSession(browser, profile, siteId, layout); samples.session.push(value); record(profile, siteId, 'session', iteration, value) }
          if (wants('mermaid')) { const value = await measureMermaid(browser, profile, siteId); samples.mermaid.push(value); record(profile, siteId, 'mermaid', iteration, value) }
          if (wantsSearchCases && count === Math.max(...options.counts)) {
            const value = await measureSearchCases(browser, profile, siteId, generationVariant)
            samples.searchCases.push(value); record(profile, siteId, 'searchCases', iteration, value)
          }
          if (wants('search')) {
            for (const [label, query] of QUERIES) {
              const value = await measureSearch(browser, profile, siteId, query)
              samples.search[label].push({ label, ...value }); record(profile, siteId, `search:${label}`, iteration, value)
            }
          }
        }
        if (samples.firstLoad.length) bucket.firstLoad = aggregate(samples.firstLoad)
        if (samples.session.length) bucket.session = aggregate(samples.session)
        if (samples.mermaid.length) bucket.mermaid = { aggregate: aggregate(samples.mermaid), samples: samples.mermaid }
        if (samples.searchCases.length) bucket.searchCases = { aggregate: aggregate(samples.searchCases), samples: samples.searchCases }
        bucket.search = Object.fromEntries(Object.entries(samples.search).filter(([, list]) => list.length).map(([label, list]) => [label, aggregate(list.map(({ label: _label, ...rest }) => rest))]))
        bucket.samples = samples
        save()
      }
      if (wants('sequence') && options.counts.length > 1) {
        await serve('all')
        const ids = options.counts.map(siteIdOf)
        const list = []
        const firstLoads = []
        for (let iteration = 1; iteration <= options.iterations; iteration++) {
          log(`${profile} all sites in sequence, iteration ${iteration}/${options.iterations}`)
          const value = await measureSequence(browser, profile, ids)
          list.push(value); record(profile, 'all', 'sequence', iteration, value)
          const first = await measureFirstLoad(browser, profile, 'all')
          firstLoads.push(first); record(profile, 'all', 'firstLoad', iteration, first)
        }
        results.profiles[profile].sequence = { sites: ids, aggregate: aggregate(list), samples: list, firstLoadAggregate: aggregate(firstLoads), firstLoadSamples: firstLoads }
        save()
      }
    }
    completed = true
  } finally {
    if (browser) await browser.close()
    results.finishedAt = new Date().toISOString()
    save()
    if (!options.remote) try { compose(servedRoot || path.join(dataRoot, 'storage-all'), ['down']) } catch (error) { console.error(String(error)) }
    if (completed) {
      const sanitized = writeSanitizedResults(results)
      log(`Wrote sanitized measurements to ${path.relative(repository, sanitized)}`)
    }
    if (!options.keep) {
      rmSync(dataRoot, { recursive: true, force: true })
      rmSync(resultsFile, { force: true })
      rmSync(rawFile, { force: true })
      log('Removed generated data and raw results; pass --keep to retain them')
    }
  }
  if (options.keep) log(`Kept raw results in ${path.relative(repository, resultsFile)} and ${path.relative(repository, rawFile)}`)
}

await main()
