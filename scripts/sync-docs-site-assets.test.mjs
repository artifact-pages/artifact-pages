import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { findStaleCopies, syncCopies } from './sync-docs-site-assets.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docs-site-assets-'))
  const sharedDir = path.join(root, 'shared/assets')
  const sitesRoot = path.join(root, 'sites')
  await mkdir(sharedDir, { recursive: true })
  await mkdir(path.join(sitesRoot, 'guide/ja'), { recursive: true })
  await mkdir(path.join(sitesRoot, 'architecture'), { recursive: true })
  await writeFile(path.join(sharedDir, 'site.css'), 'body{}')
  await writeFile(path.join(sharedDir, 'site.js'), 'void 0')
  return { root, sharedDir, sitesRoot }
}

test('sync copies shared assets into every site, then the check passes', async (t) => {
  const { root, sharedDir, sitesRoot } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.equal((await findStaleCopies({ sharedDir, sitesRoot })).length, 4)
  const written = await syncCopies({ sharedDir, sitesRoot })
  assert.deepEqual(written.sort(), [
    'architecture/assets/site.css', 'architecture/assets/site.js', 'guide/assets/site.css', 'guide/assets/site.js',
  ].map((file) => path.join(...file.split('/'))))
  assert.equal(await readFile(path.join(sitesRoot, 'guide/assets/site.css'), 'utf8'), 'body{}')
  assert.deepEqual(await findStaleCopies({ sharedDir, sitesRoot }), [])
})

test('the check reports a site copy edited in place', async (t) => {
  const { root, sharedDir, sitesRoot } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))

  await syncCopies({ sharedDir, sitesRoot })
  await writeFile(path.join(sitesRoot, 'guide/assets/site.js'), 'edited')
  assert.deepEqual(await findStaleCopies({ sharedDir, sitesRoot }), [{ site: 'guide', file: 'site.js', reason: 'differs' }])
})

test('site-specific assets that are not shared are left alone', async (t) => {
  const { root, sharedDir, sitesRoot } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))

  await mkdir(path.join(sitesRoot, 'guide/assets'), { recursive: true })
  await writeFile(path.join(sitesRoot, 'guide/assets/diagram.svg'), '<svg/>')
  await syncCopies({ sharedDir, sitesRoot })
  assert.equal(await readFile(path.join(sitesRoot, 'guide/assets/diagram.svg'), 'utf8'), '<svg/>')
  assert.deepEqual(await findStaleCopies({ sharedDir, sitesRoot }), [])
})
