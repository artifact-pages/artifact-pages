import { mkdir, readFile, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadOwnerTrustAnchor, ownerTrustAnchorEnrolled, verifyApprovalRecord } from './approval-validation.mjs';
import { canonicalDigest, canonicalJson } from './canonical.mjs';
import { requireActiveSeal } from './seals.mjs';

export async function prepareApproval({ manifestPath, approvalId, command, expiresAt, now = new Date().toISOString(), outPath }) {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = await readManifest(absoluteManifest);
  if (manifest.testOnly === true || Object.hasOwn(manifest, 'reviewKeys')) throw approvalError('PRODUCTION_MANIFEST_REQUIRED');
  if (manifest.schemaVersion !== 1 || typeof manifest.runId !== 'string' || !manifest.runId
      || !manifest.policy || typeof manifest.policy !== 'object'
      || !manifest.approvalPolicy || typeof manifest.approvalPolicy !== 'object') {
    throw approvalError('APPROVAL_MANIFEST_INVALID');
  }
  const activeSeal = await requireActiveSeal(absoluteManifest);
  const anchor = loadOwnerTrustAnchor();
  if (!anchor || anchor.status !== 'enrolled' || !ownerTrustAnchorEnrolled()) throw approvalError('OWNER_TRUST_ANCHOR_UNENROLLED');
  if (typeof approvalId !== 'string' || !approvalId || typeof command !== 'string' || !command) throw approvalError('APPROVAL_ID_AND_COMMAND_REQUIRED');
  if (!isCanonicalUtc(now) || !isCanonicalUtc(expiresAt)) throw approvalError('APPROVAL_TIMESTAMP_INVALID');
  const approvedAt = Date.parse(now);
  const expiry = Date.parse(expiresAt);
  const scopeExpiry = Date.parse(manifest.scopeExpiresAt);
  const windowText = manifest.approvalWindows?.[approvalId]?.expiresAt ?? manifest.scopeExpiresAt;
  if (!isCanonicalUtc(activeSeal.createdAt) || Date.parse(activeSeal.createdAt) > approvedAt) {
    throw approvalError('APPROVAL_BEFORE_ACTIVE_SEAL');
  }
  if (!isCanonicalUtc(manifest.scopeExpiresAt) || !isCanonicalUtc(windowText)
      || approvedAt >= expiry || expiry > scopeExpiry || expiry > Date.parse(windowText)) {
    throw approvalError('APPROVAL_EXPIRY_OUTSIDE_SCOPE');
  }
  const record = {
    schemaVersion: 1,
    runId: manifest.runId,
    id: approvalId,
    command,
    transition: command,
    sealDigest: activeSeal.digest,
    scopeDigest: canonicalDigest({ policy: manifest.policy, approvalPolicy: manifest.approvalPolicy }),
    approvedAt: now,
    expiresAt,
    reviewerKeyId: 'owner',
    reviewerKeyFingerprint: anchor.fingerprint,
  };
  const payloadDigest = canonicalDigest(record);
  const payloadPath = path.resolve(outPath ?? approvalPath(absoluteManifest, manifest, approvalId, command, activeSeal.digest, payloadDigest, '.payload.json'));
  const runtimeRoot = path.dirname(absoluteManifest);
  if (!isInside(runtimeRoot, payloadPath)) throw approvalError('APPROVAL_PATH_OUTSIDE_RUNTIME');
  await writeImmutable(payloadPath, canonicalJson(record));
  return {
    record,
    payloadPath,
    payloadDigest,
    scopeDigest: record.scopeDigest,
    activeSealDigest: activeSeal.digest,
    artifacts: activeSeal.artifacts ?? [],
    signCommand: `ssh-keygen -Y sign -f "$HOME/.ssh/<owner-key>" -n artifact-pages-provider-proof "${payloadPath}"`,
  };
}

export async function attachApproval({ manifestPath, approvalId, command, payloadPath: requestedPayloadPath, signaturePath, outPath, now = Date.now() }) {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = await readManifest(absoluteManifest);
  if (manifest.testOnly === true || Object.hasOwn(manifest, 'reviewKeys')) throw approvalError('PRODUCTION_MANIFEST_REQUIRED');
  const activeSeal = await requireActiveSeal(absoluteManifest);
  const anchor = loadOwnerTrustAnchor();
  if (!anchor || anchor.status !== 'enrolled' || !ownerTrustAnchorEnrolled()) throw approvalError('OWNER_TRUST_ANCHOR_UNENROLLED');
  const activeDirectory = approvalTransitionDirectory(absoluteManifest, manifest, approvalId, command);
  if (!isInside(path.dirname(absoluteManifest), activeDirectory)) throw approvalError('APPROVAL_PATH_OUTSIDE_RUNTIME');
  const payloadPath = path.resolve(requestedPayloadPath ?? await resolvePreparedPayload(activeDirectory, activeSeal.digest));
  if (!isInside(path.dirname(absoluteManifest), payloadPath)) throw approvalError('APPROVAL_PATH_OUTSIDE_RUNTIME');
  const payloadText = await readFile(payloadPath, 'utf8');
  const payload = JSON.parse(payloadText);
  if (payloadText !== canonicalJson(payload)) throw approvalError('APPROVAL_PAYLOAD_NOT_CANONICAL');
  const sigPath = path.resolve(signaturePath ?? `${payloadPath}.sig`);
  const signatureBytes = await readFile(sigPath);
  const record = { ...payload, signature: signatureBytes.toString('base64') };
  const verifiedManifest = {
    ...manifest,
    activeSealDigest: activeSeal.digest,
    activeSeal,
    sealChainVerified: true,
  };
  if (!verifyApprovalRecord(record, verifiedManifest, approvalId, command, now)) throw approvalError('OWNER_APPROVAL_INVALID');
  const payloadDigest = canonicalDigest(payload);
  const approvalFile = path.resolve(outPath ?? approvalPath(absoluteManifest, manifest, approvalId, command, activeSeal.digest, payloadDigest, '.json'));
  if (!isInside(path.dirname(absoluteManifest), approvalFile)) throw approvalError('APPROVAL_PATH_OUTSIDE_RUNTIME');
  await writeImmutable(approvalFile, `${JSON.stringify(record, null, 2)}\n`);
  return { approvalFile, payloadDigest: canonicalDigest(payload), sealDigest: activeSeal.digest };
}

function approvalPath(manifestPath, manifest, approvalId, command, sealDigest, payloadDigest, suffix) {
  return path.join(approvalTransitionDirectory(manifestPath, manifest, approvalId, command), `${sealDigest}-${payloadDigest}${suffix}`);
}

function approvalTransitionDirectory(manifestPath, manifest, approvalId, command) {
  const encodedId = Buffer.from(approvalId).toString('hex');
  const encodedCommand = Buffer.from(command).toString('hex');
  return path.join(path.dirname(manifestPath), manifest.approvalDirectory ?? 'approvals', encodedId, encodedCommand);
}

async function resolvePreparedPayload(directory, activeSealDigest) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') throw approvalError('APPROVAL_PAYLOAD_REQUIRED');
    throw error;
  });
  const payloads = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${activeSealDigest}-`) && entry.name.endsWith('.payload.json'))
    .map((entry) => path.join(directory, entry.name));
  if (payloads.length !== 1) throw approvalError(payloads.length ? 'APPROVAL_PAYLOAD_AMBIGUOUS' : 'APPROVAL_PAYLOAD_REQUIRED');
  return payloads[0];
}

async function readManifest(manifestPath) {
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

async function writeImmutable(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EEXIST') throw approvalError('APPROVAL_RECORD_ALREADY_EXISTS');
    throw error;
  } finally {
    await handle?.close();
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isCanonicalUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function approvalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
