import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Prebuilt CLI selection for the composite Actions (TD4, specification "Shared
// Action behavior"). An Action uses a released binary only when its ref is the
// release tag of the source tree it runs from; every other case builds from source.

// Platforms the release workflow builds and the Actions can run. Windows is not
// built: the Actions build from source there.
export const platforms = [
  { os: 'linux', arch: 'amd64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'darwin', arch: 'amd64' },
  { os: 'darwin', arch: 'arm64' },
]

const runnerOS = { Linux: 'linux', macOS: 'darwin' }
const runnerArch = { X64: 'amd64', ARM64: 'arm64' }

export function assetName(version, os, arch) {
  return `artifact-pages_v${version}_${os}_${arch}`
}

export function checksumsName(version) {
  return `artifact-pages_v${version}_checksums.txt`
}

export function noticesName(version) {
  return `artifact-pages_v${version}_THIRD_PARTY_NOTICES.txt`
}

export function readProductVersion(sourceRoot) {
  const source = readFileSync(path.join(sourceRoot, 'cli', 'internal', 'version', 'version.go'), 'utf8')
  const match = /const Product = "([^"]+)"/.exec(source)
  if (!match) throw new Error('cli/internal/version/version.go does not define the Product constant')
  return match[1]
}

// Returns { use: true, version, asset, ... } or { use: false, reason }.
export function selectPrebuilt({ actionRef, product, repository, runnerOs, runnerArch: arch }) {
  const os = runnerOS[runnerOs]
  const cpu = runnerArch[arch]
  if (!os || !cpu) return { use: false, reason: `no prebuilt CLI for runner ${runnerOs || '(unknown)'}/${arch || '(unknown)'}` }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || (repository ?? '').split('/').some((part) => part === '.' || part === '..')) return { use: false, reason: 'the Action repository is unknown' }
  const tag = /^v(\d+\.\d+\.\d+)$/.exec(actionRef ?? '')
  if (!tag) return { use: false, reason: `the Action ref ${JSON.stringify(actionRef ?? '')} is not a release tag` }
  if (tag[1] !== product) return { use: false, reason: `the Action ref ${actionRef} does not match the source version v${product}` }
  const base = `https://github.com/${repository}/releases/download/${actionRef}/`
  const asset = assetName(product, os, cpu)
  return { use: true, version: product, tag: actionRef, repository, asset, checksums: checksumsName(product), assetUrl: base + asset, checksumsUrl: base + checksumsName(product) }
}

export function parseChecksums(text) {
  const entries = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *]([^\s/\\]+)$/.exec(line.trim())
    if (match) entries.set(match[2], match[1].toLowerCase())
  }
  return entries
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function download(url, { fetchImpl, token }) {
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) })
  if (response.status === 200) return Buffer.from(await response.arrayBuffer())
  if ((response.status === 403 || response.status === 429) && token) {
    // Rate limited without authentication: retry through the API with the workflow token.
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url)
    if (match) {
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
      const release = await fetchImpl(`https://api.github.com/repos/${match[1]}/releases/tags/${match[2]}`, { headers, signal: AbortSignal.timeout(30000) })
      if (release.status === 200) {
        const asset = (await release.json()).assets?.find((candidate) => candidate.name === match[3])
        if (asset?.url) {
          const authenticated = await fetchImpl(asset.url, { headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'follow', signal: AbortSignal.timeout(60000) })
          if (authenticated.status === 200) return Buffer.from(await authenticated.arrayBuffer())
        }
      }
    }
  }
  const error = new Error(`download of ${url} returned HTTP ${response.status}`)
  error.status = response.status
  throw error
}

// Downloads, verifies and installs the binary at `destination`. Resolves to
// { used: false, reason } when the source build should be used instead (no
// matching release, unsupported platform, missing asset or checksum entry).
// A checksum mismatch throws: it is never papered over with a fallback.
export async function installPrebuilt(options) {
  const selection = selectPrebuilt(options)
  if (!selection.use) return { used: false, reason: selection.reason }
  const fetchImpl = options.fetchImpl ?? fetch
  const token = options.token ?? ''
  let binary
  let checksums
  try {
    checksums = parseChecksums((await download(selection.checksumsUrl, { fetchImpl, token })).toString('utf8'))
    if (!checksums.has(selection.asset)) return { used: false, reason: `${selection.checksums} has no entry for ${selection.asset}` }
    binary = await download(selection.assetUrl, { fetchImpl, token })
  } catch (error) {
    return { used: false, reason: `release asset unavailable: ${String(error.message).replace(token || '\u0000', '***')}` }
  }
  const actual = sha256(binary)
  if (actual !== checksums.get(selection.asset)) {
    throw new Error(`checksum mismatch for ${selection.asset}: expected ${checksums.get(selection.asset)}, got ${actual}`)
  }
  writeFileSync(options.destination, binary)
  chmodSync(options.destination, 0o755)
  return { used: true, reason: `${selection.asset} verified against ${selection.checksums}`, version: selection.version }
}

async function main() {
  const env = process.env
  const sourceRootIndex = process.argv.indexOf('--source-root')
  const sourceRoot = sourceRootIndex >= 0 ? process.argv[sourceRootIndex + 1] : ''
  const output = (used, reason) => {
    process.stdout.write(`Artifact Pages CLI: ${used ? 'using the released binary' : 'building from source'} (${reason}).\n`)
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `used=${used}\n`)
  }
  try {
    const result = await installPrebuilt({
      actionRef: env.ARTIFACT_PAGES_ACTION_REF,
      repository: env.ARTIFACT_PAGES_ACTION_REPOSITORY,
      product: readProductVersion(sourceRoot),
      runnerOs: env.RUNNER_OS,
      runnerArch: env.RUNNER_ARCH,
      destination: path.join(env.RUNNER_TEMP, 'artifact-pages'),
      token: env.ARTIFACT_PAGES_TOKEN ?? '',
    })
    output(result.used, result.reason)
  } catch (error) {
    process.stderr.write(`::error title=Artifact Pages CLI::${String(error.message).replace(env.ARTIFACT_PAGES_TOKEN || '\u0000', '***')}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
