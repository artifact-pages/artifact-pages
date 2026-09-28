import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withWebReleaseLock } from './web-release-lock.mjs'
import { parseVersionLabel } from './web-release-version.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localRoot = path.join(projectRoot, '.local')
const releaseRoot = path.join(localRoot, 'releases')

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    const outcome = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed with ${outcome}.`)
  }
}

function runNpm(args) {
  // npm exposes its CLI and Node executable to lifecycle scripts. Reuse them
  // when present; direct script invocation can still resolve npm from PATH.
  if (process.env.npm_execpath) {
    run(process.env.npm_node_execpath || process.execPath, [process.env.npm_execpath, ...args])
    return
  }

  run('npm', args)
}

async function refuseExistingVersion(version) {
  const archiveName = `artifact-pages-web-v${version}.tar.gz`
  for (const suffix of ['', '.json', '.sha256']) {
    const outputPath = path.join(releaseRoot, `${archiveName}${suffix}`)
    try {
      await fs.lstat(outputPath)
      throw new Error(`Refusing to overwrite an existing release file: ${outputPath}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

async function packageWeb(args) {
  const version = parseVersionLabel(args)

  await withWebReleaseLock(
    { projectRoot, releaseRoot, version },
    async (token) => {
      await refuseExistingVersion(version)
      runNpm(['run', 'build'])
      run(process.execPath, [path.join(projectRoot, 'scripts', 'generate-third-party-notices.mjs')])
      run(
        process.execPath,
        [path.join(projectRoot, 'scripts', 'package-web-release.mjs'), ...args],
        { ...process.env, ARTIFACT_PAGES_WEB_RELEASE_LOCK_TOKEN: token },
      )
    },
  )
}

packageWeb(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
