#!/usr/bin/env node
// Generate one Terraform Registry package repository from the monorepo module.
//
//   node scripts/build-terraform-package-repos.mjs \
//     --module cloudflare --version 0.1.0 --source-tag terraform-cloudflare/v0.1.0 \
//     --source-commit <40-hex-sha> --out DIR
//
// The result is deliberately a copy of the checked-in module tree plus three
// release-owned files: README notice, release.json, and the generated-PR guard.
import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const terraformModules = {
  cloudflare: {
    repository: 'terraform-cloudflare-artifact-pages',
    registryAddress: 'artifact-pages/artifact-pages/cloudflare',
    excluded: new Set(['RELEASE.md', 'scripts/check-package.py', 'modules/delivery/main.test.js']),
  },
  aws: {
    repository: 'terraform-aws-artifact-pages',
    registryAddress: 'artifact-pages/artifact-pages/aws',
    excluded: new Set(['artifact-csp.test.js', 'deployment.test.js', 'routes.test.js']),
  },
}

const plainVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const shaPattern = /^[0-9a-f]{40}$/

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function trackedModuleFiles(sourceRoot, module) {
  const prefix = `terraform/modules/${module}/`
  const result = spawnSync('git', ['ls-files', '-z', '--stage', '--', `terraform/modules/${module}`], {
    cwd: sourceRoot,
    encoding: null,
  })
  if (result.status !== 0) throw new Error(result.stderr.toString('utf8').trim() || 'cannot enumerate tracked module files')
  return result.stdout.toString('utf8').split('\0').filter(Boolean).map((entry) => {
    const separator = entry.indexOf('\t')
    const [mode, , stage] = entry.slice(0, separator).split(' ')
    const repositoryPath = entry.slice(separator + 1)
    if (stage !== '0') throw new Error(`module file has an unmerged index entry: ${repositoryPath}`)
    if (mode === '120000') throw new Error(`module tree contains an unsupported symlink: ${repositoryPath.slice(prefix.length)}`)
    if (mode !== '100644' && mode !== '100755') throw new Error(`module tree contains an unsupported file mode ${mode}: ${repositoryPath}`)
    if (!repositoryPath.startsWith(prefix)) throw new Error(`unexpected tracked path outside the module: ${repositoryPath}`)
    return { repositoryPath, relativePath: repositoryPath.slice(prefix.length), mode }
  })
}

function repositoryCommit(sourceRoot) {
  return runGit(sourceRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
}

function copyTrackedModule(sourceRoot, module, target, excluded, files) {
  if (files.length === 0) throw new Error(`module has no tracked files: terraform/modules/${module}`)
  for (const { repositoryPath, relativePath, mode } of files) {
    if (excluded.has(relativePath)) continue
    const from = path.join(sourceRoot, repositoryPath)
    const to = path.join(target, relativePath)
    const stat = lstatSync(from, { throwIfNoEntry: false })
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`tracked module file is missing or not a regular file: ${repositoryPath}`)
    mkdirSync(path.dirname(to), { recursive: true })
    cpSync(from, to)
    chmodSync(to, mode === '100755' ? 0o755 : 0o644)
  }
}

function rewriteRegistryExample(file, registryAddress, version) {
  let contents = readFileSync(file, 'utf8')
  const sources = [...contents.matchAll(/^([ \t]*source[ \t]*=[ \t]*")[^"]*("[ \t]*)$/gm)]
  const versions = [...contents.matchAll(/^([ \t]*version[ \t]*=[ \t]*")[^"]*("[ \t]*)$/gm)]
  if (sources.length !== 1 || versions.length !== 1) {
    throw new Error(`${path.relative(process.cwd(), file)} must contain one module source and one exact version`)
  }
  contents = contents.replace(/^([ \t]*source[ \t]*=[ \t]*")[^"]*("[ \t]*)$/m, (_line, before, after) => `${before}${registryAddress}${after}`)
  contents = contents.replace(/^([ \t]*version[ \t]*=[ \t]*")[^"]*("[ \t]*)$/m, (_line, before, after) => `${before}${version}${after}`)
  writeFileSync(file, contents)
}

function generatedPullRequestWorkflow() {
  return `name: Close pull requests to generated repository\n\non:\n  pull_request_target:\n    types: [opened, reopened]\n\npermissions:\n  contents: read\n  pull-requests: write\n\njobs:\n  close-generated-pull-request:\n    runs-on: ubuntu-24.04\n    steps:\n      - name: Point contributors to the source repository\n        env:\n          GH_TOKEN: \${{ github.token }}\n          PR_NUMBER: \${{ github.event.pull_request.number }}\n        run: |\n          set -euo pipefail\n          gh pr comment "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --body "This repository is generated from https://github.com/artifact-pages/artifact-pages. Please open issues and pull requests in the monorepo; changes here are replaced by the next module release."\n          gh pr close "$PR_NUMBER" --repo "$GITHUB_REPOSITORY"\n`
}

export function buildTerraformPackageRepos({ sourceRoot = projectRoot, out, module, version, sourceTag, sourceCommit }) {
  const definition = terraformModules[module]
  if (!definition) throw new Error(`unknown Terraform module ${module}; choose cloudflare or aws`)
  if (!plainVersion.test(version ?? '')) throw new Error(`version must be plain X.Y.Z without prerelease or build metadata, got ${version}`)
  const expectedTag = `terraform-${module}/v${version}`
  if (sourceTag !== undefined && sourceTag !== expectedTag) throw new Error(`source tag must be ${expectedTag}, got ${sourceTag}`)
  sourceTag ??= expectedTag
  sourceCommit ??= repositoryCommit(sourceRoot)
  if (!shaPattern.test(sourceCommit)) throw new Error(`source commit must be a full 40-character SHA, got ${sourceCommit}`)
  if (!out) throw new Error('--out is required')

  const moduleRoot = path.resolve(sourceRoot, 'terraform', 'modules', module)
  const required = ['README.md', 'LICENSE', 'main.tf', 'variables.tf', 'outputs.tf', 'versions.tf', 'examples/registry-consumer/main.tf']
  const trackedFiles = trackedModuleFiles(sourceRoot, module)
  const trackedPaths = new Set(trackedFiles.map(({ relativePath }) => relativePath))
  for (const relative of required) {
    if (!trackedPaths.has(relative) || !lstatSync(path.join(moduleRoot, relative), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`module is missing required tracked file ${relative}`)
    }
  }

  const target = path.resolve(out, definition.repository)
  if (target === moduleRoot || target.startsWith(`${moduleRoot}${path.sep}`) || moduleRoot.startsWith(`${target}${path.sep}`)) {
    throw new Error('output directory must not overlap the source module')
  }
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  copyTrackedModule(sourceRoot, module, target, definition.excluded, trackedFiles)
  rewriteRegistryExample(path.join(target, 'examples', 'registry-consumer', 'main.tf'), definition.registryAddress, version)

  const sourceRepository = 'artifact-pages/artifact-pages'
  const readme = readFileSync(path.join(target, 'README.md'), 'utf8')
  const notice = `> This repository is generated from [${sourceRepository}](https://github.com/${sourceRepository}) (\`terraform/modules/${module}\`). Open issues and pull requests there; changes here are replaced by the next module release.\n\n`
  writeFileSync(path.join(target, 'README.md'), notice + readme)
  writeFileSync(path.join(target, 'release.json'), `${JSON.stringify({
    schemaVersion: 1,
    version,
    repository: `artifact-pages/${definition.repository}`,
    sourceTag,
    sourceCommit,
  }, null, 2)}\n`)
  const workflow = path.join(target, '.github', 'workflows', 'close-generated-pull-requests.yml')
  mkdirSync(path.dirname(workflow), { recursive: true })
  writeFileSync(workflow, generatedPullRequestWorkflow())

  return [{ module, repository: definition.repository, directory: target, version, sourceTag, sourceCommit }]
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = option('out')
    if (!output) throw new Error('--out is required')
    const built = buildTerraformPackageRepos({
      module: option('module'),
      version: option('version'),
      sourceTag: option('source-tag'),
      sourceCommit: option('source-commit'),
      out: path.resolve(output),
    })
    for (const entry of built) console.log(`${entry.repository}: ${entry.directory} (${entry.sourceTag} at ${entry.sourceCommit})`)
  } catch (error) {
    console.error(`build-terraform-package-repos failed: ${error.message}`)
    process.exit(1)
  }
}
