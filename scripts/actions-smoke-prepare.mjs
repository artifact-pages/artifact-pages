// Prepares the runner-local target for .github/workflows/verify.yml's actions-smoke job:
// deployment configs that register the committed smoke site for this repository,
// and a packaged test web bundle for app deploy. Nothing here needs credentials.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const repository = process.env.GITHUB_REPOSITORY
const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
const scratch = process.env.SMOKE_ROOT
if (!repository || !scratch) throw new Error('GITHUB_REPOSITORY and SMOKE_ROOT are required')

const storage = path.join(scratch, 'storage')
const configDir = path.join(workspace, '.local', 'actions-smoke')
await fs.mkdir(storage, { recursive: true })
await fs.mkdir(configDir, { recursive: true })

const config = (sites) => [
  'schemaVersion: 1',
  'provider: local',
  'local:',
  `  root: ${JSON.stringify(storage)}`,
  sites,
  '',
].join('\n')
await fs.writeFile(path.join(configDir, 'config.yaml'), config([
  'sites:',
  '  smoke:',
  '    name: Actions smoke',
  `    repository: ${repository}`,
  '    sourcePath: fixtures/actions-smoke/site',
].join('\n')))
await fs.writeFile(path.join(configDir, 'config-unregister.yaml'), config('sites: {}'))

const payload = path.join(scratch, 'app-payload')
const archiveName = 'artifact-pages-web-vactions-smoke.tar.gz'
const archive = path.join(scratch, archiveName)
const files = {
  'assets/app.js': 'window.actionsSmoke = true;\n',
  'index.html': '<!doctype html><main>Actions smoke</main><script src="/assets/app.js"></script>\n',
}
for (const [relative, contents] of Object.entries(files)) {
  await fs.mkdir(path.dirname(path.join(payload, relative)), { recursive: true })
  await fs.writeFile(path.join(payload, relative), contents)
}
const tar = spawnSync('tar', ['-czf', archive, '-C', payload, '.'], {
  stdio: 'inherit',
  env: { ...process.env, COPYFILE_DISABLE: '1' },
})
if (tar.status !== 0) throw new Error('tar failed')
const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex')
await fs.writeFile(`${archive}.json`, JSON.stringify({
  schemaVersion: 1,
  product: 'artifact-pages',
  component: 'web',
  version: 'actions-smoke',
  archive: archiveName,
  archiveSha256: digest,
  sourceCommit: '0000000000000000000000000000000000000000',
  sourceDirty: false,
  files: Object.keys(files).sort(),
}))
await fs.writeFile(`${archive}.sha256`, `${digest}  ${archiveName}\n`)

const outputs = [
  `storage=${storage}`,
  'config=.local/actions-smoke/config.yaml',
  'unregister-config=.local/actions-smoke/config-unregister.yaml',
  `archive=${archive}`,
].join('\n')
if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${outputs}\n`)
console.log(outputs)
