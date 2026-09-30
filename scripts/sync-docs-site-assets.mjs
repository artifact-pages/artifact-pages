// Copies the shared documentation-site assets into every site under docs/public/sites.
// Each site is published under its own CSP boundary (/_artifacts/<site>/), so sites cannot
// load assets from one another; each keeps a committed copy of the shared files.
//
//   node scripts/sync-docs-site-assets.mjs          copy docs/public/shared/assets into each site
//   node scripts/sync-docs-site-assets.mjs --check  fail when any site copy is missing or differs
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.')).map((entry) => entry.name).sort()
}

async function listSites(sitesRoot) {
  const entries = await readdir(sitesRoot, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort()
}

async function readOptional(file) {
  try {
    return await readFile(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** Returns one entry per site copy that is missing or differs from the shared source. */
export async function findStaleCopies({ sharedDir, sitesRoot }) {
  const files = await listFiles(sharedDir)
  const stale = []
  for (const site of await listSites(sitesRoot)) {
    for (const file of files) {
      const target = path.join(sitesRoot, site, 'assets', file)
      const [source, copy] = await Promise.all([readFile(path.join(sharedDir, file)), readOptional(target)])
      if (copy === null) stale.push({ site, file, reason: 'missing' })
      else if (!source.equals(copy)) stale.push({ site, file, reason: 'differs' })
    }
  }
  return stale
}

/** Copies every shared file into each site's assets directory and returns the written paths. */
export async function syncCopies({ sharedDir, sitesRoot }) {
  const stale = await findStaleCopies({ sharedDir, sitesRoot })
  for (const { site, file } of stale) {
    const targetDir = path.join(sitesRoot, site, 'assets')
    await mkdir(targetDir, { recursive: true })
    await copyFile(path.join(sharedDir, file), path.join(targetDir, file))
  }
  return stale.map(({ site, file }) => path.join(site, 'assets', file))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = {
    sharedDir: path.join(repositoryRoot, 'docs/public/shared/assets'),
    sitesRoot: path.join(repositoryRoot, 'docs/public/sites'),
  }
  if (process.argv.includes('--check')) {
    const stale = await findStaleCopies(options)
    for (const { site, file, reason } of stale) {
      console.error(`docs/public/sites/${site}/assets/${file}: ${reason} (run npm run docs:sync-assets)`)
    }
    process.exitCode = stale.length ? 1 : 0
    if (!stale.length) console.log('Documentation site assets match docs/public/shared/assets.')
  } else {
    const written = await syncCopies(options)
    console.log(written.length ? `Updated ${written.map((file) => `docs/public/sites/${file}`).join(', ')}` : 'Documentation site assets are already up to date.')
  }
}
