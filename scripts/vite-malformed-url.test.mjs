import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, path: requestPath }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

async function startVite(storageRoot) {
  const source = `
    import { createServer } from 'vite'
    const server = await createServer({
      configFile: ${JSON.stringify(path.join(repositoryRoot, 'vite.config.ts'))},
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, strictPort: true },
    })
    await server.listen()
    process.send({ type: 'ready', port: server.httpServer.address().port })
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      GAP_LOCAL_STORAGE_ROOT: storageRoot,
      NODE_OPTIONS: '--unhandled-rejections=strict',
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Vite did not start: ${stderr}`)), 10_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`Vite exited before startup (code ${code}, signal ${signal}): ${stderr}`))
    })
    child.on('message', (message) => {
      if (message?.type === 'ready') {
        clearTimeout(timeout)
        resolve(message.port)
      }
    })
  })

  try {
    return { child, port: await ready, getStderr: () => stderr }
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
}

test('malformed artifact URLs return 400 without stopping local Vite', { timeout: 20_000 }, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-pages-vite-url-'))
  const storageRoot = path.join(temporaryRoot, 'storage')
  const reports = path.join(storageRoot, '_artifacts', 'sre', 'reports')
  await mkdir(reports, { recursive: true })
  await writeFile(path.join(reports, 'with space.md'), 'space-ok')
  await writeFile(path.join(reports, '設計.md'), 'unicode-ok')
  await writeFile(path.join(reports, '100%.md'), 'percent-ok')
  await writeFile(path.join(storageRoot, 'secret.txt'), 'outside-storage-sentinel')

  let vite
  try {
    vite = await startVite(storageRoot)

    let malformed
    try {
      malformed = await request(vite.port, '/_artifacts/bad%')
    } catch (error) {
      assert.fail(`malformed request closed its connection: ${error}; Vite stderr: ${vite.getStderr()}`)
    }
    assert.equal(malformed.status, 400, `malformed path response: ${malformed.status} ${malformed.body}`)

    const root = await request(vite.port, '/')
    assert.equal(root.status, 200, `root request after malformed path: ${root.status}`)

    for (const [encodedName, expected] of [
      ['with%20space.md', 'space-ok'],
      [`${encodeURIComponent('設計')}.md`, 'unicode-ok'],
      ['100%25.md', 'percent-ok'],
    ]) {
      const artifact = await request(vite.port, `/_artifacts/sre/reports/${encodedName}`)
      assert.equal(artifact.status, 200, `valid artifact ${encodedName} returned ${artifact.status}`)
      assert.equal(artifact.body, expected)
    }

    const traversal = await request(vite.port, '/_artifacts/sre%2F..%2F..%2Fsecret.txt')
    assert.notEqual(traversal.body, 'outside-storage-sentinel')
    assert.equal(vite.child.exitCode, null, `Vite exited with code ${vite.child.exitCode}: ${vite.getStderr()}`)
    assert.equal(vite.child.signalCode, null, `Vite exited with signal ${vite.child.signalCode}: ${vite.getStderr()}`)
  } finally {
    if (vite?.child.exitCode === null && vite.child.signalCode === null) {
      const exited = once(vite.child, 'exit')
      vite.child.kill('SIGKILL')
      await exited
    }
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
