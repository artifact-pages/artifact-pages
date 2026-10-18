import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { canonicalDigest } from './canonical.mjs';
import { assertInvocationMatchesTransition, getInvocation } from './invocation-registry.mjs';
import { AuthorizationError, requireExternalCapability } from './policy.mjs';

export const VERIFICATION_RECORD_VERSION = 1;
export const DEFAULT_VERIFICATION_MAX_AGE_MS = 5 * 60 * 1000;
export const DEFAULT_PROBE_TIMEOUT_MS = 10 * 1000;

const immutableProbe = (probe) => Object.freeze(probe);

export const PROBE_DEFINITIONS = Object.freeze([
  immutableProbe({ id: 'aws.inventory.caller-identity', credentialClass: 'aws-inventory', provider: 'aws', kind: 'positive', operation: 'GetCallerIdentity', targetRef: 'awsAccount', expectedStatus: 200, stage: 'preflight' }),
  immutableProbe({ id: 'aws.inventory.list-buckets', credentialClass: 'aws-inventory', provider: 'aws', kind: 'positive', operation: 'ListAllMyBuckets', targetRef: 'awsAccount', expectedStatus: 200, stage: 'preflight' }),
  immutableProbe({ id: 'aws.inventory.preserved-object-read', credentialClass: 'aws-inventory', provider: 'aws', kind: 'positive', operation: 'GetObject', targetRef: 'awsPreservedObject', expectedStatus: 200, stage: 'preflight' }),
  immutableProbe({ id: 'aws.inventory.preserved-distribution-read', credentialClass: 'aws-inventory', provider: 'aws', kind: 'positive', operation: 'GetDistribution', targetRef: 'awsPreservedDistribution', expectedStatus: 200, stage: 'preflight' }),
  immutableProbe({ id: 'aws.provisioner.caller-identity', credentialClass: 'aws-provisioner', provider: 'aws', kind: 'positive', operation: 'GetCallerIdentity', targetRef: 'awsAccount', expectedStatus: 200, stage: 'preflight' }),
  immutableProbe({ id: 'aws.provisioner.preserved-object-denied', credentialClass: 'aws-provisioner', provider: 'aws', kind: 'negative-read', operation: 'GetObject', targetRef: 'awsPreservedObject', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'aws.provisioner.preserved-distribution-denied', credentialClass: 'aws-provisioner', provider: 'aws', kind: 'negative-read', operation: 'GetDistribution', targetRef: 'awsPreservedDistribution', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'aws.provisioner.preserved-bucket-list-denied', credentialClass: 'aws-provisioner', provider: 'aws', kind: 'negative-read', operation: 'ListBucket', targetRef: 'awsPreservedBucket', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'aws.operator.proof-bucket-list', credentialClass: 'aws-test-operator', provider: 'aws', kind: 'positive', operation: 'ListBucket', targetRef: 'proofBucket', expectedStatus: 200, stage: 'preflight' }),
  immutableProbe({ id: 'aws.operator.proof-object-get', credentialClass: 'aws-test-operator', provider: 'aws', kind: 'positive', operation: 'GetObject', targetRef: 'proofCanary', expectedStatus: 200, stage: 'preflight' }),
  immutableProbe({ id: 'aws.operator.preserved-object-denied', credentialClass: 'aws-test-operator', provider: 'aws', kind: 'negative-read', operation: 'GetObject', targetRef: 'awsPreservedObject', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'aws.operator.preserved-distribution-denied', credentialClass: 'aws-test-operator', provider: 'aws', kind: 'negative-read', operation: 'GetDistribution', targetRef: 'awsPreservedDistribution', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'aws.operator.preserved-bucket-list-denied', credentialClass: 'aws-test-operator', provider: 'aws', kind: 'negative-read', operation: 'ListBucket', targetRef: 'awsPreservedBucket', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'aws.publisher.own-index-get', credentialClass: 'aws-satellite-a', provider: 'aws', kind: 'positive', operation: 'GetObject', targetRef: 'awsOwnIndex', expectedStatus: 200, stage: 'preflight' }),
  immutableProbe({ id: 'aws.publisher.preserved-object-denied', credentialClass: 'aws-satellite-a', provider: 'aws', kind: 'negative-read', operation: 'GetObject', targetRef: 'awsPreservedObject', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'aws.publisher.preserved-distribution-denied', credentialClass: 'aws-satellite-a', provider: 'aws', kind: 'negative-read', operation: 'GetDistribution', targetRef: 'awsPreservedDistribution', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'aws.publisher.neighbor-index-denied', credentialClass: 'aws-satellite-a', provider: 'aws', kind: 'negative-read', operation: 'GetObject', targetRef: 'awsNeighborIndex', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'aws.publisher.neighbor-artifact-denied', credentialClass: 'aws-satellite-a', provider: 'aws', kind: 'negative-read', operation: 'GetObject', targetRef: 'awsNeighborArtifact', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'aws.publisher.neighbor-preview-denied', credentialClass: 'aws-satellite-a', provider: 'aws', kind: 'negative-read', operation: 'GetObject', targetRef: 'awsNeighborPreview', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'aws.publisher.neighbor-control-denied', credentialClass: 'aws-satellite-a', provider: 'aws', kind: 'negative-read', operation: 'GetObject', targetRef: 'awsNeighborControl', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'aws.publisher.preserved-bucket-list-denied', credentialClass: 'aws-satellite-a', provider: 'aws', kind: 'negative-read', operation: 'ListBucket', targetRef: 'awsPreservedBucket', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'cloudflare.reader.exact-registry-get', credentialClass: 'cloudflare-registry-reader', provider: 'cloudflare', kind: 'positive', operation: 'GetObject', targetRef: 'cfRegistryKey', expectedStatus: 200, stage: 'preflight' }),
  immutableProbe({ id: 'cloudflare.reader.exact-app-version-get', credentialClass: 'cloudflare-registry-reader', provider: 'cloudflare', kind: 'positive', operation: 'GetObject', targetRef: 'cfAppVersionKey', expectedStatus: 200, stage: 'preflight' }),
  immutableProbe({ id: 'cloudflare.reader.out-of-scope-control-denied', credentialClass: 'cloudflare-registry-reader', provider: 'cloudflare', kind: 'negative-read', operation: 'GetObject', targetRef: 'cfOutOfScopeControl', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'cloudflare.reader.unrelated-bucket-denied', credentialClass: 'cloudflare-registry-reader', provider: 'cloudflare', kind: 'negative-read', operation: 'GetObject', targetRef: 'cfUnrelatedVerifyBucket', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'cloudflare.writer.own-index-get', credentialClass: 'cloudflare-site-a-writer', provider: 'cloudflare', kind: 'positive', operation: 'GetObject', targetRef: 'cfOwnIndex', expectedStatus: 200, stage: 'preflight' }),
  immutableProbe({ id: 'cloudflare.writer.neighbor-index-denied', credentialClass: 'cloudflare-site-a-writer', provider: 'cloudflare', kind: 'negative-read', operation: 'GetObject', targetRef: 'cfNeighborIndex', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'cloudflare.writer.neighbor-artifact-denied', credentialClass: 'cloudflare-site-a-writer', provider: 'cloudflare', kind: 'negative-read', operation: 'GetObject', targetRef: 'cfNeighborArtifact', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'cloudflare.writer.neighbor-preview-denied', credentialClass: 'cloudflare-site-a-writer', provider: 'cloudflare', kind: 'negative-read', operation: 'GetObject', targetRef: 'cfNeighborPreview', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'cloudflare.writer.neighbor-control-denied', credentialClass: 'cloudflare-site-a-writer', provider: 'cloudflare', kind: 'negative-read', operation: 'GetObject', targetRef: 'cfNeighborControl', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'cloudflare.writer.prefix-boundary-sibling-denied', credentialClass: 'cloudflare-site-a-writer', provider: 'cloudflare', kind: 'negative-read', operation: 'GetObject', targetRef: 'cfBoundarySibling', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'cloudflare.writer.unrelated-bucket-denied', credentialClass: 'cloudflare-site-a-writer', provider: 'cloudflare', kind: 'negative-read', operation: 'GetObject', targetRef: 'cfUnrelatedVerifyBucket', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'cloudflare.observer.life-prefix-get', credentialClass: 'cloudflare-life-observer', provider: 'cloudflare', kind: 'positive', operation: 'GetObject', targetRef: 'cfLifeObject', expectedStatus: 200, stage: 'preflight' }),
  immutableProbe({ id: 'cloudflare.observer.other-prefix-denied', credentialClass: 'cloudflare-life-observer', provider: 'cloudflare', kind: 'negative-read', operation: 'GetObject', targetRef: 'cfNeighborIndex', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'preflight' }),
  immutableProbe({ id: 'aws.canary.cross-site-put-denied', credentialClass: 'aws-satellite-a', provider: 'aws', kind: 'negative-write-canary', operation: 'PutObject', targetRef: 'awsDisposableNeighborCanary', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'canary' }),
  immutableProbe({ id: 'aws.canary.cross-site-delete-denied', credentialClass: 'aws-satellite-a', provider: 'aws', kind: 'negative-write-canary', operation: 'DeleteObject', targetRef: 'awsDisposableNeighborCanary', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'canary' }),
  immutableProbe({ id: 'cloudflare.canary.cross-site-put-denied', credentialClass: 'cloudflare-site-a-writer', provider: 'cloudflare', kind: 'negative-write-canary', operation: 'PutObject', targetRef: 'cfDisposableNeighborCanary', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'canary' }),
  immutableProbe({ id: 'cloudflare.canary.cross-site-delete-denied', credentialClass: 'cloudflare-site-a-writer', provider: 'cloudflare', kind: 'negative-write-canary', operation: 'DeleteObject', targetRef: 'cfDisposableNeighborCanary', expectedStatus: 403, expectedErrorCode: 'AccessDenied', stage: 'canary' }),
]);

export class CredentialVerificationError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'CredentialVerificationError';
    this.code = code;
  }
}

export function targetConfirmationDigest(target) {
  const confirmation = target?.confirmation;
  if (!confirmation || confirmation.status !== 200 || typeof confirmation.requestId !== 'string' || !confirmation.requestId
    || typeof confirmation.etag !== 'string' || !confirmation.etag
    || typeof confirmation.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(confirmation.sha256)) {
    throw new CredentialVerificationError('PROBE_TARGET_NOT_INDEPENDENTLY_CONFIRMED');
  }
  const { confirmation: ignored, ...resource } = target;
  void ignored;
  const { digest, ...confirmed } = confirmation;
  void digest;
  const expected = canonicalDigest({ resource, confirmation: confirmed });
  if (target.confirmation.digest !== expected) throw new CredentialVerificationError('PROBE_TARGET_CONFIRMATION_MISMATCH');
  return expected;
}

export function makeTargetConfirmation(resource, { requestId, etag, sha256, status = 200 }) {
  const confirmation = { status, requestId, etag, sha256 };
  return { ...structuredClone(resource), confirmation: { ...confirmation, digest: canonicalDigest({ resource, confirmation }) } };
}

export async function verifyCredential({
  manifest,
  capability,
  invocationId,
  invocationDigest,
  credential,
  policyInspector,
  probeTransport,
  recordStore,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  now = () => Date.now(),
}) {
  requireExternalCapability(capability);
  if (manifest?.testOnly === true || !manifest?.activeSealDigest || !capability?.command
    || capability.manifest !== manifest) {
    throw new CredentialVerificationError('SIGNED_TRANSITION_REQUIRED');
  }
  if (!invocationId || !/^[a-f0-9]{64}$/u.test(invocationDigest ?? '')) throw new CredentialVerificationError('INVOCATION_BINDING_REQUIRED');
  const invocation = getInvocation(invocationId);
  if (invocation.transition !== capability.command) throw new CredentialVerificationError('INVOCATION_TRANSITION_MISMATCH');
  if (!credential || !credential.credentialClass || !credential.instanceId || !credential.expiresAt) {
    throw new CredentialVerificationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED');
  }
  if (credential.provider !== invocation.provider || credential.credentialClass !== invocation.credentialClass) {
    throw new CredentialVerificationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED', 'credential does not match the fixed invocation');
  }
  if (!credential.credentialSource) throw new CredentialVerificationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED', 'credential source is missing');
  if (credential.accountId !== expectedAccountId(credential.provider) || Date.parse(credential.expiresAt) <= now()) {
    throw new CredentialVerificationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED', 'wrong account or expired credential');
  }
  if (typeof policyInspector !== 'function' || typeof probeTransport !== 'function' || !recordStore) {
    throw new CredentialVerificationError('EXECUTION_PATH_NOT_IMPLEMENTED');
  }
  if (!Number.isInteger(probeTimeoutMs) || probeTimeoutMs < 1 || probeTimeoutMs > 60_000) {
    throw new CredentialVerificationError('PROBE_TIMEOUT_INVALID');
  }

  const expected = manifest.policy?.credentialExpectations?.[credential.credentialClass];
  if (!expected || expected.provider !== credential.provider || expected.accountId !== credential.accountId
    || expected.resourceBindings == null || expected.policyDigests == null) {
    throw new CredentialVerificationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED', 'sealed credential expectation is missing');
  }

  const readback = await policyInspector({
    provider: credential.provider,
    credentialSource: credential.credentialSource,
    credentialClass: credential.credentialClass,
    identityCredential: credential,
    inspectorCredential: credential.inspector,
    expected,
  });
  validateReadback(readback, expected, credential);

  const probes = PROBE_DEFINITIONS.filter((probe) => probe.credentialClass === credential.credentialClass && probe.stage === 'preflight');
  if (probes.length === 0) throw new CredentialVerificationError('EXECUTION_PATH_NOT_IMPLEMENTED', `no probes for ${credential.credentialClass}`);
  const results = [];
  for (const definition of probes) {
    const target = resolveProbeTarget(manifest, definition);
    let response;
    try {
      response = await runProbeWithTimeout(probeTransport, {
        credential,
        provider: definition.provider,
        operation: definition.operation,
        target: sanitizedTarget(target),
        probeId: definition.id,
      }, probeTimeoutMs);
    } catch (error) {
      if (error instanceof CredentialVerificationError) throw error;
      throw new CredentialVerificationError('PROBE_TRANSPORT_FAILED', definition.id);
    }
    results.push(validateProbeResult(definition, target, response, now()));
  }

  const time = new Date(now()).toISOString();
  const recordContent = {
    schemaVersion: VERIFICATION_RECORD_VERSION,
    runId: manifest.runId,
    activeSealDigest: manifest.activeSealDigest,
    transition: capability.command,
    invocationId,
    invocationDigest,
    provider: credential.provider,
    credentialSource: credential.credentialSource,
    identity: {
      accountId: readback.identity.accountId,
      principalArn: readback.identity.principalArn,
      roleArn: readback.identity.roleArn,
    },
    credentialInstanceId: credential.instanceId,
    policyDigests: structuredClone(readback.policyDigests),
    resourceBindings: structuredClone(readback.resourceBindings),
    probes: results,
    verifiedAt: time,
    credentialExpiresAt: credential.expiresAt,
  };
  rejectCredentialMaterial(recordContent);
  const record = { ...recordContent, digest: canonicalDigest(recordContent) };
  await recordStore.write(record);
  return record;
}

export function requireCredentialVerification({ record, manifest, capability, invocationId, invocationDigest, credential, now = Date.now(), minimumLifetimeMs = 60000, maxVerificationAgeMs = DEFAULT_VERIFICATION_MAX_AGE_MS }) {
  requireExternalCapability(capability);
  if (capability.manifest !== manifest) throw new AuthorizationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED');
  const invocation = assertInvocationMatchesTransition(invocationId, capability.command);
  if (credential?.provider !== invocation.provider || credential?.credentialClass !== invocation.credentialClass) {
    throw new AuthorizationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED');
  }
  if (!isVerificationRecord(record)) throw new AuthorizationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED');
  const { digest, ...content } = record;
  if (digest !== canonicalDigest(content)
    || record.runId !== manifest.runId
    || record.activeSealDigest !== manifest.activeSealDigest
    || record.transition !== capability.command
    || record.invocationId !== invocationId
    || record.invocationDigest !== invocationDigest
    || record.provider !== credential.provider
    || record.credentialSource !== credential.credentialSource
    || record.identity?.accountId !== credential.accountId
    || record.identity?.principalArn !== credential.principalArn
    || record.identity?.roleArn !== credential.resourceBindings?.roleArn
    || record.credentialInstanceId !== credential.instanceId
    || canonicalDigest(record.policyDigests) !== canonicalDigest(credential.policyDigests)
    || canonicalDigest(record.resourceBindings) !== canonicalDigest(credential.resourceBindings)
    || record.credentialExpiresAt !== credential.expiresAt
    || !isCanonicalUtc(record.verifiedAt)
    || Date.parse(record.verifiedAt) > now
    || now - Date.parse(record.verifiedAt) > maxVerificationAgeMs
    || Date.parse(record.credentialExpiresAt) - now < minimumLifetimeMs
    || !record.probes.every((probe) => ['positive', 'denied'].includes(probe.outcome))) {
    throw new AuthorizationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED');
  }
  return record;
}

export function createVerificationRecordStore(directory) {
  const root = path.resolve(directory);
  return Object.freeze({
    async write(record) {
      if (!isVerificationRecord(record)) throw new CredentialVerificationError('INVALID_VERIFICATION_RECORD');
      await mkdir(root, { recursive: true, mode: 0o700 });
      await assertPrivateRecordDirectory(root);
      const finalPath = path.join(root, `${record.digest}.json`);
      const temporaryPath = `${finalPath}.${process.pid}.tmp`;
      let handle;
      try {
        handle = await open(temporaryPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporaryPath, finalPath);
      } catch (error) {
        await handle?.close().catch(() => {});
        await rm(temporaryPath, { force: true }).catch(() => {});
        if (error?.code === 'EEXIST') throw new CredentialVerificationError('VERIFICATION_RECORD_ALREADY_EXISTS');
        throw error;
      }
      return finalPath;
    },
    async read(digest) {
      if (!/^[a-f0-9]{64}$/u.test(digest ?? '')) return null;
      try {
        await assertPrivateRecordDirectory(root);
        const filename = path.join(root, `${digest}.json`);
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return null;
        const record = JSON.parse(await readFile(filename, 'utf8'));
        return isVerificationRecord(record) ? record : null;
      } catch {
        return null;
      }
    },
  });
}

async function assertPrivateRecordDirectory(directory) {
  const info = await lstat(directory).catch(() => null);
  const actual = await realpath(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || !actual || (info.mode & 0o077) !== 0) {
    throw new CredentialVerificationError('VERIFICATION_RECORD_STORE_NOT_PRIVATE');
  }
}

function validateReadback(readback, expected, credential) {
  if (!readback || !readback.identity || readback.identity.accountId !== expected.accountId
    || readback.identity.accountId !== credential.accountId
    || typeof readback.identity.principalArn !== 'string' || !readback.identity.principalArn
    || readback.identity.roleArn !== expected.roleArn
    || canonicalDigest(readback.policyDigests ?? {}) !== canonicalDigest(expected.policyDigests)
    || canonicalDigest(readback.resourceBindings ?? {}) !== canonicalDigest(expected.resourceBindings)
    || canonicalDigest(readback.policyDigests ?? {}) !== canonicalDigest(credential.policyDigests)
    || canonicalDigest(readback.resourceBindings ?? {}) !== canonicalDigest(credential.resourceBindings)
    || hasForbiddenResource(readback.resourceBindings, credential.credentialClass)) {
    throw new CredentialVerificationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED', 'authoritative policy readback does not match the sealed scope');
  }
}

function resolveProbeTarget(manifest, definition) {
  const target = manifest.policy?.verificationTargets?.[definition.targetRef];
  if (!target || target.provider !== definition.provider) throw new CredentialVerificationError('PROBE_TARGET_BINDING_REQUIRED', definition.targetRef);
  if (definition.kind === 'negative-read') targetConfirmationDigest(target);
  if (isProductionTarget(target)) throw new CredentialVerificationError('PRODUCTION_PROBE_FORBIDDEN');
  if (definition.operation === 'PutObject' || definition.operation === 'DeleteObject' || definition.operation === 'DeleteObjects') {
    if (definition.stage !== 'canary' || target.canary !== true || target.disposable !== true) {
      throw new CredentialVerificationError('DESTRUCTIVE_PROBE_REQUIRES_DISPOSABLE_CANARY');
    }
  }
  return target;
}

function validateProbeResult(definition, target, response, time) {
  if (!response || typeof response !== 'object' || !Number.isInteger(response.status)) {
    throw new CredentialVerificationError('PROBE_RESULT_INVALID', definition.id);
  }
  const common = {
    id: definition.id,
    outcome: definition.kind === 'positive' ? 'positive' : 'denied',
    target: sanitizedTarget(target),
    status: response.status,
    errorCode: response.errorCode ?? null,
    requestId: typeof response.requestId === 'string' ? response.requestId : null,
    observedAt: new Date(time).toISOString(),
  };
  if (definition.kind === 'positive') {
    if (response.status !== definition.expectedStatus || response.errorCode) throw new CredentialVerificationError('POSITIVE_CONTROL_FAILED', definition.id);
  } else if (response.status !== definition.expectedStatus || response.errorCode !== definition.expectedErrorCode) {
    throw new CredentialVerificationError('NEGATIVE_PROBE_NOT_DENIED', `${definition.id}:${response.errorCode ?? response.status}`);
  }
  return common;
}

async function runProbeWithTimeout(probeTransport, input, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => probeTransport({ ...input, signal: controller.signal })),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new CredentialVerificationError('PROBE_TIMEOUT', input.probeId));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sanitizedTarget(target) {
  const fields = ['provider', 'accountId', 'bucket', 'key', 'distributionId', 'zoneId', 'zoneName', 'prefix', 'operation'];
  return Object.fromEntries(fields.filter((key) => target[key] !== undefined).map((key) => [key, target[key]]));
}

function hasForbiddenResource(bindings, credentialClass) {
  const values = stringValues(bindings);
  const production = values.includes('9ac354c8aa31d424224d8c4f3aa8ba2a')
    || values.includes('artifact-pages.dev')
    || values.includes('artifact-pages')
    || values.includes('arn:aws:s3:::artifact-pages')
    || values.includes('arn:aws:s3:::artifact-pages/*');
  const preservedAws = values.includes('artifact-pages-231136241959-us-east-1') || values.includes('ECFTIR5GVPQDF')
    || values.includes('arn:aws:s3:::artifact-pages-231136241959-us-east-1')
    || values.includes('arn:aws:cloudfront::231136241959:distribution/ECFTIR5GVPQDF');
  return production || (preservedAws && credentialClass !== 'aws-inventory');
}

function stringValues(value, output = []) {
  if (Array.isArray(value)) for (const item of value) stringValues(item, output);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) stringValues(item, output);
  else if (typeof value === 'string') output.push(value);
  return output;
}

function isProductionTarget(target) {
  return target.accountId === '9ac354c8aa31d424224d8c4f3aa8ba2a'
    || target.bucket === 'artifact-pages'
    || target.zoneName === 'artifact-pages.dev'
    || target.zoneId === '3eb221959ea55267ea2bfb93af45ef7e';
}

function expectedAccountId(provider) {
  if (provider === 'aws') return '231136241959';
  if (provider === 'cloudflare') return '21a0acb78621cc00cfa655a276d77b74';
  return null;
}

function isVerificationRecord(record) {
  if (!record || record.schemaVersion !== VERIFICATION_RECORD_VERSION || !Array.isArray(record.probes)) return false;
  const { digest, ...content } = record;
  return typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest) && digest === canonicalDigest(content);
}

function rejectCredentialMaterial(value, parent = '') {
  if (Array.isArray(value)) {
    for (const item of value) rejectCredentialMaterial(item, parent);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (/(?:secret|token|password|private.?key|credential.?value|access.?key.?id)/i.test(key)) {
        throw new CredentialVerificationError('CREDENTIAL_MATERIAL_IN_VERIFICATION_RECORD', parent ? `${parent}.${key}` : key);
      }
      rejectCredentialMaterial(nested, parent ? `${parent}.${key}` : key);
    }
    return;
  }
  if (typeof value === 'string' && /(?:AKIA[0-9A-Z]{16}|Bearer\s+\S+|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/u.test(value)) {
    throw new CredentialVerificationError('CREDENTIAL_MATERIAL_IN_VERIFICATION_RECORD', parent);
  }
}

function isCanonicalUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
