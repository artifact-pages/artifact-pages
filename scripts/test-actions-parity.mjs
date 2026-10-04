import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPreviewTrust } from '../actions/shared/verify-preview-pr.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localRoot = path.join(projectRoot, '.local')
const actionRunner = path.join(projectRoot, 'actions', 'shared', 'invoke-cli.mjs')

const expectedActionContracts = {
  admin: {
    directory: path.join(projectRoot, 'actions', 'admin'),
    inputs: ['operation', 'config', 'github-token', 'site', 'archive', 'repository', 'dry-run', 'publish-on', 'summary', 'checkout', 'fetch-depth'],
    outputs: ['operation', 'outcome', 'site', 'registry-updated', 'changes', 'preview-changes', 'result', 'exit-code', 'error'],
  },
  site: {
    directory: path.join(projectRoot, 'actions', 'site-publish'),
    inputs: ['site', 'source', 'config', 'github-token', 'dry-run', 'publish-on', 'summary', 'checkout', 'fetch-depth'],
    outputs: ['operation', 'outcome', 'site', 'registry-updated', 'changes', 'preview-changes', 'result', 'exit-code', 'error'],
  },
  preview: {
    directory: path.join(projectRoot, 'actions', 'preview-publish'),
    inputs: ['site', 'source', 'head', 'default-ref', 'pull-request', 'include', 'base-url', 'config', 'github-token', 'dry-run', 'comment', 'summary', 'checkout', 'fetch-depth'],
    outputs: ['operation', 'outcome', 'site', 'group-list-url', 'documents', 'result', 'exit-code', 'error', 'comment-url'],
  },
}

function sectionKeys(source, sectionName) {
  const lines = source.split(/\r?\n/)
  const sectionStart = lines.findIndex((line) => line === `${sectionName}:`)
  assert.notEqual(sectionStart, -1, `action.yml is missing the ${sectionName} section`)

  const keys = []
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (lines[index] && !/^\s/.test(lines[index])) break
    const match = lines[index].match(/^  ([\w-]+):\s*$/)
    if (match) keys.push(match[1])
  }
  return keys
}

function sectionProperties(source, sectionName, key) {
  const lines = source.split(/\r?\n/)
  const sectionStart = lines.findIndex((line) => line === `${sectionName}:`)
  const entryStart = lines.findIndex((line, index) => index > sectionStart && line === `  ${key}:`)
  assert.notEqual(entryStart, -1, `${sectionName}.${key} is missing from action.yml`)

  const properties = {}
  for (let index = entryStart + 1; index < lines.length; index += 1) {
    if (lines[index] && !/^    /.test(lines[index])) break
    const match = lines[index].match(/^    ([\w-]+):\s*(.*)$/)
    if (match) properties[match[1]] = match[2]
  }
  return properties
}

function parseCliStep(source) {
  const lines = source.split(/\r?\n/)
  const idIndex = lines.findIndex((line) => line === '      id: cli')
  assert.notEqual(idIndex, -1, 'action.yml is missing the CLI step id')
  let stepStart = idIndex
  while (stepStart >= 0 && !/^    - name: /.test(lines[stepStart])) stepStart -= 1
  assert.notEqual(stepStart, -1, 'action.yml is missing the CLI step declaration')

  let stepEnd = idIndex + 1
  while (stepEnd < lines.length && !/^    - name: /.test(lines[stepEnd])) stepEnd += 1
  const stepLines = lines.slice(stepStart, stepEnd)
  const envIndex = stepLines.findIndex((line) => line === '      env:')
  assert.notEqual(envIndex, -1, 'CLI step is missing its environment block')

  const env = {}
  for (let index = envIndex + 1; index < stepLines.length; index += 1) {
    const match = stepLines[index].match(/^        ([A-Z][A-Z0-9_]*):\s*(.*)$/)
    if (match) env[match[1]] = match[2]
    else if (stepLines[index] && !/^          /.test(stepLines[index])) break
  }

  return { lines: stepLines, env }
}

// The Marketplace entry point at the repository root must stay the site-publish
// Action, differing only in listing metadata and root-relative source paths.
async function assertRootActionMatchesSitePublish() {
  const root = await fs.readFile(path.join(projectRoot, 'action.yml'), 'utf8')
  const site = await fs.readFile(path.join(expectedActionContracts.site.directory, 'action.yml'), 'utf8')
  assert.match(root, /^name: Artifact Pages$/m, 'root Action must keep its Marketplace name')
  assert.match(root, /^branding:\n  icon: book-open\n  color: blue$/m, 'root Action must keep its Marketplace branding')
  const description = root.match(/^description: (.*)$/m)?.[1] ?? ''
  assert.ok(description.length > 0 && description.length <= 125, 'root Action description must be present and short enough for the Marketplace card')
  const rootBody = root.slice(root.indexOf('\ninputs:\n'))
  const siteBody = site.slice(site.indexOf('\ninputs:\n'))
    .replace('${{ github.action_path }}/../../go.mod', '${{ github.action_path }}/go.mod')
    .replaceAll('working-directory: ${{ github.action_path }}/../..', 'working-directory: ${{ github.action_path }}')
    .replaceAll('--source-root "${{ github.action_path }}/../.."', '--source-root "${{ github.action_path }}"')
    .replaceAll('$GITHUB_ACTION_PATH/../shared/', '$GITHUB_ACTION_PATH/actions/shared/')
  assert.equal(rootBody, siteBody, 'root Action inputs, outputs and steps must match actions/site-publish apart from root-relative paths')
  assert.equal(
    await fs.realpath(path.join(projectRoot, 'actions', 'shared', 'invoke-cli.mjs')),
    await fs.realpath(actionRunner),
    'root Action runner path must resolve to the shared wrapper',
  )
}

async function assertCompositeActionWiring() {
  for (const [kind, contract] of Object.entries(expectedActionContracts)) {
    const actionPath = path.join(contract.directory, 'action.yml')
    const source = await fs.readFile(actionPath, 'utf8')
    const actualInputs = sectionKeys(source, 'inputs').sort()
    const actualOutputs = sectionKeys(source, 'outputs').sort()
    assert.deepEqual(actualInputs, [...contract.inputs].sort(), `${kind} Action input contract changed`)
    assert.deepEqual(actualOutputs, [...contract.outputs].sort(), `${kind} Action output contract changed`)
    if (kind === 'admin') {
      assert.equal(sectionProperties(source, 'inputs', 'operation').default, 'registry-register', 'admin Action must default to registry register')
    }

    const step = parseCliStep(source)
    assert.match(source, /^  using: composite$/m, `${kind} Action must remain an optional composite wrapper`)
    assert.match(source, /^        go-version-file: \$\{\{ github\.action_path \}\}\/\.\.\/\.\.\/go\.mod$/m, `${kind} Action must read go.mod relative to its own source`)
    assert.match(source, /^      working-directory: \$\{\{ github\.action_path \}\}\/\.\.\/\.\.$/m, `${kind} Action must build from its own repository root`)
    assert.match(source, /^      run: go build -trimpath -o "\$RUNNER_TEMP\/artifact-pages" \.\/cli\/cmd\/artifact-pages$/m, `${kind} Action must build the shared CLI binary`)
    assert.ok(step.lines.includes('      working-directory: ${{ github.workspace }}'), `${kind} CLI invocation must run from the adopter's workspace`)
    assert.ok(step.lines.includes('      run: node "$GITHUB_ACTION_PATH/../shared/invoke-cli.mjs"'), `${kind} Action must invoke the shared CLI wrapper from action_path`)

    const expectedEnv = {
      ARTIFACT_PAGES_CLI: '${{ runner.temp }}/artifact-pages',
      ARTIFACT_PAGES_ACTION_KIND: kind,
      GITHUB_TOKEN: '${{ inputs.github-token || github.token }}',
    }
    if (kind === 'site') expectedEnv.ARTIFACT_PAGES_INPUT_OPERATION = 'publish'
    if (kind === 'preview') expectedEnv.ARTIFACT_PAGES_INPUT_OPERATION = 'publish'
    // The comment input belongs to the separate comment step, not the CLI invocation.
    for (const inputName of contract.inputs.filter((name) => name !== 'github-token' && name !== 'checkout' && name !== 'fetch-depth' && !(kind === 'preview' && name === 'comment'))) {
      const envName = `ARTIFACT_PAGES_INPUT_${inputName.toUpperCase().replaceAll('-', '_')}`
      if (envName !== 'ARTIFACT_PAGES_INPUT_OPERATION' || kind !== 'site') {
        expectedEnv[envName] = `\${{ inputs.${inputName} }}`
      }
    }
    assert.deepEqual(step.env, expectedEnv, `${kind} Action input-to-environment wiring changed`)

    const outputMappings = Object.fromEntries(contract.outputs.map((name) => [
      name,
      sectionProperties(source, 'outputs', name).value,
    ]))
    const expectedOutputMappings = Object.fromEntries(contract.outputs.map((name) => {
      const outputKey = name.includes('-') ? `['${name}']` : `.${name}`
      const expression = kind === 'preview' && name === 'comment-url'
        ? "${{ steps.comment.outputs['comment-url'] }}"
        : kind === 'preview'
        ? `\${{ steps.cli.outputs${outputKey} || steps.preflight.outputs${outputKey} }}`
        : `\${{ steps.cli.outputs${outputKey} }}`
      return [name, expression]
    }))
    assert.deepEqual(outputMappings, expectedOutputMappings, `${kind} Action outputs must relay the shared CLI step outputs`)

    // Prebuilt CLI: a release-tag ref installs the released binary; every Go step is skipped then.
    assert.match(source, /ARTIFACT_PAGES_ACTION_REF: \$\{\{ github\.action_ref \}\}/, `${kind} Action must decide on the Action ref`)
    assert.match(source, /ARTIFACT_PAGES_ACTION_REPOSITORY: \$\{\{ github\.action_repository \}\}/, `${kind} Action must download from its own repository`)
    assert.match(source, /ARTIFACT_PAGES_TOKEN: \$\{\{ github\.token \}\}/, `${kind} Action must use the workflow token, not the private-config token, for release downloads`)
    assert.equal((source.match(/if: \$\{\{ steps\.prebuilt\.outputs\.used != 'true' \}\}/g) ?? []).length, 4, `${kind} Action must skip setup-go, the cache steps and the build when the released binary is used`)
    assert.ok(source.indexOf('id: prebuilt') < source.indexOf('uses: actions/setup-go@'), `${kind} Action must try the released binary before Go setup`)
    if (kind === 'preview') assert.ok(source.indexOf('verify-preview-pr.mjs') < source.indexOf('id: prebuilt'), 'preview trust preflight must precede the CLI download')

    // Go build cache (IMP-46 slice 3): actions/cache keyed on the pinned source, because setup-go cannot hash a go.sum outside the workspace.
    assert.match(source, /^      uses: actions\/cache@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m, `${kind} Action must pin actions/cache to a full SHA`)
    assert.match(source, /^        key: \$\{\{ steps\.go-cache\.outputs\.key \}\}$/m, `${kind} Action must key the Go cache on the pinned source`)
    assert.match(source, /cat go\.mod go\.sum/, `${kind} Action Go cache key must hash go.mod and go.sum`)
    assert.ok(source.indexOf('uses: actions/setup-go@') < source.indexOf('id: go-cache') && source.indexOf('uses: actions/cache@') < source.indexOf('go build -trimpath'), `${kind} Action must restore the Go cache after Go setup and before the build`)

    // Own checkout (decision 2): pinned, workflow token only, no persisted credentials, before anything else.
    assert.match(source, new RegExp(`ARTIFACT_PAGES_INPUT_CHECKOUT: \\$\\{\\{ inputs\\.checkout \\}\\}`), `${kind} Action must pass the checkout input to the decision step`)
    assert.equal(sectionProperties(source, 'inputs', 'checkout').default, 'auto', `${kind} checkout must default to auto`)
    assert.equal(sectionProperties(source, 'inputs', 'fetch-depth').default, '"0"', `${kind} fetch-depth must default to 0`)
    assert.match(source, /^      uses: actions\/checkout@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m, `${kind} checkout must be pinned to a full SHA with a version comment`)
    assert.match(source, /^      if: \$\{\{ steps\.checkout-mode\.outputs\.checkout == 'true' \}\}$/m, `${kind} checkout must follow the decision step`)
    assert.match(source, /^        fetch-depth: \$\{\{ inputs\.fetch-depth \}\}$/m, `${kind} checkout must use the fetch-depth input`)
    assert.match(source, /^        persist-credentials: false$/m, `${kind} checkout must not persist credentials`)
    assert.doesNotMatch(source.slice(source.indexOf('uses: actions/checkout@'), source.indexOf('uses: actions/checkout@') + 400), /token:/, `${kind} checkout must use the workflow token, not the github-token input`)
    assert.ok(source.indexOf('checkout-mode.mjs') < source.indexOf('uses: actions/setup-go@'), `${kind} checkout must precede Go setup`)
    if (kind === 'preview') {
      assert.match(source, /^        ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}$/m, 'preview checkout must use the base ref, never the pull-request head')
      assert.ok(source.indexOf('uses: actions/checkout@') < source.indexOf('verify-preview-pr.mjs'), 'preview checkout must precede the preflight that reads Git refs')
      assert.doesNotMatch(source, /pull_request\.head\.(ref|sha)/, 'preview Action must not reference the pull-request head for checkout')
    } else {
      assert.doesNotMatch(source, /\n        ref:/, `${kind} checkout must use the event's default ref`)
    }

    if (kind === 'preview') {
      const preflightLine = source.indexOf('run: node "$GITHUB_ACTION_PATH/../shared/verify-preview-pr.mjs"')
      const setupGoLine = source.indexOf('uses: actions/setup-go@')
      const cliLine = source.indexOf('run: node "$GITHUB_ACTION_PATH/../shared/invoke-cli.mjs"')
      assert.ok(preflightLine >= 0 && setupGoLine > preflightLine && cliLine > setupGoLine, 'preview trust preflight must run before CLI build and provider-backed invocation')
      assert.match(source, /ARTIFACT_PAGES_INPUT_PULL_REQUEST: \$\{\{ inputs\.pull-request \}\}/, 'preview Action must pass only the explicit pull-request input to preflight')
      assert.match(source, /ARTIFACT_PAGES_INPUT_HEAD: \$\{\{ inputs\.head \}\}/, 'preview Action must verify the selected head when PR provenance is explicit')
      assert.match(source, /ARTIFACT_PAGES_INPUT_DEFAULT_REF: \$\{\{ inputs\.default-ref \}\}/, 'preview Action must give preflight the same default-ref input as the CLI')
      assert.equal(sectionProperties(source, 'inputs', 'head').default, '""', 'preview head must default to empty so runtime resolution applies')
      assert.equal(sectionProperties(source, 'inputs', 'default-ref').default, '""', 'preview default-ref must default to empty so runtime resolution applies')
      assert.equal(sectionProperties(source, 'inputs', 'comment').default, '"false"', 'preview comment must be opt-in')
      const commentLine = source.indexOf('run: node "$GITHUB_ACTION_PATH/../shared/preview-comment.mjs"')
      assert.ok(commentLine > cliLine, 'preview comment must run after the CLI step')
      assert.match(source, /if: \$\{\{ always\(\) && inputs\.comment == 'true' && steps\.preflight\.outputs\.trusted == 'true' \}\}/, 'preview comment must run even after a CLI failure, but only once trust preflight passed')
    }
  }

  await assertRootActionMatchesSitePublish()

  await assert.rejects(fs.access(path.join(projectRoot, 'actions', 'preview-preflight')), 'the standalone preview-preflight Action was removed; preview-publish runs the trust verification itself')

  assert.equal(await fs.realpath(path.resolve(expectedActionContracts.admin.directory, '../../go.mod')), await fs.realpath(path.join(projectRoot, 'go.mod')), 'admin Action source path must resolve to this repository go.mod')
  assert.equal(await fs.realpath(path.resolve(expectedActionContracts.site.directory, '../../go.mod')), await fs.realpath(path.join(projectRoot, 'go.mod')), 'site Action source path must resolve to this repository go.mod')
  assert.equal(await fs.realpath(path.resolve(expectedActionContracts.admin.directory, '../shared/invoke-cli.mjs')), await fs.realpath(actionRunner), 'admin Action runner path must resolve to the shared wrapper')
  assert.equal(await fs.realpath(path.resolve(expectedActionContracts.site.directory, '../shared/invoke-cli.mjs')), await fs.realpath(actionRunner), 'site Action runner path must resolve to the shared wrapper')
  assert.equal(await fs.realpath(path.resolve(expectedActionContracts.preview.directory, '../shared/invoke-cli.mjs')), await fs.realpath(actionRunner), 'preview Action runner path must resolve to the shared wrapper')
  assert.equal(await fs.realpath(path.resolve(expectedActionContracts.preview.directory, '../shared/verify-preview-pr.mjs')), await fs.realpath(path.join(projectRoot, 'actions', 'shared', 'verify-preview-pr.mjs')), 'preview Action preflight path must resolve to the shared verifier')
}

async function assertWorkflowExamples() {
  const exampleDirectory = path.join(projectRoot, 'examples', 'github-actions')
  const examples = (await fs.readdir(exampleDirectory)).filter((name) => name.endsWith('.yml')).sort()
  assert.deepEqual(examples, [
    'admin-app-deploy.yml',
    'admin-registry-register.yml',
    'satellite-preview-label.yml',
    'satellite-preview.yml',
    'satellite-publish.yml',
  ], 'workflow examples must name the public operations they invoke')

  for (const name of examples) {
    const source = await fs.readFile(path.join(exampleDirectory, name), 'utf8')
    const thirdPartyRefs = [...source.matchAll(/^\s+uses: (?:actions\/checkout|aws-actions\/configure-aws-credentials)@([^\s#]+).*$/gm)]
    assert.ok(thirdPartyRefs.length > 0, `${name} should pin its third-party Action references`)
    for (const [, revision] of thirdPartyRefs) {
      assert.match(revision, /^[0-9a-f]{40}$/, `${name} has an unpinned third-party Action: ${revision}`)
    }
    assert.match(source, /uses: tasuku43\/git-artifact-pages\/actions\/(?:admin|site-publish|preview-publish)@<FULL_REVIEWED_ACTION_COMMIT_SHA>/, `${name} should make the unpublished component release pin explicit`)
    if (!name.startsWith('satellite-preview')) {
      assert.match(source, /^permissions:\n  contents: read\n  id-token: write$/m, `${name} should request only repository read and OIDC token permissions`)
    }
    assert.match(source, /persist-credentials: false/, `${name} should not persist checkout credentials`)
    assert.doesNotMatch(source, /workflow_call|contents:\s+write/, `${name} should not add a reusable workflow or broad GitHub token permissions`)
  }

  const admin = await fs.readFile(path.join(exampleDirectory, 'admin-registry-register.yml'), 'utf8')
  assert.match(admin, /ARTIFACT_PAGES_REGISTRY_ADMIN_ROLE_ARN/, 'registry workflow must use the registry admin role')
  assert.match(admin, /operation: registry-register/, 'registry workflow must call the registry register operation')
  const app = await fs.readFile(path.join(exampleDirectory, 'admin-app-deploy.yml'), 'utf8')
  assert.match(app, /ARTIFACT_PAGES_APP_DEPLOY_ROLE_ARN/, 'application workflow must use the app-plane role')
  const satellite = await fs.readFile(path.join(exampleDirectory, 'satellite-publish.yml'), 'utf8')
  assert.match(satellite, /ARTIFACT_PAGES_SRE_PUBLISH_ROLE_ARN/, 'satellite workflow must use the site-scoped role')
  assert.match(satellite, /^\s+site: sre$/m, 'satellite workflow must select a site explicitly')

  const preview = await fs.readFile(path.join(exampleDirectory, 'satellite-preview.yml'), 'utf8')
  assert.match(preview, /^\s+if: github\.event\.pull_request\.head\.repo\.full_name == github\.repository$/m, 'preview jobs must skip fork-origin PRs before any step runs')
  assert.doesNotMatch(preview, /preview-preflight|needs:/, 'preview example is a single job; preview-publish verifies trust itself')
  assert.doesNotMatch(preview, /pull_request_target/, 'preview workflow must not use privileged pull_request_target')
  assert.match(preview, /ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/, 'checkout may load only the registered repository base branch')
  assert.doesNotMatch(preview, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/, 'workflow must not check out PR head content')
  assert.ok(preview.indexOf('configure-aws-credentials@') < preview.indexOf('actions/preview-publish@'), 'provider credentials must be configured before the provider-backed preview Action')
  assert.match(preview, /pull-request: \$\{\{ github\.event\.pull_request\.number \}\}/, 'workflow must pass PR provenance explicitly')
  assert.doesNotMatch(preview, /^\s+(?:head|default-ref):/m, 'workflow should rely on the pull_request defaults for head and default-ref')
  assert.match(preview, /^\s+comment: true$/m, 'workflow should opt in to the preview comment')
  assert.match(preview, /pull-requests: write/, 'the publish job needs pull-requests: write to comment')
  assert.match(preview, /fetch-depth: 0/, 'workflow must fetch full history for merge-base selection')
  assert.match(preview, /id-token: write/, 'only the provider job should request OIDC permission')

  const labeled = await fs.readFile(path.join(exampleDirectory, 'satellite-preview-label.yml'), 'utf8')
  assert.match(labeled, /types: \[labeled, synchronize, reopened\]/, 'label example must react to label, push, and reopen events')
  assert.match(labeled, /^    paths:$/m, 'label example must filter by paths')
  assert.match(labeled, /github\.event\.label\.name == 'preview'/, 'label example must check the label')
  assert.match(labeled, /github\.event\.label\.name != 'preview' && format\('-unrelated-\{0\}', github\.run_id\)/, 'label example must isolate unrelated-label events from the preview concurrency group')
  assert.doesNotMatch(labeled, /pull_request_target/, 'label example must not use pull_request_target')
  assert.doesNotMatch(labeled, /preview-preflight/, 'label example must not reference the removed preflight Action')
  assert.match(labeled, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/, 'label example must skip fork-origin PRs')
  assert.ok(labeled.indexOf('configure-aws-credentials@') < labeled.indexOf('actions/preview-publish@'), 'label example must configure credentials before publishing')
}

function run(command, args, { cwd = projectRoot, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'no exit status'}).${detail ? `\n${detail}` : ''}`)
  }
  return result.stdout.trim()
}

async function writeFile(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split('/'))
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, contents)
}

function git(root, ...args) {
  return run('git', args, { cwd: root }).trim()
}

async function initRepository(root, origin) {
  await fs.mkdir(root, { recursive: true })
  git(root, 'init', '--initial-branch=main')
  git(root, 'remote', 'add', 'origin', origin)
  git(root, 'config', 'user.name', 'Artifact Pages Action Test')
  git(root, 'config', 'user.email', 'artifact-pages-action@example.invalid')
}

function commit(root, message) {
  git(root, 'add', '--all')
  git(root, 'commit', '-m', message)
}

function parseCliResult(execution, label) {
  let result
  try {
    result = JSON.parse(execution.stdout)
  } catch {
    throw new Error(`${label} did not return JSON (exit ${execution.status}): ${execution.stdout}\n${execution.stderr}`)
  }
  return { exitCode: execution.status, result, stdout: execution.stdout, stderr: execution.stderr }
}

async function treeSnapshot(root) {
  const files = []
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath)
      } else if (entry.isFile()) {
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/')
        const digest = createHash('sha256').update(await fs.readFile(absolutePath)).digest('hex')
        files.push([relativePath, digest])
      }
    }
  }
  await visit(root)
  return files
}

function parseActionOutputs(contents) {
  const outputs = {}
  const lines = contents.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const separator = lines[index].indexOf('<<')
    if (separator < 1) continue
    const name = lines[index].slice(0, separator)
    const delimiter = lines[index].slice(separator + 2)
    const valueLines = []
    index += 1
    while (index < lines.length && lines[index] !== delimiter) {
      valueLines.push(lines[index])
      index += 1
    }
    assert.notEqual(index, lines.length, `unterminated GitHub output ${name}`)
    outputs[name] = valueLines.join('\n')
  }
  return outputs
}

function assertActionParity(direct, action, label) {
  assert.equal(action.exitCode, direct.exitCode, `${label}: Action exit status differs from direct CLI`)
  assert.deepEqual(action.result, direct.result, `${label}: Action JSON result differs from direct CLI`)
  assert.equal(action.stdout, direct.stdout, `${label}: Action stdout differs from direct CLI`)

  const outputs = action.outputs
  assert.equal(Number(outputs['exit-code']), direct.exitCode, `${label}: typed exit-code output`)
  assert.equal(outputs.operation, direct.result.operation, `${label}: operation output`)
  assert.equal(outputs.outcome, direct.result.outcome, `${label}: outcome output`)
  assert.equal(outputs.site ?? '', direct.result.site ?? '', `${label}: site output`)
  if (direct.result.operation === 'preview publish') {
    assert.equal(outputs['group-list-url'], direct.result.groupListUrl, `${label}: group-list-url output`)
    assert.deepEqual(JSON.parse(outputs.documents), direct.result.documents ?? [], `${label}: documents JSON output`)
    assert.deepEqual(JSON.parse(outputs.result), direct.result, `${label}: complete result output`)
  } else {
    assert.deepEqual(JSON.parse(outputs.changes), direct.result.changes ?? [], `${label}: changes output`)
    assert.deepEqual(JSON.parse(outputs['preview-changes']), direct.result.previewChanges ?? [], `${label}: preview-changes output`)
    assert.deepEqual(JSON.parse(outputs.result), direct.result, `${label}: result output`)
  }
  if (typeof direct.result.registryUpdated === 'boolean') {
    assert.equal(outputs['registry-updated'], String(direct.result.registryUpdated), `${label}: registry-updated boolean output`)
  }
  assert.equal(outputs.error ?? '', direct.result.error ?? '', `${label}: error output`)
}

async function runAction(kind, operation, cliArgs, inputs, workspace, binaryPath, scratchRoot, preflight = undefined, extraEnv = {}) {
  const outputPath = path.join(scratchRoot, `github-output-${kind}-${operation}-${Date.now()}.txt`)
  await fs.writeFile(outputPath, '')
  const actionEnvironment = {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    GITHUB_WORKSPACE: workspace,
    ARTIFACT_PAGES_CLI: binaryPath,
    ARTIFACT_PAGES_ACTION_KIND: kind,
    ARTIFACT_PAGES_INPUT_OPERATION: operation,
    ...extraEnv,
    ...Object.fromEntries(Object.entries(inputs).map(([name, value]) => [
      `ARTIFACT_PAGES_INPUT_${name.toUpperCase().replaceAll('-', '_')}`,
      value,
    ])),
  }

  if (kind === 'preview') {
    assert.ok(preflight?.event, 'preview Action parity must run its trust preflight before invoking the CLI')
    const eventPath = path.join(scratchRoot, `github-event-${Date.now()}.json`)
    await fs.writeFile(eventPath, JSON.stringify(preflight.event))
    const trustCheck = await verifyPreviewTrust({
      env: {
        ...actionEnvironment,
        GITHUB_REPOSITORY: preflight.repository,
        GITHUB_EVENT_NAME: preflight.eventName ?? 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
      },
    })
    assert.equal(trustCheck.explicit, false, 'pull-request none must remain a manual preview even during a same-repository PR event')
  }

  const execution = spawnSync('node', [actionRunner], {
    cwd: workspace,
    env: actionEnvironment,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (execution.error) throw execution.error
  const directResult = parseCliResult({ status: execution.status, stdout: execution.stdout, stderr: execution.stderr }, 'Action')
  const outputs = parseActionOutputs(await fs.readFile(outputPath, 'utf8'))
  const actionResult = JSON.parse(outputs.result)
  assert.deepEqual(actionResult, directResult.result, 'GitHub outputs did not preserve the CLI JSON object')
  return {
    exitCode: execution.status,
    result: actionResult,
    stdout: execution.stdout,
    stderr: execution.stderr,
    outputs,
  }
}

async function assertPreviewPreflight(repositoryDirectory, scratchRoot) {
  const headSHA = git(repositoryDirectory, 'rev-parse', 'HEAD')
  const repository = 'example/satellite'
  const sameRepositoryEvent = {
    repository: { full_name: repository },
    pull_request: {
      number: 42,
      base: { repo: { full_name: repository } },
      head: { repo: { full_name: repository }, sha: headSHA },
    },
  }
  const baseEnvironment = {
    GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_WORKSPACE: repositoryDirectory,
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_TOKEN: 'read-only-test-token',
  }

  let apiCalls = 0
  const responseFor = (metadata) => async (url, request) => {
    apiCalls += 1
    assert.equal(String(url), 'https://api.github.com/repos/example/satellite/pulls/42')
    assert.equal(request.headers.Authorization, 'Bearer read-only-test-token')
    return { status: 200, text: async () => JSON.stringify(metadata) }
  }
  const metadata = {
    number: 42,
    html_url: 'https://github.com/example/satellite/pull/42',
    base: { repo: { full_name: repository } },
    head: { repo: { full_name: repository }, sha: headSHA },
  }

  const manual = await verifyPreviewTrust({ env: { ...baseEnvironment, ARTIFACT_PAGES_INPUT_PULL_REQUEST: 'none' }, event: sameRepositoryEvent, fetchImpl: responseFor(metadata) })
  assert.deepEqual(manual, { explicit: false }, 'pull-request none must force a manual preview')
  assert.equal(apiCalls, 0, 'manual preview preflight should not look up a PR')
  const nonPullRequestEvent = await verifyPreviewTrust({ env: { ...baseEnvironment, GITHUB_EVENT_NAME: 'workflow_dispatch' }, event: sameRepositoryEvent, fetchImpl: responseFor(metadata) })
  assert.deepEqual(nonPullRequestEvent, { explicit: false }, 'only a pull_request event defaults the PR number')
  assert.equal(apiCalls, 0, 'a non-PR event must not look up a PR')
  const defaulted = await verifyPreviewTrust({ env: baseEnvironment, event: sameRepositoryEvent, fetchImpl: responseFor(metadata) })
  assert.deepEqual(defaulted, { explicit: true, pullRequestURL: metadata.html_url, headSHA }, 'the event PR number goes through the same verification as an explicit one')
  assert.equal(apiCalls, 1, 'a defaulted PR number is verified through the GitHub API')
  apiCalls = 0
  await assert.rejects(
    verifyPreviewTrust({ env: baseEnvironment, event: sameRepositoryEvent, fetchImpl: responseFor({ ...metadata, head: { repo: { full_name: 'contributor/satellite' }, sha: headSHA } }) }),
    /must originate from workflow repository/,
  )
  await assert.rejects(
    verifyPreviewTrust({ env: baseEnvironment, event: sameRepositoryEvent, fetchImpl: responseFor({ ...metadata, head: { repo: { full_name: repository }, sha: 'f'.repeat(40) } }) }),
    /no longer matches/,
  )
  apiCalls = 0

  const forkEvent = structuredClone(sameRepositoryEvent)
  forkEvent.pull_request.head.repo.full_name = 'contributor/satellite'
  await assert.rejects(
    verifyPreviewTrust({ env: baseEnvironment, event: forkEvent, fetchImpl: responseFor(metadata) }),
    /fork-origin pull requests cannot publish previews/,
  )
  assert.equal(apiCalls, 0, 'fork event should be rejected before GitHub lookup or provider invocation')

  const forkEventPath = path.join(scratchRoot, 'fork-preview-event.json')
  const preflightOutputPath = path.join(scratchRoot, 'fork-preview-preflight-output.txt')
  await fs.writeFile(forkEventPath, JSON.stringify(forkEvent))
  await fs.writeFile(preflightOutputPath, '')
  const failedPreflight = spawnSync('node', [path.join(projectRoot, 'actions', 'shared', 'verify-preview-pr.mjs')], {
    cwd: repositoryDirectory,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: forkEventPath,
      GITHUB_WORKSPACE: repositoryDirectory,
      GITHUB_OUTPUT: preflightOutputPath,
      ARTIFACT_PAGES_INPUT_SITE: 'sre',
      ARTIFACT_PAGES_INPUT_PULL_REQUEST: '',
    },
    encoding: 'utf8',
  })
  assert.equal(failedPreflight.status, 1, 'composite preflight must fail the Action for a fork-origin event')
  const preflightOutputs = parseActionOutputs(await fs.readFile(preflightOutputPath, 'utf8'))
  assert.equal(preflightOutputs.outcome, 'failed', 'composite preflight should return a typed failure output')
  assert.equal(preflightOutputs.site, 'sre', 'composite preflight failure should preserve the selected site')
  assert.equal(preflightOutputs.error.includes('fork-origin'), true, 'composite preflight should expose the fork rejection reason')
  assert.deepEqual(JSON.parse(preflightOutputs.documents), [], 'preflight failure should return an empty typed document array')
  assert.equal(JSON.parse(preflightOutputs.result).error, preflightOutputs.error, 'preflight failure result should preserve its error output')

  // A manual preview whose default ref is not fetched fails early with typed outputs and guidance.
  const refsOutputPath = path.join(scratchRoot, 'refs-preview-preflight-output.txt')
  await fs.writeFile(refsOutputPath, '')
  const refsPreflight = spawnSync('node', [path.join(projectRoot, 'actions', 'shared', 'verify-preview-pr.mjs')], {
    cwd: repositoryDirectory,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_WORKSPACE: repositoryDirectory,
      GITHUB_OUTPUT: refsOutputPath,
      ARTIFACT_PAGES_INPUT_SITE: 'sre',
      ARTIFACT_PAGES_INPUT_PULL_REQUEST: '',
      ARTIFACT_PAGES_INPUT_HEAD: 'HEAD',
      ARTIFACT_PAGES_INPUT_DEFAULT_REF: 'origin/not-fetched',
    },
    encoding: 'utf8',
  })
  assert.equal(refsPreflight.status, 1, 'unreachable default ref must fail the Action before the CLI runs')
  const refsOutputs = parseActionOutputs(await fs.readFile(refsOutputPath, 'utf8'))
  assert.equal(refsOutputs.trusted, 'true', 'trust verification precedes the ref check')
  assert.equal(refsOutputs.outcome, 'failed')
  assert.equal(refsOutputs['exit-code'], '1')
  assert.match(refsOutputs.error, /fetch-depth: 0/, 'ref failure must tell the caller how to fix the checkout')
  assert.equal(JSON.parse(refsOutputs.result).error, refsOutputs.error)

  await assert.rejects(
    verifyPreviewTrust({ env: { ...baseEnvironment, GITHUB_EVENT_NAME: 'pull_request_target' }, event: sameRepositoryEvent, fetchImpl: responseFor(metadata) }),
    /pull_request_target is not supported/,
  )
  assert.equal(apiCalls, 0, 'pull_request_target should be rejected before GitHub lookup')

  const verified = await verifyPreviewTrust({
    env: { ...baseEnvironment, ARTIFACT_PAGES_INPUT_HEAD: 'HEAD', ARTIFACT_PAGES_INPUT_PULL_REQUEST: '42' },
    event: sameRepositoryEvent,
    fetchImpl: responseFor(metadata),
  })
  assert.deepEqual(verified, { explicit: true, pullRequestURL: metadata.html_url, headSHA })
  assert.equal(apiCalls, 1, 'explicit PR input should be resolved through the read-only GitHub API')

  await assert.rejects(
    verifyPreviewTrust({
      env: { ...baseEnvironment, ARTIFACT_PAGES_INPUT_PULL_REQUEST: '43' },
      event: sameRepositoryEvent,
      fetchImpl: responseFor(metadata),
    }),
    /does not match the current pull_request event/,
  )

  const movedMetadata = { ...metadata, head: { ...metadata.head, sha: 'f'.repeat(40) } }
  await assert.rejects(
    verifyPreviewTrust({
      env: { ...baseEnvironment, ARTIFACT_PAGES_INPUT_HEAD: 'HEAD', ARTIFACT_PAGES_INPUT_PULL_REQUEST: '42' },
      event: { ...sameRepositoryEvent, pull_request: { ...sameRepositoryEvent.pull_request, head: { ...sameRepositoryEvent.pull_request.head, sha: 'f'.repeat(40) } } },
      fetchImpl: responseFor(movedMetadata),
    }),
    /selected preview head does not match/,
  )

  const forkMetadata = { ...metadata, head: { repo: { full_name: 'contributor/satellite' }, sha: headSHA } }
  await assert.rejects(
    verifyPreviewTrust({
      env: { ...baseEnvironment, GITHUB_EVENT_NAME: 'workflow_dispatch', ARTIFACT_PAGES_INPUT_PULL_REQUEST: 'https://github.com/example/satellite/pull/42' },
      event: {},
      fetchImpl: responseFor(forkMetadata),
    }),
    /must originate from workflow repository/,
  )

  await assert.rejects(
    verifyPreviewTrust({ env: { ...baseEnvironment, ARTIFACT_PAGES_INPUT_PULL_REQUEST: 'https://github.com/other/repo/pull/42' }, event: sameRepositoryEvent, fetchImpl: responseFor(metadata) }),
    /does not belong to workflow repository/,
  )

  const apiCallsBeforeUntrustedEndpoint = apiCalls
  await assert.rejects(
    verifyPreviewTrust({
      env: { ...baseEnvironment, GITHUB_EVENT_NAME: 'workflow_dispatch', ARTIFACT_PAGES_INPUT_PULL_REQUEST: '42' },
      event: {},
      apiBaseURL: 'http://localhost:1234',
      fetchImpl: responseFor(metadata),
    }),
    /trusted HTTPS API origin/,
  )
  assert.equal(apiCalls, apiCallsBeforeUntrustedEndpoint, 'preflight must not send the read token to an untrusted HTTP API endpoint')

  const malformedEventPath = path.join(scratchRoot, 'invalid-preview-event.json')
  await fs.writeFile(malformedEventPath, '{')
  await assert.rejects(
    verifyPreviewTrust({ env: { ...baseEnvironment, GITHUB_EVENT_PATH: malformedEventPath }, eventName: 'pull_request' }),
  )
}

function runDirect(binaryPath, workspace, args, label) {
  const execution = spawnSync(binaryPath, args, {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (execution.error) throw execution.error
  return parseCliResult(execution, label)
}

async function makeTestBundle(root) {
  const payloadRoot = path.join(root, 'action-app-payload')
  const archiveName = 'artifact-pages-web-vaction-parity.tar.gz'
  const archivePath = path.join(root, archiveName)
  const files = {
    'assets/app.js': 'window.actionParity = true;\n',
    'index.html': '<!doctype html><main>Action parity</main><script src="/assets/app.js"></script>\n',
  }
  for (const [relativePath, contents] of Object.entries(files)) {
    await writeFile(payloadRoot, relativePath, contents)
  }
  run('tar', ['-czf', archivePath, '-C', payloadRoot, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  const digest = createHash('sha256').update(await fs.readFile(archivePath)).digest('hex')
  await fs.writeFile(`${archivePath}.json`, JSON.stringify({
    schemaVersion: 1,
    product: 'artifact-pages',
    component: 'web',
    version: 'action-parity',
    archive: archiveName,
    archiveSha256: digest,
    sourceCommit: '0000000000000000000000000000000000000000',
    sourceDirty: false,
    files: Object.keys(files).sort(),
  }))
  await fs.writeFile(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`)
  return archivePath
}

async function main() {
  await assertCompositeActionWiring()
  await assertWorkflowExamples()
  await fs.mkdir(localRoot, { recursive: true })
  const scratchRoot = await fs.mkdtemp(path.join(localRoot, 'actions-parity-'))
  try {
    const adminRoot = path.join(scratchRoot, 'admin')
    const satelliteRoot = path.join(scratchRoot, 'satellite')
    const storageRoot = path.join(scratchRoot, 'storage')
    const actionStorageRoot = path.join(scratchRoot, 'action-storage')
    const binaryPath = path.join(scratchRoot, 'artifact-pages')
    await fs.mkdir(storageRoot, { recursive: true })
    await Promise.all([
      initRepository(adminRoot, 'https://github.com/example/platform-admin.git'),
      initRepository(satelliteRoot, 'https://github.com/example/satellite.git'),
    ])

    const registeredSites = [
      'sites:',
      '  sre:',
      '    name: SRE',
      '    repository: example/satellite',
      '    sourcePath: docs/artifacts',
    ].join('\n')
    const emptySites = 'sites: {}'
    const deploymentConfig = (root, sites = registeredSites) => [
      'schemaVersion: 1',
      'provider: local',
      'local:',
      `  root: ${JSON.stringify(root)}`,
      sites,
      '',
    ].join('\n')
    const deploymentConfigWithoutSites = (root) => [
      'schemaVersion: 1',
      'provider: local',
      'local:',
      `  root: ${JSON.stringify(root)}`,
      '',
    ].join('\n')
    await writeFile(adminRoot, 'artifact-pages.yaml', deploymentConfig(storageRoot))
    await writeFile(adminRoot, '.artifact-pages-action.yaml', deploymentConfig(actionStorageRoot))
    await writeFile(adminRoot, '.artifact-pages-unregister.yaml', deploymentConfig(storageRoot, emptySites))
    await writeFile(adminRoot, '.artifact-pages-action-unregister.yaml', deploymentConfig(actionStorageRoot, emptySites))
    await writeFile(adminRoot, '.artifact-pages-no-sites.yaml', deploymentConfigWithoutSites(storageRoot))
    await writeFile(adminRoot, '.artifact-pages-action-no-sites.yaml', deploymentConfigWithoutSites(actionStorageRoot))
    commit(adminRoot, 'Add admin registry and local target')

    await writeFile(satelliteRoot, 'artifact-pages.yaml', deploymentConfig(storageRoot))
    await writeFile(satelliteRoot, '.artifact-pages-action.yaml', deploymentConfig(actionStorageRoot))
    await writeFile(satelliteRoot, 'docs/artifacts/overview.html', '<!doctype html><title>Overview</title><h1>SRE overview</h1>\n')
    commit(satelliteRoot, 'Add SRE artifact')
    run('go', ['build', '-o', binaryPath, './cli/cmd/artifact-pages'])

    const registryApplyArgs = ['registry', 'register', '--config', 'artifact-pages.yaml', '--format', 'json']
    const initialRegistry = runDirect(binaryPath, adminRoot, registryApplyArgs, 'initial registry register')
    assert.equal(initialRegistry.exitCode, 0, `initial registry register failed: ${JSON.stringify(initialRegistry.result)}`)
    assert.equal(initialRegistry.result.operation, 'registry register', 'registry Action must invoke the registry register operation')
    assert.equal(initialRegistry.result.outcome, 'registered', 'registry register must return the registered outcome')
    const actionInitialRegistry = await runAction('admin', 'registry-register', registryApplyArgs, {
      config: '.artifact-pages-action.yaml',
    }, adminRoot, binaryPath, scratchRoot)
    assertActionParity(initialRegistry, actionInitialRegistry, 'registry register')

    const registryArgs = ['registry', 'register', '--config', 'artifact-pages.yaml', '--dry-run', '--format', 'json']
    const registryStorageBeforeDryRun = await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)])
    const directRegistry = runDirect(binaryPath, adminRoot, registryArgs, 'direct registry register dry-run')
    const actionRegistry = await runAction('admin', 'registry-register', registryArgs, {
      config: '.artifact-pages-action.yaml', 'dry-run': 'true',
    }, adminRoot, binaryPath, scratchRoot)
    assertActionParity(directRegistry, actionRegistry, 'registry register dry-run')
    assert.deepEqual(await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)]), registryStorageBeforeDryRun, 'registry register dry-run changed local storage')

    const invalidRegistryArgs = ['registry', 'register', '--config', '.artifact-pages-no-sites.yaml', '--format', 'json']
    const invalidRegistryStorageBefore = await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)])
    const directInvalidRegistry = runDirect(binaryPath, adminRoot, invalidRegistryArgs, 'registry register config without sites')
    assert.equal(directInvalidRegistry.exitCode, 2, 'registry register without sites in config should preserve the CLI usage/validation exit class')
    const actionInvalidRegistry = await runAction('admin', 'registry-register', invalidRegistryArgs, {
      config: '.artifact-pages-action-no-sites.yaml',
    }, adminRoot, binaryPath, scratchRoot)
    assertActionParity(directInvalidRegistry, actionInvalidRegistry, 'registry register config without sites')
    assert.deepEqual(await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)]), invalidRegistryStorageBefore, 'registry register config validation changed local storage')

    const invalidUnregisterArgs = ['registry', 'unregister', '--site', 'sre', '--config', '.artifact-pages-no-sites.yaml', '--format', 'json']
    const directInvalidUnregister = runDirect(binaryPath, adminRoot, invalidUnregisterArgs, 'registry unregister config without sites')
    assert.equal(directInvalidUnregister.exitCode, 2, 'registry unregister without sites in config should preserve the CLI usage/validation exit class')
    const actionInvalidUnregister = await runAction('admin', 'registry-unregister', invalidUnregisterArgs, {
      site: 'sre', config: '.artifact-pages-action-no-sites.yaml',
    }, adminRoot, binaryPath, scratchRoot)
    assertActionParity(directInvalidUnregister, actionInvalidUnregister, 'registry unregister config without sites')
    assert.deepEqual(await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)]), invalidRegistryStorageBefore, 'registry unregister config validation changed local storage')

    const unregisterArgs = ['registry', 'unregister', '--site', 'sre', '--config', '.artifact-pages-unregister.yaml', '--dry-run', '--format', 'json']
    const unregisterStorageBeforeDryRun = await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)])
    const directUnregister = runDirect(binaryPath, adminRoot, unregisterArgs, 'direct registry unregister dry-run')
    const actionUnregister = await runAction('admin', 'registry-unregister', unregisterArgs, {
      site: 'sre', config: '.artifact-pages-action-unregister.yaml', 'dry-run': 'true',
    }, adminRoot, binaryPath, scratchRoot)
    assertActionParity(directUnregister, actionUnregister, 'registry unregister dry-run')
    assert.deepEqual(await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)]), unregisterStorageBeforeDryRun, 'registry unregister dry-run changed local storage')

    const unregisterApplyArgs = ['registry', 'unregister', '--site', 'sre', '--config', '.artifact-pages-unregister.yaml', '--format', 'json']
    const directUnregisterApply = runDirect(binaryPath, adminRoot, unregisterApplyArgs, 'registry unregister')
    const actionUnregisterApply = await runAction('admin', 'registry-unregister', unregisterApplyArgs, {
      site: 'sre', config: '.artifact-pages-action-unregister.yaml',
    }, adminRoot, binaryPath, scratchRoot)
    assertActionParity(directUnregisterApply, actionUnregisterApply, 'registry unregister')

    const reregisterRegistry = runDirect(binaryPath, adminRoot, registryApplyArgs, 'registry reregister')
    const actionReregisterRegistry = await runAction('admin', 'registry-register', registryApplyArgs, {
      config: '.artifact-pages-action.yaml',
    }, adminRoot, binaryPath, scratchRoot)
    assertActionParity(reregisterRegistry, actionReregisterRegistry, 'registry reregister')

    const siteArgs = ['site', 'publish', '--site', 'sre', '--source', 'docs/artifacts', '--config', 'artifact-pages.yaml', '--dry-run', '--format', 'json']
    const siteStorageBeforeDryRun = await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)])
    const directSite = runDirect(binaryPath, satelliteRoot, siteArgs, 'direct site dry-run')
    const actionSite = await runAction('site', 'publish', siteArgs, {
      site: 'sre', source: 'docs/artifacts', config: '.artifact-pages-action.yaml', 'dry-run': 'true',
    }, satelliteRoot, binaryPath, scratchRoot)
    assertActionParity(directSite, actionSite, 'site publish dry-run')
    assert.deepEqual(await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)]), siteStorageBeforeDryRun, 'site publish dry-run changed local storage')

    // publish-on: a run outside the condition is a dry-run, so a real-looking invocation changes nothing.
    const gatedSite = await runAction('site', 'publish', siteArgs.filter((arg) => arg !== '--dry-run'), {
      site: 'sre', source: 'docs/artifacts', config: '.artifact-pages-action.yaml', 'publish-on': 'push:refs/heads/main\nworkflow_dispatch',
    }, satelliteRoot, binaryPath, scratchRoot, undefined, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge' })
    assertActionParity(directSite, gatedSite, 'site publish gated by publish-on')
    assert.match(gatedSite.stderr, /::notice title=Artifact Pages dry-run::publish-on does not match event pull_request/, 'publish-on dry-run must be announced')
    assert.deepEqual(await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)]), siteStorageBeforeDryRun, 'publish-on dry-run changed local storage')
    const badPublishOn = await runAction('site', 'publish', siteArgs, {
      site: 'sre', source: 'docs/artifacts', config: '.artifact-pages-action.yaml', 'publish-on': 'push:main',
    }, satelliteRoot, binaryPath, scratchRoot).catch((error) => error)
    assert.ok(badPublishOn instanceof Error || badPublishOn.exitCode === 2, 'a malformed publish-on must fail')

    // Job Summary: written after the outputs, also on failure, and suppressed by summary: false.
    const summaryPath = path.join(scratchRoot, 'step-summary.md')
    await fs.writeFile(summaryPath, '')
    await runAction('site', 'publish', siteArgs, {
      site: 'sre', source: 'docs/artifacts', config: '.artifact-pages-action.yaml', 'dry-run': 'true',
    }, satelliteRoot, binaryPath, scratchRoot, undefined, { GITHUB_STEP_SUMMARY: summaryPath })
    const siteSummary = await fs.readFile(summaryPath, 'utf8')
    assert.match(siteSummary, /^### Artifact Pages: site publish \(planned\)/, 'site publish summary heading')
    assert.match(siteSummary, /- \*\*Mode:\*\* dry-run/, 'site publish summary shows dry-run')
    assert.match(siteSummary, /- \*\*Changes:\*\* \d+/, 'site publish summary shows the change count')
    await fs.writeFile(summaryPath, '')
    await runAction('site', 'publish', siteArgs, {
      site: 'sre', source: 'docs/artifacts', config: '.artifact-pages-action.yaml', 'dry-run': 'true', summary: 'false',
    }, satelliteRoot, binaryPath, scratchRoot, undefined, { GITHUB_STEP_SUMMARY: summaryPath })
    assert.equal(await fs.readFile(summaryPath, 'utf8'), '', 'summary: false must write nothing')
    await fs.writeFile(summaryPath, '')
    await runAction('site', 'publish', ['site', 'publish', '--site', 'not-registered', '--source', 'docs/artifacts', '--config', 'artifact-pages.yaml', '--dry-run', '--format', 'json'], {
      site: 'not-registered', source: 'docs/artifacts', config: '.artifact-pages-action.yaml', 'dry-run': 'true',
    }, satelliteRoot, binaryPath, scratchRoot, undefined, { GITHUB_STEP_SUMMARY: summaryPath })
    assert.match(await fs.readFile(summaryPath, 'utf8'), /\(failed\)[\s\S]*> \*\*Error \(exit 1\):\*\*/, 'failure summary shows the error')

    const failingSiteArgs = ['site', 'publish', '--site', 'not-registered', '--source', 'docs/artifacts', '--config', 'artifact-pages.yaml', '--dry-run', '--format', 'json']
    const directFailure = runDirect(binaryPath, satelliteRoot, failingSiteArgs, 'direct unregistered-site dry-run')
    assert.equal(directFailure.exitCode, 1, 'direct unregistered-site dry-run should preserve provider/eligibility exit class')
    const actionFailure = await runAction('site', 'publish', failingSiteArgs, {
      site: 'not-registered', source: 'docs/artifacts', config: '.artifact-pages-action.yaml', 'dry-run': 'true',
    }, satelliteRoot, binaryPath, scratchRoot)
    assertActionParity(directFailure, actionFailure, 'site publish failure')

    const initialSiteArgs = ['site', 'publish', '--site', 'sre', '--source', 'docs/artifacts', '--config', 'artifact-pages.yaml', '--format', 'json']
    const initialSite = runDirect(binaryPath, satelliteRoot, initialSiteArgs, 'initial site publish')
    assert.equal(initialSite.exitCode, 0, `initial site publish failed: ${JSON.stringify(initialSite.result)}`)
    const actionInitialSite = await runAction('site', 'publish', initialSiteArgs, {
      site: 'sre', source: 'docs/artifacts', config: '.artifact-pages-action.yaml',
    }, satelliteRoot, binaryPath, scratchRoot)
    assertActionParity(initialSite, actionInitialSite, 'site publish')

    const previewBranch = 'preview-action-fixture'
    git(satelliteRoot, 'checkout', '-b', previewBranch)
    await writeFile(satelliteRoot, 'docs/artifacts/overview.html', '<!doctype html><title>Preview overview</title><h1>Review this change</h1>\n')
    await writeFile(satelliteRoot, 'docs/artifacts/extra data.json', '{"generated":true}\n')
    commit(satelliteRoot, 'Prepare preview Action fixture')
    const previewHeadSHA = git(satelliteRoot, 'rev-parse', previewBranch)
    const previewPRLikeEvent = {
      repository: { full_name: 'example/satellite' },
      pull_request: {
        number: 42,
        base: { repo: { full_name: 'example/satellite' } },
        head: { repo: { full_name: 'example/satellite' }, sha: previewHeadSHA },
      },
    }
    await assertPreviewPreflight(satelliteRoot, scratchRoot)
    const previewInputs = {
      site: 'sre',
      source: 'docs/artifacts',
      head: previewBranch,
      'default-ref': 'main',
      'pull-request': 'none',
      include: '\n  extra data.json  \r\n',
      'base-url': 'https://pages.example.test',
      config: '.artifact-pages-action.yaml',
      'dry-run': 'true',
    }
    const directPreviewArgs = [
      'preview', 'publish', '--site', 'sre', '--source', 'docs/artifacts', '--head', previewBranch,
      '--default-ref', 'main', '--base-url', 'https://pages.example.test', '--include', 'extra data.json',
      '--config', 'artifact-pages.yaml', '--dry-run', '--format', 'json',
    ]
    const previewActionStorageBeforeDryRun = await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)])
    const directPreviewDryRun = runDirect(binaryPath, satelliteRoot, directPreviewArgs, 'direct preview publish dry-run')
    const actionPreviewDryRun = await runAction('preview', 'publish', directPreviewArgs, previewInputs, satelliteRoot, binaryPath, scratchRoot, {
      event: previewPRLikeEvent,
      repository: 'example/satellite',
    })
    assertActionParity(directPreviewDryRun, actionPreviewDryRun, 'preview publish dry-run')
    assert.equal(directPreviewDryRun.result.outcome, 'planned', 'preview dry-run should report a plan')
    assert.match(directPreviewDryRun.result.groupId, /^head:/, 'pull-request none in a PR event should create a manual group')
    assert.equal(directPreviewDryRun.result.pullRequestUrl ?? '', '', 'pull-request none must not carry PR provenance from the event')
    assert.equal(directPreviewDryRun.result.documents.length, 1, 'preview result should expose the changed document URL')
    assert.ok(directPreviewDryRun.result.objects.some((object) => object.path === 'extra data.json'), 'newline include input should be expanded to a repeated CLI include flag')
    assert.doesNotMatch(directPreviewDryRun.result.documents[0].url, /[?&]group=/, 'manual preview document URL should not claim PR group context')
    assert.deepEqual(await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)]), previewActionStorageBeforeDryRun, 'preview Action dry-run changed local provider state')

    const previewApplyArgs = directPreviewArgs.filter((arg) => arg !== '--dry-run')
    const previewApplyInputs = { ...previewInputs, 'dry-run': 'false' }
    const directPreviewApply = runDirect(binaryPath, satelliteRoot, previewApplyArgs, 'direct preview publish')
    const actionPreviewApply = await runAction('preview', 'publish', previewApplyArgs, previewApplyInputs, satelliteRoot, binaryPath, scratchRoot, {
      event: previewPRLikeEvent,
      repository: 'example/satellite',
    })
    assertActionParity(directPreviewApply, actionPreviewApply, 'preview publish')
    assert.equal(directPreviewApply.result.outcome, 'published', 'preview Action should publish through the shared CLI')
    assert.equal(actionPreviewApply.outputs['group-list-url'], directPreviewApply.result.groupListUrl, 'preview Action should expose its group-list URL')
    assert.deepEqual(JSON.parse(actionPreviewApply.outputs.documents), directPreviewApply.result.documents, 'preview Action should expose the CLI document URL array')
    assert.deepEqual(JSON.parse(actionPreviewApply.outputs.result), directPreviewApply.result, 'preview Action should expose the full typed CLI result')

    const actionPreviewCatalog = JSON.parse(await fs.readFile(path.join(actionStorageRoot, '_previews', 'sre', 'catalog.json'), 'utf8'))
    assert.equal(actionPreviewCatalog.groups.length, 1, 'preview Action should publish the expected manual group')
    assert.equal(actionPreviewCatalog.groups[0].headSha, previewHeadSHA, 'preview Action should select the exact requested Git head without checking it out')
    assert.deepEqual(await fs.readFile(path.join(actionStorageRoot, '_previews', 'sre', 'revisions', previewHeadSHA, 'files', 'extra data.json'), 'utf8'), '{"generated":true}\n', 'preview Action should publish explicitly included non-document resources with its original UTF-8 filename')
    git(satelliteRoot, 'checkout', 'main')

    const missingHead = 'ffffffffffffffffffffffffffffffffffffffff'
    const stalePreviewCatalog = {
      schemaVersion: 1,
      site: 'sre',
      groups: [{
        id: 'pr:42',
        kind: 'pull-request',
        headSha: missingHead,
        prUrl: 'https://github.com/example/satellite/pull/42',
        updatedAt: '2026-09-27T00:00:00Z',
        documents: [{ path: 'overview.html', title: 'Missing preview', format: 'html' }],
      }],
    }
    await writeFile(storageRoot, '_previews/sre/catalog.json', `${JSON.stringify(stalePreviewCatalog, null, 2)}\n`)
    await writeFile(actionStorageRoot, '_previews/sre/catalog.json', `${JSON.stringify(stalePreviewCatalog, null, 2)}\n`)
    for (const [label, root] of [['direct CLI', storageRoot], ['shared Action', actionStorageRoot]]) {
      const catalogPath = path.join(root, '_previews', 'sre', 'catalog.json')
      assert.deepEqual(JSON.parse(await fs.readFile(catalogPath, 'utf8')), stalePreviewCatalog, `${label} should start from the same stale catalog`)
      await assert.rejects(
        fs.access(path.join(root, '_previews', 'sre', 'revisions', missingHead, 'manifest.json')),
        (error) => error.code === 'ENOENT',
        `${label} stale preview fixture must reference a confirmed-missing manifest`,
      )
    }

    const previewStorageBeforeDryRun = await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)])
    const stalePreviewDryRunArgs = ['site', 'publish', '--site', 'sre', '--source', 'docs/artifacts', '--config', 'artifact-pages.yaml', '--dry-run', '--format', 'json']
    const directStalePreviewDryRun = runDirect(binaryPath, satelliteRoot, stalePreviewDryRunArgs, 'direct stale preview dry-run')
    const actionStalePreviewDryRun = await runAction('site', 'publish', stalePreviewDryRunArgs, {
      site: 'sre', source: 'docs/artifacts', config: '.artifact-pages-action.yaml', 'dry-run': 'true',
    }, satelliteRoot, binaryPath, scratchRoot)
    assertActionParity(directStalePreviewDryRun, actionStalePreviewDryRun, 'site publish stale preview dry-run')
    assert.deepEqual(directStalePreviewDryRun.result.previewChanges, [{
      action: 'remove', groupId: 'pr:42', headSha: missingHead, reason: 'manifest-missing',
    }], 'site-publish dry-run should plan the confirmed-missing preview removal')
    assert.deepEqual(await Promise.all([treeSnapshot(storageRoot), treeSnapshot(actionStorageRoot)]), previewStorageBeforeDryRun, 'site-publish preview dry-run changed local storage')

    const stalePreviewArgs = ['site', 'publish', '--site', 'sre', '--source', 'docs/artifacts', '--config', 'artifact-pages.yaml', '--format', 'json']
    const directStalePreview = runDirect(binaryPath, satelliteRoot, stalePreviewArgs, 'direct site publish with stale preview reference')
    const actionStalePreview = await runAction('site', 'publish', stalePreviewArgs, {
      site: 'sre', source: 'docs/artifacts', config: '.artifact-pages-action.yaml', 'dry-run': 'false',
    }, satelliteRoot, binaryPath, scratchRoot)
    assertActionParity(directStalePreview, actionStalePreview, 'site publish stale preview cleanup')
    const expectedStalePreviewDisposition = [{
      action: 'remove',
      groupId: 'pr:42',
      headSha: missingHead,
      reason: 'manifest-missing',
    }]
    assert.equal(directStalePreview.exitCode, 0, 'stale preview cleanup should succeed')
    assert.equal(directStalePreview.result.outcome, 'published', 'stale preview cleanup should publish its reconciliation')
    assert.deepEqual(directStalePreview.result.previewChanges, expectedStalePreviewDisposition, 'direct CLI stale preview disposition')
    for (const [label, root] of [['direct CLI', storageRoot], ['shared Action', actionStorageRoot]]) {
      const catalogPath = path.join(root, '_previews', 'sre', 'catalog.json')
      const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
      assert.deepEqual(catalog.groups, [], `${label} should remove the stale catalog reference`)
    }

    const fullTextArgs = ['site', 'publish', '--site', 'sre', '--source', 'docs/artifacts', '--config', 'artifact-pages.yaml', '--format', 'json']
    const directFullText = runDirect(binaryPath, satelliteRoot, fullTextArgs, 'direct site publish with full-text data')
    const actionFullText = await runAction('site', 'publish', fullTextArgs, {
      site: 'sre', source: 'docs/artifacts', config: '.artifact-pages-action.yaml',
    }, satelliteRoot, binaryPath, scratchRoot)
    assertActionParity(directFullText, actionFullText, 'site publish (full-text data always published)')
    assert.equal(directFullText.exitCode, 0, `full-text site publish failed: ${JSON.stringify(directFullText.result)}`)
    for (const [label, root] of [['direct CLI', storageRoot], ['shared Action', actionStorageRoot]]) {
      const meta = JSON.parse(await fs.readFile(path.join(root, '_indexes', 'sre', 'meta.json'), 'utf8'))
      assert.ok(meta.fullTextUrl, `${label} full-text publish should advertise fullTextUrl`)
    }

    const appArchive = await makeTestBundle(scratchRoot)
    const directAppDryRunArgs = ['app', 'deploy', '--archive', appArchive, '--config', 'artifact-pages.yaml', '--dry-run', '--format', 'json']
    const directStorageBeforeAppDryRun = await treeSnapshot(storageRoot)
    const actionStorageBeforeAppDryRun = await treeSnapshot(actionStorageRoot)
    const directAppDryRun = runDirect(binaryPath, adminRoot, directAppDryRunArgs, 'direct app deploy dry-run')
    const actionAppDryRun = await runAction('admin', 'app-deploy', directAppDryRunArgs, {
      archive: appArchive, config: '.artifact-pages-action.yaml', 'dry-run': 'true',
    }, adminRoot, binaryPath, scratchRoot)
    assertActionParity(directAppDryRun, actionAppDryRun, 'app deploy dry-run')
    assert.equal(directAppDryRun.result.outcome, 'planned', 'app deploy dry-run should return a plan')
    assert.ok(directAppDryRun.result.changes.length > 0, 'app deploy dry-run should report pending object changes')
    assert.deepEqual(await treeSnapshot(storageRoot), directStorageBeforeAppDryRun, 'direct app deploy dry-run wrote to the local target')
    assert.deepEqual(await treeSnapshot(actionStorageRoot), actionStorageBeforeAppDryRun, 'Action app deploy dry-run wrote to the local target')

    const directAppArgs = ['app', 'deploy', '--archive', appArchive, '--config', 'artifact-pages.yaml', '--format', 'json']
    const directApp = runDirect(binaryPath, adminRoot, directAppArgs, 'direct app deploy')
    const actionApp = await runAction('admin', 'app-deploy', directAppArgs, {
      archive: appArchive, config: '.artifact-pages-action.yaml', 'dry-run': 'false',
    }, adminRoot, binaryPath, scratchRoot)
    assertActionParity(directApp, actionApp, 'app deploy')

    console.log('GitHub Action parity smoke passed: admin, site (and the identical root Marketplace entry point), and preview wrappers relay their shared CLI contracts, outputs, and exit codes; preview dry-run/apply matches direct CLI behavior, including newline includes and manual provenance in a PR event. Trust checks reject forks and pull_request_target before API/provider work, validate explicit same-repository PR identity/head SHA, and return typed preflight failures. The workflow example keeps fork jobs step-free, checks out only the base branch, and orders preflight before provider credentials. No provider credentials or live GitHub Actions run were used.')
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
