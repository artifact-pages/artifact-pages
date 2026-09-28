import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

function lockContents(version, token) {
  return `pid=${process.pid}\nversion=${version}\ntoken=${token}\n`
}

export async function withWebReleaseLock(
  { projectRoot, releaseRoot, version, inheritedToken },
  task,
) {
  await fs.mkdir(releaseRoot, { recursive: true })
  // Every release shares the same dist tree, so a global packaging lock must
  // also serialize builds that use different version labels.
  const lockPath = path.join(releaseRoot, 'artifact-pages-web-package.lock')

  if (inheritedToken) {
    const contents = await fs.readFile(lockPath, 'utf8')
    const expectedTokenLine = `token=${inheritedToken}\n`
    const expectedVersionLine = `version=${version}\n`
    if (!contents.includes(expectedTokenLine) || !contents.includes(expectedVersionLine)) {
      throw new Error(`Refusing to use release lock for a different package operation: ${lockPath}`)
    }
    return task(inheritedToken)
  }

  const token = randomUUID()
  const contents = lockContents(version, token)
  let handle

  try {
    handle = await fs.open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(
        `Refusing to package version ${version}: release lock ${path.relative(projectRoot, lockPath)} already exists. Another packager may be active, or a previous attempt may have stopped; inspect the release files before removing the lock.`,
      )
    }
    throw error
  }

  try {
    await handle.writeFile(contents)
    return await task(token)
  } finally {
    try {
      await handle.close()
    } finally {
      try {
        if ((await fs.readFile(lockPath, 'utf8')) === contents) {
          await fs.rm(lockPath)
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
}
