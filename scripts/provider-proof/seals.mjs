import { spawnSync } from 'node:child_process';
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalDigest, canonicalJson, sha256 } from './canonical.mjs';
import { verifyApprovalRecord } from './approval-validation.mjs';

export { canonicalDigest, canonicalJson, sha256 } from './canonical.mjs';
export { approvalSigningBytes } from './approval-validation.mjs';

export const SEAL_STAGES = Object.freeze([
  'bootstrap', 'discovery', 'inventory', 'create-plan', 'post-apply',
  'lifecycle-add', 'lifecycle-outcome', 'lifecycle-restore', 'a9-pins',
  'destroy-plan', 'final-preservation',
]);

const PREDECESSORS = Object.freeze({
  bootstrap: [],
  discovery: ['bootstrap'],
  inventory: ['discovery'],
  'create-plan': ['inventory'],
  'post-apply': ['create-plan'],
  'lifecycle-add': ['post-apply'],
  'lifecycle-outcome': ['lifecycle-add'],
  'lifecycle-restore': ['lifecycle-outcome'],
  'a9-pins': ['lifecycle-restore'],
  'destroy-plan': ['a9-pins'],
  'final-preservation': ['destroy-plan'],
});

export class SealError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SealError';
    this.code = code;
  }
}

export async function appendSeal({ manifestPath, stage = 'bootstrap', artifacts = [], now = new Date().toISOString() }) {
  if (!SEAL_STAGES.includes(stage)) throw new SealError('UNKNOWN_SEAL_STAGE');
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = await readJson(absoluteManifest);
  validateManifestShape(manifest);
  const root = path.dirname(absoluteManifest);
  const sealDirectory = path.resolve(root, manifest.sealDirectory ?? 'seals');
  if (!isInside(root, sealDirectory)) throw new SealError('SEAL_DIRECTORY_OUTSIDE_RUNTIME');
  const chain = await readSealChain({ manifestPath: absoluteManifest, verifyArtifacts: true });
  const prior = chain.at(-1);
  if (stage === 'bootstrap' && prior) throw new SealError('BOOTSTRAP_ALREADY_SEALED');
  if (stage !== 'bootstrap') {
    if (!prior || !PREDECESSORS[stage].includes(prior.stage)) throw new SealError('SKIPPED_SEAL_TRANSITION', stage);
  }
  const files = await resolveArtifactPaths(root, artifacts);
  const fileDigests = [];
  for (const file of files) {
    const bytes = await readFile(file.absolute);
    fileDigests.push({ path: file.relative, sha256: sha256(bytes), size: bytes.byteLength });
  }
  if (stage !== 'bootstrap' && fileDigests.length === 0) throw new SealError('SEAL_EVIDENCE_REQUIRED', stage);
  const manifestBytes = await readFile(absoluteManifest);
  const record = {
    schemaVersion: 1,
    sequence: chain.length + 1,
    stage,
    createdAt: new Date(now).toISOString(),
    previousDigest: prior?.digest ?? null,
    manifestSha256: sha256(manifestBytes),
    policySha256: canonicalDigest(manifest.policy),
    approvalsSha256: canonicalDigest(manifest.approvalPolicy),
    artifacts: fileDigests,
  };
  if (stage === 'bootstrap') record.workspaceSnapshot = await createWorkspaceSnapshot(root, manifest);
  record.digest = canonicalDigest(record);
  const filename = `${String(record.sequence).padStart(3, '0')}-${stage}-${record.digest}.json`;
  const outputPath = path.join(sealDirectory, filename);
  await writeImmutable(outputPath, canonicalJson(record));
  return { record, path: outputPath };
}

export async function readSealChain({ manifestPath, verifyArtifacts = true }) {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = await readJson(absoluteManifest);
  validateManifestShape(manifest);
  const root = path.dirname(absoluteManifest);
  const sealDirectory = path.resolve(root, manifest.sealDirectory ?? 'seals');
  if (!isInside(root, sealDirectory)) throw new SealError('SEAL_DIRECTORY_OUTSIDE_RUNTIME');
  let entries;
  try {
    entries = (await readdir(sealDirectory)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const chain = [];
  let previousDigest = null;
  for (const [index, name] of entries.entries()) {
    const record = await readJson(path.join(sealDirectory, name));
    const { digest, ...content } = record;
    if (digest !== canonicalDigest(content)) throw new SealError('SEAL_DIGEST_MISMATCH', name);
    if (record.sequence !== index + 1 || record.previousDigest !== previousDigest) throw new SealError('SEAL_CHAIN_MISMATCH', name);
    if (record.manifestSha256 !== sha256(await readFile(absoluteManifest))) throw new SealError('MANIFEST_CHANGED_AFTER_SEAL', name);
    if (verifyArtifacts) await verifyArtifactDigests(root, record.artifacts ?? []);
    if (verifyArtifacts && record.workspaceSnapshot) await verifyWorkspaceSnapshot(root, manifest, record.workspaceSnapshot);
    const expectedName = `${String(record.sequence).padStart(3, '0')}-${record.stage}-${digest}.json`;
    if (name !== expectedName) throw new SealError('SEAL_FILENAME_MISMATCH', name);
    previousDigest = digest;
    chain.push(record);
  }
  return chain;
}

export async function requireActiveSeal(manifestPath) {
  const chain = await readSealChain({ manifestPath, verifyArtifacts: true });
  if (!chain.length) throw new SealError('UNSEALED_MANIFEST');
  return chain.at(-1);
}

export async function verifyApprovalFile({ manifestPath, approvalId, command, now = Date.now() }) {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = await readJson(absoluteManifest);
  if (manifest.testOnly === true) throw new SealError('TEST_FIXTURE_CANNOT_AUTHORIZE_EXTERNAL_WORK');
  if (Object.hasOwn(manifest, 'reviewKeys')) throw new SealError('MANIFEST_REVIEW_KEYS_REJECTED');
  const active = await requireActiveSeal(absoluteManifest);
  if (typeof approvalId !== 'string' || !approvalId || typeof command !== 'string' || !command) throw new SealError('OWNER_APPROVAL_REQUIRED');
  const transitionDirectory = path.resolve(
    path.dirname(absoluteManifest),
    manifest.approvalDirectory ?? 'approvals',
    Buffer.from(approvalId).toString('hex'),
    Buffer.from(command).toString('hex'),
  );
  if (!isInside(path.dirname(absoluteManifest), transitionDirectory)) throw new SealError('APPROVAL_PATH_OUTSIDE_RUNTIME');
  const entries = await readdir(transitionDirectory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') throw new SealError('OWNER_APPROVAL_REQUIRED');
    throw error;
  });
  const candidates = entries.filter((entry) => entry.isFile()
    && entry.name.startsWith(`${active.digest}-`) && entry.name.endsWith('.json'));
  const verifiedManifest = {
    ...manifest,
    activeSealDigest: active.digest,
    activeSeal: active,
    sealChainVerified: true,
  };
  const validRecords = [];
  for (const candidate of candidates) {
    let record;
    try {
      record = await readJson(path.join(transitionDirectory, candidate.name));
    } catch {
      throw new SealError('OWNER_APPROVAL_INVALID');
    }
    if (verifyApprovalRecord(record, verifiedManifest, approvalId, command, now)) validRecords.push(record);
  }
  if (!validRecords.length) throw new SealError(candidates.length ? 'OWNER_APPROVAL_INVALID' : 'OWNER_APPROVAL_REQUIRED');
  validRecords.sort((left, right) => Date.parse(right.approvedAt) - Date.parse(left.approvedAt));
  if (validRecords.length > 1 && validRecords[0].approvedAt === validRecords[1].approvedAt) throw new SealError('OWNER_APPROVAL_AMBIGUOUS');
  return validRecords[0];
}

export async function hashWorkspaceDiff(cwd) {
  const result = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new SealError('GIT_DIFF_UNAVAILABLE');
  return sha256(result.stdout);
}

function validateManifestShape(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.runId !== 'string') throw new SealError('INVALID_MANIFEST');
  if (manifest.testOnly !== true && Object.hasOwn(manifest, 'reviewKeys')) throw new SealError('MANIFEST_REVIEW_KEYS_REJECTED');
  rejectCredentialMaterial(manifest);
  if (!manifest.policy || !manifest.approvalPolicy) throw new SealError('MANIFEST_POLICY_REQUIRED');
}

function rejectCredentialMaterial(value, parent = '') {
  if (Array.isArray(value)) {
    for (const item of value) rejectCredentialMaterial(item, parent);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (/(?:secret|token|password|private.?key|credential.?value)/i.test(key)) throw new SealError('CREDENTIAL_MATERIAL_IN_MANIFEST', key);
      rejectCredentialMaterial(nested, key);
    }
    return;
  }
  if (typeof value === 'string' && /(?:AKIA[0-9A-Z]{16}|Bearer\s+\S+|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/.test(value)) {
    throw new SealError('CREDENTIAL_MATERIAL_IN_MANIFEST', parent);
  }
}

async function resolveArtifactPaths(root, artifacts) {
  if (!Array.isArray(artifacts)) throw new SealError('INVALID_ARTIFACT_LIST');
  const result = [];
  const unique = new Set();
  for (const input of artifacts) {
    const absolute = path.resolve(root, input);
    if (!isInside(root, absolute)) throw new SealError('ARTIFACT_OUTSIDE_RUNTIME', input);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) throw new SealError('ARTIFACT_NOT_A_FILE', input);
    const actual = await realpath(absolute);
    if (!isInside(await realpath(root), actual)) throw new SealError('ARTIFACT_SYMLINK_ESCAPE', input);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (unique.has(relative)) throw new SealError('DUPLICATE_ARTIFACT', relative);
    unique.add(relative);
    result.push({ absolute, relative });
  }
  return result.sort((a, b) => a.relative.localeCompare(b.relative));
}

async function verifyArtifactDigests(root, artifacts) {
  for (const item of artifacts) {
    const [file] = await resolveArtifactPaths(root, [item.path]);
    if (sha256(await readFile(file.absolute)) !== item.sha256) throw new SealError('SEALED_ARTIFACT_CHANGED', item.path);
  }
}

async function createWorkspaceSnapshot(runtimeRoot, manifest) {
  if (manifest.testOnly === true) return null;
  if (!manifest.workspaceRoot || !manifest.baselineCommit || !Array.isArray(manifest.sourceFiles) || manifest.sourceFiles.length === 0) {
    throw new SealError('BOOTSTRAP_WORKSPACE_SNAPSHOT_REQUIRED');
  }
  const workspaceRoot = path.resolve(runtimeRoot, manifest.workspaceRoot);
  const info = await stat(workspaceRoot).catch(() => null);
  if (!info?.isDirectory()) throw new SealError('WORKSPACE_ROOT_INVALID');
  const head = gitText(['rev-parse', 'HEAD'], workspaceRoot).trim();
  if (head !== manifest.baselineCommit) throw new SealError('WORKSPACE_BASELINE_COMMIT_MISMATCH');
  const diff = gitBytes(['diff', '--binary', 'HEAD'], workspaceRoot);
  const files = [];
  for (const relative of [...new Set(manifest.sourceFiles)].sort()) {
    const absolute = path.resolve(workspaceRoot, relative);
    if (!isInside(workspaceRoot, absolute)) throw new SealError('SOURCE_FILE_OUTSIDE_WORKSPACE', relative);
    const actual = await realpath(absolute).catch(() => null);
    if (!actual || !isInside(await realpath(workspaceRoot), actual)) throw new SealError('SOURCE_FILE_INVALID', relative);
    const bytes = await readFile(actual);
    files.push({ path: relative.split(path.sep).join('/'), sha256: sha256(bytes), size: bytes.byteLength });
  }
  return { baselineCommit: head, gitDiffSha256: sha256(diff), files };
}

async function verifyWorkspaceSnapshot(runtimeRoot, manifest, snapshot) {
  const workspaceRoot = path.resolve(runtimeRoot, manifest.workspaceRoot);
  const head = gitText(['rev-parse', 'HEAD'], workspaceRoot).trim();
  if (head !== snapshot.baselineCommit || head !== manifest.baselineCommit) throw new SealError('SEALED_WORKSPACE_HEAD_CHANGED');
  const diff = gitBytes(['diff', '--binary', 'HEAD'], workspaceRoot);
  if (sha256(diff) !== snapshot.gitDiffSha256) throw new SealError('SEALED_WORKSPACE_DIFF_CHANGED');
  for (const item of snapshot.files) {
    const absolute = path.resolve(workspaceRoot, item.path);
    if (!isInside(workspaceRoot, absolute)) throw new SealError('SOURCE_FILE_OUTSIDE_WORKSPACE', item.path);
    const actual = await realpath(absolute).catch(() => null);
    if (!actual || !isInside(await realpath(workspaceRoot), actual) || sha256(await readFile(actual)) !== item.sha256) {
      throw new SealError('SEALED_SOURCE_FILE_CHANGED', item.path);
    }
  }
}

function gitText(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new SealError('GIT_METADATA_UNAVAILABLE');
  return result.stdout;
}

function gitBytes(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new SealError('GIT_DIFF_UNAVAILABLE');
  return result.stdout;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new SealError('INVALID_JSON', path.basename(file));
    throw error;
  }
}

async function writeImmutable(file, text) {
  await (await import('node:fs/promises')).mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const existing = await readFile(file, 'utf8');
      if (existing !== text) throw new SealError('IMMUTABLE_SEAL_COLLISION');
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
