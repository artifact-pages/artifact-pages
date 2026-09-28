import { spawnSync } from 'node:child_process'
import process from 'node:process'

const projectName = 'git-artifact-pages-e2e'
const port = process.env.E2E_PORT ?? '4174'
const baseURL = `http://127.0.0.1:${port}`
let exitCode = 1

if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error(`E2E_PORT must be a TCP port between 1 and 65535; received "${port}".`)
  process.exit(1)
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })

  if (result.error) {
    console.error(result.error.message)
    return 1
  }

  return result.status ?? 1
}

async function waitForServer() {
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseURL)
      if (response.ok) return true
    } catch {
      // nginx may need a moment after Compose reports the container as running.
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  return false
}

try {
  const env = {
    COMPOSE_PROJECT_NAME: projectName,
    WEB_PORT: port,
    WEB_ROOT: process.env.WEB_ROOT ?? './dist',
    PREVIEW_ROOT: process.env.PREVIEW_ROOT ?? './fixtures/storage/_previews',
  }
  const startStatus = run('docker', ['compose', '-p', projectName, 'up', '--detach'], env)

  if (startStatus !== 0) {
    exitCode = startStatus
  } else if (!(await waitForServer())) {
    console.error(`The local nginx test server did not become available at ${baseURL}.`)
  } else {
    exitCode = run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test'], {
      PLAYWRIGHT_BASE_URL: baseURL,
    })
  }
} catch (error) {
  console.error(error)
} finally {
  const stopStatus = run('docker', ['compose', '-p', projectName, 'down', '--remove-orphans'], {
    COMPOSE_PROJECT_NAME: projectName,
    WEB_PORT: port,
  })

  if (exitCode === 0 && stopStatus !== 0) exitCode = stopStatus
}

process.exitCode = exitCode
