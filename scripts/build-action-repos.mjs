#!/usr/bin/env node
// Generates the content of the four per-Action repositories (TD14) from actions/<name>/.
//
//   node scripts/build-action-repos.mjs [--version X.Y.Z] [--out DIR] [--repository OWNER/REPO]
//
// For each Action the output directory <out>/<name>-action/ holds:
//   action.yml     the source action.yml with shared script paths made repository-relative
//   scripts/       the shared scripts the Action runs (import closure, no tests)
//   release.json   {schemaVersion, actionVersion, bootstrapCli, cliRange, repository}
// The component version tags the generated repository independently from that CLI pin.
//   README.md      actions/<name>/README.md behind a "generated" notice
//   LICENSE        the product license
// The output is deterministic, so a re-run for the same commit changes nothing.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { requireCliRange } from '../actions/shared/cli-range.mjs'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const organization = 'artifact-pages'
export const productRepository = `${organization}/artifact-pages`
// Source directory under actions/ -> published repository <dir>-action.
export const actionNames = ['publish', 'preview', 'registry', 'app-deploy']

export function repositoryName(name) {
  return `${name}-action`
}

export function readProductVersion(sourceRoot = projectRoot) {
  const source = readFileSync(path.join(sourceRoot, 'cli', 'internal', 'version', 'version.go'), 'utf8')
  const match = /const Product = "([^"]+)"/.exec(source)
  if (!match) throw new Error('cli/internal/version/version.go does not define the Product constant')
  return match[1]
}

// Shared scripts an action.yml runs, plus everything they import.
export function scriptClosure(actionYml, sharedDir) {
  const wanted = new Set([...actionYml.matchAll(/\.\.\/shared\/([A-Za-z0-9_-]+\.mjs)/g)].map((match) => match[1]))
  const queue = [...wanted]
  while (queue.length > 0) {
    const file = queue.pop()
    const source = readFileSync(path.join(sharedDir, file), 'utf8')
    for (const match of source.matchAll(/from '\.\/([A-Za-z0-9_-]+\.mjs)'/g)) {
      if (!wanted.has(match[1])) {
        wanted.add(match[1])
        queue.push(match[1])
      }
    }
  }
  return [...wanted].sort()
}

export function repositoryActionYml(actionYml) {
  const rewritten = actionYml.replaceAll('$GITHUB_ACTION_PATH/../shared/', '$GITHUB_ACTION_PATH/scripts/')
  if (rewritten.includes('..')) throw new Error('action.yml still refers to a parent directory after rewriting')
  return rewritten
}

export function buildActionRepos({ sourceRoot = projectRoot, out, version, repository = productRepository, names = actionNames }) {
  const bootstrapCli = '0.2.0'
  const cliRange = '>=0.2.0 <0.3.0'
  requireCliRange(bootstrapCli, cliRange)
  if (repository !== productRepository) throw new Error('CLI release repository must be artifact-pages/artifact-pages')
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`version must look like X.Y.Z, got ${version}`)
  if (names.some((name) => !actionNames.includes(name))) throw new Error('unknown Action name')
  const built = []
  for (const name of names) {
    const source = path.join(sourceRoot, 'actions', name)
    const target = path.join(out, repositoryName(name))
    rmSync(target, { recursive: true, force: true })
    mkdirSync(path.join(target, 'scripts'), { recursive: true })
    const actionYml = readFileSync(path.join(source, 'action.yml'), 'utf8')
    writeFileSync(path.join(target, 'action.yml'), repositoryActionYml(actionYml))
    const scripts = scriptClosure(actionYml, path.join(sourceRoot, 'actions', 'shared'))
    for (const script of scripts) cpSync(path.join(sourceRoot, 'actions', 'shared', script), path.join(target, 'scripts', script))
    writeFileSync(path.join(target, 'release.json'), `${JSON.stringify({ schemaVersion: 2, actionVersion: version, bootstrapCli, cliRange, repository }, null, 2)}\n`)
    const readme = readFileSync(path.join(source, 'README.md'), 'utf8')
    writeFileSync(path.join(target, 'README.md'), `> This repository is generated from [${productRepository}](https://github.com/${productRepository}) (\`actions/${name}\`) on its component release. Open issues and pull requests there.\n\n${readme}`)
    cpSync(path.join(sourceRoot, 'LICENSE'), path.join(target, 'LICENSE'))
    built.push({ name, repository: repositoryName(name), directory: target, scripts })
  }
  return built
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = path.resolve(option('out') ?? path.join(projectRoot, '.local', 'action-repos'))
    const version = option('version') ?? readProductVersion()
    const built = buildActionRepos({ out, version, repository: option('repository') ?? productRepository, names: option('action') ? [option('action')] : actionNames })
    for (const entry of built) console.log(`${entry.repository}: ${entry.directory} (${entry.scripts.join(', ')})`)
  } catch (error) {
    console.error(`build-action-repos failed: ${error.message}`)
    process.exit(1)
  }
}
