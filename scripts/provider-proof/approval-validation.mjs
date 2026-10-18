import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalDigest, canonicalJson } from './canonical.mjs';

const TRUST_ANCHOR_PATH = fileURLToPath(new URL('./trust-anchor.json', import.meta.url));
const APPROVAL_NAMESPACE = 'artifact-pages-provider-proof';
const APPROVAL_FIELDS = new Set([
  'schemaVersion', 'runId', 'id', 'command', 'transition', 'sealDigest', 'scopeDigest',
  'approvedAt', 'expiresAt', 'reviewerKeyId', 'reviewerKeyFingerprint', 'signature',
]);

export function loadOwnerTrustAnchor() {
  try {
    const anchor = JSON.parse(readFileSync(TRUST_ANCHOR_PATH, 'utf8'));
    const fields = ['schemaVersion', 'keyId', 'algorithm', 'status', 'publicKey', 'fingerprint'];
    if (!anchor || Object.keys(anchor).length !== fields.length || Object.keys(anchor).some((key) => !fields.includes(key))) return null;
    if (!anchor || anchor.schemaVersion !== 1 || anchor.keyId !== 'owner' || anchor.algorithm !== 'ssh-ed25519') return null;
    if (anchor.status === 'unenrolled' && anchor.publicKey === null && anchor.fingerprint === null) return anchor;
    if (anchor.status !== 'enrolled' || typeof anchor.publicKey !== 'string' || typeof anchor.fingerprint !== 'string') return null;
    if (fingerprintKey(anchor.publicKey) !== anchor.fingerprint) return null;
    return anchor;
  } catch {
    return null;
  }
}

export function ownerTrustAnchorEnrolled() {
  return loadOwnerTrustAnchor()?.status === 'enrolled';
}

export function fingerprintKey(publicKey) {
  const parsed = parseEd25519PublicKey(publicKey);
  const digest = createHash('sha256').update(parsed.blob).digest('base64').replace(/=+$/u, '');
  return `SHA256:${digest}`;
}

export function approvalSigningBytes(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('approval record must be an object');
  const { signature, ...signedFields } = record;
  return Buffer.from(canonicalJson(signedFields), 'utf8');
}

export function verifyApprovalSignature(record, publicKey) {
  let temporaryDirectory;
  try {
    if (!record || typeof record.signature !== 'string' || !isCanonicalBase64(record.signature)) return false;
    const parsedKey = parseEd25519PublicKey(publicKey);
    const signatureBytes = Buffer.from(record.signature, 'base64');
    temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'provider-proof-ssh-verify-'));
    const allowedSignersPath = path.join(temporaryDirectory, 'allowed_signers');
    const signaturePath = path.join(temporaryDirectory, 'approval.sig');
    writeFileSync(allowedSignersPath, `owner ${parsedKey.type} ${parsedKey.base64}\n`, { mode: 0o600, flag: 'wx' });
    writeFileSync(signaturePath, signatureBytes, { mode: 0o600, flag: 'wx' });
    const result = spawnSync('ssh-keygen', [
      '-Y', 'verify',
      '-f', allowedSignersPath,
      '-I', 'owner',
      '-n', APPROVAL_NAMESPACE,
      '-s', signaturePath,
    ], {
      input: approvalSigningBytes(record),
      encoding: null,
      maxBuffer: 1024 * 1024,
      timeout: 5000,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  } finally {
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function verifyApprovalRecord(record, manifest, approvalId, command, now = Date.now()) {
  try {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    if (manifest?.testOnly === true || Object.hasOwn(manifest ?? {}, 'reviewKeys')) return false;
    if (manifest?.schemaVersion !== 1 || typeof manifest.runId !== 'string' || !manifest.runId) return false;
    if (!manifest.policy || typeof manifest.policy !== 'object' || !manifest.approvalPolicy || typeof manifest.approvalPolicy !== 'object') return false;
    if (manifest.sealChainVerified !== true || !manifest.activeSeal || manifest.activeSeal.digest !== manifest.activeSealDigest) return false;
    if (!isDigest(manifest.activeSealDigest) || !isCanonicalUtc(manifest.activeSeal.createdAt)) return false;
    if (Object.keys(record).some((key) => !APPROVAL_FIELDS.has(key)) || Object.keys(record).length !== APPROVAL_FIELDS.size) return false;
    if (record.schemaVersion !== 1 || record.runId !== manifest.runId) return false;
    if (record.id !== approvalId || typeof approvalId !== 'string' || !approvalId) return false;
    if (record.command !== command || record.transition !== command || typeof command !== 'string' || !command) return false;
    if (!isDigest(record.sealDigest) || record.sealDigest !== manifest.activeSealDigest) return false;
    const expectedScopeDigest = canonicalDigest({ policy: manifest.policy, approvalPolicy: manifest.approvalPolicy });
    if (!isDigest(record.scopeDigest) || record.scopeDigest !== expectedScopeDigest) return false;
    if (!isCanonicalUtc(record.approvedAt) || !isCanonicalUtc(record.expiresAt)) return false;
    const approvedAt = Date.parse(record.approvedAt);
    const expiresAt = Date.parse(record.expiresAt);
    const sealCreatedAt = Date.parse(manifest.activeSeal.createdAt);
    const scopeExpiresAt = Date.parse(manifest.scopeExpiresAt);
    const windowExpiryText = manifest.approvalWindows?.[approvalId]?.expiresAt ?? manifest.scopeExpiresAt;
    if (!isCanonicalUtc(manifest.scopeExpiresAt) || !isCanonicalUtc(windowExpiryText)) return false;
    const windowExpiresAt = Date.parse(windowExpiryText);
    if (!Number.isFinite(now) || sealCreatedAt > approvedAt || approvedAt > now || now >= expiresAt) return false;
    if (expiresAt > scopeExpiresAt || expiresAt > windowExpiresAt) return false;
    if (record.reviewerKeyId !== 'owner' || typeof record.reviewerKeyFingerprint !== 'string') return false;
    if (typeof record.signature !== 'string' || !isCanonicalBase64(record.signature)) return false;
    const anchor = loadOwnerTrustAnchor();
    if (!anchor || anchor.status !== 'enrolled' || anchor.keyId !== record.reviewerKeyId) return false;
    if (record.reviewerKeyFingerprint !== anchor.fingerprint || fingerprintKey(anchor.publicKey) !== anchor.fingerprint) return false;
    return verifyApprovalSignature(record, anchor.publicKey);
  } catch {
    return false;
  }
}

function parseEd25519PublicKey(publicKey) {
  if (typeof publicKey !== 'string') throw new TypeError('invalid SSH public key');
  const [type, base64] = publicKey.trim().split(/\s+/u);
  if (type !== 'ssh-ed25519' || !base64 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) throw new TypeError('invalid SSH Ed25519 public key');
  const blob = Buffer.from(base64, 'base64');
  if (blob.toString('base64').replace(/=+$/u, '') !== base64.replace(/=+$/u, '') || blob.length !== 51) {
    throw new TypeError('invalid SSH Ed25519 key blob');
  }
  const algorithmLength = blob.readUInt32BE(0);
  if (algorithmLength !== 11 || blob.subarray(4, 15).toString('ascii') !== type || blob.readUInt32BE(15) !== 32) {
    throw new TypeError('invalid SSH Ed25519 key blob');
  }
  return { type, base64: base64.replace(/=+$/u, ''), blob };
}

function isCanonicalBase64(value) {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value;
}

function isDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isCanonicalUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
