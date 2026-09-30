import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const legalFilePattern = /^(?:license|licence|copying|notice)(?:$|[._-])/iu
const readmePattern = /^readme(?:\..*)?$/iu

function resolvePackagePath(fromPath, dependency, lockPackages) {
  let directory = fromPath

  while (directory) {
    const candidate = path.posix.join(directory, 'node_modules', dependency)
    if (lockPackages[candidate]) return candidate

    const nestedModules = directory.lastIndexOf('/node_modules/')
    if (nestedModules >= 0) {
      directory = directory.slice(0, nestedModules)
    } else if (directory.startsWith('node_modules/')) {
      directory = ''
    } else {
      break
    }
  }

  const rootCandidate = path.posix.join('node_modules', dependency)
  return lockPackages[rootCandidate] ? rootCandidate : undefined
}

export function collectProductionPackages(lock) {
  if (!lock || lock.lockfileVersion < 3 || !lock.packages?.['']) {
    throw new Error('A package-lock.json using lockfile version 3 or later is required.')
  }

  const lockPackages = lock.packages
  const discovered = new Map()
  const expanded = new Set()

  function visit(fromPath, dependency, optional = false, inheritedOptional = false) {
    const isOptional = optional || inheritedOptional
    const packagePath = resolvePackagePath(fromPath, dependency, lockPackages)

    if (!packagePath) {
      if (isOptional) return
      throw new Error(`Could not resolve production dependency ${dependency} from ${fromPath || 'the project root'}.`)
    }

    const metadata = lockPackages[packagePath]
    if (!metadata.version) {
      throw new Error(`Production dependency ${packagePath} has no locked version.`)
    }

    const marker = packagePath.lastIndexOf('node_modules/')
    const name = metadata.name || packagePath.slice(marker + 'node_modules/'.length)
    const previous = discovered.get(packagePath)
    discovered.set(packagePath, {
      name,
      version: metadata.version,
      license: metadata.license,
      packagePath,
      optional: previous ? previous.optional && isOptional : isOptional,
    })

    const mode = `${packagePath}|${isOptional}`
    if (expanded.has(mode)) return
    expanded.add(mode)

    const required = metadata.dependencies || {}
    const optionalDependencies = metadata.optionalDependencies || {}
    const peerDependencies = metadata.peerDependencies || {}

    for (const child of Object.keys(required)) visit(packagePath, child, false, isOptional)
    for (const child of Object.keys(optionalDependencies)) {
      if (!required[child]) visit(packagePath, child, true, isOptional)
    }
    for (const child of Object.keys(peerDependencies)) {
      if (!required[child] && !optionalDependencies[child]) visit(packagePath, child, true, isOptional)
    }
  }

  const root = lockPackages['']
  const required = root.dependencies || {}
  const optionalDependencies = root.optionalDependencies || {}

  for (const dependency of Object.keys(required)) visit('', dependency)
  for (const dependency of Object.keys(optionalDependencies)) {
    if (!required[dependency]) visit('', dependency, true)
  }

  return [...discovered.values()].sort((left, right) => {
    const leftKey = `${left.name}@${left.version}`
    const rightKey = `${right.name}@${right.version}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

async function readPackageMetadata(packageRoot, lockedPackage) {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    if (packageJson.name !== lockedPackage.name || packageJson.version !== lockedPackage.version) {
      throw new Error(
        `Installed package ${packageJson.name}@${packageJson.version} does not match lockfile entry ${lockedPackage.name}@${lockedPackage.version}. Run npm ci before packaging.`,
      )
    }

    return {
      license: lockedPackage.license || packageJson.license,
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { license: lockedLicense }
    throw error
  }
}

async function readLicenseFiles(packageRoot) {
  const entries = await fs.readdir(packageRoot, { withFileTypes: true })
  const names = entries
    .filter((entry) => legalFilePattern.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  const files = []

  for (const entry of names) {
    const absolutePath = path.join(packageRoot, entry.name)
    try {
      if ((await fs.stat(absolutePath)).isFile()) {
        files.push({ name: entry.name, text: await fs.readFile(absolutePath, 'utf8') })
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  return files
}

function extractReadmeLicense(readme) {
  const headings = [...readme.matchAll(/^(#{1,6})\s+([^\n]+)$/gmu)]

  for (const heading of headings) {
    if (!/\blicen[cs]e\b/iu.test(heading[2])) continue

    const level = heading[1].length
    const start = heading.index + heading[0].length
    const nextHeading = headings.find((candidate) =>
      candidate.index > heading.index && candidate[1].length <= level,
    )
    const text = readme.slice(start, nextHeading?.index ?? readme.length).trim()

    if (text.length >= 100) return text
  }

  return undefined
}

async function readReadmeLicense(packageRoot) {
  const entries = await fs.readdir(packageRoot, { withFileTypes: true })
  const readme = entries.find((entry) => entry.isFile() && readmePattern.test(entry.name))
  if (!readme) return undefined

  return extractReadmeLicense(await fs.readFile(path.join(packageRoot, readme.name), 'utf8'))
}

export async function renderProductionNotices(projectRoot) {
  const lock = JSON.parse(await fs.readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'))
  const packages = collectProductionPackages(lock)
  const sections = []

  for (const item of packages) {
    const packageRoot = path.join(projectRoot, item.packagePath)
    let packageFiles

    try {
      packageFiles = await readLicenseFiles(packageRoot)
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (item.optional) continue
        throw new Error(`Production dependency ${item.name}@${item.version} is not installed. Run npm ci before packaging.`)
      }
      throw error
    }

    if (packageFiles.length === 0) {
      const readmeText = await readReadmeLicense(packageRoot)
      if (!readmeText) {
        throw new Error(`No license text was found for production dependency ${item.name}@${item.version}.`)
      }
      packageFiles = [{ name: 'README license section', text: readmeText }]
    }

    const metadata = await readPackageMetadata(packageRoot, item)
    const declaredLicense = metadata.license || 'Not declared in package metadata; see included license text.'
    const fileSections = packageFiles.map(({ name, text }) =>
      `--- ${name} ---\n${text.trim()}`,
    )

    sections.push([
      `${item.name}@${item.version}`,
      `Declared license: ${declaredLicense}`,
      ...fileSections,
    ].join('\n\n'))
  }

  return [
    'THIRD-PARTY SOFTWARE NOTICES',
    '',
    `Generated from package-lock.json for ${sections.length} installed production dependencies.`,
    'The Artifact Pages first-party work is licensed under MIT (see the adjacent LICENSE).',
    'Third-party packages retain their own licenses and notices below.',
    '',
    sections.join('\n\n' + '='.repeat(78) + '\n\n'),
    '',
  ].join('\n')
}

export async function generateProductionNotices(projectRoot) {
  const distRoot = path.join(projectRoot, 'web', 'dist')
  const notices = await renderProductionNotices(projectRoot)
  await fs.copyFile(path.join(projectRoot, 'LICENSE'), path.join(distRoot, 'LICENSE'))
  await fs.writeFile(path.join(distRoot, 'THIRD_PARTY_NOTICES.txt'), notices)
  return notices
}

const thisFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const projectRoot = path.resolve(path.dirname(thisFile), '..')
  generateProductionNotices(projectRoot)
    .then((notices) => {
      const packageCount = notices.match(/Generated from package-lock\.json for (\d+) installed production dependencies/u)?.[1]
      console.log(`Generated third-party notices for ${packageCount} production dependencies.`)
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
