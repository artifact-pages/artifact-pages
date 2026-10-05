import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Build the CLI once per job (IMP-60). Every composite Action on the source-build
// path would otherwise restore the Go caches into an already populated tree (tar
// "File exists", 2-4 s each) and rebuild. The first build records a marker next to
// the binary; later Actions from the same source reuse the binary and skip setup-go,
// the cache restore and `go build`. The released-binary path is decided before this
// and is unchanged.

export const binaryName = 'artifact-pages'
export const markerName = 'artifact-pages.build-marker'

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (entry.isFile()) files.push(full)
  }
  return files
}

// Hash of everything `go build ./cli/cmd/artifact-pages` reads from the Action source.
export function sourceKey(sourceRoot) {
  const hash = createHash('sha256')
  const inputs = [path.join(sourceRoot, 'go.mod'), path.join(sourceRoot, 'go.sum'), ...walk(path.join(sourceRoot, 'cli'))]
  for (const file of inputs) {
    hash.update(path.relative(sourceRoot, file).split(path.sep).join('/')).update('\0').update(readFileSync(file)).update('\0')
  }
  return hash.digest('hex')
}

function binarySha(binary) {
  return createHash('sha256').update(readFileSync(binary)).digest('hex')
}

// Returns { build: boolean, reason }. A marker is trusted only while the binary on
// disk still has the recorded digest, so a released binary installed over it forces a rebuild.
export function plan({ sourceRoot, tempDir, prebuiltUsed }) {
  if (prebuiltUsed) return { build: false, reason: 'the released binary is installed' }
  const binary = path.join(tempDir, binaryName)
  const marker = path.join(tempDir, markerName)
  if (!existsSync(binary) || !existsSync(marker)) return { build: true, reason: 'no CLI built earlier in this job' }
  let recorded
  try {
    recorded = JSON.parse(readFileSync(marker, 'utf8'))
  } catch {
    return { build: true, reason: 'the build marker is unreadable' }
  }
  if (recorded.source !== sourceKey(sourceRoot)) return { build: true, reason: 'the Action source differs from the earlier build' }
  if (recorded.binary !== binarySha(binary)) return { build: true, reason: 'the CLI binary changed since the earlier build' }
  return { build: false, reason: 'reusing the CLI built earlier in this job from the same source' }
}

export function record({ sourceRoot, tempDir }) {
  const binary = path.join(tempDir, binaryName)
  writeFileSync(path.join(tempDir, markerName), JSON.stringify({ source: sourceKey(sourceRoot), binary: binarySha(binary) }))
}

function main() {
  const [command] = process.argv.slice(2)
  const rootIndex = process.argv.indexOf('--source-root')
  const sourceRoot = rootIndex >= 0 ? process.argv[rootIndex + 1] : ''
  const tempDir = process.env.RUNNER_TEMP
  if (!sourceRoot || !tempDir) throw new Error('--source-root and RUNNER_TEMP are required')
  if (command === 'plan') {
    const result = plan({ sourceRoot, tempDir, prebuiltUsed: process.env.ARTIFACT_PAGES_PREBUILT_USED === 'true' })
    process.stdout.write(`Artifact Pages CLI build: ${result.build ? 'building' : 'skipping'} (${result.reason}).\n`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build=${result.build}\n`)
  } else if (command === 'record') {
    record({ sourceRoot, tempDir })
  } else {
    throw new Error(`unknown command ${JSON.stringify(command)}; expected plan or record`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`::error title=Artifact Pages CLI build::${error.message}\n`)
    process.exitCode = 1
  }
}
