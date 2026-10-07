#!/usr/bin/env node
// Release preflight: select one component on main. Root CLI tags match the
// product constant; new Action tags advance their published repository series.
//
//   node scripts/release-preflight.mjs --tag vX.Y.Z [--sha COMMIT] [--main-ref origin/main]
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { releaseSeries, checkPublishedActionVersion } from './release-series.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function fail(message) {
  console.error(`release preflight failed: ${message}`)
  process.exit(1)
}

const tag = option('tag')
if (!tag) fail('--tag is required')
let series
try { series = releaseSeries(tag) } catch (error) { fail(error.message) }
if (series.component === 'cli') {
  const source = readFileSync(path.join(projectRoot, 'cli/internal/version/version.go'), 'utf8')
  const constant = /const Product = "([^"]+)"/.exec(source)?.[1]
  if (!constant) fail('cannot find the CLI version constant')
  if (constant !== series.version) fail(`tag ${tag} does not equal the CLI version constant ${constant}`)
}

const git = (args) => spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' })
const sha = option('sha') ?? git(['rev-parse', 'HEAD']).stdout.trim()
const mainRef = option('main-ref', 'origin/main')
const resolved = git(['rev-parse', '--verify', `${mainRef}^{commit}`])
if (resolved.status !== 0) fail(`cannot resolve ${mainRef}; fetch main before running the preflight`)
if (git(['merge-base', '--is-ancestor', sha, mainRef]).status !== 0) fail(`commit ${sha} is not on ${mainRef}; tag a commit that has been merged to main`)

if (series.action) {
  const inventory = git(['ls-remote', '--tags', `https://github.com/artifact-pages/${series.action}-action.git`])
  if (inventory.status !== 0) fail(`cannot read published ${series.action}-action tags; retry after repository access is restored`)
  const tags = inventory.stdout.split('\n').flatMap((line) => {
    const match = /^[0-9a-f]+\s+refs\/tags\/(v[^\s]+?)(?:\^\{\})?$/.exec(line)
    return match ? [match[1]] : []
  })
  try { checkPublishedActionVersion(series, tags) } catch (error) { fail(error.message) }
}

console.log(`release preflight passed: ${tag} selects ${series.component} and ${sha} is on ${mainRef}`)
