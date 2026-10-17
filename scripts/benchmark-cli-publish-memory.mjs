import { createCipheriv, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const memoryRoot = path.join(projectRoot, '.local', 'cli-memory')
const gib = 1024 ** 3
const mib = 1024 ** 2
const diskReserveBytes = 6 * gib
const htmlPageBytes = 8 * 1024
const seed = 'artifact-pages-cli-publish-memory-t26-20261017'

const corpora = [
  { id: 'many-small', htmlPages: 5000, htmlPageBytes, binaryFiles: 5000, binaryFileBytes: 32 * 1024 },
  ...[64, 256, 512].map((sizeMiB) => ({
    id: `one-large-${sizeMiB}`,
    htmlPages: 20,
    htmlPageBytes,
    binaryFiles: 1,
    binaryFileBytes: sizeMiB * mib,
  })),
  { id: 'many-large', htmlPages: 20, htmlPageBytes, binaryFiles: 40, binaryFileBytes: 25 * mib },
]

function parseArgs(argv) {
  const options = { repetitions: 3, corpus: null, runDir: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repetitions') {
      options.repetitions = Number(argv[++index])
      if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
        throw new Error('--repetitions must be a positive integer')
      }
    } else if (arg === '--corpus') {
      options.corpus = argv[++index]?.split(',').map((value) => value.trim()).filter(Boolean)
      if (!options.corpus?.length) throw new Error('--corpus requires one or more comma-separated corpus IDs')
      const unknown = options.corpus.filter((id) => !corpora.some((corpus) => corpus.id === id))
      if (unknown.length) throw new Error(`unknown corpus ID(s): ${unknown.join(', ')}`)
    } else if (arg === '--run-dir') {
      options.runDir = argv[++index]
      if (!options.runDir) throw new Error('--run-dir requires a path')
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run benchmark:cli-publish-memory -- [--corpus ID[,ID...]] [--repetitions N] [--run-dir PATH]')
      console.log(`Corpora: ${corpora.map((corpus) => corpus.id).join(', ')}`)
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function run(command, args, { cwd = projectRoot, env = process.env, maxBuffer = 32 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer })
  if (result.error) {
    const error = new Error(`${command} ${args.join(' ')} failed to start: ${result.error.message}`)
    error.command = [command, ...args]
    error.exitStatus = result.status
    error.signal = result.signal
    error.stdout = result.stdout ?? ''
    error.stderr = result.stderr ?? ''
    throw error
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    const error = new Error(`${command} ${args.join(' ')} failed (${result.status ?? `signal ${result.signal ?? 'unknown'}`}).${detail ? `\n${detail}` : ''}`)
    error.command = [command, ...args]
    error.exitStatus = result.status
    error.signal = result.signal
    error.stdout = result.stdout ?? ''
    error.stderr = result.stderr ?? ''
    throw error
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function git(cwd, args, extraEnv = {}) {
  return run('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  }).stdout.trim()
}

async function initRepository(cwd, remoteURL) {
  await fs.mkdir(cwd, { recursive: true })
  git(cwd, ['init', '--initial-branch=main'])
  git(cwd, ['remote', 'add', 'origin', remoteURL])
  git(cwd, ['config', 'user.name', 'CLI Publish Memory Benchmark'])
  git(cwd, ['config', 'user.email', 'cli-memory@example.invalid'])
}

function commit(cwd, message) {
  git(cwd, ['add', '--all'])
  git(cwd, ['commit', '--message', message], {
    GIT_AUTHOR_DATE: '2026-09-27T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-09-27T00:00:00Z',
  })
}

async function writeFile(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split('/'))
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, contents)
}

function localDeploymentConfig(storageRoot) {
  return [
    'schemaVersion: 1',
    'provider: local',
    'local:',
    `  root: ${JSON.stringify(storageRoot)}`,
    'sites:',
    '  memory:',
    '    name: CLI publish memory benchmark',
    '    repository: example/cli-memory-satellite',
    '    sourcePath: content',
    '',
  ].join('\n')
}

function htmlPage(index, variant = 0) {
  const prefix = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page ${index}</title></head><body><main><h1>Page ${index}</h1><p>`
  const suffix = '</p></main></body></html>\n'
  const textLength = htmlPageBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
  if (textLength < 1024) throw new Error('HTML page template leaves less than 1 KiB of body text')
  const changedBytes = Math.min(1024, textLength)
  const body = `${String.fromCharCode(97 + variant).repeat(changedBytes)}${'a'.repeat(textLength - changedBytes)}`
  return `${prefix}${body}${suffix}`
}

function makeRandomChunk(relativePath, counter, byteLength) {
  const key = createHash('sha256').update(`${seed}:${relativePath}`).digest()
  const iv = createHash('sha256').update(`iv:${seed}:${relativePath}:${counter}`).digest().subarray(0, 16)
  return createCipheriv('aes-256-ctr', key, iv).update(Buffer.alloc(byteLength))
}

async function writeDeterministicBinary(target, relativePath, byteLength) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const handle = await fs.open(target, 'w')
  const chunkBytes = 1024 * 1024
  try {
    let remaining = byteLength
    let counter = 0
    while (remaining > 0) {
      const output = makeRandomChunk(relativePath, counter, Math.min(chunkBytes, remaining))
      let offset = 0
      while (offset < output.length) {
        const { bytesWritten } = await handle.write(output, offset, output.length - offset)
        if (bytesWritten === 0) throw new Error(`short write while generating ${relativePath}`)
        offset += bytesWritten
      }
      remaining -= output.length
      counter += 1
    }
  } finally {
    await handle.close()
  }
}

async function generateCorpus(corpus, satelliteRoot) {
  const contentRoot = path.join(satelliteRoot, 'content')
  await fs.mkdir(contentRoot, { recursive: true })
  for (let index = 0; index < corpus.htmlPages; index += 1) {
    const name = `page-${String(index).padStart(5, '0')}.html`
    const html = htmlPage(index)
    if (Buffer.byteLength(html) !== corpus.htmlPageBytes) throw new Error(`generated HTML page ${name} has an unexpected size`)
    await writeFile(contentRoot, name, html)
  }
  for (let index = 0; index < corpus.binaryFiles; index += 1) {
    const name = corpus.id === 'many-small'
      ? `resource-${String(index).padStart(5, '0')}.png`
      : corpus.id === 'one-large-64' || corpus.id === 'one-large-256' || corpus.id === 'one-large-512'
        ? 'resource.bin'
        : `resource-${String(index).padStart(3, '0')}.bin`
    await writeDeterministicBinary(path.join(contentRoot, name), name, corpus.binaryFileBytes)
  }
}

function parseDuration(value) {
  const match = value.trim().match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/)
  if (!match) return null
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  return hours * 3600 + minutes * 60 + seconds
}

function parseTimeOutput(platform, output) {
  if (platform === 'darwin') {
    const rss = output.match(/^\s*(\d+)\s+maximum resident set size\s*$/im)
    const real = output.match(/(?:^|\s)(\d+(?:\.\d+)?)\s+real\b/im)
    if (rss || real) return {
      rssBytes: rss ? Number(rss[1]) : null,
      timeSeconds: real ? Number(real[1]) : null,
      rssUnit: 'bytes',
    }
    return null
  }
  if (platform === 'linux') {
    const rss = output.match(/^\s*Maximum resident set size \(kbytes\):\s*(\d+)\s*$/im)
    const elapsed = output.match(/^\s*Elapsed \(wall clock\) time \(h:mm:ss or m:ss\):\s*(.+?)\s*$/im)
    const seconds = elapsed ? parseDuration(elapsed[1]) : null
    if (rss || seconds !== null) return {
      rssBytes: rss ? Number(rss[1]) * 1024 : null,
      timeSeconds: seconds,
      rssUnit: 'KiB converted to bytes',
    }
    return null
  }
  return null
}

function measuredCommand(binaryPath, args, cwd, measurement) {
  const timeArgs = process.platform === 'darwin' ? ['-l'] : process.platform === 'linux' ? ['-v'] : null
  if (!timeArgs) throw new Error(`unsupported platform for /usr/bin/time measurement: ${process.platform}`)
  const command = '/usr/bin/time'
  const result = spawnSync(command, [...timeArgs, binaryPath, ...args], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const parsed = parseTimeOutput(process.platform, `${stderr}\n${stdout}`)
  const sample = {
    command: [command, ...timeArgs, binaryPath, ...args],
    exitStatus: result.status,
    signal: result.signal ?? null,
    rssBytes: parsed?.rssBytes ?? null,
    timeSeconds: parsed?.timeSeconds ?? null,
    outcome: safeJson(stdout)?.outcome ?? null,
    stdout,
    stderr,
  }
  if (result.error) sample.failure = `could not run ${command}: ${result.error.message}`
  else if (!Number.isFinite(sample.rssBytes) || !Number.isFinite(sample.timeSeconds)) {
    sample.failure = `could not parse /usr/bin/time ${timeArgs[0]} output for ${process.platform}; expected maximum resident set size and real/wall time fields (wrapper exit status ${result.status ?? 'null'}${result.signal ? `, ${result.signal}` : ''})`
  } else if (result.status !== 0) sample.failure = `measured command failed with exit status ${result.status ?? 'null'}${result.signal ? ` (${result.signal})` : ''}`
  sample.stdout = sample.stdout.slice(0, 4000)
  sample.stderr = sample.stderr.slice(0, 8000)
  return sample
}

async function realPathIfPresentOrNearest(candidate) {
  const absolute = path.resolve(candidate)
  const missing = []
  let current = absolute
  while (true) {
    try {
      const realCurrent = await fs.realpath(current)
      return path.join(realCurrent, ...missing.reverse())
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.push(path.basename(current))
      current = parent
    }
  }
}

function isStrictChild(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function selectRunDir(providedPath) {
  await fs.mkdir(memoryRoot, { recursive: true })
  const realRoot = await fs.realpath(memoryRoot)
  const proposed = providedPath
    ? (path.isAbsolute(providedPath) ? providedPath : path.resolve(projectRoot, providedPath))
    : path.join(realRoot, `t26-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`)
  const candidateReal = await realPathIfPresentOrNearest(proposed)
  if (!isStrictChild(realRoot, candidateReal)) {
    throw new Error(`--run-dir must resolve to a strict child of ${realRoot}; got ${candidateReal}`)
  }
  const existing = await fs.stat(proposed).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (existing) {
    const realExisting = await fs.realpath(proposed)
    if (!isStrictChild(realRoot, realExisting)) throw new Error(`--run-dir resolves outside ${realRoot}: ${realExisting}`)
    const contents = await fs.readdir(realExisting)
    if (contents.length > 0) throw new Error(`--run-dir already exists and is not empty: ${realExisting}`)
  }
  await fs.mkdir(proposed, { recursive: true })
  const realCreated = await fs.realpath(proposed)
  if (!isStrictChild(realRoot, realCreated)) throw new Error(`created run directory escaped ${realRoot}: ${realCreated}`)
  return realCreated
}

async function freeBytesAt(directory) {
  const output = run('df', ['-Pk', directory]).stdout.trim().split(/\r?\n/).at(-1)
  const fields = output.trim().split(/\s+/)
  const availableBlocks = Number(fields[3])
  if (!Number.isFinite(availableBlocks)) throw new Error(`could not parse available space from df -Pk: ${output}`)
  return availableBlocks * 1024
}

function corpusByteCounts(corpus) {
  const htmlBytes = corpus.htmlPages * corpus.htmlPageBytes
  const binaryBytes = corpus.binaryFiles * corpus.binaryFileBytes
  return {
    htmlBytes,
    binaryBytes,
    sourceBytes: htmlBytes + binaryBytes,
    largestFileBytes: Math.max(corpus.htmlPageBytes, corpus.binaryFileBytes),
    sourceFileCount: corpus.htmlPages + corpus.binaryFiles,
  }
}

async function captureHostMetadata() {
  const commandOutput = (command, args) => {
    try {
      return run(command, args).stdout.trim()
    } catch (error) {
      return `unavailable: ${error.message}`
    }
  }
  let model = 'unavailable'
  let memoryBytes = null
  if (process.platform === 'darwin') {
    model = commandOutput('sysctl', ['-n', 'hw.model'])
    const bytes = commandOutput('sysctl', ['-n', 'hw.memsize'])
    if (/^\d+$/.test(bytes)) memoryBytes = Number(bytes)
  }
  const osVersion = process.platform === 'darwin'
    ? commandOutput('sw_vers', ['-productVersion'])
    : `${os.type()} ${os.release()}`
  const cliCommit = commandOutput('git', ['rev-parse', 'HEAD'])
  return {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    machineModel: model,
    memoryBytes,
    osVersion,
    goVersion: commandOutput('go', ['version']),
    nodeVersion: process.version,
    cliCommit,
    provider: 'local',
    repetitions: null,
    measurement: {
      command: process.platform === 'darwin' ? '/usr/bin/time -l' : '/usr/bin/time -v',
      platformFormat: process.platform,
      rssStoredAs: 'bytes',
      elapsedStoredAs: 'seconds',
    },
    diskReserveBytes,
  }
}

function cliArgs(satelliteConfig, { dryRun = false } = {}) {
  const args = ['site', 'sync', '--site', 'memory', '--source', 'content', '--config', satelliteConfig]
  if (dryRun) args.push('--dry-run')
  args.push('--format', 'json')
  return args
}

function setExpectedOutcome(sample, expected) {
  sample.expectedOutcome = expected
  if (!sample.failure && sample.outcome !== expected) {
    sample.failure = `expected outcome ${JSON.stringify(expected)}, got ${JSON.stringify(sample.outcome)}`
  }
}

function printMarkdown(results) {
  const scenarioOrder = ['first-publish', 'no-op-publish', 'differential-publish', 'dry-run']
  const labels = {
    'first-publish': 'First publish',
    'no-op-publish': 'No-op publish',
    'differential-publish': 'Differential publish',
    'dry-run': 'Dry-run',
  }
  for (const corpus of results.corpora) {
    console.log(`\n### ${corpus.id} — ${corpus.status}`)
    if (corpus.status !== 'completed') {
      if (corpus.diskSafety) console.log(`Available before run: ${(corpus.diskSafety.availableBeforeBytes / gib).toFixed(2)} GiB; estimated peak: ${(corpus.diskSafety.estimatedPeakBytes / gib).toFixed(2)} GiB.`)
      if (corpus.failure) console.log(`Failure: ${corpus.failure.message}`)
      continue
    }
    console.log('| Scenario | Median peak RSS (MiB) | Max peak RSS (MiB) | Median time (s) | Max time (s) |')
    console.log('| --- | ---: | ---: | ---: | ---: |')
    for (const scenarioId of scenarioOrder) {
      const samples = corpus.scenarios[scenarioId].samples
      const r = samples.map((sample) => sample.rssBytes / mib).sort((a, b) => a - b)
      const t = samples.map((sample) => sample.timeSeconds).sort((a, b) => a - b)
      console.log(`| ${labels[scenarioId]} | ${median(r).toFixed(1)} | ${Math.max(...r).toFixed(1)} | ${median(t).toFixed(3)} | ${Math.max(...t).toFixed(3)} |`)
    }
  }
}

function median(sortedValues) {
  const middle = Math.floor(sortedValues.length / 2)
  return sortedValues.length % 2
    ? sortedValues[middle]
    : (sortedValues[middle - 1] + sortedValues[middle]) / 2
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const runDir = await selectRunDir(options.runDir)
  const binaryPath = path.join(runDir, 'artifact-pages')
  const selectedCorpora = options.corpus
    ? corpora.filter((corpus) => options.corpus.includes(corpus.id))
    : corpora
  const results = {
    schemaVersion: 1,
    runId: path.basename(runDir),
    runDirectory: runDir,
    metadata: await captureHostMetadata(),
    corpusDefinitions: corpora,
    corpora: [],
    failures: [],
  }
  results.metadata.repetitions = options.repetitions
  results.metadata.buildCommand = ['go', 'build', '-o', binaryPath, './cli/cmd/artifact-pages']
  results.metadata.buildEnvironment = {
    GOCACHE: path.join(runDir, 'go-cache'),
    GOPROXY: 'off',
    GOTOOLCHAIN: 'local',
  }
  results.metadata.sourceGenerator = { algorithm: 'AES-256-CTR deterministic byte stream', seed }
  await saveResults(runDir, results)

  try {
    run('go', ['build', '-o', binaryPath, './cli/cmd/artifact-pages'], {
      env: { ...process.env, GOCACHE: results.metadata.buildEnvironment.GOCACHE, GOPROXY: 'off', GOTOOLCHAIN: 'local' },
    })
    for (const corpus of selectedCorpora) {
      const counts = corpusByteCounts(corpus)
      const storagePath = path.join(runDir, 'corpora', corpus.id, 'storage')
      const corpusRoot = path.join(runDir, 'corpora', corpus.id)
      const adminRoot = path.join(corpusRoot, 'admin')
      const satelliteRoot = path.join(corpusRoot, 'satellite')
      const record = {
        id: corpus.id,
        definition: { ...corpus },
        ...counts,
        status: 'in progress',
        scenarios: {},
      }
      results.corpora.push(record)
      const availableBeforeBytes = await freeBytesAt(projectRoot)
      const estimatedPeakBytes = counts.sourceBytes * 4 + 256 * mib
      record.diskSafety = { availableBeforeBytes, estimatedPeakBytes, reserveBytes: diskReserveBytes }
      if (availableBeforeBytes - estimatedPeakBytes < diskReserveBytes) {
        record.status = 'skipped: disk'
        record.diskSafety.reason = `free bytes minus estimated peak would be below ${diskReserveBytes} bytes`
        await saveResults(runDir, results)
        continue
      }

      await fs.mkdir(corpusRoot, { recursive: true })
      await initRepository(adminRoot, 'https://github.com/example/cli-memory-admin.git')
      await initRepository(satelliteRoot, 'https://github.com/example/cli-memory-satellite.git')
      await writeFile(adminRoot, 'artifact-pages.yaml', localDeploymentConfig(storagePath))
      commit(adminRoot, 'configure local memory benchmark site')
      await generateCorpus(corpus, satelliteRoot)
      commit(satelliteRoot, `add ${corpus.id} deterministic source corpus`)
      const baseCommit = git(satelliteRoot, ['rev-parse', 'HEAD'])

      const changedPagePath = 'content/page-00000.html'
      await writeFile(satelliteRoot, changedPagePath, htmlPage(0, 1))
      commit(satelliteRoot, 'change one HTML body by 1 KiB')
      const differentialCommit = git(satelliteRoot, ['rev-parse', 'HEAD'])
      await writeFile(satelliteRoot, changedPagePath, htmlPage(0, 2))
      commit(satelliteRoot, 'make a further 1 KiB HTML body change')
      const dryRunCommit = git(satelliteRoot, ['rev-parse', 'HEAD'])
      const satelliteConfig = path.relative(satelliteRoot, path.join(adminRoot, 'artifact-pages.yaml'))

      for (const scenarioId of ['first-publish', 'no-op-publish', 'differential-publish', 'dry-run']) {
        record.scenarios[scenarioId] = { samples: [] }
      }
      for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
        // Every repetition begins at the same source commit with an empty local object root.
        const realStoragePath = await realPathIfPresentOrNearest(storagePath)
        if (!isStrictChild(runDir, realStoragePath)) {
          throw new Error(`refusing to delete storage outside the run directory: ${realStoragePath}`)
        }
        await fs.rm(storagePath, { recursive: true, force: true })
        git(satelliteRoot, ['reset', '--hard', baseCommit])
        run(binaryPath, ['registry', 'sync', '--config', 'artifact-pages.yaml', '--format', 'json'], { cwd: adminRoot })

        const first = measuredCommand(binaryPath, cliArgs(satelliteConfig), satelliteRoot, results.metadata.measurement)
        first.repetition = repetition
        setExpectedOutcome(first, 'synced')
        record.scenarios['first-publish'].samples.push(first)
        if (first.failure) throw measuredFailure(record, 'first-publish', first)

        const noOp = measuredCommand(binaryPath, cliArgs(satelliteConfig), satelliteRoot, results.metadata.measurement)
        noOp.repetition = repetition
        setExpectedOutcome(noOp, 'no-op')
        record.scenarios['no-op-publish'].samples.push(noOp)
        if (noOp.failure) throw measuredFailure(record, 'no-op-publish', noOp)

        git(satelliteRoot, ['reset', '--hard', differentialCommit])
        const differential = measuredCommand(binaryPath, cliArgs(satelliteConfig), satelliteRoot, results.metadata.measurement)
        differential.repetition = repetition
        setExpectedOutcome(differential, 'synced')
        record.scenarios['differential-publish'].samples.push(differential)
        if (differential.failure) throw measuredFailure(record, 'differential-publish', differential)

        git(satelliteRoot, ['reset', '--hard', dryRunCommit])
        const dryRun = measuredCommand(binaryPath, cliArgs(satelliteConfig, { dryRun: true }), satelliteRoot, results.metadata.measurement)
        dryRun.repetition = repetition
        setExpectedOutcome(dryRun, 'planned')
        record.scenarios['dry-run'].samples.push(dryRun)
        if (dryRun.failure) throw measuredFailure(record, 'dry-run', dryRun)

        await saveResults(runDir, results)
        console.log(`${corpus.id}: repetition ${repetition}/${options.repetitions} complete`)
      }
      record.status = 'completed'
      await saveResults(runDir, results)
    }
  } catch (error) {
    const failure = {
      message: error instanceof Error ? error.message : String(error),
      command: error.command ?? null,
      exitStatus: error.exitStatus ?? null,
      signal: error.signal ?? null,
      stdout: (error.stdout ?? '').slice(0, 4000),
      stderr: (error.stderr ?? '').slice(0, 8000),
    }
    results.failures.push(failure)
    const active = results.corpora.find((entry) => entry.status === 'in progress')
    if (active) {
      active.status = 'failed'
      active.failure = failure
    }
    await saveResults(runDir, results)
    console.error(`Benchmark stopped: ${failure.message}`)
    console.error(`Partial results retained at ${path.join(runDir, 'results.json')}`)
    printMarkdown(results)
    process.exitCode = 1
    return
  }

  await saveResults(runDir, results)
  printMarkdown(results)
  console.log(`\nRaw results: ${path.join(runDir, 'results.json')}`)
}

function safeJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

function measuredFailure(record, scenarioId, sample) {
  const error = new Error(`${record.id} ${scenarioId} repetition ${sample.repetition} failed: ${sample.failure}`)
  error.command = sample.command
  error.exitStatus = sample.exitStatus
  error.signal = sample.signal
  error.stdout = sample.stdout
  error.stderr = sample.stderr
  return error
}

async function saveResults(runDir, results) {
  const target = path.join(runDir, 'results.json')
  const realTarget = await realPathIfPresentOrNearest(target)
  if (!isStrictChild(runDir, realTarget)) throw new Error(`refusing to write results outside run directory: ${realTarget}`)
  await fs.writeFile(target, `${JSON.stringify(results, null, 2)}\n`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
