import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(projectRoot, 'dist')
const localRoot = path.join(projectRoot, '.local')
const releaseRoot = path.join(localRoot, 'releases')
const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

function parseVersionLabel(args) {
  const versionIndex = args.indexOf('--version')
  const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined

  if (!version || !labelPattern.test(version)) {
    throw new Error(
      'Pass a release label with --version (letters, numbers, dot, underscore, plus, and hyphen; 64 characters max).',
    )
  }

  if (args.filter((argument) => argument === '--version').length !== 1 || args.length !== 2) {
    throw new Error('Usage: npm run package:web -- --version <label>')
  }

  return version
}

async function listFiles(directory, relativeDirectory = '') {
  const entries = await fs.readdir(path.join(directory, relativeDirectory), {
    withFileTypes: true,
  })
  const files = []

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name)

    if (entry.isSymbolicLink()) {
      throw new Error(`Web build output must not contain symbolic links: ${relativePath}`)
    }

    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, relativePath)))
      continue
    }

    if (!entry.isFile()) {
      throw new Error(`Unsupported web build output entry: ${relativePath}`)
    }

    files.push(relativePath)
  }

  return files.sort()
}

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed.`)
  }

  return result.stdout.trim()
}

async function sha256(filePath) {
  const contents = await fs.readFile(filePath)
  return createHash('sha256').update(contents).digest('hex')
}

function runTar(archivePath, payloadRoot) {
  const result = spawnSync('tar', ['-czf', archivePath, '-C', payloadRoot, '.'], {
    cwd: projectRoot,
    // macOS bsdtar otherwise includes AppleDouble `._*` resource-fork files.
    // They are not in the release manifest and must not become deployed objects.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    encoding: 'utf8',
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'Could not create the web distribution archive.')
  }
}

async function main() {
  const version = parseVersionLabel(process.argv.slice(2))
  const files = await listFiles(distRoot)

  if (
    !files.includes('index.html') ||
    !files.includes('LICENSE') ||
    !files.includes('THIRD_PARTY_NOTICES.txt') ||
    !files.some((file) => file.startsWith('assets/'))
  ) {
    throw new Error(
      'Build the Vite application and generate license notices first; dist must contain index.html, LICENSE, assets/, and THIRD_PARTY_NOTICES.txt.',
    )
  }

  for (const prefix of ['_indexes', '_artifacts', '_previews', '_control']) {
    if (files.some((file) => file === prefix || file.startsWith(`${prefix}/`))) {
      throw new Error(`The web distribution must not include ${prefix} storage.`)
    }
  }

  const commit = gitOutput(['rev-parse', 'HEAD'])
  const sourceDirty = gitOutput(['status', '--porcelain', '--untracked-files=all']) !== ''
  const archiveName = `artifact-pages-web-v${version}.tar.gz`
  const manifestName = `${archiveName}.json`
  const checksumName = `${archiveName}.sha256`

  await fs.mkdir(releaseRoot, { recursive: true })
  const outputPaths = [archiveName, manifestName, checksumName].map((name) =>
    path.join(releaseRoot, name),
  )

  for (const outputPath of outputPaths) {
    try {
      await fs.access(outputPath)
      throw new Error(`Refusing to overwrite an existing release file: ${outputPath}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  const stagingRoot = await fs.mkdtemp(path.join(localRoot, 'package-web-'))
  const stagedPayload = path.join(stagingRoot, 'payload')
  const stagedArchive = path.join(stagingRoot, archiveName)
  const stagedManifest = path.join(stagingRoot, manifestName)
  const stagedChecksum = path.join(stagingRoot, checksumName)

  try {
    await fs.cp(distRoot, stagedPayload, { recursive: true, errorOnExist: true })
    runTar(stagedArchive, stagedPayload)

    const archiveSha256 = await sha256(stagedArchive)
    const manifest = {
      schemaVersion: 1,
      product: 'artifact-pages',
      component: 'web',
      version,
      archive: archiveName,
      archiveSha256,
      sourceCommit: commit,
      sourceDirty,
      files,
    }

    await fs.writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`)
    await fs.writeFile(stagedChecksum, `${archiveSha256}  ${archiveName}\n`)

    const publishedPaths = []
    try {
      for (const [stagedPath, outputPath] of [
        [stagedArchive, outputPaths[0]],
        [stagedManifest, outputPaths[1]],
        [stagedChecksum, outputPaths[2]],
      ]) {
        await fs.rename(stagedPath, outputPath)
        publishedPaths.push(outputPath)
      }
    } catch (error) {
      await Promise.all(publishedPaths.map((filePath) => fs.rm(filePath, { force: true })))
      throw error
    }

    console.log(`Packaged ${files.length} web files for version ${version}:`)
    for (const outputPath of outputPaths) {
      console.log(path.relative(projectRoot, outputPath))
    }
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
