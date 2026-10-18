import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalDigest, sha256 } from './canonical.mjs';
import { credentialClassDefinition, credentialMaterialKeys } from './credential-loader.mjs';
import { requireCredentialVerification } from './credential-verification.mjs';
import { assertInvocationMatchesTransition, getInvocation } from './invocation-registry.mjs';
import { AuthorizationError, requireExternalCapability, validateChildEnvironment } from './policy.mjs';

const ACTIVE_CHILDREN = new Map();
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 500;
const BASE_CHILD_ENV = Object.freeze({
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  PATH: '/usr/bin:/bin',
  AWS_DEFAULT_REGION: 'us-east-1',
  AWS_REGION: 'us-east-1',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_CLI_AUTO_PROMPT: 'off',
  AWS_MAX_ATTEMPTS: '1',
});

export class LauncherError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'LauncherError';
    this.code = code;
  }
}

export async function resolveInvocation(id, { runtimeRoot, manifest, activeSeal }) {
  const descriptor = getInvocation(id);
  const root = await realpath(path.resolve(runtimeRoot));
  const tool = manifest.execution?.tools?.[descriptor.executableRef];
  if (!tool || typeof tool.path !== 'string' || path.isAbsolute(tool.path) || !/^[a-f0-9]{64}$/u.test(tool.sha256 ?? '')) {
    throw new LauncherError('EXECUTION_PATH_NOT_IMPLEMENTED', `missing sealed executable ${descriptor.executableRef}`);
  }
  const executablePath = resolveRuntimePath(root, tool.path);
  await rejectSymlinkComponents(root, executablePath);
  const sealedArtifacts = new Map((activeSeal?.artifacts ?? []).map((artifact) => [artifact.path, artifact.sha256]));
  if (sealedArtifacts.get(tool.path) !== tool.sha256) throw new LauncherError('SEALED_EXECUTABLE_REQUIRED', descriptor.executableRef);
  const declaredToolInfo = await lstat(executablePath).catch(() => null);
  if (!declaredToolInfo?.isFile() || declaredToolInfo.isSymbolicLink()) {
    throw new LauncherError('VERIFIED_EXECUTABLE_REQUIRED', descriptor.executableRef);
  }
  const executable = await realpath(executablePath).catch(() => null);
  const executableInfo = executable ? await stat(executable).catch(() => null) : null;
  if (!executableInfo?.isFile() || sha256(await readFile(executable)) !== tool.sha256) {
    throw new LauncherError('VERIFIED_EXECUTABLE_REQUIRED', descriptor.executableRef);
  }

  const inputDigests = await resolveSealedInputs(root, descriptor.inputs ?? [], manifest, activeSeal);
  const cwd = await resolveWorkingDirectory(descriptor.cwdRoot, root, manifest, inputDigests);
  const outputPaths = descriptor.outputs.map((relative) => resolveRuntimePath(root, relative));
  const argv = [...descriptor.argv];
  if (argv.some((item) => typeof item !== 'string')) throw new LauncherError('INVOCATION_ARGUMENT_INVALID');
  if (argv.some((item) => /^(?:--profile(?:=|$)|--endpoint-url(?:=|$)|--role-arn(?:=|$)|--role-session-name(?:=|$)|--web-identity-token-file(?:=|$))/u.test(item))) {
    throw new LauncherError('PROVIDER_OVERRIDE_IN_INVOCATION');
  }
  const resolved = {
    executable,
    executableSha256: tool.sha256,
    argv,
    cwd,
    cwdRoot: descriptor.cwdRoot,
    inputDigests,
    outputPaths,
    timeoutMs: descriptor.timeoutMs,
    credentialClass: descriptor.credentialClass,
    provider: descriptor.provider,
  };
  const invocationDigest = canonicalDigest({ id, descriptor, resolved });
  return Object.freeze({ id, descriptor, ...resolved, invocationDigest, runtimeRoot: root });
}

export async function buildChildEnvironment({ invocation, credential, isolationRoot, parentEnvironment = process.env }) {
  validateParentEnvironment(parentEnvironment);
  if (!invocation || !credential || invocation.credentialClass !== credential.credentialClass) {
    throw new AuthorizationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED', 'credential class mismatch');
  }
  const definition = credentialClassDefinition(invocation.credentialClass);
  if (credential.provider !== definition.provider || credential.accountId !== definition.accountId) {
    throw new AuthorizationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED', 'credential target mismatch');
  }
  const secretKeys = credentialMaterialKeys(credential);
  if (secretKeys.length !== definition.variables.length || definition.variables.some((key) => !secretKeys.includes(key))) {
    throw new AuthorizationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED', 'credential set does not match the fixed class');
  }
  const safeId = invocation.id.replace(/[^A-Za-z0-9._-]/gu, '_');
  const safeInstanceId = credential.instanceId.replace(/[^A-Za-z0-9._-]/gu, '_');
  const home = path.resolve(isolationRoot, safeId, safeInstanceId, randomUUID(), 'home');
  const temp = path.resolve(isolationRoot, safeId, safeInstanceId, randomUUID(), 'tmp');
  if (!isWithin(isolationRoot, home) || !isWithin(isolationRoot, temp)) throw new LauncherError('ISOLATED_HOME_REQUIRED');
  await createNoSymlinkDirectory(invocation.runtimeRoot, isolationRoot);
  await createPrivateDirectory(home, isolationRoot);
  await createPrivateDirectory(temp, isolationRoot);
  const awsConfig = path.join(home, 'aws-config');
  const awsCredentials = path.join(home, 'aws-credentials');
  await writePrivateFile(awsConfig, '');
  await writePrivateFile(awsCredentials, '');
  const environment = {
    ...BASE_CHILD_ENV,
    HOME: home,
    TMPDIR: temp,
    AWS_CONFIG_FILE: awsConfig,
    AWS_SHARED_CREDENTIALS_FILE: awsCredentials,
    ...credential.environment,
  };
  validateChildEnvironment(environment, {
    allowProofCredentials: true,
    allowedCredentialKeys: definition.variables,
    isolatedRoot: path.resolve(isolationRoot),
  });
  return Object.freeze(environment);
}

export async function runSupervisedInvocation({
  invocation,
  manifest,
  capability,
  credential,
  verificationRecord,
  parentEnvironment = process.env,
  launchContainer,
  killGroup = killProcessGroup,
  now = () => Date.now(),
}) {
  if (!invocation || !invocation.id) throw new LauncherError('EXECUTION_PATH_NOT_IMPLEMENTED');
  requireExternalCapability(capability);
  if (capability.manifest !== manifest) throw new LauncherError('UNTRUSTED_CAPABILITY');
  const canonicalInvocation = await resolveInvocation(invocation.id, {
    runtimeRoot: invocation.runtimeRoot,
    manifest,
    activeSeal: manifest.activeSeal,
  });
  if (canonicalInvocation.invocationDigest !== invocation.invocationDigest
    || canonicalDigest(canonicalInvocation) !== canonicalDigest(invocation)) {
    throw new LauncherError('INVOCATION_DESCRIPTOR_CHANGED');
  }
  invocation = canonicalInvocation;
  assertInvocationMatchesTransition(invocation.id, capability.command);
  if (typeof launchContainer !== 'function') throw new LauncherError('EXECUTION_PATH_NOT_IMPLEMENTED', 'reviewed Linux container runner is unavailable');
  const record = requireCredentialVerification({
    record: verificationRecord,
    manifest,
    capability,
    invocationId: invocation.id,
    invocationDigest: invocation.invocationDigest,
    credential,
    now: now(),
    minimumLifetimeMs: invocation.timeoutMs + (manifest.teardownReserveMs ?? 60000),
  });
  const environment = await buildChildEnvironment({
    invocation,
    credential,
    isolationRoot: path.join(invocation.runtimeRoot, 'child-environments'),
    parentEnvironment,
  });
  const remainingCredentialMs = Date.parse(credential.expiresAt) - now();
  const remainingApprovalMs = Date.parse(capability.approvalExpiresAt) - now();
  const teardownReserveMs = manifest.teardownReserveMs ?? 60000;
  if (remainingCredentialMs < invocation.timeoutMs + teardownReserveMs
    || remainingApprovalMs < invocation.timeoutMs + teardownReserveMs) {
    throw new AuthorizationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED', 'remaining lifetime or teardown reserve is insufficient');
  }
  if (Object.keys(verificationRecord).some((key) => /secret|token|password/i.test(key))) {
    throw new LauncherError('CREDENTIAL_MATERIAL_IN_VERIFICATION_RECORD');
  }

  for (const output of invocation.outputPaths) await ensureRuntimeParent(invocation.runtimeRoot, output);
  let child;
  try {
    child = await launchContainer({
      invocation,
      environment,
      manifest,
      capability,
      shell: false,
      readOnlyInputs: true,
      hostCredentials: false,
      dockerSocket: false,
    });
  } catch {
    throw new LauncherError('CHILD_SPAWN_FAILED');
  }
  if (!child || !Number.isInteger(child.pid) || !child.stdout || !child.stderr || typeof child.once !== 'function') {
    throw new LauncherError('CHILD_SPAWN_INTERFACE_INVALID');
  }
  ACTIVE_CHILDREN.set(child.pid, child);

  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let captureOverflow = false;
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= MAX_CAPTURE_BYTES) stdoutChunks.push(Buffer.from(chunk));
    else captureOverflow = true;
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_CAPTURE_BYTES) stderrChunks.push(Buffer.from(chunk));
    else captureOverflow = true;
  });

  let timer;
  let forceTimer;
  let timedOut = false;
  const exit = new Promise((resolve, reject) => {
    child.once('error', () => reject(new LauncherError('CHILD_PROCESS_ERROR')));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const deadline = new Promise((resolve) => {
    timer = setTimeout(async () => {
      timedOut = true;
      await killGroup(child, 'SIGTERM').catch(() => {});
      forceTimer = setTimeout(() => { void killGroup(child, 'SIGKILL'); }, FORCE_KILL_DELAY_MS);
      resolve({ deadline: true });
    }, invocation.timeoutMs);
    timer.unref?.();
  });

  let result;
  try {
    result = await Promise.race([exit, deadline]);
    if (result.deadline) result = await exit;
  } catch (error) {
    await killGroup(child, 'SIGTERM').catch(() => {});
    await killGroup(child, 'SIGKILL').catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    ACTIVE_CHILDREN.delete(child.pid);
  }

  const values = Object.values(credential.environment);
  const stdout = redact(Buffer.concat(stdoutChunks), values);
  const stderr = redact(Buffer.concat(stderrChunks), values);
  if (captureOverflow || stdoutBytes > MAX_CAPTURE_BYTES || stderrBytes > MAX_CAPTURE_BYTES) {
    await terminateActiveChildren(killGroup);
    throw new LauncherError('CHILD_OUTPUT_LIMIT_EXCEEDED');
  }
  if (invocation.outputPaths[0]) await writePrivateFile(invocation.outputPaths[0], stdout);
  if (invocation.outputPaths[1]) await writePrivateFile(invocation.outputPaths[1], stderr);
  if (timedOut) throw new LauncherError('CHILD_DEADLINE_EXCEEDED');
  if (result.code !== 0) throw new LauncherError('CHILD_EXITED_NONZERO', String(result.code ?? result.signal ?? 'unknown'));

  return Object.freeze({
    invocationId: invocation.id,
    transition: capability.command,
    verificationDigest: record.digest,
    exitCode: result.code,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    outputPaths: invocation.outputPaths.map((item) => path.relative(invocation.runtimeRoot, item)),
    credentialExpiresAt: credential.expiresAt,
  });
}

export async function terminateActiveChildren(killGroup = killProcessGroup) {
  const current = [...ACTIVE_CHILDREN.values()];
  await Promise.all(current.map(async (child) => {
    await killGroup(child, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, FORCE_KILL_DELAY_MS));
    if (ACTIVE_CHILDREN.has(child.pid)) await killGroup(child, 'SIGKILL');
    ACTIVE_CHILDREN.delete(child.pid);
  }));
  return current.length;
}

export function assertNoActiveChildren() {
  if (ACTIVE_CHILDREN.size) throw new LauncherError('RECORDED_CHILDREN_REMAIN', String(ACTIVE_CHILDREN.size));
}

function validateParentEnvironment(environment) {
  validateChildEnvironment(environment);
  for (const key of Object.keys(environment)) {
    if (/^(?:HTTP|HTTPS|ALL|NO)_PROXY$/iu.test(key) || /^AWS_ENDPOINT_URL(?:_.*)?$/u.test(key)
      || /^CF_VERIFY_/u.test(key) || /^CLOUDFLARE_API_TOKEN$/iu.test(key) || /^ACTIONS_ID_TOKEN_REQUEST_(?:TOKEN|URL)$/u.test(key)
      || key === 'GITHUB_TOKEN' || key === 'GH_TOKEN'
      || key === 'SSH_AUTH_SOCK' || key === 'SSH_AGENT_PID') {
      if (environment[key]) throw new AuthorizationError('INHERITED_CREDENTIAL_FALLBACK', key);
    }
  }
}

async function resolveWorkingDirectory(rootName, runtimeRoot, manifest, sealedInputs) {
  if (rootName === 'runtime') return runtimeRoot;
  const declared = manifest.execution?.roots?.[rootName];
  if (typeof declared !== 'string' || !declared || !sealedInputs.some((input) => input.path === declared && input.size === null)) {
    throw new LauncherError('SEALED_WORKING_DIRECTORY_REQUIRED', rootName);
  }
  const absolute = resolveRuntimePath(runtimeRoot, declared);
  await rejectSymlinkComponents(runtimeRoot, absolute);
  const declaredInfo = await lstat(absolute).catch(() => null);
  if (!declaredInfo?.isDirectory() || declaredInfo.isSymbolicLink()) throw new LauncherError('SEALED_WORKING_DIRECTORY_REQUIRED', rootName);
  const actual = await realpath(absolute).catch(() => null);
  const info = actual ? await stat(actual).catch(() => null) : null;
  if (!actual || !info?.isDirectory() || !isWithin(runtimeRoot, actual)) throw new LauncherError('SEALED_WORKING_DIRECTORY_REQUIRED', rootName);
  return actual;
}

async function resolveSealedInputs(runtimeRoot, inputs, manifest, activeSeal) {
  const sealed = new Map((activeSeal?.artifacts ?? []).map((artifact) => [artifact.path, artifact.sha256]));
  const results = [];
  for (const relative of inputs) {
    const absolute = resolveRuntimePath(runtimeRoot, relative);
    await rejectSymlinkComponents(runtimeRoot, absolute);
    const declaredInfo = await lstat(absolute).catch(() => null);
    if (!declaredInfo || declaredInfo.isSymbolicLink()) throw new LauncherError('SEALED_INPUT_SYMLINK_DENIED', relative);
    const actual = await realpath(absolute).catch(() => null);
    if (!actual || !isWithin(runtimeRoot, actual)) throw new LauncherError('SEALED_INPUT_REQUIRED', relative);
    const info = await stat(actual);
    if (info.isFile()) {
      const digest = sha256(await readFile(actual));
      const expected = sealed.get(relative);
      if (digest !== expected) throw new LauncherError('SEALED_INPUT_DIGEST_MISMATCH', relative);
      results.push({ path: relative, sha256: digest, size: info.size });
    } else if (info.isDirectory()) {
      const digest = await digestDirectory(actual);
      if (digest !== sealed.get(relative)) throw new LauncherError('SEALED_INPUT_DIGEST_MISMATCH', relative);
      results.push({ path: relative, sha256: digest, size: null });
    } else {
      throw new LauncherError('SEALED_INPUT_REQUIRED', relative);
    }
  }
  return results;
}

async function digestDirectory(directory) {
  const files = [];
  async function visit(current, relativeRoot) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(relativeRoot, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new LauncherError('SEALED_INPUT_SYMLINK_DENIED', relative);
      if (entry.isDirectory()) await visit(absolute, relativeRoot);
      else if (entry.isFile()) files.push({ path: relative, sha256: sha256(await readFile(absolute)) });
      else throw new LauncherError('SEALED_INPUT_ENTRY_DENIED', relative);
    }
  }
  await visit(directory, directory);
  return canonicalDigest(files);
}

function resolveRuntimePath(runtimeRoot, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new LauncherError('RUNTIME_PATH_INVALID');
  const absolute = path.resolve(runtimeRoot, relative);
  if (!isWithin(runtimeRoot, absolute)) throw new LauncherError('RUNTIME_PATH_INVALID');
  return absolute;
}

async function rejectSymlinkComponents(runtimeRoot, absolute) {
  const root = await realpath(runtimeRoot).catch(() => null);
  if (!root || !isWithin(root, absolute)) throw new LauncherError('RUNTIME_PATH_INVALID');
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink()) throw new LauncherError('RUNTIME_PATH_SYMLINK_DENIED');
  }
}

async function writePrivateFile(filename, value) {
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createPrivateDirectory(directory, parent) {
  await createNoSymlinkDirectory(parent, directory);
  const actualParent = await realpath(parent).catch(() => null);
  const actualDirectory = await realpath(directory).catch(() => null);
  if (!actualParent || !actualDirectory || !isWithin(actualParent, actualDirectory)) throw new LauncherError('ISOLATED_HOME_REQUIRED');
  const info = await stat(actualDirectory);
  if (!info.isDirectory()) throw new LauncherError('ISOLATED_HOME_REQUIRED');
}

async function ensureRuntimeParent(runtimeRoot, filename) {
  const absolute = path.resolve(filename);
  if (!isWithin(runtimeRoot, absolute)) throw new LauncherError('OUTPUT_OUTSIDE_RUNTIME');
  await createNoSymlinkDirectory(runtimeRoot, path.dirname(absolute));
}

async function createNoSymlinkDirectory(parent, directory) {
  const resolvedParent = await realpath(parent).catch(() => null);
  const lexicalParent = path.resolve(parent);
  const lexicalDirectory = path.resolve(directory);
  if (!resolvedParent || !isWithin(lexicalParent, lexicalDirectory)) throw new LauncherError('ISOLATED_HOME_REQUIRED');
  const resolvedDirectory = path.resolve(resolvedParent, path.relative(lexicalParent, lexicalDirectory));
  const segments = path.relative(resolvedParent, resolvedDirectory).split(path.sep).filter(Boolean);
  let current = resolvedParent;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const info = await lstat(current).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new LauncherError('ISOLATED_HOME_REQUIRED');
    const actual = await realpath(current).catch(() => null);
    if (!actual || !isWithin(resolvedParent, actual)) throw new LauncherError('ISOLATED_HOME_REQUIRED');
  }
}

function redact(buffer, secrets) {
  let result = buffer.toString('utf8');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) result = result.split(secret).join('[REDACTED]');
  }
  result = result
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, '[REDACTED_AWS_ACCESS_KEY]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, '$1[REDACTED]')
    .replace(/(AWS_SECRET_ACCESS_KEY\s*[=:]\s*)\S+/giu, '$1[REDACTED]')
    .replace(/(AWS_SESSION_TOKEN\s*[=:]\s*)\S+/giu, '$1[REDACTED]');
  return Buffer.from(result, 'utf8');
}

async function killProcessGroup(child, signal) {
  if (Number.isInteger(child?.pid) && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  try {
    child?.kill?.(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
