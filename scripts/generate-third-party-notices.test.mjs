import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { collectProductionPackages, generateProductionNotices, renderProductionNotices } from './generate-third-party-notices.mjs'

async function createPackage(root, packagePath, files) {
  const directory = path.join(root, packagePath)
  await mkdir(directory, { recursive: true })
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(directory, name), contents)
  }
}

test('collects the locked production dependency graph and renders included license texts', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-pages-notices-'))

  try {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': {
          dependencies: { alpha: '1.0.0' },
          optionalDependencies: { optionalOnly: '1.0.0' },
          devDependencies: { devOnly: '1.0.0' },
        },
        'node_modules/alpha': { version: '1.0.0', license: 'MIT', dependencies: { beta: '2.0.0' } },
        'node_modules/alpha/node_modules/beta': { version: '2.0.0', license: 'BSD-3-Clause' },
        'node_modules/optionalOnly': { version: '1.0.0', license: 'MIT', optional: true },
        'node_modules/devOnly': { version: '1.0.0', license: 'UNLICENSED', dev: true },
      },
    }
    await writeFile(path.join(projectRoot, 'package-lock.json'), JSON.stringify(lock))
    await writeFile(path.join(projectRoot, 'LICENSE'), 'Project MIT license')
    await createPackage(projectRoot, 'node_modules/alpha', {
      'package.json': JSON.stringify({ name: 'alpha', version: '1.0.0', license: 'MIT' }),
      LICENSE: 'Alpha license text',
    })
    await createPackage(projectRoot, 'node_modules/alpha/node_modules/beta', {
      'package.json': JSON.stringify({ name: 'beta', version: '2.0.0', license: 'BSD-3-Clause' }),
      'README.md': '# Beta\n\n## License\n\nBeta license text that is long enough to be retained by the license-section extractor, including the full grant and copyright conditions required by the source package.\n',
    })

    const packages = collectProductionPackages(lock)
    assert.deepEqual(packages.map(({ name, version }) => `${name}@${version}`), [
      'alpha@1.0.0',
      'beta@2.0.0',
      'optionalOnly@1.0.0',
    ])

    const notices = await renderProductionNotices(projectRoot)
    assert.match(notices, /Alpha license text/u)
    assert.match(notices, /Beta license text/u)
    assert.doesNotMatch(notices, /devOnly/u)
    assert.doesNotMatch(notices, /optionalOnly/u)

    await mkdir(path.join(projectRoot, 'dist'))
    await generateProductionNotices(projectRoot)
    assert.equal(await readFile(path.join(projectRoot, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8'), notices)
    assert.equal(await readFile(path.join(projectRoot, 'dist/LICENSE'), 'utf8'), 'Project MIT license')
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

test('fails when a production dependency has no included license text', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-pages-notices-'))

  try {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { missing: '1.0.0' } },
        'node_modules/missing': { version: '1.0.0', license: 'MIT' },
      },
    }
    await writeFile(path.join(projectRoot, 'package-lock.json'), JSON.stringify(lock))
    await createPackage(projectRoot, 'node_modules/missing', {
      'package.json': JSON.stringify({ name: 'missing', version: '1.0.0', license: 'MIT' }),
    })

    await assert.rejects(renderProductionNotices(projectRoot), /No license text was found for production dependency missing@1\.0\.0/u)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

test('fails when installed package versions do not match the lockfile', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-pages-notices-'))

  try {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { mismatch: '1.0.0' } },
        'node_modules/mismatch': { version: '1.0.0', license: 'MIT' },
      },
    }
    await writeFile(path.join(projectRoot, 'package-lock.json'), JSON.stringify(lock))
    await createPackage(projectRoot, 'node_modules/mismatch', {
      'package.json': JSON.stringify({ name: 'mismatch', version: '1.0.1', license: 'MIT' }),
      LICENSE: 'MIT license text',
    })

    await assert.rejects(renderProductionNotices(projectRoot), /does not match lockfile entry mismatch@1\.0\.0/u)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})
