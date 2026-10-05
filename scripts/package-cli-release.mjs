#!/usr/bin/env node
// Builds the release CLI binaries for the platforms the composite Actions can
// use, writes their sha256 checksums and the Go dependency notices (TD2: notices
// must accompany any distributed CLI binary), and writes everything to --out.
//
//   node scripts/package-cli-release.mjs --version X.Y.Z --out DIR [--platform linux/amd64]
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assetName, checksumsName, noticesName, platforms, sha256 } from '../actions/shared/prebuilt-cli.mjs'
import { readProductVersion } from './build-action-repos.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const licensePattern = /^(licen[cs]e|copying|notice)([.-].*)?$/i

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function fail(message) {
  console.error(`package-cli-release failed: ${message}`)
  process.exit(1)
}

function go(args, env = {}) {
  const result = spawnSync('go', args, { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) fail(`go ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

// Returns the third-party modules linked into the CLI for one platform.
export function linkedModules(platform) {
  const output = go(
    ['list', '-deps', '-f', '{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}', './cli/cmd/artifact-pages'],
    { GOOS: platform.os, GOARCH: platform.arch, CGO_ENABLED: '0' },
  )
  return output.split('\n').filter(Boolean).map((line) => {
    const [modulePath, version, dir] = line.split('\t')
    return { path: modulePath, version, dir }
  })
}

export function renderNotices(modules, firstPartyLicense) {
  const unique = new Map()
  for (const module of modules) unique.set(`${module.path}@${module.version}`, module)
  const sections = [`Artifact Pages\n\n${firstPartyLicense.trim()}`]
  for (const key of [...unique.keys()].sort()) {
    const module = unique.get(key)
    const files = readdirSync(module.dir).filter((name) => licensePattern.test(name)).sort()
    if (files.length === 0) throw new Error(`${key} has no license file in ${module.dir}`)
    const text = files.map((name) => readFileSync(path.join(module.dir, name), 'utf8').trim()).join('\n\n')
    sections.push(`${key}\n\n${text}`)
  }
  return `This file lists the licenses of the Go modules linked into the artifact-pages CLI binaries.\n\n${sections.join(`\n\n${'-'.repeat(72)}\n\n`)}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = option('version')
  const out = option('out')
  if (!version || !out) fail('--version and --out are required')
  if (readProductVersion(projectRoot) !== version) fail(`--version ${version} does not equal the CLI product version ${readProductVersion(projectRoot)}`)
  const only = option('platform')
  const selected = platforms.filter((platform) => !only || `${platform.os}/${platform.arch}` === only)
  if (selected.length === 0) fail(`unknown platform ${only}`)
  mkdirSync(out, { recursive: true })

  const lines = []
  for (const platform of selected) {
    const asset = assetName(version, platform.os, platform.arch)
    go(['build', '-trimpath', '-o', path.join(path.resolve(out), asset), './cli/cmd/artifact-pages'], { GOOS: platform.os, GOARCH: platform.arch, CGO_ENABLED: '0' })
    lines.push(`${sha256(readFileSync(path.join(out, asset)))}  ${asset}`)
  }
  writeFileSync(path.join(out, checksumsName(version)), `${lines.join('\n')}\n`)
  const modules = selected.flatMap((platform) => linkedModules(platform))
  writeFileSync(path.join(out, noticesName(version)), renderNotices(modules, readFileSync(path.join(projectRoot, 'LICENSE'), 'utf8')))
  console.log(`Wrote ${selected.length} binaries, ${checksumsName(version)} and ${noticesName(version)} to ${out}`)
}
