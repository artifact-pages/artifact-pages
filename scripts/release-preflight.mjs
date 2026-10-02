#!/usr/bin/env node
// Release preflight (TD2): the pushed tag must be a plain vMAJOR.MINOR.PATCH,
// equal the CLI's product version constant, and point at a commit on main.
//
//   node scripts/release-preflight.mjs --tag vX.Y.Z [--sha COMMIT] [--main-ref origin/main]
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

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
const match = /^v(\d+\.\d+\.\d+)$/.exec(tag)
if (!match) fail(`tag ${tag} must look like vMAJOR.MINOR.PATCH (no pre-release suffix, no component prefix)`)

const source = readFileSync(path.join(projectRoot, 'cli/internal/version/version.go'), 'utf8')
const constant = /const Product = "([^"]+)"/.exec(source)?.[1]
if (!constant) fail('cannot find the product version constant in cli/internal/version/version.go')
if (constant !== match[1]) fail(`tag ${tag} does not equal the CLI version constant ${constant}; the release commit must set cli/internal/version.Product to ${match[1]}`)

const git = (args) => spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' })
const sha = option('sha') ?? git(['rev-parse', 'HEAD']).stdout.trim()
const mainRef = option('main-ref', 'origin/main')
const resolved = git(['rev-parse', '--verify', `${mainRef}^{commit}`])
if (resolved.status !== 0) fail(`cannot resolve ${mainRef}; fetch main before running the preflight`)
if (git(['merge-base', '--is-ancestor', sha, mainRef]).status !== 0) fail(`commit ${sha} is not on ${mainRef}; tag a commit that has been merged to main`)

console.log(`release preflight passed: ${tag} equals the CLI constant and ${sha} is on ${mainRef}`)
