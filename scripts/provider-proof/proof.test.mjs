import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  AuthorizationError,
  PHASE,
  TARGETS,
  assertPolicyExcludesPreserved,
  authorizeOperation,
  capabilityForLocalTest,
  fingerprintKey,
  policyAllows,
  resolveCommandCapability,
  validateCapsAndExpiry,
  validateChildEnvironment,
  validateCleanupState,
  validateDiscoveryCandidates,
  validateDistributionBinding,
  validateEffectiveConfig,
  validateLifecycleChange,
  verifyApprovalRecord,
} from './policy.mjs';
import { GuardedTransport, createFetchTransport } from './guarded-transport.mjs';
import {
  appendSeal,
  canonicalJson,
  canonicalDigest,
  readSealChain,
  verifyApprovalFile,
} from './seals.mjs';
import { loadOwnerTrustAnchor, ownerTrustAnchorEnrolled } from './approval-validation.mjs';
import { main } from './proof.mjs';
import { INVOCATIONS, EXECUTION_PATHS, assertInvocationMatchesTransition, getExecutionPath } from './invocation-registry.mjs';
import { CREDENTIAL_CLASS_NAMES, credentialClassDefinition, PrivateCredentialLoader } from './credential-loader.mjs';
import { createVerificationRecordStore, makeTargetConfirmation, PROBE_DEFINITIONS, requireCredentialVerification, targetConfirmationDigest, verifyCredential } from './credential-verification.mjs';
import { buildChildEnvironment, requireSealedPreservationCheckpoint, resolveInvocation, runSupervisedInvocation, terminateActiveChildren, assertNoActiveChildren } from './launcher.mjs';
import { assertNoWildcardAllows, assertProofPolicyContainsDenies, policyDocumentDigest, readPolicyTemplate, renderAwsPolicySet, renderPolicyTemplate } from './policy-templates.mjs';

const LOCAL = 'http://127.0.0.1:19876';
const expiry = '2030-01-01T00:00:00.000Z';
const approvalNow = Date.parse('2026-10-18T00:00:00.000Z');

function fixtureManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: 'provider-proof-20261018-local-test',
    testOnly: true,
    allowLocalEmulator: true,
    activeSealDigest: 'local-seal-digest',
    sealChainVerified: true,
    policy: { version: 1, denyByDefault: true },
    approvalPolicy: { signaturesRequired: true, testFixture: true },
    bindings: {
      aws: {
        accountId: TARGETS.awsAccount,
        distributionId: 'E2PROOF20261018',
        preservedStateKey: 'aws-verify/terraform.tfstate',
      },
      cloudflare: {
        reviewed: true,
        accountId: TARGETS.cloudflareVerifyAccount,
        zoneId: 'zone-verify-20261018',
        zoneName: TARGETS.cloudflareVerifyZoneName,
        bucket: 'artifact-pages-stream-verify',
        backendBucket: 'artifact-pages-verify-state',
        stateKey: 'cloudflare-verify/terraform.tfstate',
      },
    },
    identities: {
      inventory: { roleArn: 'arn:aws:iam::231136241959:role/artifact-pages-verify' },
      preservation: { roleArn: 'arn:aws:iam::231136241959:role/artifact-pages-verify-readonly' },
      provisioning: { roleArn: 'arn:aws:iam::231136241959:role/ap-proof-20261018-test-operator' },
      proof: { roleArn: 'arn:aws:iam::231136241959:role/ap-proof-20261018-proof' },
      observer: { roleArn: 'arn:aws:iam::231136241959:role/ap-proof-20261018-observer' },
      cleanup: { roleArn: 'arn:aws:iam::231136241959:role/ap-proof-20261018-cleanup' },
      'cleanup-post-a7': { roleArn: 'arn:aws:iam::231136241959:role/ap-proof-20261018-cleanup' },
      'cleanup-final-a8': { roleArn: 'arn:aws:iam::231136241959:role/ap-proof-20261018-cleanup' },
      gzip: { roleArn: 'arn:aws:iam::231136241959:role/ap-proof-20261018-proof' },
      'lifecycle-owner': { roleArn: 'arn:aws:iam::231136241959:role/ap-proof-20261018-lifecycle-owner' },
    },
    lifecycle: {
      baseline: [{ id: 'existing-retention', enabled: true, conditions: { prefix: '_previews/' }, delete_objects_transition: { condition: { type: 'Age', max_age: 604800 } } }],
      addition: {
        id: 'proof-life-20261018-expire',
        enabled: true,
        conditions: { prefix: '_previews/proof-life-20261018/' },
        delete_objects_transition: { condition: { type: 'Age', max_age: 86400 } },
        abort_multipart_uploads_transition: { condition: { type: 'Age', max_age: 604800 } },
      },
      approvedAddPlanDigest: 'cf-life-add-plan-digest',
      approvedRestorePlanDigest: 'cf-life-restore-plan-digest',
      baselineDigest: 'cf-life-baseline-digest',
      currentDigest: 'cf-life-current-digest',
      expectedStateDigest: 'cf-life-state-digest',
      writerFreezeDigest: 'cf-writer-freeze-digest',
      terraformResourceAddress: 'cloudflare_r2_bucket_lifecycle.proof',
      terraformAddresses: ['cloudflare_r2_bucket_lifecycle.proof'],
      backendKeys: ['terraform/verify.tfstate', 'terraform/verify.tfstate.tflock'],
      stateKey: 'terraform/verify.tfstate',
    },
    reviewedDeltas: {
      'delivery:aws': { '_indexes/sites.json': 'aws-registry-delta', 'index.html': 'aws-app-delta' },
      'delivery:cloudflare': { '_indexes/sites.json': 'cf-registry-delta', 'index.html': 'cf-app-delta' },
      'failures:aws': {},
      'failures:cloudflare': {},
      'cleanup:post-a7': { '_indexes/sites.json': 'cf-post-a7-registry' },
      'cleanup:final-a8': { '_indexes/sites.json': 'cf-final-registry' },
    },
    reviewedInvalidationPaths: {
      'delivery:aws': ['/_indexes/sites.json', '/_artifacts/proof-a-20261018/index.json'],
      'delivery:cloudflare': ['/_indexes/sites.json', '/_artifacts/proof-a-20261018/index.json'],
      'failures:aws': ['/_indexes/proof-a-20261018/index.json'],
      'failures:cloudflare': ['/_indexes/proof-a-20261018/index.json'],
      gzip: ['/_indexes/proof-a-20261018/index.json'],
    },
    registryBaseline: { siteIds: ['existing-docs', 'existing-admin'] },
    approvedCreatePlanDigest: 'aws-create-plan-digest',
    approvedCreateAddresses: ['aws_s3_bucket.proof', 'aws_cloudfront_distribution.proof'],
    approvedDestroyPlanDigest: 'aws-destroy-plan-digest',
    createdResourceAddresses: ['aws_s3_bucket.proof', 'aws_cloudfront_distribution.proof', 'aws_iam_role.proof_operator'],
    approvedDestroyAddresses: ['aws_s3_bucket.proof', 'aws_cloudfront_distribution.proof', 'aws_iam_role.proof_operator'],
    caps: { requests: 20, bytes: 1000, operatorMinutes: 60 },
    ...overrides,
  };
}

function operation(service, action, resource, more = {}) {
  const method = more.method ?? ({
    HeadObject: 'HEAD',
    PutObject: 'PUT', DeleteObject: 'DELETE', DeleteObjects: 'POST', CopyObject: 'PUT', UpdateLifecycle: 'PUT',
    CreateInvalidation: 'POST', TerraformCreate: 'POST', TerraformDestroy: 'POST',
    PutStateObject: 'PUT', PutStateLock: 'PUT', DeleteStateLock: 'DELETE', DeleteStateObject: 'DELETE',
    GetCallerIdentity: 'POST',
  }[action] ?? 'GET');
  return {
    service,
    action,
    method,
    endpoint: LOCAL,
    localTest: true,
    resource,
    ...more,
  };
}

function fakeHarness(command, manifest = fixtureManifest(), options = {}) {
  let credentialLoads = 0;
  const outbound = [];
  const responses = options.responses ?? [];
  const capability = capabilityForLocalTest(command, manifest);
  const client = new GuardedTransport({
    capability,
    credentialLoader: async () => { credentialLoads += 1; return { fake: true }; },
    serializer: options.serializer,
    signer: options.signer,
    maxRetries: options.maxRetries ?? 0,
    transport: async (wire, authorizedOperation) => {
      outbound.push({ wire, operation: authorizedOperation });
      return responses.length ? responses.shift() : { status: 200, items: [], body: {} };
    },
  });
  return {
    client,
    get credentialLoads() { return credentialLoads; },
    outbound,
  };
}

async function makeSSHKey(root) {
  const privateKeyPath = path.join(root, 'owner-test-key');
  const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', privateKeyPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return { privateKeyPath, publicKey: (await readFile(`${privateKeyPath}.pub`, 'utf8')).trim() };
}

async function copyTestHarness(root, publicKey) {
  const source = path.resolve('scripts/provider-proof');
  const destination = path.join(root, 'harness');
  await cp(source, destination, { recursive: true, filter: (sourcePath) => !sourcePath.endsWith('proof.test.mjs') });
  await writeFile(path.join(destination, 'trust-anchor.json'), `${JSON.stringify({
    schemaVersion: 1,
    keyId: 'owner',
    algorithm: 'ssh-ed25519',
    status: 'enrolled',
    publicKey,
    fingerprint: fingerprintKey(publicKey),
  }, null, 2)}\n`);
  return destination;
}

async function sshSign(privateKeyPath, payloadPath, namespace = 'artifact-pages-provider-proof') {
  const result = spawnSync('ssh-keygen', ['-Y', 'sign', '-f', privateKeyPath, '-n', namespace, payloadPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return readFile(`${payloadPath}.sig`);
}

async function copiedModule(harnessPath, filename) {
  return import(pathToFileURL(path.join(harnessPath, filename)).href);
}

async function assertDeniedBeforeCredential(harness, op, code) {
  await assert.rejects(harness.client.request(op), (error) => error instanceof AuthorizationError && error.code === code);
  assert.equal(harness.credentialLoads, 0, 'denied operation must not load credentials');
  assert.equal(harness.outbound.length, 0, 'denied operation must not send a request');
}

function preservedAwsGet() {
  return operation('aws-s3', 'GetObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.preservedAwsBucket }, { key: '_indexes/existing/index.json' });
}

function proofAwsPut(key = '_artifacts/proof-a-20261018/index.html', extra = {}) {
  return operation('aws-s3', 'PutObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { key, payload: { sha256: 'a'.repeat(64) }, ...extra });
}

function proofCloudflareRead(key = '_indexes/proof-a-20261018/index.json', more = {}) {
  return operation('cloudflare-s3', 'GetObject', {
    accountId: TARGETS.cloudflareVerifyAccount,
    zoneId: 'zone-verify-20261018',
    bucket: 'artifact-pages-stream-verify',
  }, { key, ...more });
}

test('the phase table is explicit and phase positive controls are local only', async () => {
  const discovery = fakeHarness('inventory');
  await discovery.client.request(operation('cloudflare-discovery', 'GetZoneMetadata', {
    accountId: TARGETS.cloudflareVerifyAccount,
    zoneName: TARGETS.cloudflareVerifyZoneName,
  }));
  assert.equal(discovery.outbound.length, 1);

  const awsInventory = fakeHarness('inventory');
  await awsInventory.client.request(preservedAwsGet());
  await awsInventory.client.request(operation('aws-s3', 'HeadBucket', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { method: 'HEAD' }));
  assert.equal(awsInventory.outbound.length, 2);

  const provisioning = fakeHarness('bootstrap-aws');
  await provisioning.client.request(operation('terraform', 'TerraformCreate', { accountId: TARGETS.awsAccount, stack: 'new-aws-proof', planDigest: 'aws-create-plan-digest', addresses: ['aws_s3_bucket.proof', 'aws_cloudfront_distribution.proof'] }, { method: 'POST' }));
  assert.equal(provisioning.outbound.length, 1);

  const awsA5 = fakeHarness('delivery:aws');
  await awsA5.client.request(proofAwsPut());
  assert.equal(awsA5.outbound.length, 1);
  await assertDeniedBeforeCredential(fakeHarness('delivery:aws'), proofAwsPut('_previews/proof-life-20261018/head/manifest.json'), 'OBJECT_KEY_DENIED');

  const cfA6 = fakeHarness('delivery:cloudflare');
  await cfA6.client.request(operation('cloudflare-s3', 'PutObject', {
    accountId: TARGETS.cloudflareVerifyAccount, zoneId: 'zone-verify-20261018', bucket: 'artifact-pages-stream-verify',
  }, { key: '_artifacts/proof-a-20261018/index.html', payload: { sha256: 'b'.repeat(64) } }));
  assert.equal(cfA6.outbound.length, 1);

  const cfCache = fakeHarness('delivery:cloudflare');
  await cfCache.client.request(operation('cloudflare-cache', 'CreateInvalidation', {
    accountId: TARGETS.cloudflareVerifyAccount, zoneId: 'zone-verify-20261018',
  }, { method: 'POST', payload: { paths: ['/_indexes/sites.json'] } }));
  assert.equal(cfCache.outbound.length, 1);

  const a7 = fakeHarness('failures:aws');
  await a7.client.request(operation('aws-s3', 'GetObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { key: '_indexes/proof-a-20261018/index.json' }));
  await a7.client.request(operation('aws-s3', 'ListObjectsV2', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { prefix: '_indexes/proof-a-20261018/' }));
  assert.equal(a7.outbound.length, 2);

  const a8Setup = fakeHarness('lifecycle:aws:setup');
  await a8Setup.client.request(proofAwsPut('_previews/proof-life-20261018/0123456789abcdef/manifest.json'));
  assert.equal(a8Setup.outbound.length, 1);
  await assertDeniedBeforeCredential(fakeHarness('lifecycle:aws:setup'), proofAwsPut('_indexes/proof-a-20261018/index.json'), 'OBJECT_KEY_DENIED');

  const a8Observe = fakeHarness('lifecycle:aws:observe-only');
  await a8Observe.client.request(operation('aws-s3', 'HeadObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { key: '_previews/proof-life-20261018/0123456789abcdef/manifest.json' }));
  await a8Observe.client.request(operation('aws-s3', 'ListObjectVersions', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { prefix: '_previews/proof-life-20261018/' }));
  assert.equal(a8Observe.outbound.length, 2);

  const cfObserve = fakeHarness('lifecycle:cloudflare:observe-only');
  await cfObserve.client.request(operation('cloudflare-s3', 'ListObjectsV2', {
    accountId: TARGETS.cloudflareVerifyAccount, zoneId: 'zone-verify-20261018', bucket: 'artifact-pages-stream-verify',
  }, { prefix: '_previews/proof-life-20261018/' }));
  assert.equal(cfObserve.outbound.length, 1);

  const a8ReconcileManifest = fixtureManifest({ lifecycle: { ...fixtureManifest().lifecycle, observationStartedAt: '2026-10-18T00:00:00Z', observationClosedAt: '2026-10-18T02:00:00Z', observationOutcome: 'complete' } });
  const a8Reconcile = fakeHarness('lifecycle:aws:reconcile', a8ReconcileManifest);
  await a8Reconcile.client.request(operation('aws-s3', 'DeleteObjects', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { payload: { keys: ['_previews/proof-life-20261018/0123456789abcdef/manifest.json'] } }));
  assert.equal(a8Reconcile.outbound.length, 1);

  const a9 = fakeHarness('gzip');
  await a9.client.request(operation('aws-s3', 'PutObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { key: '_indexes/proof-a-20261018/index.json', payload: { contentEncoding: 'gzip', sha256: 'c'.repeat(64) } }));
  assert.equal(a9.outbound.length, 1);
  await assertDeniedBeforeCredential(fakeHarness('gzip'), operation('aws-s3', 'PutObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, {
    key: '_previews/proof-life-20261018/head/manifest.json', payload: { contentEncoding: 'gzip' },
  }), 'OBJECT_KEY_DENIED');

  const finalSnapshot = fakeHarness('preserve:checkpoint');
  await finalSnapshot.client.request(preservedAwsGet());
  assert.equal(finalSnapshot.outbound.length, 1);

  const postA7Manifest = fixtureManifest({ approvalState: { A7: { expiresAt: expiry } } });
  const postA7 = fakeHarness('cleanup:post-a7', postA7Manifest);
  await postA7.client.request(operation('aws-s3', 'DeleteObjects', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, {
    payload: { keys: ['_indexes/proof-a-20261018/index.json', '_indexes/proof-neighbor-20261018/index.json'] },
  }));
  await postA7.client.request(operation('aws-s3', 'PutObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, {
    key: '_indexes/sites.json',
    payload: { deltaDigest: 'cf-post-a7-registry', registrySiteIds: ['existing-docs', 'existing-admin', TARGETS.lifeSite] },
  }));
  assert.equal(postA7.outbound.length, 2);
  await assertDeniedBeforeCredential(fakeHarness('cleanup:post-a7', postA7Manifest), operation('aws-s3', 'PutObject', {
    accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket,
  }, { key: '_indexes/sites.json', payload: {
    deltaDigest: 'cf-post-a7-registry',
    registrySiteIds: ['existing-docs', 'existing-admin', TARGETS.lifeSite, TARGETS.proofSites[0]],
  } }), 'POST_A7_REGISTRATION_REMAINS');

  const finalA8Manifest = fixtureManifest({
    lifecycle: { ...fixtureManifest().lifecycle, observationClosedAt: '2026-10-18T03:00:00Z', observationOutcome: 'complete' },
    a9Status: 'not-run',
    cleanup: {
      acceptedDestroyPlanDigest: 'aws-destroy-plan-digest',
      cfLifecycleRestored: true,
      writerVersion: '0.5.0',
      requiredWriterRange: '>=0.5.0 <0.6.0',
    },
  });
  const finalA8 = fakeHarness('cleanup:final-a8', finalA8Manifest);
  await finalA8.client.request(operation('cloudflare-s3', 'PutObject', {
    accountId: TARGETS.cloudflareVerifyAccount, zoneId: 'zone-verify-20261018', bucket: 'artifact-pages-stream-verify',
  }, { key: '_indexes/sites.json', payload: {
    deltaDigest: 'cf-final-registry', registrySiteIds: ['existing-docs', 'existing-admin'],
  } }));
  await finalA8.client.request(operation('terraform', 'TerraformDestroy', {
    accountId: TARGETS.awsAccount, stack: 'new-aws-proof', planDigest: 'aws-destroy-plan-digest',
    addresses: ['aws_s3_bucket.proof', 'aws_cloudfront_distribution.proof', 'aws_iam_role.proof_operator'],
  }, { method: 'POST' }));
  assert.equal(finalA8.outbound.length, 2);
  await assertDeniedBeforeCredential(fakeHarness('cleanup:final-a8', finalA8Manifest), operation('terraform', 'TerraformDestroy', {
    accountId: TARGETS.awsAccount, stack: 'new-aws-proof', planDigest: 'aws-destroy-plan-digest',
    addresses: ['aws_s3_bucket.proof', 'aws_cloudfront_distribution.proof'],
  }, { method: 'POST' }), 'DESTROY_PLAN_NOT_ACCEPTED');
  await assertDeniedBeforeCredential(fakeHarness('cleanup:final-a8', finalA8Manifest), operation('cloudflare-s3', 'PutObject', {
    accountId: TARGETS.cloudflareVerifyAccount, zoneId: 'zone-verify-20261018', bucket: 'artifact-pages-stream-verify',
  }, { key: '_indexes/sites.json', payload: {
    deltaDigest: 'cf-final-registry', registrySiteIds: ['existing-docs', 'existing-admin', TARGETS.lifeSite],
  } }), 'FINAL_A8_PROOF_REGISTRATION_REMAINS');
});

test('proof contexts refuse preserved AWS GET, PUT, DELETE, and invalidation before credentials or requests', async () => {
  const commands = ['delivery:aws', 'delivery:cloudflare', 'failures:aws', 'lifecycle:aws:observe-only', 'gzip'];
  const preserved = [
    preservedAwsGet(),
    operation('aws-s3', 'PutObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.preservedAwsBucket }, { key: '_artifacts/x', payload: {} }),
    operation('aws-s3', 'DeleteObjects', { accountId: TARGETS.awsAccount, bucket: TARGETS.preservedAwsBucket }, { payload: { keys: ['_artifacts/x'] } }),
    operation('aws-cloudfront', 'CreateInvalidation', { accountId: TARGETS.awsAccount, distributionId: TARGETS.preservedAwsDistribution }, { payload: { paths: ['/index.html'] }, method: 'POST' }),
  ];
  for (const command of commands) {
    for (const op of preserved) {
      const harness = fakeHarness(command);
      await assert.rejects(harness.client.request(op), (error) => error instanceof AuthorizationError && error.code === 'PRESERVED_RESOURCE_DENIED_TO_PROOF');
      assert.equal(harness.credentialLoads, 0);
      assert.equal(harness.outbound.length, 0);
    }
  }
});

test('inventory allows only enumerated reads, rejects mutations and unrelated resources with zero requests', async () => {
  const allowed = fakeHarness('inventory');
  await allowed.client.request(operation('aws-query', 'GetBucketLifecycleConfiguration', { accountId: TARGETS.awsAccount, bucket: TARGETS.preservedAwsBucket }, { method: 'POST', payload: { Action: 'GetBucketLifecycleConfiguration', Bucket: TARGETS.preservedAwsBucket } }));
  assert.equal(allowed.outbound.length, 1);

  const denied = [
    operation('aws-s3', 'PutObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.preservedAwsBucket }, { key: '_artifacts/x', payload: {} }),
    operation('aws-query', 'PutBucketLifecycleConfiguration', { accountId: TARGETS.awsAccount, bucket: TARGETS.preservedAwsBucket }, { method: 'POST', payload: { Action: 'PutBucketLifecycleConfiguration' } }),
    operation('aws-query', 'GetBucketLifecycleConfiguration', { accountId: TARGETS.awsAccount, bucket: TARGETS.preservedAwsBucket }, { method: 'POST', payload: { Action: 'PutBucketLifecycleConfiguration', Bucket: TARGETS.preservedAwsBucket } }),
    operation('aws-query', 'GetBucketLifecycleConfiguration', { accountId: TARGETS.awsAccount, bucket: TARGETS.preservedAwsBucket }, { method: 'POST', payload: { Action: 'GetBucketLifecycleConfiguration', Bucket: 'other-bucket' } }),
    operation('aws-cloudfront', 'CreateInvalidation', { accountId: TARGETS.awsAccount, distributionId: TARGETS.preservedAwsDistribution }, { method: 'POST', payload: { paths: ['/'] } }),
    operation('aws-s3', 'RunInstances', { accountId: TARGETS.awsAccount, bucket: TARGETS.preservedAwsBucket }),
    operation('aws-s3', 'GetDistribution', { accountId: TARGETS.awsAccount, bucket: TARGETS.preservedAwsBucket }, { method: 'GET' }),
    operation('aws-s3', 'GetObject', { accountId: TARGETS.awsAccount, bucket: 'unrelated-bucket' }, { key: 'x' }),
    operation('aws-query', 'PutObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.preservedAwsBucket }, { method: 'POST', payload: { Action: 'PutObject' } }),
  ];
  const expectedCodes = ['INVENTORY_OPERATION_DENIED', 'UNKNOWN_OPERATION', 'UNKNOWN_OPERATION', 'UNKNOWN_OPERATION', 'INVENTORY_OPERATION_DENIED', 'UNKNOWN_OPERATION', 'UNKNOWN_OPERATION', 'TARGET_NOT_ALLOWED', 'UNKNOWN_OPERATION'];
  for (const [index, op] of denied.entries()) await assertDeniedBeforeCredential(fakeHarness('inventory'), op, expectedCodes[index]);
});

test('Cloudflare discovery is metadata only until a single reviewed binding exists', async () => {
  const unbound = fixtureManifest({ bindings: { ...fixtureManifest().bindings, cloudflare: { zoneName: TARGETS.cloudflareVerifyZoneName, reviewed: false } } });
  const harness = fakeHarness('inventory', unbound);
  await harness.client.request(operation('cloudflare-discovery', 'GetZoneMetadata', { accountId: TARGETS.cloudflareVerifyAccount, zoneName: TARGETS.cloudflareVerifyZoneName }));
  await harness.client.request(operation('cloudflare-api', 'GetBucketMetadata', { accountId: TARGETS.cloudflareVerifyAccount, discovery: true }));
  assert.equal(harness.outbound.length, 2);
  const bucketRead = proofCloudflareRead();
  const denied = fakeHarness('inventory', unbound);
  await assertDeniedBeforeCredential(denied, bucketRead, 'DISCOVERY_BINDING_REVIEW_REQUIRED');
  await assertDeniedBeforeCredential(fakeHarness('inventory', unbound), operation('cloudflare-api', 'GetLifecycle', {
    accountId: TARGETS.cloudflareVerifyAccount, zoneId: 'zone-verify-20261018', bucket: 'artifact-pages-stream-verify',
  }), 'DISCOVERY_BINDING_REVIEW_REQUIRED');
  assert.throws(() => validateDiscoveryCandidates({ candidates: [{ accountId: TARGETS.cloudflareVerifyAccount, zoneName: TARGETS.cloudflareVerifyZoneName, zoneId: 'z1', bucket: 'b1' }, { accountId: TARGETS.cloudflareVerifyAccount, zoneName: TARGETS.cloudflareVerifyZoneName, zoneId: 'z2', bucket: 'b2' }], approvedAccountId: TARGETS.cloudflareVerifyAccount }), /DISCOVERY_CANDIDATE_AMBIGUOUS/);
  assert.throws(() => validateDiscoveryCandidates({ candidates: [{ accountId: TARGETS.cloudflareProductionAccount, zoneName: TARGETS.cloudflareVerifyZoneName, zoneId: 'z1', bucket: 'b1' }], approvedAccountId: TARGETS.cloudflareVerifyAccount }), /DISCOVERY_CANDIDATE_NOT_BINDABLE/);
  const trustedBinding = {
    ownerReviewed: true,
    provenance: 'verification-root+state+delivery-config',
    zoneId: 'z1', bucket: 'b1', endpoint: 'https://r2.example.invalid', hostname: 'proof.example.invalid',
    backendBucket: 'state-verify', backendKey: 'terraform/verify.tfstate', configDigest: 'c'.repeat(64),
    stateLineage: 'lineage', reviewedSealDigest: 'seal',
  };
  assert.throws(() => validateDiscoveryCandidates({ candidates: [{ accountId: TARGETS.cloudflareVerifyAccount, zoneName: TARGETS.cloudflareVerifyZoneName, zoneId: 'z1', bucket: 'b1' }], approvedAccountId: TARGETS.cloudflareVerifyAccount }), /TRUSTED_DISCOVERY_BINDING_REQUIRED/);
  assert.equal(validateDiscoveryCandidates({ candidates: [{ accountId: TARGETS.cloudflareVerifyAccount, zoneName: TARGETS.cloudflareVerifyZoneName, zoneId: 'z1', bucket: 'b1' }], approvedAccountId: TARGETS.cloudflareVerifyAccount, trustedBinding }).bucket, 'b1');

  const boundInventory = fakeHarness('inventory');
  await boundInventory.client.request(operation('cloudflare-api', 'GetLifecycle', {
    accountId: TARGETS.cloudflareVerifyAccount, zoneId: 'zone-verify-20261018', bucket: 'artifact-pages-stream-verify',
  }));
  assert.equal(boundInventory.outbound.length, 1);
});

test('preservation capability cannot become proof or mutate resources', async () => {
  const preserve = fakeHarness('preserve:checkpoint');
  await preserve.client.request(preservedAwsGet());
  const denied = fakeHarness('preserve:checkpoint');
  await assertDeniedBeforeCredential(denied, operation('aws-s3', 'DeleteObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.preservedAwsBucket }, { key: '_artifacts/existing/a' }), 'PRESERVATION_READ_ONLY_DENIED');
  assert.equal(capabilityForLocalTest('preserve:checkpoint', fixtureManifest()).context, 'preservation');
  assert.throws(() => capabilityForLocalTest('delivery:aws', { testOnly: false, allowLocalEmulator: true }), /LOCAL_TEST_CAPABILITY_REQUIRES_TEST_FIXTURE/);
  assert.throws(() => resolveCommandCapability('proof:preservation', { testOnly: false, activeSealDigest: 's', sealChainVerified: true }, null), /UNKNOWN_COMMAND/);
  const cfPreserve = fakeHarness('preserve:checkpoint');
  await cfPreserve.client.request(operation('cloudflare-api', 'GetLifecycle', {
    accountId: TARGETS.cloudflareVerifyAccount, zoneId: 'zone-verify-20261018', bucket: 'artifact-pages-stream-verify',
  }));
  const cfPreserveMutation = fakeHarness('preserve:checkpoint');
  await assertDeniedBeforeCredential(cfPreserveMutation, operation('cloudflare-api', 'UpdateLifecycle', {
    accountId: TARGETS.cloudflareVerifyAccount, zoneId: 'zone-verify-20261018', bucket: 'artifact-pages-stream-verify',
  }, { method: 'PUT', payload: [] }), 'PRESERVATION_READ_ONLY_DENIED');
});

test('A6 and A7 reject Cloudflare lifecycle changes; A8 owner permits only exact add/restore transactions', async () => {
  const manifest = fixtureManifest();
  const lifecycleOp = (command, planDigest, payload = manifest.lifecycle.baseline, extra = {}) => operation('cloudflare-api', 'UpdateLifecycle', {
    accountId: TARGETS.cloudflareVerifyAccount, zoneId: 'zone-verify-20261018', bucket: 'artifact-pages-stream-verify',
  }, {
    method: 'PUT', planDigest, payload, baselineDigest: manifest.lifecycle.baselineDigest,
    stateDigest: manifest.lifecycle.expectedStateDigest,
    viaTerraform: true,
    resourceAddress: manifest.lifecycle.terraformResourceAddress,
    planAddresses: manifest.lifecycle.terraformAddresses,
    liveCheck: {
      lockHeld: true,
      lifecycleDigest: planDigest === manifest.lifecycle.approvedRestorePlanDigest ? manifest.lifecycle.currentDigest : manifest.lifecycle.baselineDigest,
      stateDigest: manifest.lifecycle.expectedStateDigest,
      writerFreezeDigest: manifest.lifecycle.writerFreezeDigest,
    },
    ...extra,
  });
  await assertDeniedBeforeCredential(fakeHarness('delivery:cloudflare', manifest), lifecycleOp('delivery:cloudflare', 'cf-life-add-plan-digest', [...manifest.lifecycle.baseline, manifest.lifecycle.addition]), 'SITE_OPERATION_DENIED');
  await assertDeniedBeforeCredential(fakeHarness('failures:cloudflare', manifest), lifecycleOp('failures:cloudflare', 'cf-life-add-plan-digest', [...manifest.lifecycle.baseline, manifest.lifecycle.addition]), 'SITE_OPERATION_DENIED');

  const setup = fakeHarness('lifecycle:cloudflare:setup', manifest);
  await setup.client.request(lifecycleOp('lifecycle:cloudflare:setup', 'cf-life-add-plan-digest', [...manifest.lifecycle.baseline, manifest.lifecycle.addition]));
  assert.equal(setup.outbound.length, 1);

  const terraformApply = fakeHarness('lifecycle:cloudflare:setup', manifest);
  await terraformApply.client.request(operation('terraform', 'TerraformCreate', {
    accountId: TARGETS.cloudflareVerifyAccount, stack: 'cloudflare-lifecycle',
    planDigest: 'cf-life-add-plan-digest', addresses: ['cloudflare_r2_bucket_lifecycle.proof'],
  }, { method: 'POST' }));
  assert.equal(terraformApply.outbound.length, 1);

  const invalid = [
    lifecycleOp('lifecycle:cloudflare:setup', 'cf-life-add-plan-digest', [...manifest.lifecycle.baseline, { ...manifest.lifecycle.addition, conditions: { prefix: '_previews/' } }]),
    lifecycleOp('lifecycle:cloudflare:setup', 'wrong-hash', [...manifest.lifecycle.baseline, manifest.lifecycle.addition]),
    lifecycleOp('lifecycle:cloudflare:setup', 'cf-life-add-plan-digest', [...manifest.lifecycle.baseline, manifest.lifecycle.addition], { baselineDigest: 'stale' }),
    lifecycleOp('lifecycle:cloudflare:setup', 'cf-life-add-plan-digest', [...manifest.lifecycle.baseline, manifest.lifecycle.addition], { stateDigest: 'stale' }),
    lifecycleOp('lifecycle:cloudflare:setup', 'cf-life-add-plan-digest', [...manifest.lifecycle.baseline, manifest.lifecycle.addition], { viaTerraform: false }),
    lifecycleOp('lifecycle:cloudflare:setup', 'cf-life-add-plan-digest', [...manifest.lifecycle.baseline, manifest.lifecycle.addition], {
      liveCheck: { ...lifecycleOp('lifecycle:cloudflare:setup', 'cf-life-add-plan-digest').liveCheck, lockHeld: false },
    }),
    operation('cloudflare-api', 'UpdateLifecycle', { accountId: TARGETS.cloudflareVerifyAccount, zoneId: 'zone-verify-20261018', bucket: 'wrong-bucket' }, { method: 'PUT', planDigest: 'cf-life-add-plan-digest', payload: [...manifest.lifecycle.baseline, manifest.lifecycle.addition] }),
    operation('terraform', 'TerraformCreate', { accountId: TARGETS.cloudflareVerifyAccount, stack: 'cloudflare-lifecycle', planDigest: 'wrong-hash', addresses: ['cloudflare_r2_bucket_lifecycle.proof'] }, { method: 'POST' }),
  ];
  for (const op of invalid) {
    const harness = fakeHarness('lifecycle:cloudflare:setup', manifest);
    await assert.rejects(harness.client.request(op));
    assert.equal(harness.credentialLoads, 0);
    assert.equal(harness.outbound.length, 0);
  }
  const duplicate = [...manifest.lifecycle.baseline, manifest.lifecycle.addition, { ...manifest.lifecycle.addition }];
  assert.throws(() => validateLifecycleChange(duplicate, manifest.lifecycle.baseline, manifest.lifecycle.addition), /DUPLICATE_OR_INVALID_LIFECYCLE_ID/);
  const altered = [...manifest.lifecycle.baseline.map((rule) => ({ ...rule, enabled: false })), manifest.lifecycle.addition];
  assert.throws(() => validateLifecycleChange(altered, manifest.lifecycle.baseline, manifest.lifecycle.addition), /LIFECYCLE_UNRELATED_RULE_CHANGED/);

  const premature = fakeHarness('lifecycle:cloudflare:reconcile', manifest);
  const restoreRules = manifest.lifecycle.baseline;
  await assertDeniedBeforeCredential(premature, lifecycleOp('lifecycle:cloudflare:reconcile', 'cf-life-restore-plan-digest', restoreRules, { baselineDigest: 'cf-life-current-digest' }), 'PREMATURE_LIFECYCLE_RESTORATION');
  const closed = fixtureManifest({ lifecycle: { ...manifest.lifecycle, observationClosedAt: '2026-10-18T03:00:00Z', observationOutcome: 'complete' } });
  const restoration = fakeHarness('lifecycle:cloudflare:reconcile', closed);
  await restoration.client.request(lifecycleOp('lifecycle:cloudflare:reconcile', 'cf-life-restore-plan-digest', restoreRules, { baselineDigest: closed.lifecycle.currentDigest }));
  assert.equal(restoration.outbound.length, 1);
  const changedAfterClose = fakeHarness('lifecycle:cloudflare:reconcile', closed);
  await assertDeniedBeforeCredential(changedAfterClose, lifecycleOp('lifecycle:cloudflare:reconcile', 'cf-life-restore-plan-digest', [{ id: 'unexpected', enabled: true }], { baselineDigest: closed.lifecycle.currentDigest }), 'LIFECYCLE_RESTORE_DRIFT');
});

test('lifecycle backend access is confined to the reviewed bucket and exact state/lock keys', async () => {
  const permitted = fakeHarness('lifecycle:cloudflare:setup');
  await permitted.client.request(operation('state', 'PutStateLock', { backend: 'cloudflare-verify', backendBucket: 'artifact-pages-verify-state', key: 'terraform/verify.tfstate.tflock' }, { method: 'PUT', payload: {} }));
  assert.equal(permitted.outbound.length, 1);
  const denied = [
    operation('state', 'PutStateLock', { backend: 'cloudflare-verify', backendBucket: 'other', key: 'terraform/verify.tfstate.tflock' }, { method: 'PUT', payload: {} }),
    operation('state', 'PutStateObject', { backend: 'cloudflare-verify', backendBucket: 'artifact-pages-verify-state', key: 'other.tfstate' }, { method: 'PUT', payload: {} }),
    operation('state', 'PutStateObject', { backend: 'cloudflare-verify', backendBucket: 'artifact-pages-verify-state', key: 'terraform/verify.tfstate', migration: true }, { method: 'PUT', payload: {} }),
    operation('state', 'DeleteStateObject', { backend: 'cloudflare-verify', backendBucket: 'artifact-pages-verify-state', key: 'terraform/verify.tfstate' }, { method: 'DELETE' }),
    operation('terraform', 'TerraformDestroy', { accountId: TARGETS.cloudflareVerifyAccount, stack: 'cloudflare-lifecycle', deleteLifecycleResource: true }, { method: 'POST' }),
  ];
  for (const op of denied) await assert.rejects(fakeHarness('lifecycle:cloudflare:setup').client.request(op));
});

test('post-apply distribution binding rejects unknown, substituted, wrong-address, wrong-account, partial, or preserved IDs', () => {
  assert.throws(() => validateDistributionBinding({ address: 'aws_cloudfront_distribution.other', expectedAddress: TARGETS.proofAwsDistributionAddress, accountId: TARGETS.awsAccount, expectedAccountId: TARGETS.awsAccount, distributionId: 'E2PROOF', outputs: { distributionId: 'E2PROOF', resourceAddress: TARGETS.proofAwsDistributionAddress } }), /DISTRIBUTION_BINDING_MISMATCH/);
  assert.throws(() => validateDistributionBinding({ address: TARGETS.proofAwsDistributionAddress, expectedAddress: TARGETS.proofAwsDistributionAddress, accountId: '999999999999', expectedAccountId: TARGETS.awsAccount, distributionId: 'E2PROOF', outputs: { distributionId: 'E2PROOF', resourceAddress: TARGETS.proofAwsDistributionAddress } }), /DISTRIBUTION_BINDING_MISMATCH/);
  assert.throws(() => validateDistributionBinding({ address: TARGETS.proofAwsDistributionAddress, expectedAddress: TARGETS.proofAwsDistributionAddress, accountId: TARGETS.awsAccount, expectedAccountId: TARGETS.awsAccount, distributionId: 'E2PROOF', outputs: { distributionId: 'E2OTHER', resourceAddress: TARGETS.proofAwsDistributionAddress } }), /DISTRIBUTION_OUTPUT_SUBSTITUTION/);
  assert.throws(() => validateDistributionBinding({ address: TARGETS.proofAwsDistributionAddress, expectedAddress: TARGETS.proofAwsDistributionAddress, accountId: TARGETS.awsAccount, expectedAccountId: TARGETS.awsAccount, distributionId: 'E2PROOF', outputs: { distributionId: 'E2PROOF', resourceAddress: 'aws_cloudfront_distribution.other' }, partialApply: true }), /PARTIAL_APPLY_REQUIRES_RECOVERY_REVIEW/);
  assert.throws(() => validateDistributionBinding({ address: TARGETS.proofAwsDistributionAddress, expectedAddress: TARGETS.proofAwsDistributionAddress, accountId: TARGETS.awsAccount, expectedAccountId: TARGETS.awsAccount, distributionId: TARGETS.preservedAwsDistribution, outputs: { distributionId: TARGETS.preservedAwsDistribution, preservedDistributionId: TARGETS.preservedAwsDistribution, resourceAddress: TARGETS.proofAwsDistributionAddress } }), /PRESERVED_DISTRIBUTION_SUBSTITUTION/);
  assert.throws(() => validateDistributionBinding({ address: TARGETS.proofAwsDistributionAddress, expectedAddress: TARGETS.proofAwsDistributionAddress, accountId: TARGETS.awsAccount, expectedAccountId: TARGETS.awsAccount, distributionId: 'E2UNKNOWN', outputs: { distributionId: 'E2UNKNOWN', resourceAddress: TARGETS.proofAwsDistributionAddress }, partialApply: true }), /PARTIAL_APPLY_REQUIRES_RECOVERY_REVIEW/);
});

test('an unknown distribution is unusable before binding; the bound proof distribution is a positive control', async () => {
  const unbound = fixtureManifest({ bindings: { ...fixtureManifest().bindings, aws: { accountId: TARGETS.awsAccount } } });
  const unknown = operation('aws-cloudfront', 'CreateInvalidation', { accountId: TARGETS.awsAccount, distributionId: 'E2UNKNOWN' }, { method: 'POST', payload: { paths: ['/_indexes/proof-a-20261018/index.json'] } });
  await assertDeniedBeforeCredential(fakeHarness('delivery:aws', unbound), unknown, 'TARGET_NOT_ALLOWED');
  const allowed = fakeHarness('delivery:aws');
  await allowed.client.request(operation('aws-cloudfront', 'CreateInvalidation', { accountId: TARGETS.awsAccount, distributionId: 'E2PROOF20261018' }, { method: 'POST', payload: { paths: ['/_indexes/sites.json'] } }));
  assert.equal(allowed.outbound.length, 1);
  const deniedPath = fakeHarness('delivery:aws');
  await assertDeniedBeforeCredential(deniedPath, operation('aws-cloudfront', 'CreateInvalidation', { accountId: TARGETS.awsAccount, distributionId: 'E2PROOF20261018' }, { method: 'POST', payload: { paths: ['/_artifacts/proof-b-20261018/index.html'] } }), 'INVALIDATION_PATH_NOT_REVIEWED');
  const a7LifeManifest = fixtureManifest({ reviewedInvalidationPaths: { ...fixtureManifest().reviewedInvalidationPaths, 'failures:aws': ['/_indexes/proof-life-20261018/index.json'] } });
  await assertDeniedBeforeCredential(fakeHarness('failures:aws', a7LifeManifest), operation('aws-cloudfront', 'CreateInvalidation', {
    accountId: TARGETS.awsAccount, distributionId: 'E2PROOF20261018',
  }, { method: 'POST', payload: { paths: ['/_indexes/proof-life-20261018/index.json'] } }), 'LIFE_FROZEN_OR_CLEANUP_GATED');
  const unrelatedSiteManifest = fixtureManifest({ reviewedInvalidationPaths: { ...fixtureManifest().reviewedInvalidationPaths, 'delivery:aws': ['/_indexes/proof-evil-20261018/index.json'] } });
  await assertDeniedBeforeCredential(fakeHarness('delivery:aws', unrelatedSiteManifest), operation('aws-cloudfront', 'CreateInvalidation', {
    accountId: TARGETS.awsAccount, distributionId: 'E2PROOF20261018',
  }, { method: 'POST', payload: { paths: ['/_indexes/proof-evil-20261018/index.json'] } }), 'INVALIDATION_PATH_DENIED');
});

test('malicious config, smoke overrides, inherited credential fallbacks, and alternate addressing fail closed', async () => {
  assert.throws(() => validateEffectiveConfig({ provider: 'aws', aws: { bucket: TARGETS.preservedAwsBucket } }, { provider: 'aws', target: TARGETS.proofAwsBucket }), /CONFIG_TARGET_MISMATCH/);
  assert.throws(() => validateEffectiveConfig({ provider: 'aws', aws: { bucket: TARGETS.proofAwsBucket, endpointOverride: 'https://evil.invalid' } }, { provider: 'aws', target: TARGETS.proofAwsBucket }), /AWS_ALTERNATE_ADDRESSING_DENIED/);
  assert.throws(() => validateChildEnvironment({ AWS_PROFILE: 'artifact-pages-verify' }), /INHERITED_CREDENTIAL_FALLBACK/);
  assert.throws(() => validateChildEnvironment({ AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/token' }), /INHERITED_CREDENTIAL_FALLBACK/);
  assert.throws(() => validateChildEnvironment({ ARTIFACT_PAGES_PROOF_BUCKET_OVERRIDE: TARGETS.preservedAwsBucket }), /SMOKE_BUCKET_OVERRIDE_DENIED/);
  const alternate = fakeHarness('delivery:aws');
  await assertDeniedBeforeCredential(alternate, { ...proofAwsPut(), endpoint: 'https://s3.eu-west-1.amazonaws.com' }, 'ENDPOINT_MISMATCH');
  const alias = fakeHarness('delivery:aws');
  await assertDeniedBeforeCredential(alias, { ...proofAwsPut(), addressingAlias: true }, 'UNSEALED_ENDPOINT');
  const userInfoLoopback = fakeHarness('delivery:aws');
  await assertDeniedBeforeCredential(userInfoLoopback, { ...proofAwsPut(), endpoint: 'http://127.0.0.1:19876@evil.invalid' }, 'ENDPOINT_MISMATCH');
});

test('redirects stop before a second dispatch; retries preserve original requests and reauthorize each attempt', async () => {
  const redirect = fakeHarness('delivery:aws', fixtureManifest(), { responses: [{ status: 302, headers: { location: 'https://unrelated.invalid/_artifacts/proof-a-20261018/index.html' } }] });
  await assert.rejects(redirect.client.request(operation('aws-s3', 'GetObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { key: '_artifacts/proof-a-20261018/index.html' })), /UPSTREAM_REDIRECT_REJECTED/);
  assert.equal(redirect.credentialLoads, 1);
  assert.equal(redirect.outbound.length, 1, 'redirect responses are rejected without a second request');
  assert.equal(redirect.outbound.some(({ operation: op }) => op.endpoint.includes('unrelated.invalid')), false);
  const redirectWithoutLocation = fakeHarness('delivery:aws', fixtureManifest(), { responses: [{ status: 301 }] });
  await assert.rejects(redirectWithoutLocation.client.request(operation('aws-s3', 'GetObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { key: '_artifacts/proof-a-20261018/index.html' })), /UPSTREAM_REDIRECT_REJECTED/);
  assert.equal(redirectWithoutLocation.outbound.length, 1);

  const original = operation('aws-s3', 'GetObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { key: '_indexes/proof-a-20261018/index.json' });
  const proposedTarget = operation('aws-s3', 'GetObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { key: '_artifacts/proof-a-20261018/index.html' });
  const retry = fakeHarness('delivery:aws', fixtureManifest(), { maxRetries: 1, responses: [
    { status: 503, retryable: true, retryOperation: proposedTarget },
    { status: 200 },
  ] });
  const result = await retry.client.request(original);
  assert.equal(result.status, 200);
  assert.equal(retry.credentialLoads, 2, 'each retry gets a fresh authorization and credential load');
  assert.equal(retry.outbound.length, 2);
  assert.deepEqual(retry.outbound.map(({ operation: op }) => op), [original, original], 'a response cannot replace the original operation');

  const defaultRetry = fakeHarness('delivery:aws', fixtureManifest(), { responses: [
    { status: 503, retryable: true }, { status: 200 },
  ] });
  await defaultRetry.client.request(original);
  assert.equal(defaultRetry.outbound.length, 1, 'automatic retries are disabled by default');

  const protectedRetry = fakeHarness('delivery:aws', fixtureManifest(), { maxRetries: 1, responses: [
    { status: 503, retryable: true }, { status: 200 },
  ] });
  const conditional = {
    ...original,
    headers: { 'If-Match': 'etag-1', 'content-type': 'application/json' },
    payload: { condition: 'same-version', body: 'same-bytes' },
  };
  let signingTimestamp = 0;
  protectedRetry.client = new GuardedTransport({
    capability: capabilityForLocalTest('delivery:aws', fixtureManifest()),
    credentialLoader: async () => ({ fake: true }),
    serializer: async (op) => ({
      method: op.method,
      url: `${op.endpoint}${op.path ?? ''}`,
      endpoint: op.endpoint,
      body: JSON.stringify(op.payload),
      headers: { ...op.headers, 'x-amz-date': String(++signingTimestamp) },
      operation: structuredClone(op),
    }),
    signer: async (wire) => ({ ...wire, headers: { ...wire.headers, authorization: `signature-${Math.random()}` } }),
    maxRetries: 1,
    transport: async (wire, op) => {
      protectedRetry.outbound.push({ wire, operation: op });
      return protectedRetry.outbound.length === 1 ? { status: 503 } : { status: 200 };
    },
  });
  await protectedRetry.client.request(conditional);
  const [firstWire, secondWire] = protectedRetry.outbound.map(({ wire }) => wire);
  assert.equal(firstWire.url, secondWire.url);
  assert.equal(firstWire.method, secondWire.method);
  assert.equal(firstWire.body, secondWire.body);
  assert.equal(firstWire.headers['If-Match'], secondWire.headers['If-Match']);
  assert.notEqual(firstWire.headers['x-amz-date'], secondWire.headers['x-amz-date']);
  assert.notEqual(firstWire.headers.authorization, secondWire.headers.authorization);

  let fetchOptions;
  const fetchTransport = createFetchTransport(async (_url, options) => {
    fetchOptions = options;
    return { status: 302, headers: new Headers({ location: 'https://elsewhere.invalid/' }), arrayBuffer: async () => new ArrayBuffer(0) };
  });
  const fetchResult = await fetchTransport({ method: 'GET', url: 'https://example.invalid/', headers: { authorization: 'secret' } });
  assert.equal(fetchOptions.redirect, 'manual');
  assert.equal(fetchResult.status, 302);

  const writeRetry = fakeHarness('delivery:aws', fixtureManifest(), { maxRetries: 2, responses: [
    { status: 503, retryable: true }, { status: 200 },
  ] });
  await writeRetry.client.request(proofAwsPut());
  assert.equal(writeRetry.outbound.length, 1, 'writes are not in the automatic retry allowlist');

  const pagination = fakeHarness('inventory', fixtureManifest(), { responses: [
    { status: 200, items: [{ key: '_indexes/existing/index.json' }], nextOperation: operation('aws-s3', 'GetObject', { accountId: TARGETS.awsAccount, bucket: 'unrelated-bucket' }, { key: 'x' }) },
  ] });
  await assert.rejects(pagination.client.listAll(preservedAwsGet()), /TARGET_NOT_ALLOWED/);
  assert.equal(pagination.credentialLoads, 1);
  assert.equal(pagination.outbound.length, 1);

  const mixed = fakeHarness('failures:aws');
  await assertDeniedBeforeCredential(mixed, operation('aws-s3', 'DeleteObjects', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { payload: { keys: ['_artifacts/proof-a-20261018/one', '_previews/proof-life-20261018/head/manifest.json'] } }), 'OBJECT_KEY_DENIED');
  const versionedMixed = fakeHarness('cleanup:final-a8', fixtureManifest({
    lifecycle: { ...fixtureManifest().lifecycle, observationClosedAt: '2026-10-18T03:00:00Z', observationOutcome: 'complete' },
    a9Status: 'not-run',
    cleanup: { acceptedDestroyPlanDigest: 'aws-destroy-plan-digest', cfLifecycleRestored: true, writerVersion: '0.5.0', requiredWriterRange: '>=0.5.0 <0.6.0' },
  }));
  await assertDeniedBeforeCredential(versionedMixed, operation('aws-s3', 'DeleteObjects', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, {
    payload: { objects: [
      { Key: '_previews/proof-life-20261018/head/manifest.json', VersionId: 'version-1' },
      { Key: '_previews/proof-a-20261018/head/manifest.json', VersionId: 'version-2' },
    ] },
  }), 'OBJECT_KEY_DENIED');
  const unverifiableBatch = fakeHarness('cleanup:final-a8', fixtureManifest({
    lifecycle: { ...fixtureManifest().lifecycle, observationClosedAt: '2026-10-18T03:00:00Z', observationOutcome: 'complete' },
    a9Status: 'not-run',
    cleanup: { acceptedDestroyPlanDigest: 'aws-destroy-plan-digest', cfLifecycleRestored: true, writerVersion: '0.5.0', requiredWriterRange: '>=0.5.0 <0.6.0' },
  }));
  await assertDeniedBeforeCredential(unverifiableBatch, operation('aws-s3', 'DeleteObjects', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, {
    payload: { objects: [{ Key: '_previews/proof-life-20261018/head/manifest.json', VersionId: '' }, { Key: '_previews/proof-life-20261018/other.json', Extra: true }] },
  }), 'UNVERIFIABLE_BATCH_OBJECTS');
  const raw = fakeHarness('delivery:aws');
  await assertDeniedBeforeCredential(raw, { ...proofAwsPut(), rawRequest: true }, 'RAW_REQUEST_BYPASS_DENIED');

  const serializedTarget = fakeHarness('delivery:aws', fixtureManifest(), {
    serializer: async (op) => ({
      method: op.method,
      endpoint: op.endpoint,
      url: `${op.endpoint}/_artifacts/proof-a-20261018/index.html`,
      operation: { ...op, resource: { ...op.resource, bucket: TARGETS.preservedAwsBucket } },
    }),
  });
  await assertDeniedBeforeCredential(serializedTarget, proofAwsPut(), 'OPERATION_INTENT_CHANGED');

  const signedTarget = fakeHarness('delivery:aws', fixtureManifest(), {
    signer: async (wire) => ({
      ...wire,
      operation: { ...wire.operation, resource: { ...wire.operation.resource, bucket: TARGETS.preservedAwsBucket } },
    }),
  });
  await assert.rejects(signedTarget.client.request(proofAwsPut()), /OPERATION_INTENT_CHANGED/);
  assert.equal(signedTarget.credentialLoads, 1);
  assert.equal(signedTarget.outbound.length, 0, 'the signed non-allowed target must be rejected before dispatch');
});

test('life writes/deletes during observation and cleanup before outcome all fail', async () => {
  const observing = fixtureManifest({ lifecycle: { ...fixtureManifest().lifecycle, observationStartedAt: '2026-10-18T00:00:00Z' } });
  for (const action of ['PutObject', 'DeleteObject', 'DeleteObjects', 'CopyObject']) {
    const harness = fakeHarness('delivery:aws', observing);
    const payload = action === 'DeleteObjects' ? { keys: ['_previews/proof-life-20261018/head/manifest.json'] }
      : action === 'PutObject' ? {} : undefined;
    await assertDeniedBeforeCredential(harness, operation('aws-s3', action, { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { key: '_previews/proof-life-20261018/head/manifest.json', payload }), 'LIFE_FROZEN_OR_CLEANUP_GATED');
  }
  const a7Life = fakeHarness('failures:aws');
  await assertDeniedBeforeCredential(a7Life, operation('aws-s3', 'GetObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { key: '_previews/proof-life-20261018/head/manifest.json' }), 'LIFE_FROZEN_OR_CLEANUP_GATED');
  await assertDeniedBeforeCredential(fakeHarness('failures:aws'), operation('aws-s3', 'ListObjectsV2', {
    accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket,
  }, { prefix: '_indexes/' }), 'OBJECT_KEY_DENIED');
  await assertDeniedBeforeCredential(fakeHarness('cleanup:post-a7'), operation('aws-s3', 'ListObjectsV2', {
    accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket,
  }, { prefix: '_previews/' }), 'OBJECT_KEY_DENIED');
  await assertDeniedBeforeCredential(fakeHarness('delivery:aws'), operation('aws-s3', 'ListObjectsV2', {
    accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket,
  }), 'OBJECT_PREFIX_REQUIRED');
  const observerWrite = fakeHarness('lifecycle:aws:observe-only', observing);
  await assertDeniedBeforeCredential(observerWrite, operation('aws-s3', 'DeleteObjects', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, {
    payload: { keys: ['_previews/proof-life-20261018/head/manifest.json'] },
  }), 'OBSERVATION_IS_READ_ONLY');
  await assertDeniedBeforeCredential(fakeHarness('lifecycle:aws:observe-only', observing), operation('aws-s3', 'ListObjectsV2', {
    accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket,
  }, { prefix: '_indexes/proof-life-20261018/' }), 'OBSERVATION_PREFIX_DENIED');
  const premature = fixtureManifest({ lifecycle: { ...fixtureManifest().lifecycle, observationStartedAt: '2026-10-18T00:00:00Z' }, a9Status: 'not-run', cleanup: { acceptedDestroyPlanDigest: 'aws-destroy-plan-digest', cfLifecycleRestored: true } });
  const final = fakeHarness('cleanup:final-a8', premature);
  await assertDeniedBeforeCredential(final, operation('terraform', 'TerraformDestroy', { accountId: TARGETS.awsAccount, stack: 'new-aws-proof', planDigest: 'aws-destroy-plan-digest', addresses: ['aws_s3_bucket.proof'] }, { method: 'POST' }), 'OBSERVATION_OUTCOME_REQUIRED');
});

test('cleanup normal, early-exit, and censor branches preserve A8/A9 boundaries', () => {
  const now = Date.parse('2026-10-18T01:00:00Z');
  const post = validateCleanupState({ approvalState: { A7: { expiresAt: '2026-10-18T02:00:00Z' } } }, 'post-a7', { now });
  assert.deepEqual(post.deleteSites, ['proof-a-20261018', 'proof-b-20261018', 'proof-neighbor-20261018']);
  assert.equal(post.deleteLife, false);
  assert.equal(post.destroyStack, false);

  const completed = fixtureManifest({
    lifecycle: { ...fixtureManifest().lifecycle, observationOutcome: 'complete', observationClosedAt: '2026-10-18T02:00:00Z' },
    a9Status: 'completed',
    approvedDestroyPlanDigest: 'destroy-review-hash',
    cleanup: { acceptedDestroyPlanDigest: 'destroy-review-hash', cfLifecycleRestored: true, writerVersion: '0.5.0', requiredWriterRange: '>=0.5.0 <0.6.0' },
  });
  assert.deepEqual(validateCleanupState(completed, 'final-a8', { writerVersion: '0.5.0' }), { deleteSites: [TARGETS.lifeSite], deleteLife: true, destroyStack: true });

  const earlyExit = fixtureManifest({
    lifecycle: { ...fixtureManifest().lifecycle, observationOutcome: 'censored', observationClosedAt: '2026-10-18T01:15:00Z' },
    a9Status: 'not-run',
    approvedDestroyPlanDigest: 'destroy-review-hash',
    cleanup: { acceptedDestroyPlanDigest: 'destroy-review-hash', cfLifecycleRestored: true, writerVersion: '0.5.2', requiredWriterRange: '>=0.5.0 <0.6.0' },
  });
  assert.deepEqual(validateCleanupState(earlyExit, 'final-a8', { writerVersion: '0.5.2' }), { deleteSites: [TARGETS.lifeSite], deleteLife: true, destroyStack: true });

  const censor = fixtureManifest({
    lifecycle: { ...fixtureManifest().lifecycle, observationOutcome: 'censored', observationClosedAt: '2026-10-18T02:00:00Z' },
    a9Status: 'not-run',
    approvedDestroyPlanDigest: 'destroy-review-hash',
    cleanup: { acceptedDestroyPlanDigest: 'destroy-review-hash', cfLifecycleRestored: true, writerVersion: '0.5.1', requiredWriterRange: '>=0.5.0 <0.6.0' },
  });
  assert.equal(validateCleanupState(censor, 'final-a8').deleteLife, true);
  assert.throws(() => validateCleanupState(completed, 'final-a8', { writerVersion: '0.4.4' }), /INCOMPATIBLE_CLEANUP_WRITER/);
  assert.throws(() => validateCleanupState({ ...completed, cleanup: { ...completed.cleanup, writerVersion: undefined } }, 'final-a8'), /CLEANUP_WRITER_VERSION_REQUIRED/);
  assert.throws(() => validateCleanupState({ ...completed, cleanup: { ...completed.cleanup, acceptedDestroyPlanDigest: 'stale' } }, 'final-a8'), /DESTROY_PLAN_NOT_ACCEPTED/);
  assert.throws(() => validateCleanupState({ ...completed, cleanup: { ...completed.cleanup, cfLifecycleRestored: false } }, 'final-a8'), /CLOUDFLARE_LIFECYCLE_NOT_RESTORED/);
  assert.throws(() => validateCleanupState({ ...completed, lifecycle: { ...completed.lifecycle, observationOutcome: 'open', observationClosedAt: undefined } }, 'final-a8'), /OBSERVATION_OUTCOME_REQUIRED/);
});

test('IAM role and session policies independently exclude preserved bucket and distribution ARNs', () => {
  const proofPolicy = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:DeleteObjects', 'cloudfront:CreateInvalidation'], Resource: [`arn:aws:s3:::${TARGETS.proofAwsBucket}/*`, `arn:aws:cloudfront::${TARGETS.awsAccount}:distribution/E2PROOF20261018`] }] };
  assert.equal(assertPolicyExcludesPreserved(proofPolicy), true);
  assert.equal(policyAllows(proofPolicy, 's3:PutObject', `arn:aws:s3:::${TARGETS.proofAwsBucket}/_artifacts/proof-a-20261018/a`), true);
  assert.throws(() => assertPolicyExcludesPreserved({ Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] }), /SESSION_POLICY_INCLUDES_PRESERVED_ARN/);
  assert.throws(() => assertPolicyExcludesPreserved({ Statement: [{ Effect: 'Allow', Action: 'cloudfront:CreateInvalidation', Resource: `arn:aws:cloudfront::${TARGETS.awsAccount}:distribution/*`, Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } } }] }), /SESSION_POLICY_INCLUDES_PRESERVED_ARN/);
});

test('seal and reseal produce an immutable chained ledger; tamper and skipped stages fail closed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-seals-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = {
    schemaVersion: 1,
    runId: 'seals-local-test',
    testOnly: true,
    sealDirectory: 'seals',
    policy: { version: 1, denyByDefault: true },
    approvalPolicy: { signaturesRequired: true },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(root, 'plan.txt'), 'baseline plan\n');
  const first = await appendSeal({ manifestPath, stage: 'bootstrap', artifacts: ['plan.txt'], now: '2026-10-18T00:00:00Z' });
  await writeFile(path.join(root, 'discovery.json'), '{"zoneId":"zone-test"}\n');
  const second = await appendSeal({ manifestPath, stage: 'discovery', artifacts: ['discovery.json'], now: '2026-10-18T00:01:00Z' });
  await writeFile(path.join(root, 'inventory.json'), '{"complete":true}\n');
  const third = await appendSeal({ manifestPath, stage: 'inventory', artifacts: ['inventory.json'], now: '2026-10-18T00:02:00Z' });
  const chain = await readSealChain({ manifestPath });
  assert.deepEqual(chain.map((item) => item.stage), ['bootstrap', 'discovery', 'inventory']);
  assert.equal(second.record.previousDigest, first.record.digest);
  assert.equal(third.record.previousDigest, second.record.digest);
  assert.notEqual(first.record.digest, third.record.digest);
  await assert.rejects(appendSeal({ manifestPath, stage: 'inventory', artifacts: ['inventory.json'] }), /SKIPPED_SEAL_TRANSITION/);
  const secondSealBytes = await readFile(second.path);
  const tamperedSeal = JSON.parse(secondSealBytes.toString('utf8'));
  tamperedSeal.stage = 'create-plan';
  await writeFile(second.path, `${JSON.stringify(tamperedSeal)}\n`);
  await assert.rejects(readSealChain({ manifestPath }), /SEAL_DIGEST_MISMATCH/);
  await writeFile(second.path, secondSealBytes);
  await writeFile(path.join(root, 'plan.txt'), 'tampered plan\n');
  await assert.rejects(readSealChain({ manifestPath }), /SEALED_ARTIFACT_CHANGED/);
});

async function createApprovalFixture(root, { approvalId = 'A4', command = 'inventory', manifestOverrides = {} } = {}) {
  const workspace = path.join(root, 'workspace');
  const runtime = path.join(root, 'runtime');
  await mkdir(workspace, { recursive: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(workspace, 'proof-source.js'), 'export const sealed = true;\n');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Provider Proof Test']);
  git(['config', 'user.email', 'proof-test@example.invalid']);
  git(['add', 'proof-source.js']);
  git(['commit', '--quiet', '-m', 'approval fixture']);
  const keyPair = await makeSSHKey(root);
  const harness = await copyTestHarness(root, keyPair.publicKey);
  const manifestPath = path.join(runtime, 'manifest.json');
  const manifest = {
    schemaVersion: 1,
    runId: `approval-${path.basename(root)}`,
    workspaceRoot: '../workspace',
    baselineCommit: git(['rev-parse', 'HEAD']),
    sourceFiles: ['proof-source.js'],
    policy: { version: 1, denyByDefault: true },
    approvalPolicy: { signaturesRequired: true },
    scopeExpiresAt: expiry,
    approvalWindows: { [approvalId]: { expiresAt: expiry } },
    ...manifestOverrides,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const copiedSeals = await copiedModule(harness, 'seals.mjs');
  const active = await copiedSeals.appendSeal({ manifestPath, stage: 'bootstrap', now: '2026-10-17T00:00:00.000Z' });
  const helpers = await copiedModule(harness, 'approval-helpers.mjs');
  const prepared = await helpers.prepareApproval({ manifestPath, approvalId, command, expiresAt: expiry, now: '2026-10-18T00:00:00.000Z' });
  await sshSign(keyPair.privateKeyPath, prepared.payloadPath);
  const attached = await helpers.attachApproval({ manifestPath, approvalId, command, payloadPath: prepared.payloadPath, now: approvalNow });
  return { workspace, runtime, harness, manifestPath, manifest, activeSeal: active.record, keyPair, prepared, attached, helpers };
}

async function signRecord(keyPair, record, namespace = 'artifact-pages-provider-proof') {
  const payloadPath = path.join(path.dirname(keyPair.privateKeyPath), `signed-${Math.random().toString(16).slice(2)}.payload.json`);
  await writeFile(payloadPath, canonicalJson(record));
  const signature = await sshSign(keyPair.privateKeyPath, payloadPath, namespace);
  await rm(payloadPath, { force: true });
  await rm(`${payloadPath}.sig`, { force: true });
  return { ...record, signature: signature.toString('base64') };
}

async function verifyFileWithCopiedHarness(fixture, approvalId, command, now = approvalNow) {
  const copiedSeals = await copiedModule(fixture.harness, 'seals.mjs');
  return copiedSeals.verifyApprovalFile({ manifestPath: fixture.manifestPath, approvalId, command, now });
}

test('owner SSH approval uses the pinned anchor and both entry points enforce one exact schema', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-approval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createApprovalFixture(root);
  const copiedPolicy = await copiedModule(fixture.harness, 'policy.mjs');
  const copiedSeals = await copiedModule(fixture.harness, 'seals.mjs');
  const record = JSON.parse(await readFile(fixture.attached.approvalFile, 'utf8'));
  const verifiedManifest = {
    ...fixture.manifest,
    activeSealDigest: fixture.activeSeal.digest,
    activeSeal: fixture.activeSeal,
    sealChainVerified: true,
  };
  assert.equal(copiedPolicy.verifyApprovalRecord(record, verifiedManifest, 'A4', 'inventory', approvalNow), true);
  assert.equal((await verifyFileWithCopiedHarness(fixture, 'A4', 'inventory')).sealDigest, fixture.activeSeal.digest);
  const productionAnchor = loadOwnerTrustAnchor();
  assert.equal(ownerTrustAnchorEnrolled(), true);
  assert.equal(productionAnchor.status, 'enrolled');
  assert.equal(productionAnchor.fingerprint, fingerprintKey(productionAnchor.publicKey));
  assert.notEqual(fingerprintKey(fixture.keyPair.publicKey), productionAnchor.fingerprint, 'the fixture key is not the enrolled owner key');
  assert.equal(record.reviewerKeyFingerprint, fingerprintKey(fixture.keyPair.publicKey));
  assert.equal(verifyApprovalRecord(record, verifiedManifest, 'A4', 'inventory', approvalNow), false, 'production accepts only the checked-in owner key');
  await assert.rejects(
    verifyApprovalFile({ manifestPath: fixture.manifestPath, approvalId: 'A4', command: 'inventory', now: approvalNow }),
    (error) => error.code === 'OWNER_APPROVAL_INVALID',
  );

  const legacyManifestPath = path.join(root, 'legacy-manifest.json');
  await writeFile(legacyManifestPath, `${JSON.stringify({ ...fixture.manifest, reviewKeys: { owner: fixture.keyPair.publicKey } }, null, 2)}\n`);
  await assert.rejects(appendSeal({ manifestPath: legacyManifestPath }), /MANIFEST_REVIEW_KEYS_REJECTED/);
  assert.equal(copiedPolicy.verifyApprovalRecord(record, { ...verifiedManifest, reviewKeys: { owner: fixture.keyPair.publicKey } }, 'A4', 'inventory', approvalNow), false);

  const productionAttempt = spawnSync('node', [path.resolve('scripts/provider-proof/proof.mjs'), 'approval-prepare', '--manifest', fixture.manifestPath, '--approval', 'A4', '--command', 'inventory', '--expires-at', expiry], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ARTIFACT_PAGES_OWNER_PUBLIC_KEY: fixture.keyPair.publicKey },
  });
  assert.equal(productionAttempt.status, 0, productionAttempt.stderr);
  const preparedByProduction = JSON.parse(productionAttempt.stdout);
  const productionPayloadPath = path.resolve(process.cwd(), preparedByProduction.payloadPath);
  const relativePayloadPath = path.relative(root, productionPayloadPath);
  assert.ok(relativePayloadPath && !relativePayloadPath.startsWith(`..${path.sep}`) && relativePayloadPath !== '..', 'production prepare writes inside the test temp root');
  const productionPayload = JSON.parse(await readFile(productionPayloadPath, 'utf8'));
  assert.equal(productionPayload.reviewerKeyFingerprint, productionAnchor.fingerprint, 'the environment override must not replace the checked-in anchor');

  const unenrolledRoot = path.join(root, 'unenrolled');
  await mkdir(unenrolledRoot, { recursive: true });
  const unenrolledHarness = await copyTestHarness(unenrolledRoot, fixture.keyPair.publicKey);
  await writeFile(path.join(unenrolledHarness, 'trust-anchor.json'), `${JSON.stringify({
    schemaVersion: 1,
    keyId: 'owner',
    algorithm: 'ssh-ed25519',
    status: 'unenrolled',
    publicKey: null,
    fingerprint: null,
  }, null, 2)}\n`);
  const unenrolledHelpers = await copiedModule(unenrolledHarness, 'approval-helpers.mjs');
  await assert.rejects(
    unenrolledHelpers.prepareApproval({ manifestPath: fixture.manifestPath, approvalId: 'A4', command: 'inventory', expiresAt: expiry, now: '2026-10-18T00:00:00.000Z' }),
    (error) => error.code === 'OWNER_TRUST_ANCHOR_UNENROLLED',
  );
  await assert.rejects(
    unenrolledHelpers.attachApproval({ manifestPath: fixture.manifestPath, approvalId: 'A4', command: 'inventory', payloadPath: fixture.prepared.payloadPath, now: approvalNow }),
    (error) => error.code === 'OWNER_TRUST_ANCHOR_UNENROLLED',
  );

  const originalBytes = await readFile(fixture.attached.approvalFile);
  const changedRecord = async (candidate) => {
    await writeFile(fixture.attached.approvalFile, `${JSON.stringify(candidate, null, 2)}\n`);
    assert.equal(copiedPolicy.verifyApprovalRecord(candidate, verifiedManifest, 'A4', 'inventory', approvalNow), false);
    await assert.rejects(copiedSeals.verifyApprovalFile({ manifestPath: fixture.manifestPath, approvalId: 'A4', command: 'inventory', now: approvalNow }), /OWNER_APPROVAL_INVALID/);
    await writeFile(fixture.attached.approvalFile, originalBytes);
  };

  await changedRecord(await signRecord(fixture.keyPair, { ...record, approvedAt: 'malformed-date' }));
  await changedRecord(await signRecord(fixture.keyPair, { ...record, expiresAt: 'malformed-date' }));
  await changedRecord(await signRecord(fixture.keyPair, { ...record, reviewerKeyFingerprint: 'SHA256:wrong' }));
  await changedRecord(await signRecord(fixture.keyPair, { ...record, sealDigest: '0'.repeat(64) }));
  await changedRecord(await signRecord(fixture.keyPair, { ...record, scopeDigest: '1'.repeat(64) }));
  await changedRecord({ ...record, signature: 'not base64' });
  const wrongNamespace = await signRecord(fixture.keyPair, Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'signature')), 'wrong-namespace');
  await changedRecord(wrongNamespace);
  await changedRecord({ ...record, expiresAt: '2029-12-31T23:59:59.000Z' });
  await changedRecord({ ...record, testOnly: false });
  await assert.rejects(copiedSeals.verifyApprovalFile({ manifestPath: fixture.manifestPath, approvalId: 'A4', command: 'gzip', now: approvalNow }), /OWNER_APPROVAL_REQUIRED/);

  const preparedAgain = await fixture.helpers.prepareApproval({ manifestPath: fixture.manifestPath, approvalId: 'A4', command: 'inventory', expiresAt: '2029-12-31T23:59:59.000Z', now: '2026-10-18T00:00:00.000Z' });
  assert.notEqual(preparedAgain.payloadPath, fixture.prepared.payloadPath);
  assert.equal((await readFile(fixture.attached.approvalFile)).equals(originalBytes), true, 'preparing a replacement leaves the earlier approval record intact');
});

async function createShellGuardFixture(root, overrides = {}) {
  const { sealArtifacts = {}, ...manifestOverrides } = overrides;
  const workspace = path.join(root, 'workspace');
  const runtime = path.join(root, 'runtime');
  await mkdir(workspace, { recursive: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(workspace, 'proof-source.js'), 'export const sealed = true;\n');
  const evidenceBytes = Buffer.from('local signed-approval fixture\n');
  await writeFile(path.join(runtime, 'evidence.txt'), evidenceBytes);
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Provider Proof Test']);
  git(['config', 'user.email', 'proof-test@example.invalid']);
  git(['add', 'proof-source.js']);
  git(['commit', '--quiet', '-m', 'shell guard fixture']);
  const keyPair = await makeSSHKey(root);
  const harness = await copyTestHarness(root, keyPair.publicKey);
  const scopeExpiresAt = overrides.scopeExpiresAt ?? expiry;
  const approvalWindows = Object.fromEntries(['A4', 'A5', 'A6', 'A7', 'A8', 'A9'].map((id) => [id, { expiresAt: scopeExpiresAt }]));
  const manifest = {
    schemaVersion: 1,
    runId: `shell-guard-${path.basename(root)}`,
    sealDirectory: 'seals',
    approvalDirectory: 'approvals',
    workspaceRoot: '../workspace',
    baselineCommit: git(['rev-parse', 'HEAD']),
    sourceFiles: ['proof-source.js'],
    policy: { version: 1, denyByDefault: true },
    approvalPolicy: { signaturesRequired: true },
    scopeExpiresAt,
    approvalWindows,
    caps: { requests: 10, bytes: 1000, operatorMinutes: 60 },
    usage: { requests: 0, bytes: 0, operatorMinutes: 0 },
    preservationCheckpoint: {
      status: 'passed',
      path: 'evidence.txt',
      sha256: createHash('sha256').update(evidenceBytes).digest('hex'),
    },
    approvalState: { A7: { expiresAt: scopeExpiresAt } },
    bindings: { cloudflare: { reviewed: true, bucket: 'local-fake-r2-bucket', zoneId: 'zone-test' } },
    lifecycle: { observationOutcome: 'complete', observationClosedAt: '2026-10-18T01:00:00.000Z' },
    a9Status: 'not-run',
    approvedDestroyPlanDigest: 'destroy-plan-digest',
    cleanup: { acceptedDestroyPlanDigest: 'destroy-plan-digest', cfLifecycleRestored: true, writerVersion: '0.5.0', requiredWriterRange: '>=0.5.0 <0.6.0' },
    reviewedDeltas: {},
    endpoints: { 'aws-s3': { [TARGETS.preservedAwsBucket]: 'https://s3.us-east-1.amazonaws.com' } },
    ...manifestOverrides,
    approvalWindows: { ...approvalWindows, ...(overrides.approvalWindows ?? {}) },
  };
  const manifestPath = path.join(runtime, 'manifest.json');
  const operationPath = path.join(runtime, 'operation.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(operationPath, `${JSON.stringify({
    service: 'aws-s3',
    action: 'GetObject',
    method: 'GET',
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    resource: { accountId: TARGETS.awsAccount, bucket: TARGETS.preservedAwsBucket },
    key: '_indexes/existing/index.json',
  }, null, 2)}\n`);
  const chosenExpiry = Math.min(Date.parse(manifest.scopeExpiresAt), Date.parse(manifest.approvalWindows.A5.expiresAt));
  const approvedAtMs = Math.min(approvalNow, chosenExpiry - 2 * 24 * 60 * 60 * 1000);
  const sealBaseMs = approvedAtMs - 60_000;
  const seals = await copiedModule(harness, 'seals.mjs');
  await seals.appendSeal({ manifestPath, stage: 'bootstrap', now: new Date(sealBaseMs).toISOString() });
  for (const stage of ['discovery', 'inventory', 'create-plan', 'post-apply']) {
    const offset = { discovery: 1, inventory: 2, 'create-plan': 3, 'post-apply': 4 }[stage];
    await seals.appendSeal({ manifestPath, stage, artifacts: sealArtifacts[stage] ?? ['evidence.txt'], now: new Date(sealBaseMs + offset * 1000).toISOString() });
  }
  const helpers = await copiedModule(harness, 'approval-helpers.mjs');
  async function addApproval(approvalId, command) {
    const windowExpiry = manifest.approvalWindows?.[approvalId]?.expiresAt ?? manifest.scopeExpiresAt;
    const prepared = await helpers.prepareApproval({
      manifestPath,
      approvalId,
      command,
      expiresAt: windowExpiry,
      now: new Date(approvedAtMs).toISOString(),
    });
    await sshSign(keyPair.privateKeyPath, prepared.payloadPath);
    return helpers.attachApproval({ manifestPath, approvalId, command, payloadPath: prepared.payloadPath, now: approvedAtMs });
  }
  await addApproval('A5', 'delivery:aws');
  return { workspace, runtime, harness, commandsPath: path.join(harness, 'commands.sh'), manifestPath, operationPath, manifest, keyPair, addApproval };
}

test('bootstrap seals hash the committed source tree and fail on source or worktree drift', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const runtime = path.join(root, 'runtime');
  await mkdir(workspace, { recursive: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(workspace, 'proof-source.js'), 'export const sealed = true;\n');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Provider Proof Test']);
  git(['config', 'user.email', 'proof-test@example.invalid']);
  git(['add', 'proof-source.js']);
  git(['commit', '--quiet', '-m', 'proof fixture']);
  const manifest = {
    schemaVersion: 1,
    runId: 'workspace-seal-test',
    testOnly: false,
    sealDirectory: 'seals',
    workspaceRoot: '../workspace',
    baselineCommit: git(['rev-parse', 'HEAD']),
    sourceFiles: ['proof-source.js'],
    policy: { version: 1 },
    approvalPolicy: { signaturesRequired: true },
  };
  const manifestPath = path.join(runtime, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const { record } = await appendSeal({ manifestPath, stage: 'bootstrap' });
  assert.ok(record.workspaceSnapshot.gitDiffSha256);
  assert.equal(record.workspaceSnapshot.files.length, 1);
  assert.equal((await readSealChain({ manifestPath }))[0].digest, record.digest);
  await writeFile(path.join(workspace, 'proof-source.js'), 'export const sealed = false;\n');
  await assert.rejects(readSealChain({ manifestPath }), /SEALED_WORKSPACE_DIFF_CHANGED|SEALED_SOURCE_FILE_CHANGED/);
});

test('commands.sh refuses missing approvals, target mismatch, changed hashes, collisions, expiry, and exhausted caps', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createShellGuardFixture(root);
  const commands = fixture.commandsPath;
  const invoke = ({ approval = 'A5', args = [] } = {}) => spawnSync('sh', [commands, 'guard', '--manifest', fixture.manifestPath, '--command', 'delivery:aws', '--approval', approval, '--operation', fixture.operationPath, ...args], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });

  const missingApproval = invoke({ approval: 'A6' });
  assert.equal(missingApproval.status, 2);
  assert.match(missingApproval.stderr, /OWNER_APPROVAL_REQUIRED/);

  const wrongTarget = invoke();
  assert.equal(wrongTarget.status, 2);
  assert.match(wrongTarget.stderr, /PRESERVED_RESOURCE_DENIED_TO_PROOF/);

  await writeFile(path.join(fixture.workspace, 'proof-source.js'), 'export const sealed = false;\n');
  const changedHash = invoke();
  assert.equal(changedHash.status, 2);
  assert.match(changedHash.stderr, /SEALED_WORKSPACE_DIFF_CHANGED|SEALED_SOURCE_FILE_CHANGED/);

  const collisionRoot = path.join(root, 'collision');
  const collisionFixture = await createShellGuardFixture(collisionRoot, { collisions: ['proof-a-20261018'] });
  const collision = spawnSync('sh', [collisionFixture.commandsPath, 'guard', '--manifest', collisionFixture.manifestPath, '--command', 'delivery:aws', '--approval', 'A5', '--operation', collisionFixture.operationPath], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  assert.equal(collision.status, 2);
  assert.match(collision.stderr, /RESOURCE_COLLISION/);

  const expiredRoot = path.join(root, 'expired');
  const expiredFixture = await createShellGuardFixture(expiredRoot, { scopeExpiresAt: '2020-01-01T00:00:00.000Z' });
  const expired = spawnSync('sh', [expiredFixture.commandsPath, 'guard', '--manifest', expiredFixture.manifestPath, '--command', 'delivery:aws', '--approval', 'A5', '--operation', expiredFixture.operationPath], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  assert.equal(expired.status, 2);
  assert.match(expired.stderr, /SCOPE_EXPIRED/);

  const exhaustedRoot = path.join(root, 'exhausted');
  const exhaustedFixture = await createShellGuardFixture(exhaustedRoot, { usage: { requests: 11 } });
  const exhausted = spawnSync('sh', [exhaustedFixture.commandsPath, 'guard', '--manifest', exhaustedFixture.manifestPath, '--command', 'delivery:aws', '--approval', 'A5', '--operation', exhaustedFixture.operationPath], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  assert.equal(exhausted.status, 2);
  assert.match(exhausted.stderr, /CAP_EXHAUSTED/);

  const arbitraryRun = spawnSync('sh', [commands, 'run', 'arbitrary-provider-command', '--manifest', fixture.manifestPath], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  assert.equal(arbitraryRun.status, 2);
  assert.match(arbitraryRun.stderr, /COMMAND_NOT_IN_RUNBOOK/);
  const external = spawnSync('sh', [commands, 'external', '--manifest', fixture.manifestPath, '--command', 'aws s3api list-buckets'], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  assert.equal(external.status, 2);
  assert.match(external.stderr, /ARBITRARY_COMMAND_PAYLOAD_REJECTED/);
});

test('non-plan phases require credential verification or a reviewed execution path', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-run-interface-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createShellGuardFixture(root);
  const manifestPath = fixture.manifestPath;
  const commands = fixture.commandsPath;
  const phases = [
    ['A4', 'inventory', ['inventory', '--manifest', manifestPath, '--approval', 'A4']],
    ['A5', 'bootstrap-aws', ['bootstrap-aws', '--manifest', manifestPath, '--approval', 'A5']],
    ['A5', 'delivery:aws', ['delivery', '--provider', 'aws', '--cases', 'P1', '--manifest', manifestPath, '--approval', 'A5']],
    ['A6', 'delivery:cloudflare', ['delivery', '--provider', 'cloudflare', '--cases', 'P1', '--manifest', manifestPath, '--approval', 'A6']],
    ['A7', 'failures:aws', ['failures', '--provider', 'aws', '--cases', 'P4', '--manifest', manifestPath, '--approval', 'A7']],
    ['A7', 'failures:cloudflare', ['failures', '--provider', 'cloudflare', '--cases', 'P4', '--manifest', manifestPath, '--approval', 'A7']],
    ['A8', 'lifecycle:aws:setup', ['lifecycle', '--provider', 'aws', '--setup', '--manifest', manifestPath, '--approval', 'A8']],
    ['A8', 'lifecycle:cloudflare:setup', ['lifecycle', '--provider', 'cloudflare', '--setup', '--manifest', manifestPath, '--approval', 'A8']],
    ['A8', 'lifecycle:aws:observe-only', ['lifecycle', '--provider', 'aws', '--observe-only', '--manifest', manifestPath, '--approval', 'A8']],
    ['A8', 'lifecycle:cloudflare:observe-only', ['lifecycle', '--provider', 'cloudflare', '--observe-only', '--manifest', manifestPath, '--approval', 'A8']],
    ['A8', 'lifecycle:aws:reconcile', ['lifecycle', '--provider', 'aws', '--reconcile', '--manifest', manifestPath, '--approval', 'A8']],
    ['A8', 'lifecycle:cloudflare:reconcile', ['lifecycle', '--provider', 'cloudflare', '--reconcile', '--manifest', manifestPath, '--approval', 'A8']],
    ['A9', 'gzip', ['gzip', '--manifest', manifestPath, '--approval', 'A9']],
    ['A7', 'cleanup:post-a7', ['cleanup', '--phase', 'post-a7', '--manifest', manifestPath, '--approval', 'A7']],
    ['A8', 'cleanup:final-a8', ['cleanup', '--phase', 'final-a8', '--manifest', manifestPath, '--approval', 'A8']],
    ['A4', 'cloudflare-api-get', ['cloudflare-api-get', '--path', `/accounts/${TARGETS.cloudflareVerifyAccount}/r2/buckets/local-fake-r2-bucket/lifecycle`, '--manifest', manifestPath, '--approval', 'A4', '--out', path.join(fixture.runtime, 'lifecycle.json')]],
  ];
  for (const [approvalId, command, args] of phases) {
    if (command !== 'delivery:aws') await fixture.addApproval(approvalId, command);
    const result = spawnSync('sh', [commands, 'run', ...args], {
      cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    assert.equal(result.status, 2, `${command}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(EXECUTION_PATHS[command]?.implemented ? 'LEAST_PRIVILEGE_CREDENTIALS_REQUIRED' : 'EXECUTION_PATH_NOT_IMPLEMENTED'));
    assert.doesNotMatch(result.stdout, /(?:AWS_[A-Z_]+|CF_VERIFY_[A-Z_]+|token|secret|access key)/i);
    assert.doesNotMatch(result.stderr, /(?:AWS_[A-Z_]+|CF_VERIFY_[A-Z_]+|token|secret|access key)/i);
  }

  const planOnly = spawnSync('sh', [commands, 'run', 'inventory', '--manifest', manifestPath, '--approval', 'A4', '--plan-only'], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  assert.equal(planOnly.status, 0, planOnly.stderr);
  assert.match(planOnly.stdout, /"planOnly":true/);
});

test('caps and expiry are checked independently of approval strings', () => {
  const manifest = fixtureManifest();
  validateCapsAndExpiry(manifest, { expiresAt: expiry }, { requests: 1, bytes: 10 }, approvalNow);
  assert.throws(() => validateCapsAndExpiry(manifest, { expiresAt: '2020-01-01T00:00:00Z' }, { requests: 0 }, approvalNow), /APPROVAL_EXPIRED/);
  assert.throws(() => validateCapsAndExpiry(manifest, { expiresAt: expiry }, { requests: 21 }, approvalNow), /CAP_EXHAUSTED/);
  assert.throws(() => validateCapsAndExpiry(manifest, { expiresAt: expiry }, { bytes: Number.POSITIVE_INFINITY }, approvalNow), /CAP_EXHAUSTED/);
});

test('guarded requests reserve request and payload budgets before credentials', async () => {
  const oneRequest = fakeHarness('delivery:aws', fixtureManifest({ caps: { requests: 1, bytes: 1000, operatorMinutes: 60 } }));
  await oneRequest.client.request(proofAwsPut());
  await assert.rejects(oneRequest.client.request(proofAwsPut()), (error) => error instanceof AuthorizationError && error.code === 'CAP_EXHAUSTED');
  assert.equal(oneRequest.credentialLoads, 1);
  assert.equal(oneRequest.outbound.length, 1);

  await assertDeniedBeforeCredential(fakeHarness('delivery:aws', fixtureManifest({ caps: { requests: 2, bytes: 1, operatorMinutes: 60 } })), proofAwsPut(), 'CAP_EXHAUSTED');
  await assertDeniedBeforeCredential(fakeHarness('delivery:aws', fixtureManifest({ scopeExpiresAt: '2020-01-01T00:00:00Z' })), proofAwsPut(), 'APPROVAL_EXPIRED');
});

test('subprocess execution requires verified credentials and an implemented path, and rejects context overrides', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-command-'));
  try {
    const manifest = fixtureManifest();
    const manifestPath = path.join(root, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const code = await main(['external', '--manifest', manifestPath, '--command', 'aws s3api get-object'], {});
    assert.equal(code, 2);
    const contextCode = await main(['seal', '--manifest', manifestPath, '--offline'], { ARTIFACT_PAGES_PROOF_CONTEXT: 'preservation' });
    assert.equal(contextCode, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inherited credentials are rejected before guard, phase, and external capability work; offline seal remains usable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-env-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commands = path.resolve('scripts/provider-proof/commands.sh');
  const missingManifest = path.join(root, 'missing-manifest.json');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', AWS_PROFILE: 'artifact-pages-verify' };
  const calls = [
    ['guard', ['guard', '--manifest', missingManifest, '--command', 'delivery:aws', '--approval', 'A5', '--operation', path.join(root, 'missing-operation.json')]],
    ['phase', ['run', 'inventory', '--manifest', missingManifest, '--approval', 'A4']],
    ['external', ['external', '--manifest', missingManifest, '--command', 'aws s3api list-buckets']],
  ];
  for (const [label, args] of calls) {
    const result = spawnSync('sh', [commands, ...args], { cwd: process.cwd(), encoding: 'utf8', env });
    assert.equal(result.status, 2, `${label}: ${result.stderr}`);
    assert.match(result.stderr, /INHERITED_CREDENTIAL_FALLBACK/);
    assert.doesNotMatch(result.stderr, /ENOENT|INVALID_MANIFEST/);
  }

  const manifestPath = path.join(root, 'offline-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, runId: 'offline-seal', testOnly: true, policy: {}, approvalPolicy: {} })}\n`);
  assert.equal(await main(['seal', '--manifest', manifestPath, '--offline'], env), 0);
});

test('fixed invocation registry uses argument vectors and leaves unimplemented paths closed', () => {
  for (const [id, invocation] of Object.entries(INVOCATIONS)) {
    assert.ok(id.length > 0);
    assert.ok(Array.isArray(invocation.argv));
    assert.ok(invocation.argv.every((argument) => typeof argument === 'string'));
    assert.doesNotMatch(invocation.argv.join('\0'), /(?:\|\||&&|;|`|\$\()/u);
    const capturePaths = Object.values(invocation.captures ?? {});
    const artifactPaths = invocation.artifacts ?? [];
    assert.ok(invocation.captures?.stdout && invocation.captures?.stderr, `${id} captures both streams`);
    assert.ok(capturePaths.every((capture) => !artifactPaths.includes(capture)), `${id} keeps artifact paths out of captures`);
  }
  const plan = INVOCATIONS['aws.provisioner.plan'];
  assert.equal(plan.captures.stdout, 'evidence/aws-plan.txt');
  assert.equal(plan.captures.stderr, 'evidence/aws-plan.stderr');
  assert.deepEqual(plan.artifacts, ['aws-create.plan']);
  assert.throws(() => assertInvocationMatchesTransition('aws.delivery.site-a', 'delivery:cloudflare'), /INVOCATION_TRANSITION_MISMATCH/);
  assert.throws(() => getExecutionPath('failures:aws'), /EXECUTION_PATH_NOT_IMPLEMENTED/);
  assert.throws(() => getExecutionPath('delivery:cloudflare'), /EXECUTION_PATH_NOT_IMPLEMENTED/);
  assert.throws(() => getExecutionPath('lifecycle:aws:observe-only'), /EXECUTION_PATH_NOT_IMPLEMENTED/);
  for (const transition of ['lifecycle:aws:reconcile', 'gzip', 'cleanup:final-a8']) {
    assert.throws(() => getExecutionPath(transition), /EXECUTION_PATH_NOT_IMPLEMENTED/);
  }
  const pathsWithProbes = Object.values(EXECUTION_PATHS).filter((item) => item.implemented);
  for (const executionPath of pathsWithProbes) {
    for (const id of executionPath.invocationIds) {
      const credentialClass = INVOCATIONS[id].credentialClass;
      assert.ok(PROBE_DEFINITIONS.some((probe) => probe.credentialClass === credentialClass && probe.stage === 'preflight'), `${id} has preflight probes`);
    }
  }
  for (const credentialClass of ['aws-observer', 'aws-admin-publisher']) {
    assert.throws(() => credentialClassDefinition(credentialClass), /EXECUTION_PATH_NOT_IMPLEMENTED/);
  }
  assert.deepEqual(EXECUTION_PATHS['cleanup:post-a7'].invocationIds, []);
});

test('reviewed policy templates render without unresolved scope and keep documented wildcard creates isolated', async () => {
  const bindings = policyTemplateBindings();
  const rendered = await renderAwsPolicySet(bindings);
  assert.equal(Object.keys(rendered.digests).length, 8);
  for (const digest of Object.values(rendered.digests)) assert.match(digest, /^[a-f0-9]{64}$/u);

  const inventory = rendered.documents.inventory;
  const inventoryRead = inventory.Statement.find((statement) => statement.Sid === 'ReadEnumeratedBucketObjectsAndVersions');
  assert.ok(inventoryRead.Resource.includes(bindings.PRESERVED_BUCKET_ARN));
  const inventoryListDeny = inventory.Statement.find((statement) => statement.Sid === 'DenyAllOtherBuckets');
  assert.ok(!JSON.stringify(inventoryListDeny).includes('ListAllMyBuckets'));

  const provisioner = rendered.documents.provisioner;
  assert.ok(provisioner.Statement.some((statement) => statement.Sid === 'DenyCloudFrontCreationOnTheProvisionerIdentity'));
  assert.ok(!provisioner.Statement.some((statement) => statement.Effect === 'Allow' && statement.Resource === '*' && JSON.stringify(statement.Action ?? []).includes('CreateDistribution')));
  const allowedActions = [
    { action: 's3:CreateBucket', resource: bindings.PROOF_BUCKET_ARN, documents: Object.entries(rendered.documents) },
    // IAM role creation belongs only to the provisioner; operator and publisher policies intentionally deny IAM.
    { action: 'iam:CreateRole', resource: bindings.PUBLISHER_ROLE_ARNS[0], documents: [['provisioner', provisioner]] },
    { action: 'sts:GetCallerIdentity', resource: '*', documents: Object.entries(rendered.documents) },
  ];
  for (const { action, resource, documents } of allowedActions) {
    for (const [name, document] of documents) {
      assert.equal(renderedDocumentsDeny(document, action, resource), false, `${name} denies ${action} on ${resource}`);
    }
  }
  for (const [name, document] of Object.entries(rendered.documents)) {
    for (const statement of allPolicyStatements(document)) {
      if (statement.Effect !== 'Deny' || statement.NotAction === undefined) continue;
      const services = new Set(asPolicyList(statement.NotAction).map((action) => action.split(':', 1)[0]));
      assert.equal(services.size, 1, `${name}:${statement.Sid} NotAction is service-scoped`);
    }
  }
  const weakPreservedDeny = structuredClone(provisioner);
  weakPreservedDeny.Statement.find((statement) => statement.Sid === 'DenyPreservedProductionBucket').Action = 's3:*';
  assert.throws(() => assertProofPolicyContainsDenies(weakPreservedDeny, bindings), /PRESERVED_RESOURCE_DENY_MISSING/);
  const creation = rendered.documents.cloudfrontCreation;
  assert.ok(creation.Statement.some((statement) => statement.Effect === 'Deny' && JSON.stringify(statement.Resource).includes('ECFTIR5GVPQDF')));
  assertNoWildcardAllows(creation, {
    allowedWildcardActions: ['cloudfront:CreateDistribution', 'cloudfront:CreateFunction', 'cloudfront:CreateOriginAccessControl', 'cloudfront:CreateCachePolicy', 'cloudfront:CreateResponseHeadersPolicy', 'cloudfront:TagResource'],
  });

  const sessions = rendered.documents.sessionProfiles;
  for (const [name, session] of Object.entries(sessions)) {
    const hasVersionDelete = JSON.stringify(session).includes('s3:DeleteObjectVersion');
    assert.equal(hasVersionDelete, name === 'final-cleanup', `${name} version-delete scope`);
  }
  const a7Invalidation = sessions['a7-proof'].Statement.find((statement) => statement.Sid === 'InvalidateOnlyA7ProofDistribution');
  assert.equal(a7Invalidation.Action, 'cloudfront:CreateInvalidation');
  assert.deepEqual(a7Invalidation.Resource, bindings.PROOF_DISTRIBUTION_ARN);
  assert.ok(rendered.documents.publisherSatelliteBoundary.Statement.some((statement) => statement.Effect === 'Deny' && JSON.stringify(statement.Resource ?? statement.NotResource ?? []).includes('ECFTIR5GVPQDF')));

  const cloudflare = await readPolicyTemplate('cloudflare-credential-scopes.json');
  assert.equal(cloudflare.verifyAccountId, '21a0acb78621cc00cfa655a276d77b74');
  assert.equal(cloudflare.productionAccountIdExcluded, '9ac354c8aa31d424224d8c4f3aa8ba2a');
  assert.equal(cloudflare.temporaryCredentials.ttlSeconds, 900);
  assert.equal(cloudflare.temporaryCredentials.siteWriter.credentialClass, 'cloudflare-site-a-writer');
  assert.equal(cloudflare.temporaryCredentials.cachePurge.credentialClass, 'cloudflare-cache-purge');
  const cloudflareClasses = collectCredentialClassNames(cloudflare);
  assert.ok(cloudflareClasses.every((name) => CREDENTIAL_CLASS_NAMES.includes(name)));
  assert.equal(Object.hasOwn(cloudflare.temporaryCredentials, 'appRegistryTransaction'), false);
  assert.equal(cloudflare.temporaryCredentials.a8Reconciliation.credentialClass, 'cloudflare-reconcile');
  assert.match(cloudflare.parentTokens.lifecycleAdministrator.residualAuthority, /account-wide/u);
  assert.match(cloudflare.parentTokens.cachePurge.residualAuthority, /not restricted to the proof URL list/u);
  assert.equal(policyDocumentDigest(inventory), rendered.digests.inventory);
});

test('policy review requires unconditional boundary denies and narrowly scoped Allow wildcards', async () => {
  const protectedResources = [
    'arn:aws:s3:::artifact-pages-231136241959-us-east-1',
    'arn:aws:s3:::artifact-pages-231136241959-us-east-1/*',
    'arn:aws:cloudfront::231136241959:distribution/ECFTIR5GVPQDF',
  ];
  const proofBindings = {
    PROOF_BUCKET_ARN: 'arn:aws:s3:::ap-proof-231136241959-20261018',
    PROOF_DISTRIBUTION_ARN: 'arn:aws:cloudfront::231136241959:distribution/E2PROOF20261018',
  };
  const boundaryDeny = {
    Effect: 'Deny', Action: '*',
    Resource: [...protectedResources, proofBindings.PROOF_BUCKET_ARN, proofBindings.PROOF_DISTRIBUTION_ARN],
  };
  assert.equal(assertProofPolicyContainsDenies({ Statement: [boundaryDeny] }, proofBindings), true);
  for (const condition of [{ Bool: { 'aws:SecureTransport': 'false' } }, {}, null]) {
    assert.throws(() => assertProofPolicyContainsDenies({
      Statement: [{ ...boundaryDeny, Condition: condition }],
    }, proofBindings), /PRESERVED_RESOURCE_DENY_MISSING|PROOF_BUCKET_BOUNDARY_MISSING/u);
  }
  assert.equal(assertProofPolicyContainsDenies({
    Statement: [{ ...boundaryDeny, Condition: {} }, boundaryDeny],
  }, proofBindings), true, 'a separate unconditional Deny supplies the required evidence');
  assert.throws(() => assertProofPolicyContainsDenies({
    Statement: [
      { ...boundaryDeny, Resource: protectedResources },
      { Effect: 'Deny', Action: '*', Resource: [proofBindings.PROOF_BUCKET_ARN, proofBindings.PROOF_DISTRIBUTION_ARN], Condition: null },
    ],
  }, proofBindings), /PROOF_BUCKET_BOUNDARY_MISSING/u);

  const allowed = (action, resource, extra = {}) => ({ Statement: [{ Effect: 'Allow', Action: action, Resource: resource, ...extra }] });
  assert.equal(assertNoWildcardAllows(allowed('s3:GetObject', 'arn:aws:s3:::proof-bucket/*')), true);
  assert.equal(assertNoWildcardAllows(allowed('s3:GetObject', 'arn:aws:s3:::proof-bucket/_indexes/proof-site/*')), true);
  assert.equal(assertNoWildcardAllows(allowed(
    ['s3:GetObject', 's3:ListBucket'],
    ['arn:aws:s3:::proof-bucket/*', 'arn:aws:s3:::proof-bucket'],
  )), true, 'array forms with reviewed actions and resources remain accepted');
  assert.equal(assertNoWildcardAllows(allowed('sts:GetCallerIdentity', '*', { Condition: { Bool: { 'aws:SecureTransport': 'true' } } }), {
    allowedWildcardActions: ['sts:GetCallerIdentity'],
  }), true, 'the exact-action Resource:* exception remains unchanged with a Condition');
  assert.equal(assertNoWildcardAllows(allowed(
    'sts:GetCallerIdentity', ['*', 'arn:aws:iam::231136241959:role/proof'],
  ), { allowedWildcardActions: ['sts:GetCallerIdentity'] }), true,
  'Resource:* inside an array is accepted for an exact-action allowlist');

  for (const resource of [
    'arn:aws:s3:::proof-*/objects/*',
    'arn:aws:s3:::proof-bucket/objects/prefix*tail',
    'arn:aws:s3:::proof-bucket/objects/prefix?tail',
    'arn:aws:cloudfront::231136241959:distribution/E2PROOF*',
    'arn:aws:iam::*:role/proof',
    'arn:aws:iam::231136241959:role/proof-*',
  ]) {
    assert.throws(() => assertNoWildcardAllows(allowed('s3:GetObject', resource)), /WILDCARD_ALLOW_NOT_REVIEWED/u, resource);
  }
  for (const action of ['s3:Get*', 's3:GetObject?']) {
    assert.throws(() => assertNoWildcardAllows(allowed(action, 'arn:aws:s3:::proof-bucket/objects/key')), /WILDCARD_ALLOW_NOT_REVIEWED/u);
  }
  assert.throws(() => assertNoWildcardAllows(allowed(
    ['s3:GetObject', 's3:Get*'], 'arn:aws:s3:::proof-bucket/objects/key',
  )), /WILDCARD_ALLOW_NOT_REVIEWED/u, 'wildcards in Action arrays are rejected');
  assert.throws(() => assertNoWildcardAllows(allowed(
    's3:GetObject', ['*', 'arn:aws:s3:::proof-bucket/objects/key'],
  )), /WILDCARD_ALLOW_NOT_REVIEWED/u, 'Resource:* arrays need exact-action allowlisting');
  assert.throws(() => assertNoWildcardAllows(allowed(
    ['sts:GetCallerIdentity', 's3:GetObject'], ['*', 'arn:aws:s3:::proof-bucket/objects/key'],
  ), { allowedWildcardActions: ['sts:GetCallerIdentity'] }), /WILDCARD_ALLOW_NOT_REVIEWED/u,
  'every action paired with Resource:* must be on the exact-action allowlist');
  assert.throws(() => assertNoWildcardAllows(allowed('s3:GetObject', '*', { Condition: { Bool: { 'aws:SecureTransport': 'true' } } })), /WILDCARD_ALLOW_NOT_REVIEWED/u);
  assert.throws(() => assertNoWildcardAllows(allowed('s3:GetObject', undefined, { NotResource: 'arn:aws:s3:::proof-bucket/private/*' })), /WILDCARD_ALLOW_NOT_REVIEWED/u);
  for (const notAction of ['s3:GetObject', ['s3:GetObject', 's3:ListBucket']]) {
    assert.throws(() => assertNoWildcardAllows(allowed(undefined, 'arn:aws:s3:::proof-bucket/key', { NotAction: notAction })),
      /WILDCARD_ALLOW_NOT_REVIEWED/u, `Allow NotAction is rejected for ${Array.isArray(notAction) ? 'array' : 'string'} form`);
  }
});

test('Cloudflare scope templates reject unbound placeholders and preserve parent/child separation', async () => {
  const template = await readPolicyTemplate('cloudflare-credential-scopes.json');
  assert.throws(() => renderPolicyTemplate(template, { VERIFIED_SHARED_BUCKET: 'verify-bucket' }), /POLICY_TEMPLATE_UNBOUND/);
  const rendered = renderPolicyTemplate(template, { VERIFIED_SHARED_BUCKET: 'verify-bucket', VERIFIED_ZONE_ID: 'zone-verified', SITE_ID: 'proof-a-20261018' });
  assert.equal(rendered.temporaryCredentials.siteWriter.bucket, 'verify-bucket');
  assert.equal(rendered.temporaryCredentials.cachePurge.zoneId, 'zone-verified');
  assert.equal(rendered.controls.parentCredentialsNeverReachChild, true);
  assert.equal(rendered.controls.noPermanentSharedBucketWriterForSiteRuns, true);
  assert.equal(rendered.temporaryCredentials.productionAccountIdForbidden, '9ac354c8aa31d424224d8c4f3aa8ba2a');
  assert.ok(!Object.entries(rendered.temporaryCredentials).some(([key, value]) => key === 'accountId' && value === rendered.temporaryCredentials.productionAccountIdForbidden));
});

test('private credential loader enforces fixed class, account and expiry; child environment is isolated', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-child-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = awsInventoryCredentialSource();
  const loader = new PrivateCredentialLoader({ loadPrivateCredential: async () => source, now: () => approvalNow });
  const credential = await loader.load('aws-inventory', { minimumLifetimeMs: 60_000 });
  assert.equal(credential.credentialClass, 'aws-inventory');
  assert.equal(credential.credentialSource, 'aws-sso-assumed-role');
  assert.ok(Object.isFrozen(credential.environment));
  assert.deepEqual(Object.keys(credential.environment).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']);
  await assert.rejects(new PrivateCredentialLoader({
    loadPrivateCredential: async () => ({ ...source, accountId: '9ac354c8aa31d424224d8c4f3aa8ba2a' }), now: () => approvalNow,
  }).load('aws-inventory'), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
  await assert.rejects(new PrivateCredentialLoader({
    loadPrivateCredential: async () => ({ ...source, expiresAt: '2026-10-18T00:00:30.000Z' }), now: () => approvalNow,
  }).load('aws-inventory', { minimumLifetimeMs: 60_000 }), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
  await assert.rejects(new PrivateCredentialLoader({
    loadPrivateCredential: async () => ({ ...source, environment: { ...source.environment, AWS_PROFILE: 'owner-sso' } }), now: () => approvalNow,
  }).load('aws-inventory'), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
  await assert.rejects(new PrivateCredentialLoader({
    loadPrivateCredential: async () => ({ ...source, credentialSource: 'github-actions-oidc' }), now: () => approvalNow,
  }).load('aws-inventory'), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
  const oidcCredential = await new PrivateCredentialLoader({
    loadPrivateCredential: async () => ({
      ...source,
      credentialClass: 'aws-satellite-a',
      credentialSource: 'github-actions-oidc',
      instanceId: 'aws-oidc-satellite-a-0001',
      principalArn: 'arn:aws:sts::231136241959:assumed-role/ap-proof-20261018-a-publisher/run-0001',
    }), now: () => approvalNow,
  }).load('aws-satellite-a');
  assert.equal(oidcCredential.credentialSource, 'github-actions-oidc');

  const invocation = { id: 'aws.inventory.identity', credentialClass: 'aws-inventory', runtimeRoot: root };
  const environment = await buildChildEnvironment({ invocation, credential, isolationRoot: path.join(root, 'isolated'), parentEnvironment: { PATH: '/usr/bin:/bin' } });
  assert.equal(environment.AWS_EC2_METADATA_DISABLED, 'true');
  assert.equal(environment.AWS_ACCESS_KEY_ID, source.environment.AWS_ACCESS_KEY_ID);
  assert.ok(environment.HOME.startsWith(path.join(root, 'isolated')));
  assert.ok(environment.AWS_CONFIG_FILE.startsWith(path.join(root, 'isolated')));
  assert.equal(environment.AWS_PROFILE, undefined);
  for (const inherited of [
    { PATH: '/usr/bin:/bin', AWS_PROFILE: 'artifact-pages-verify' },
    { PATH: '/usr/bin:/bin', AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/token' },
    { PATH: '/usr/bin:/bin', AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/token' },
    { PATH: '/usr/bin:/bin', HTTP_PROXY: 'http://proxy.invalid' },
    { PATH: '/usr/bin:/bin', AWS_ENDPOINT_URL: 'https://example.invalid' },
    { PATH: '/usr/bin:/bin', CF_VERIFY_API_TOKEN: 'unrelated-token' },
    { PATH: '/usr/bin:/bin', GH_TOKEN: 'unrelated-token' },
    { PATH: '/usr/bin:/bin', SSH_AUTH_SOCK: '/tmp/ssh-agent.sock' },
  ]) {
    await assert.rejects(buildChildEnvironment({ invocation, credential, isolationRoot: path.join(root, 'isolated'), parentEnvironment: inherited }), /INHERITED_CREDENTIAL_FALLBACK/);
  }
});

test('credential verification binds signed transition, provider identity, exact policy/resources and probe evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-credential-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setup = await createCredentialGateFixture(root, { command: 'inventory', approvalId: 'A4', policy: awsInventoryPolicy() });
  const credential = await new setup.modules.loader.PrivateCredentialLoader({ loadPrivateCredential: async () => awsInventoryCredentialSource() }).load('aws-inventory');
  const calls = [];
  const recordDirectory = path.join(root, 'verification-records');
  const recordStore = createVerificationRecordStore(recordDirectory);
  const invocationDigest = 'e'.repeat(64);
  const record = await setup.modules.verification.verifyCredential({
    manifest: setup.manifest,
    capability: setup.capability,
    invocationId: 'aws.inventory.identity',
    invocationDigest,
    credential,
    policyInspector: async ({ identityCredential, expected }) => {
      assert.equal(identityCredential.instanceId, credential.instanceId);
      return awsInventoryReadback(expected);
    },
    probeTransport: async ({ operation: op, probeId }) => {
      calls.push({ probeId, operation: op });
      return { status: 200, requestId: `fake-${probeId}` };
    },
    recordStore,
    now: () => approvalNow,
  });
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.transition, 'inventory');
  assert.equal(record.invocationId, 'aws.inventory.identity');
  assert.equal(record.invocationDigest, invocationDigest);
  assert.equal(record.credentialInstanceId, credential.instanceId);
  assert.equal(record.credentialSource, 'aws-sso-assumed-role');
  assert.equal(record.probes.length, 4);
  assert.ok(record.probes.every((probe) => probe.outcome === 'positive' && probe.requestId));
  assert.deepEqual(await recordStore.read(record.digest), record);
  assert.equal((await stat(recordDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(recordDirectory, `${record.digest}.json`))).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(record), /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|fake-access|fake-secret|fake-session/u);
  assert.equal(
    await setup.modules.verification.requireCredentialVerification({ record, recordStore, manifest: setup.manifest, capability: setup.capability, invocationId: 'aws.inventory.identity', invocationDigest, credential, now: approvalNow }),
    record,
  );
  const missingProbesContent = { ...record, probes: [] };
  const { digest: ignoredDigest, ...missingProbesRecordContent } = missingProbesContent;
  void ignoredDigest;
  const missingProbesRecord = { ...missingProbesRecordContent, digest: canonicalDigest(missingProbesRecordContent) };
  await assert.rejects(setup.modules.verification.requireCredentialVerification({
    record: missingProbesRecord,
    recordStore: { async read() { return missingProbesRecord; } },
    manifest: setup.manifest,
    capability: setup.capability,
    invocationId: 'aws.inventory.identity',
    invocationDigest,
    credential,
    now: approvalNow,
  }), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
  const forgedProbes = record.probes.map((probe, index) => index === 0 ? { ...probe, requestId: 'forged-request-id' } : probe);
  const forgedContent = { ...record, probes: forgedProbes };
  delete forgedContent.digest;
  const forgedRecord = { ...forgedContent, digest: canonicalDigest(forgedContent) };
  await assert.rejects(setup.modules.verification.requireCredentialVerification({
    record: forgedRecord,
    recordStore,
    manifest: setup.manifest,
    capability: setup.capability,
    invocationId: 'aws.inventory.identity',
    invocationDigest,
    credential,
    now: approvalNow,
  }), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
});

test('verify-credentials checks the sealed preservation checkpoint before loading credentials or probing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-preservation-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceSha256 = createHash('sha256').update('local signed-approval fixture\n').digest('hex');
  const missingCheckpoint = Symbol('missing checkpoint');
  const createSetup = async (fixtureRoot, checkpoint = { status: 'passed', path: 'evidence.txt', sha256: evidenceSha256 }) => {
    const toolDirectory = path.join(fixtureRoot, 'runtime', 'tools');
    await mkdir(toolDirectory, { recursive: true });
    const executablePath = path.join(toolDirectory, 'aws-cli');
    const executableBytes = Buffer.from('sealed fake AWS CLI image payload\n');
    await writeFile(executablePath, executableBytes, { mode: 0o700 });
    const fixtureOptions = {
      policy: awsInventoryPolicy(),
      execution: { tools: { awsCli: { path: 'tools/aws-cli', sha256: createHash('sha256').update(executableBytes).digest('hex') } }, roots: {} },
      sealArtifacts: { 'post-apply': ['evidence.txt', 'tools/aws-cli'] },
    };
    fixtureOptions.preservationCheckpoint = checkpoint === missingCheckpoint ? undefined : checkpoint;
    const fixture = await createShellGuardFixture(fixtureRoot, fixtureOptions);
    return completeCredentialGateFixture(fixture, { command: 'inventory', approvalId: 'A4' });
  };
  const validSetup = await createSetup(path.join(root, 'valid'));
  const counts = { loader: 0, inspector: 0, probes: 0, writes: 0 };
  const invoke = async (setup, services) => {
    const harnessProof = await copiedModule(setup.harness, 'proof.mjs');
    const captured = { stdout: '', stderr: '' };
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    process.stdout.write = (chunk) => { captured.stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); return true; };
    process.stderr.write = (chunk) => { captured.stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); return true; };
    try {
      const exitCode = await harnessProof.main([
        'verify-credentials', '--manifest', setup.manifestPath, '--approval', 'A4', '--invocation', 'aws.inventory.identity',
      ], { PATH: '/usr/bin:/bin' }, services);
      return { exitCode, ...captured };
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }
  };
  const cases = [
    ['missing', missingCheckpoint],
    ['failed', { status: 'failed', path: 'evidence.txt', sha256: evidenceSha256 }],
    ['path mismatch', { status: 'passed', path: 'other-evidence.txt', sha256: evidenceSha256 }],
    ['hash mismatch', { status: 'passed', path: 'evidence.txt', sha256: 'f'.repeat(64) }],
  ];
  for (const [index, [name, checkpoint]] of cases.entries()) {
    const setup = await createSetup(path.join(root, `invalid-${index}`), checkpoint);
    const credential = await new setup.modules.loader.PrivateCredentialLoader({
      loadPrivateCredential: async () => awsInventoryCredentialSource(),
    }).load('aws-inventory');
    const services = {
      credentialLoader: { async load() { counts.loader += 1; return credential; } },
      policyInspector: async ({ expected }) => { counts.inspector += 1; return awsInventoryReadback(expected); },
      probeTransport: async ({ probeId }) => { counts.probes += 1; return { status: 200, requestId: `checkpoint-${probeId}` }; },
      recordStore: { async write() { counts.writes += 1; } },
      now: () => approvalNow,
    };
    Object.assign(counts, { loader: 0, inspector: 0, probes: 0, writes: 0 });
    const result = await invoke(setup, services);
    assert.equal(result.exitCode, 2, `${name} checkpoint uses the established authorization exit code`);
    assert.match(result.stderr, /PRESERVATION_CHECKPOINT_REQUIRED/u, name);
    assert.deepEqual(counts, { loader: 0, inspector: 0, probes: 0, writes: 0 }, `${name} checkpoint stops before every credential or probe service`);

    if (name === 'failed') {
      const failedManifest = setup.manifest;
      const directCapability = setup.capability;
      const directCounts = { inspector: 0, probes: 0, writes: 0 };
      await assert.rejects(setup.modules.verification.verifyCredential({
        manifest: failedManifest,
        capability: directCapability,
        invocationId: 'aws.inventory.identity',
        invocationDigest: 'e'.repeat(64),
        credential,
        policyInspector: async () => { directCounts.inspector += 1; return {}; },
        probeTransport: async () => { directCounts.probes += 1; return { status: 200, requestId: 'should-not-run' }; },
        recordStore: { async write() { directCounts.writes += 1; } },
        now: () => approvalNow,
      }), /PRESERVATION_CHECKPOINT_REQUIRED/u);
      assert.deepEqual(directCounts, { inspector: 0, probes: 0, writes: 0 }, 'direct verification also stops before inspection and probes');
    }
  }

  const validCredential = await new validSetup.modules.loader.PrivateCredentialLoader({
    loadPrivateCredential: async () => awsInventoryCredentialSource(),
  }).load('aws-inventory');
  const validServices = {
    credentialLoader: { async load() { counts.loader += 1; return validCredential; } },
    policyInspector: async ({ expected }) => { counts.inspector += 1; return awsInventoryReadback(expected); },
    probeTransport: async ({ probeId }) => { counts.probes += 1; return { status: 200, requestId: `checkpoint-${probeId}` }; },
    recordStore: { async write() { counts.writes += 1; } },
    now: () => approvalNow,
  };
  Object.assign(counts, { loader: 0, inspector: 0, probes: 0, writes: 0 });
  const positiveControl = await invoke(validSetup, validServices);
  assert.equal(positiveControl.exitCode, 0, positiveControl.stderr);
  assert.deepEqual(counts, { loader: 1, inspector: 1, probes: 4, writes: 1 }, 'a valid sealed checkpoint permits normal verification');
});

test('credential renewal, policy drift, seal drift and stale verification each close the execution gate', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-stale-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setup = await createCredentialGateFixture(root, { command: 'inventory', approvalId: 'A4', policy: awsInventoryPolicy() });
  const credential = await new setup.modules.loader.PrivateCredentialLoader({ loadPrivateCredential: async () => awsInventoryCredentialSource() }).load('aws-inventory');
  const record = await makeAwsInventoryRecord(setup, credential);
  const verify = (candidate, manifest = setup.manifest, now = approvalNow) => setup.modules.verification.requireCredentialVerification({
    record, recordStore: setup.recordStore, manifest, capability: setup.capability, invocationId: 'aws.inventory.identity',
    invocationDigest: 'e'.repeat(64), credential: candidate, now,
  });
  await assert.rejects(verify({ ...credential, instanceId: 'aws-session-renewed-0002' }), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
  await assert.rejects(verify({ ...credential, policyDigests: { ...credential.policyDigests, boundary: 'f'.repeat(64) } }), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
  await assert.rejects(verify(credential, { ...setup.manifest, activeSealDigest: 'f'.repeat(64) }), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
  await assert.rejects(verify(credential, setup.manifest, approvalNow + 6 * 60 * 1000), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
  await assert.rejects(verify({ ...credential, expiresAt: '2026-10-18T00:00:10.000Z' }, setup.manifest, approvalNow), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
});

test('wrong account, bucket, distribution, zone and preserved-resource grants fail credential verification', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-scope-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setup = await createCredentialGateFixture(root, { command: 'bootstrap-aws', approvalId: 'A5', policy: awsProvisionerPolicy() });
  const source = awsProvisionerCredentialSource();
  const credential = await new setup.modules.loader.PrivateCredentialLoader({ loadPrivateCredential: async () => source }).load('aws-provisioner');
  const verifyWith = (readback) => setup.modules.verification.verifyCredential({
    manifest: setup.manifest, capability: setup.capability, invocationId: 'aws.provisioner.plan',
    invocationDigest: 'd'.repeat(64), credential, policyInspector: async () => readback,
    probeTransport: async () => ({ status: 200 }), recordStore: { async write() {} }, now: () => approvalNow,
  });
  await assert.rejects(new setup.modules.loader.PrivateCredentialLoader({
    loadPrivateCredential: async () => ({ ...source, accountId: '9ac354c8aa31d424224d8c4f3aa8ba2a' }), now: () => approvalNow,
  }).load('aws-provisioner'), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
  await assert.rejects(verifyWith(awsProvisionerReadback(setup.manifest.policy.credentialExpectations['aws-provisioner'], {
    bucketArn: 'arn:aws:s3:::artifact-pages-231136241959-us-east-1',
  })), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
  await assert.rejects(verifyWith(awsProvisionerReadback(setup.manifest.policy.credentialExpectations['aws-provisioner'], {
    distributionArn: 'arn:aws:cloudfront::231136241959:distribution/ECFTIR5GVPQDF',
  })), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);

  const objectScopedPolicy = awsProvisionerPolicy();
  const preservedObjectArn = 'arn:aws:s3:::artifact-pages-231136241959-us-east-1/evidence/existing-object.json';
  objectScopedPolicy.credentialExpectations['aws-provisioner'].resourceBindings.bucketArn = preservedObjectArn;
  const objectSetup = await createCredentialGateFixture(path.join(root, 'preserved-object'), {
    command: 'bootstrap-aws', approvalId: 'A5', policy: objectScopedPolicy,
  });
  const objectExpected = objectSetup.manifest.policy.credentialExpectations['aws-provisioner'];
  const objectCredential = await new objectSetup.modules.loader.PrivateCredentialLoader({
    loadPrivateCredential: async () => awsProvisionerCredentialSource({ resourceBindings: structuredClone(objectExpected.resourceBindings) }),
    now: () => approvalNow,
  }).load('aws-provisioner');
  await assert.rejects(objectSetup.modules.verification.verifyCredential({
    manifest: objectSetup.manifest,
    capability: objectSetup.capability,
    invocationId: 'aws.provisioner.plan',
    invocationDigest: 'd'.repeat(64),
    credential: objectCredential,
    policyInspector: async () => awsProvisionerReadback(objectExpected),
    probeTransport: async () => ({ status: 200 }),
    recordStore: { async write() {} },
    now: () => approvalNow,
  }), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);

  const cloudflarePolicy = cloudflareWriterPolicy();
  const cloudflareSetup = await createCredentialGateFixture(path.join(root, 'cloudflare'), { command: 'delivery:cloudflare', approvalId: 'A6', policy: cloudflarePolicy });
  const cloudflareSource = cloudflareWriterCredentialSource();
  const cloudflareCredential = await new cloudflareSetup.modules.loader.PrivateCredentialLoader({ loadPrivateCredential: async () => cloudflareSource, now: () => approvalNow }).load('cloudflare-site-a-writer');
  const expected = cloudflareSetup.manifest.policy.credentialExpectations['cloudflare-site-a-writer'];
  await assert.rejects(cloudflareSetup.modules.verification.verifyCredential({
    manifest: cloudflareSetup.manifest,
    capability: cloudflareSetup.capability,
    invocationId: 'cloudflare.delivery.site-a',
    invocationDigest: 'c'.repeat(64),
    credential: cloudflareCredential,
    policyInspector: async () => cloudflareWriterReadback(expected, { zoneId: 'wrong-zone' }),
    probeTransport: async () => ({ status: 200 }),
    recordStore: { async write() {} },
    now: () => approvalNow,
  }), /LEAST_PRIVILEGE_CREDENTIALS_REQUIRED/);
});

test('hosted OIDC delivery credentials are policy-read and probed before the write invocation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-hosted-oidc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = awsSatellitePolicy();
  const setup = await createCredentialGateFixture(root, { command: 'delivery:aws', approvalId: 'A5', policy });
  const source = awsSatelliteCredentialSource();
  const credential = await new setup.modules.loader.PrivateCredentialLoader({
    loadPrivateCredential: async () => source,
    now: () => approvalNow,
  }).load('aws-satellite-a');
  const record = await setup.modules.verification.verifyCredential({
    manifest: setup.manifest,
    capability: setup.capability,
    invocationId: 'aws.delivery.site-a',
    invocationDigest: '8'.repeat(64),
    credential,
    policyInspector: async ({ expected, identityCredential }) => {
      assert.equal(identityCredential.credentialSource, 'github-actions-oidc');
      return {
        identity: { accountId: expected.accountId, roleArn: expected.roleArn, principalArn: source.principalArn },
        policyDigests: structuredClone(expected.policyDigests),
        resourceBindings: structuredClone(expected.resourceBindings),
      };
    },
    probeTransport: async ({ probeId }) => {
      const definition = PROBE_DEFINITIONS.find((probe) => probe.id === probeId);
      return definition.kind === 'positive'
        ? { status: 200, requestId: `hosted-positive-${probeId}` }
        : { status: 403, errorCode: 'AccessDenied', requestId: `hosted-denied-${probeId}` };
    },
    recordStore: { async write() {} },
    now: () => approvalNow,
  });
  assert.equal(record.credentialSource, 'github-actions-oidc');
  assert.equal(record.identity.roleArn, policy.credentialExpectations['aws-satellite-a'].roleArn);
  assert.ok(record.probes.some((probe) => probe.id === 'aws.publisher.neighbor-index-denied' && probe.outcome === 'denied'));
  assert.doesNotMatch(JSON.stringify(record), /fake-secret|fake-session/u);
});

test('negative probes require a provider authorization response; 404, timeout and malformed results do not pass', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-negative-probes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setup = await createCredentialGateFixture(root, { command: 'bootstrap-aws', approvalId: 'A5', policy: awsProvisionerPolicy() });
  const credential = await new setup.modules.loader.PrivateCredentialLoader({ loadPrivateCredential: async () => awsProvisionerCredentialSource() }).load('aws-provisioner');
  const expected = setup.manifest.policy.credentialExpectations['aws-provisioner'];
  const verify = (responseFor) => setup.modules.verification.verifyCredential({
    manifest: setup.manifest,
    capability: setup.capability,
    invocationId: 'aws.provisioner.plan',
    invocationDigest: 'd'.repeat(64),
    credential,
    policyInspector: async () => awsProvisionerReadback(expected),
    probeTransport: async ({ probeId }) => responseFor(probeId),
    recordStore: { async write() {} },
    now: () => approvalNow,
  });
  await assert.rejects(verify((probeId) => probeId === 'aws.provisioner.preserved-object-denied'
    ? { status: 404, errorCode: 'NoSuchKey', requestId: 'not-a-denial' }
    : { status: 200, requestId: 'positive-control' }), /NEGATIVE_PROBE_NOT_DENIED/);
  await assert.rejects(verify((probeId) => probeId === 'aws.provisioner.preserved-object-denied'
    ? { status: 403, errorCode: 'AccessDenied', requestId: 'denied' }
    : probeId === 'aws.provisioner.preserved-distribution-denied' ? null : { status: 200 }), /PROBE_RESULT_INVALID/);
  let storedAfterTimeout = false;
  await assert.rejects(setup.modules.verification.verifyCredential({
    manifest: setup.manifest,
    capability: setup.capability,
    invocationId: 'aws.provisioner.plan',
    invocationDigest: 'd'.repeat(64),
    credential,
    policyInspector: async () => awsProvisionerReadback(expected),
    probeTransport: async () => new Promise(() => {}),
    probeTimeoutMs: 5,
    recordStore: { async write() { storedAfterTimeout = true; } },
    now: () => approvalNow,
  }), /PROBE_TIMEOUT/);
  assert.equal(storedAfterTimeout, false);
  assert.ok(PROBE_DEFINITIONS.filter((probe) => /(?:PutObject|DeleteObject|DeleteObjects)/u.test(probe.operation)).every((probe) => probe.stage === 'canary'));
  assert.ok(PROBE_DEFINITIONS.filter((probe) => probe.provider === 'aws' && probe.credentialClass !== 'aws-inventory'
    && probe.targetRef === 'awsPreservedBucket').every((probe) => probe.operation === 'ListBucket' && probe.expectedErrorCode === 'AccessDenied'));
});

test('supervised launcher accepts only the sealed descriptor and terminates recorded container children', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  const toolDirectory = path.join(runtime, 'tools');
  await mkdir(toolDirectory, { recursive: true });
  const executablePath = path.join(toolDirectory, 'aws-cli');
  const executableBytes = Buffer.from('sealed fake AWS CLI image payload\n');
  await writeFile(executablePath, executableBytes, { mode: 0o700 });
  const base = await createShellGuardFixture(root, {
    policy: awsInventoryPolicy(),
    execution: { tools: { awsCli: { path: 'tools/aws-cli', sha256: createHash('sha256').update(executableBytes).digest('hex') } }, roots: {} },
    sealArtifacts: { 'post-apply': ['evidence.txt', 'tools/aws-cli'] },
  });
  const setup = await completeCredentialGateFixture(base, { command: 'inventory', approvalId: 'A4' });
  const invocation = await setup.modules.launcher.resolveInvocation('aws.inventory.identity', {
    runtimeRoot: setup.runtime, manifest: setup.manifest, activeSeal: setup.activeSeal,
  });
  const credential = await new setup.modules.loader.PrivateCredentialLoader({ loadPrivateCredential: async () => awsInventoryCredentialSource() }).load('aws-inventory');
  const fakeSecret = 'proof!"\\/雪☃';
  const longerFakeSecret = `${fakeSecret}-extended`;
  const redactionCredential = {
    ...credential,
    environment: {
      ...credential.environment,
      AWS_SESSION_TOKEN: fakeSecret,
      AWS_SECRET_ACCESS_KEY: longerFakeSecret,
    },
  };
  const record = await makeAwsInventoryRecord(setup, credential, invocation.invocationDigest);
  assert.equal(requireSealedPreservationCheckpoint(setup.manifest), setup.manifest.preservationCheckpoint.sha256);
  assert.throws(() => requireSealedPreservationCheckpoint({ ...setup.manifest, preservationCheckpoint: undefined }), /PRESERVATION_CHECKPOINT_REQUIRED/);
  assert.throws(() => requireSealedPreservationCheckpoint({
    ...setup.manifest,
    preservationCheckpoint: { ...setup.manifest.preservationCheckpoint, sha256: 'f'.repeat(64) },
  }), /PRESERVATION_CHECKPOINT_REQUIRED/);

  const exhaustedManifest = { ...setup.manifest, usage: { ...setup.manifest.usage, requests: setup.manifest.caps.requests } };
  const exhaustedCapability = { ...setup.capability, manifest: exhaustedManifest };
  let launchedAfterExhaustion = false;
  await assert.rejects(setup.modules.launcher.runSupervisedInvocation({
    invocation,
    manifest: exhaustedManifest,
    capability: exhaustedCapability,
    credential: redactionCredential,
    verificationRecord: record,
    recordStore: setup.recordStore,
    parentEnvironment: { PATH: '/usr/bin:/bin' },
    launchContainer: async () => { launchedAfterExhaustion = true; },
    now: () => approvalNow,
  }), /CAP_EXHAUSTED/);
  assert.equal(launchedAfterExhaustion, false);

  let launchedResolve;
  const launched = new Promise((resolve) => { launchedResolve = resolve; });
  const child = new EventEmitter();
  child.pid = 993821;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const signals = [];
  const killGroup = async (candidate, signal) => {
    signals.push(signal);
    candidate.emit('close', null, signal);
  };
  const run = setup.modules.launcher.runSupervisedInvocation({
    invocation: { ...invocation, argv: ['s3api', 'delete-bucket', '--bucket', 'artifact-pages-231136241959-us-east-1'] },
    manifest: setup.manifest,
    capability: setup.capability,
    credential,
    verificationRecord: record,
    recordStore: setup.recordStore,
    parentEnvironment: { PATH: '/usr/bin:/bin' },
    launchContainer: async () => {
      launchedResolve();
      return child;
    },
    killGroup,
    now: () => approvalNow,
  });
  await assert.rejects(run, /INVOCATION_DESCRIPTOR_CHANGED/);
  assert.deepEqual(signals, [], 'tampered argv was rejected before the container adapter ran');

  let actualChild = new EventEmitter();
  actualChild.pid = 993822;
  actualChild.stdout = new PassThrough();
  actualChild.stderr = new PassThrough();
  let runPromise = setup.modules.launcher.runSupervisedInvocation({
    invocation,
    manifest: setup.manifest,
    capability: setup.capability,
    credential: redactionCredential,
    verificationRecord: record,
    recordStore: setup.recordStore,
    parentEnvironment: { PATH: '/usr/bin:/bin' },
    launchContainer: async ({ shell, readOnlyInputs, hostCredentials, dockerSocket }) => {
      assert.equal(shell, false);
      assert.equal(readOnlyInputs, true);
      assert.equal(hostCredentials, false);
      assert.equal(dockerSocket, false);
      launchedResolve();
      return actualChild;
    },
    killGroup,
    now: () => approvalNow,
  });
  const childExit = assert.rejects(runPromise, /CHILD_EXITED_NONZERO/);
  await launched;
  const secretForms = (secret) => {
    const jsonSecret = JSON.stringify(secret).slice(1, -1);
    const mixedUnicodeSecret = [...secret].map((character, index) => index % 2 === 0
      ? character
      : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`).join('');
    return [
      secret,
      encodeURIComponent(secret),
      new URLSearchParams([['value', secret]]).toString().slice('value='.length),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
      Buffer.from(secret, 'utf8').toString('hex'),
      Buffer.from(secret, 'utf8').toString('hex').toUpperCase(),
      jsonSecret,
      jsonSecret.replaceAll('/', '\\/'),
      secret.replaceAll('/', '\\/'),
      mixedUnicodeSecret,
    ];
  };
  const encodedFakeSecrets = [...new Set([fakeSecret, longerFakeSecret].flatMap(secretForms))];
  const stdoutPayload = `fake child stdout before ${encodedFakeSecrets.join(' ')} after\n`;
  const stderrPayload = `fake child stderr before ${encodedFakeSecrets.join(' ')} after\n`;
  const splitChunks = (stream, payload) => {
    const rawSecretOffset = payload.indexOf(fakeSecret);
    const splitOffset = rawSecretOffset + Math.min(5, fakeSecret.length - 1);
    stream.write(payload.slice(0, splitOffset));
    stream.write(payload.slice(splitOffset));
  };
  splitChunks(actualChild.stdout, stdoutPayload);
  splitChunks(actualChild.stderr, stderrPayload);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await setup.modules.launcher.terminateActiveChildren(killGroup), 1);
  await childExit;
  const capturedStdout = await readFile(path.join(setup.runtime, invocation.descriptor.captures.stdout), 'utf8');
  const capturedStderr = await readFile(path.join(setup.runtime, invocation.descriptor.captures.stderr), 'utf8');
  for (const [stream, captured] of [['stdout', capturedStdout], ['stderr', capturedStderr]]) {
    assert.match(captured, new RegExp(`fake child ${stream} before \\[REDACTED\\]`, 'u'));
    assert.match(captured, / after\n/u);
    for (const secretForm of encodedFakeSecrets) assert.ok(!captured.includes(secretForm), `${stream} redacts multiple overlapping secrets in encoded forms`);
  }
  assert.equal(setup.manifest.usage.requests, 1);
  assert.equal(setup.manifest.usage.operatorMinutes, 1);
  const reservationFiles = await readdir(path.join(setup.runtime, 'usage-reservations'));
  assert.equal(reservationFiles.filter((filename) => filename.endsWith('.json')).length, 1);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.doesNotThrow(() => setup.modules.launcher.assertNoActiveChildren());
});

test('supervisor enforces each 4 MiB capture boundary and allows usage reservations exactly at both caps', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-capture-cap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setup = await createSupervisedFixture(root, { caps: { requests: 4, bytes: 1000, operatorMinutes: 4 } });
  const maxBytes = 4 * 1024 * 1024;
  const capture = (stream) => path.join(setup.runtime, setup.invocation.descriptor.captures[stream]);

  for (const [index, stream] of ['stdout', 'stderr'].entries()) {
    if (index > 0) {
      await rm(capture('stdout'), { force: true });
      await rm(capture('stderr'), { force: true });
    }
    const { child, promise } = await startFakeInvocation(setup, {
      pid: 994100 + index,
      killGroup: async () => assert.fail('an in-limit child must not be stopped'),
    });
    child[stream].write(Buffer.alloc(maxBytes, 0x41));
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0, null);
    await promise;
    assert.equal((await stat(capture(stream))).size, maxBytes, `${stream} at the exact cap is captured`);
  }

  for (const [index, stream] of ['stdout', 'stderr'].entries()) {
    await rm(capture('stdout'), { force: true });
    await rm(capture('stderr'), { force: true });
    const signals = [];
    const { child, promise } = await startFakeInvocation(setup, {
      pid: 994110 + index,
      killGroup: async (candidate, signal) => { signals.push(signal); candidate.emit('close', null, signal); },
    });
    const outputFailure = assert.rejects(promise, /CHILD_OUTPUT_LIMIT_EXCEEDED/u);
    child[stream].write(Buffer.alloc(maxBytes + 1, 0x42));
    await outputFailure;
    assert.deepEqual(signals, ['SIGTERM'], `${stream} overflow immediately starts bounded termination`);
    await assert.rejects(stat(capture('stdout')), { code: 'ENOENT' });
    await assert.rejects(stat(capture('stderr')), { code: 'ENOENT' });
  }

  assert.equal(setup.manifest.usage.requests, 4, 'the request cap is inclusive');
  assert.equal(setup.manifest.usage.operatorMinutes, 4, 'the operator-minute cap is inclusive');
  const reservationDirectory = path.join(setup.runtime, 'usage-reservations');
  assert.equal((await readdir(reservationDirectory)).filter((filename) => filename.endsWith('.json')).length, 4);
  let launchesAfterCap = 0;
  await assert.rejects(setup.modules.launcher.runSupervisedInvocation({
    invocation: setup.invocation,
    manifest: setup.manifest,
    capability: setup.capability,
    credential: setup.credential,
    verificationRecord: setup.record,
    recordStore: setup.recordStore,
    parentEnvironment: { PATH: '/usr/bin:/bin' },
    launchContainer: async () => { launchesAfterCap += 1; return createFakeChild(994120); },
    now: () => approvalNow,
  }), /CAP_EXHAUSTED/u);
  assert.equal(launchesAfterCap, 0, 'exceeding the reservation cap is rejected before launch');
  assert.doesNotThrow(() => setup.modules.launcher.assertNoActiveChildren());
});

test('supervisor escalates deadlines and retains children until close is observed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-deadline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setup = await createSupervisedFixture(root);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const advance = async (milliseconds) => {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(milliseconds);
    await new Promise((resolve) => setImmediate(resolve));
  };

  const termSignals = [];
  const termExit = await startFakeInvocation(setup, {
    pid: 994201,
    killGroup: async (child, signal) => { termSignals.push(signal); if (signal === 'SIGTERM') child.emit('close', null, signal); },
  });
  const termFailure = assert.rejects(termExit.promise, /CHILD_DEADLINE_EXCEEDED/u);
  await advance(setup.invocation.timeoutMs);
  await termFailure;
  assert.deepEqual(termSignals, ['SIGTERM']);
  assert.doesNotThrow(() => setup.modules.launcher.assertNoActiveChildren());

  await rm(path.join(setup.runtime, setup.invocation.descriptor.captures.stdout), { force: true });
  await rm(path.join(setup.runtime, setup.invocation.descriptor.captures.stderr), { force: true });
  const killSignals = [];
  const killExit = await startFakeInvocation(setup, {
    pid: 994202,
    killGroup: async (child, signal) => { killSignals.push(signal); if (signal === 'SIGKILL') child.emit('close', null, signal); },
  });
  const killFailure = assert.rejects(killExit.promise, /CHILD_DEADLINE_EXCEEDED/u);
  await advance(setup.invocation.timeoutMs);
  await advance(500);
  await killFailure;
  assert.deepEqual(killSignals, ['SIGTERM', 'SIGKILL']);
  assert.doesNotThrow(() => setup.modules.launcher.assertNoActiveChildren());

  await rm(path.join(setup.runtime, setup.invocation.descriptor.captures.stdout), { force: true });
  await rm(path.join(setup.runtime, setup.invocation.descriptor.captures.stderr), { force: true });
  const stuckSignals = [];
  const stuck = await startFakeInvocation(setup, {
    pid: 994203,
    killGroup: async (_child, signal) => { stuckSignals.push(signal); },
  });
  const stuckFailure = assert.rejects(stuck.promise, /CHILD_CLOSE_TIMEOUT/u);
  await advance(setup.invocation.timeoutMs);
  await advance(500);
  await advance(500);
  await stuckFailure;
  assert.deepEqual(stuckSignals, ['SIGTERM', 'SIGKILL']);
  assert.throws(() => setup.modules.launcher.assertNoActiveChildren(), /RECORDED_CHILDREN_REMAIN/u);

  const cleanupFailure = assert.rejects(setup.modules.launcher.terminateActiveChildren(async (_child, signal) => {
    stuckSignals.push(signal);
  }), /CHILD_CLOSE_TIMEOUT/u);
  await advance(500);
  await advance(500);
  await cleanupFailure;
  assert.deepEqual(stuckSignals, ['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL']);
  assert.throws(() => setup.modules.launcher.assertNoActiveChildren(), /RECORDED_CHILDREN_REMAIN/u);
  stuck.child.emit('close', null, 'SIGKILL');
  assert.doesNotThrow(() => setup.modules.launcher.assertNoActiveChildren(), 'a later close event clears child tracking');
});

test('supervisor preserves the first termination cause, lets close timeout win, and clears grace timers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-termination-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setup = await createSupervisedFixture(root, { caps: { requests: 5, bytes: 1000, operatorMinutes: 5 } });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const fakeSetTimeout = globalThis.setTimeout;
  const fakeClearTimeout = globalThis.clearTimeout;
  const pendingTimers = new Map();
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    let timer;
    timer = fakeSetTimeout((...callbackArgs) => {
      pendingTimers.delete(timer);
      callback(...callbackArgs);
    }, milliseconds, ...args);
    pendingTimers.set(timer, milliseconds);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    pendingTimers.delete(timer);
    return fakeClearTimeout(timer);
  };
  t.after(() => {
    globalThis.setTimeout = fakeSetTimeout;
    globalThis.clearTimeout = fakeClearTimeout;
  });

  const maxBytes = 4 * 1024 * 1024;
  const captureFiles = Object.values(setup.invocation.descriptor.captures).map((capture) => path.join(setup.runtime, capture));
  const removeCaptures = async () => Promise.all(captureFiles.map((filename) => rm(filename, { force: true })));
  const assertCapturesAbsent = async () => {
    for (const filename of captureFiles) await assert.rejects(stat(filename), { code: 'ENOENT' });
  };
  const advance = async (milliseconds) => {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(milliseconds);
    await new Promise((resolve) => setImmediate(resolve));
  };

  const deadlineSignals = [];
  const deadlineFirst = await startFakeInvocation(setup, {
    pid: 994211,
    killGroup: async (child, signal) => {
      deadlineSignals.push(signal);
      if (signal === 'SIGKILL') child.emit('close', null, signal);
    },
  });
  const deadlineFailure = assert.rejects(deadlineFirst.promise, /CHILD_DEADLINE_EXCEEDED/u);
  await advance(setup.invocation.timeoutMs);
  deadlineFirst.child.stdout.write(Buffer.alloc(maxBytes + 1, 0x43));
  await advance(500);
  await deadlineFailure;
  assert.deepEqual(deadlineSignals, ['SIGTERM', 'SIGKILL']);
  await assertCapturesAbsent();

  await removeCaptures();
  const outputSignals = [];
  const outputFirst = await startFakeInvocation(setup, {
    pid: 994212,
    killGroup: async (child, signal) => {
      outputSignals.push(signal);
      if (signal === 'SIGKILL') child.emit('close', null, signal);
    },
  });
  const outputFailure = assert.rejects(outputFirst.promise, /CHILD_OUTPUT_LIMIT_EXCEEDED/u);
  outputFirst.child.stderr.write(Buffer.alloc(maxBytes + 1, 0x44));
  await advance(500);
  await outputFailure;
  assert.deepEqual(outputSignals, ['SIGTERM', 'SIGKILL']);
  await assertCapturesAbsent();

  await removeCaptures();
  const stuckSignals = [];
  const stuckOverflow = await startFakeInvocation(setup, {
    pid: 994213,
    killGroup: async (_child, signal) => { stuckSignals.push(signal); },
  });
  const closeFailure = assert.rejects(stuckOverflow.promise, /CHILD_CLOSE_TIMEOUT/u);
  stuckOverflow.child.stdout.write(Buffer.alloc(maxBytes + 1, 0x45));
  await advance(500);
  await advance(500);
  await closeFailure;
  assert.deepEqual(stuckSignals, ['SIGTERM', 'SIGKILL']);
  await assertCapturesAbsent();
  assert.throws(() => setup.modules.launcher.assertNoActiveChildren(), /RECORDED_CHILDREN_REMAIN/u);
  stuckOverflow.child.emit('close', null, 'SIGKILL');
  assert.doesNotThrow(() => setup.modules.launcher.assertNoActiveChildren());

  const closeSignals = [];
  const closeBeforeGrace = await startFakeInvocation(setup, {
    pid: 994214,
    killGroup: async (child, signal) => {
      closeSignals.push(signal);
      child.emit('close', null, signal);
    },
  });
  const closeExitFailure = assert.rejects(closeBeforeGrace.promise, /CHILD_EXITED_NONZERO/u);
  assert.equal(await setup.modules.launcher.terminateActiveChildren(async (child, signal) => {
    closeSignals.push(signal);
    child.emit('close', null, signal);
  }), 1);
  await closeExitFailure;
  assert.deepEqual(closeSignals, ['SIGTERM']);
  assert.equal([...pendingTimers.values()].filter((milliseconds) => milliseconds === 500).length, 0,
    'no 500 ms grace timer remains pending after close wins');
});

test('usage reservations remain consumed after spawn failure and timeout, including after manifest reload', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-reservation-failures-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const caps = { requests: 1, bytes: 1000, operatorMinutes: 1 };
  const spawnSetup = await createSupervisedFixture(path.join(root, 'spawn'), { caps });
  const initialUsage = structuredClone(spawnSetup.manifest.usage);
  await assert.rejects(spawnSetup.modules.launcher.runSupervisedInvocation({
    invocation: spawnSetup.invocation,
    manifest: spawnSetup.manifest,
    capability: spawnSetup.capability,
    credential: spawnSetup.credential,
    verificationRecord: spawnSetup.record,
    recordStore: spawnSetup.recordStore,
    parentEnvironment: { PATH: '/usr/bin:/bin' },
    launchContainer: async () => { throw new Error('fake spawn failure'); },
    now: () => approvalNow,
  }), /CHILD_SPAWN_FAILED/u);
  assert.deepEqual(spawnSetup.manifest.usage, { requests: 1, bytes: 0, operatorMinutes: 1 });
  const spawnReload = { ...spawnSetup.manifest, usage: initialUsage };
  const spawnReloadCapability = { ...spawnSetup.capability, manifest: spawnReload };
  let launchAfterSpawnReload = 0;
  await assert.rejects(spawnSetup.modules.launcher.runSupervisedInvocation({
    invocation: spawnSetup.invocation,
    manifest: spawnReload,
    capability: spawnReloadCapability,
    credential: spawnSetup.credential,
    verificationRecord: spawnSetup.record,
    recordStore: spawnSetup.recordStore,
    parentEnvironment: { PATH: '/usr/bin:/bin' },
    launchContainer: async () => { launchAfterSpawnReload += 1; return createFakeChild(994301); },
    now: () => approvalNow,
  }), /CAP_EXHAUSTED/u);
  assert.equal(launchAfterSpawnReload, 0, 'the persisted spawn-failure reservation closes the reloaded manifest');

  const timeoutSetup = await createSupervisedFixture(path.join(root, 'timeout'), { caps });
  const timeoutInitialUsage = structuredClone(timeoutSetup.manifest.usage);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  const timed = await startFakeInvocation(timeoutSetup, {
    pid: 994302,
    killGroup: async (child, signal) => { signals.push(signal); if (signal === 'SIGTERM') child.emit('close', null, signal); },
  });
  const timeoutFailure = assert.rejects(timed.promise, /CHILD_DEADLINE_EXCEEDED/u);
  t.mock.timers.tick(timeoutSetup.invocation.timeoutMs);
  await new Promise((resolve) => setImmediate(resolve));
  await timeoutFailure;
  assert.deepEqual(signals, ['SIGTERM']);
  assert.deepEqual(timeoutSetup.manifest.usage, { requests: 1, bytes: 0, operatorMinutes: 1 });
  const timeoutReload = { ...timeoutSetup.manifest, usage: timeoutInitialUsage };
  const timeoutReloadCapability = { ...timeoutSetup.capability, manifest: timeoutReload };
  let launchAfterTimeoutReload = 0;
  await assert.rejects(timeoutSetup.modules.launcher.runSupervisedInvocation({
    invocation: timeoutSetup.invocation,
    manifest: timeoutReload,
    capability: timeoutReloadCapability,
    credential: timeoutSetup.credential,
    verificationRecord: timeoutSetup.record,
    recordStore: timeoutSetup.recordStore,
    parentEnvironment: { PATH: '/usr/bin:/bin' },
    launchContainer: async () => { launchAfterTimeoutReload += 1; return createFakeChild(994303); },
    now: () => approvalNow,
  }), /CAP_EXHAUSTED/u);
  assert.equal(launchAfterTimeoutReload, 0, 'the persisted timeout reservation is included after manifest reload');
  assert.doesNotThrow(() => timeoutSetup.modules.launcher.assertNoActiveChildren());
});

test('proof.mjs and policy.mjs have no direct child_process dependency', async () => {
  const forbidden = [
    /\bimport\b[^\n]*\bfrom\s*['"](?:node:)?child_process['"]/u,
    /\bexport\b[^\n]*\bfrom\s*['"](?:node:)?child_process['"]/u,
    /\bimport\s*\(\s*['"](?:node:)?child_process['"]\s*\)/u,
    /\brequire\s*\(\s*['"](?:node:)?child_process['"]\s*\)/u,
  ];
  for (const filename of ['proof.mjs', 'policy.mjs']) {
    const source = await readFile(new URL(`./${filename}`, import.meta.url), 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${filename} should not load child_process directly`);
  }
});

async function createCredentialGateFixture(root, { command, approvalId, policy }) {
  const fixture = await createShellGuardFixture(root, { policy });
  return completeCredentialGateFixture(fixture, { command, approvalId });
}

async function createSupervisedFixture(root, { caps } = {}) {
  const runtime = path.join(root, 'runtime');
  const toolDirectory = path.join(runtime, 'tools');
  await mkdir(toolDirectory, { recursive: true });
  const executablePath = path.join(toolDirectory, 'aws-cli');
  const executableBytes = Buffer.from('sealed fake AWS CLI image payload\n');
  await writeFile(executablePath, executableBytes, { mode: 0o700 });
  const fixture = await createShellGuardFixture(root, {
    policy: awsInventoryPolicy(),
    ...(caps ? { caps } : {}),
    execution: { tools: { awsCli: { path: 'tools/aws-cli', sha256: createHash('sha256').update(executableBytes).digest('hex') } }, roots: {} },
    sealArtifacts: { 'post-apply': ['evidence.txt', 'tools/aws-cli'] },
  });
  const setup = await completeCredentialGateFixture(fixture, { command: 'inventory', approvalId: 'A4' });
  const invocation = await setup.modules.launcher.resolveInvocation('aws.inventory.identity', {
    runtimeRoot: setup.runtime, manifest: setup.manifest, activeSeal: setup.activeSeal,
  });
  const credential = await new setup.modules.loader.PrivateCredentialLoader({
    loadPrivateCredential: async () => awsInventoryCredentialSource(),
  }).load('aws-inventory');
  const record = await makeAwsInventoryRecord(setup, credential, invocation.invocationDigest);
  return { ...setup, invocation, credential, record };
}

function createFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

async function startFakeInvocation(setup, { pid, killGroup, manifest = setup.manifest, capability = setup.capability }) {
  let resolveLaunched;
  const launched = new Promise((resolve) => { resolveLaunched = resolve; });
  const child = createFakeChild(pid);
  const promise = setup.modules.launcher.runSupervisedInvocation({
    invocation: setup.invocation,
    manifest,
    capability,
    credential: setup.credential,
    verificationRecord: setup.record,
    recordStore: setup.recordStore,
    parentEnvironment: { PATH: '/usr/bin:/bin' },
    launchContainer: async () => { resolveLaunched(); return child; },
    killGroup,
    now: () => approvalNow,
  });
  await launched;
  await new Promise((resolve) => setImmediate(resolve));
  return { child, promise };
}

async function completeCredentialGateFixture(fixture, { command, approvalId }) {
  if (!(approvalId === 'A5' && command === 'delivery:aws')) await fixture.addApproval(approvalId, command);
  const [seals, copiedPolicy, verification, loader, launcher, registry] = await Promise.all([
    copiedModule(fixture.harness, 'seals.mjs'),
    copiedModule(fixture.harness, 'policy.mjs'),
    copiedModule(fixture.harness, 'credential-verification.mjs'),
    copiedModule(fixture.harness, 'credential-loader.mjs'),
    copiedModule(fixture.harness, 'launcher.mjs'),
    copiedModule(fixture.harness, 'invocation-registry.mjs'),
  ]);
  const activeSeal = await seals.requireActiveSeal(fixture.manifestPath);
  const rawManifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'));
  const manifest = { ...rawManifest, activeSealDigest: activeSeal.digest, activeSeal, sealChainVerified: true };
  const approval = await seals.verifyApprovalFile({ manifestPath: fixture.manifestPath, approvalId, command, now: approvalNow });
  const capability = copiedPolicy.resolveCommandCapability(command, manifest, approval, approvalNow);
  return { ...fixture, modules: { seals, policy: copiedPolicy, verification, loader, launcher, registry }, manifest, capability, activeSeal };
}

function awsInventoryPolicy() {
  const roleArn = 'arn:aws:iam::231136241959:role/ap-proof-20261018-inventory';
  const policyDigests = { identity: 'a'.repeat(64), inlinePolicy: 'b'.repeat(64), boundary: 'c'.repeat(64) };
  const resourceBindings = {
    roleArn,
    bucketArns: [
      'arn:aws:s3:::artifact-pages-231136241959-us-east-1',
      'arn:aws:s3:::ap-proof-231136241959-20261018',
    ],
    distributionArns: [
      'arn:aws:cloudfront::231136241959:distribution/ECFTIR5GVPQDF',
      'arn:aws:cloudfront::231136241959:distribution/E2PROOF20261018',
    ],
  };
  return {
    version: 1,
    denyByDefault: true,
    credentialExpectations: {
      'aws-inventory': { provider: 'aws', accountId: '231136241959', roleArn, policyDigests, resourceBindings },
    },
    verificationTargets: {
      awsAccount: { provider: 'aws', accountId: '231136241959' },
      awsPreservedBucket: confirmedAwsPreservedBucket(),
      awsPreservedObject: confirmedAwsPreservedObject(),
      awsPreservedDistribution: confirmedAwsPreservedDistribution(),
    },
  };
}

function awsProvisionerPolicy() {
  const roleArn = 'arn:aws:iam::231136241959:role/ap-proof-20261018-provisioner';
  const policyDigests = { identity: '1'.repeat(64), permissions: '2'.repeat(64), boundary: '3'.repeat(64) };
  const resourceBindings = {
    roleArn,
    bucketArn: 'arn:aws:s3:::ap-proof-231136241959-20261018',
    distributionArn: 'arn:aws:cloudfront::231136241959:distribution/E2PROOF20261018',
  };
  return {
    version: 1,
    denyByDefault: true,
    credentialExpectations: {
      'aws-provisioner': { provider: 'aws', accountId: '231136241959', roleArn, policyDigests, resourceBindings },
    },
    verificationTargets: {
      awsAccount: { provider: 'aws', accountId: '231136241959' },
      awsPreservedBucket: confirmedAwsPreservedBucket(),
      awsPreservedObject: confirmedAwsPreservedObject(),
      awsPreservedDistribution: confirmedAwsPreservedDistribution(),
    },
  };
}

function cloudflareWriterPolicy() {
  const resourceBindings = {
    bucket: 'artifact-pages-stream-verify',
    accountId: '21a0acb78621cc00cfa655a276d77b74',
    zoneId: 'zone-verify-20261018',
    sitePrefixes: [
      '_indexes/proof-a-20261018/', '_artifacts/proof-a-20261018/',
      '_previews/proof-a-20261018/', '_control/sites/proof-a-20261018/',
    ],
  };
  return {
    version: 1,
    denyByDefault: true,
    credentialExpectations: {
      'cloudflare-site-a-writer': {
        provider: 'cloudflare', accountId: '21a0acb78621cc00cfa655a276d77b74',
        policyDigests: { temporaryCredentialScope: '4'.repeat(64) }, resourceBindings,
      },
    },
    verificationTargets: {},
  };
}

function awsSatellitePolicy() {
  const roleArn = 'arn:aws:iam::231136241959:role/ap-proof-20261018-a-publisher';
  const bucketArn = 'arn:aws:s3:::ap-proof-231136241959-20261018';
  const distributionArn = 'arn:aws:cloudfront::231136241959:distribution/E2PROOF20261018';
  return {
    version: 1,
    denyByDefault: true,
    credentialExpectations: {
      'aws-satellite-a': {
        provider: 'aws', accountId: '231136241959', roleArn,
        policyDigests: { identity: '8'.repeat(64), permissions: '9'.repeat(64), boundary: 'a'.repeat(64) },
        resourceBindings: { roleArn, bucketArns: [bucketArn], distributionArns: [distributionArn], prefixes: [
          '_indexes/proof-a-20261018/', '_artifacts/proof-a-20261018/', '_previews/proof-a-20261018/', '_control/sites/proof-a-20261018/',
        ] },
      },
    },
    verificationTargets: {
      awsAccount: { provider: 'aws', accountId: '231136241959' },
      awsOwnIndex: { provider: 'aws', accountId: '231136241959', bucket: 'ap-proof-231136241959-20261018', key: '_indexes/proof-a-20261018/index.json' },
      awsPreservedBucket: confirmedAwsPreservedBucket(),
      awsPreservedObject: confirmedAwsPreservedObject(),
      awsPreservedDistribution: confirmedAwsPreservedDistribution(),
      awsNeighborIndex: confirmedAwsKey('proof-b-20261018', '_indexes/proof-b-20261018/index.json'),
      awsNeighborArtifact: confirmedAwsKey('proof-b-20261018', '_artifacts/proof-b-20261018/report.json'),
      awsNeighborPreview: confirmedAwsKey('proof-b-20261018', '_previews/proof-b-20261018/index.html'),
      awsNeighborControl: confirmedAwsKey('proof-b-20261018', '_control/sites/proof-b-20261018/lock.json'),
    },
  };
}

function awsInventoryCredentialSource(overrides = {}) {
  const expectation = awsInventoryPolicy().credentialExpectations['aws-inventory'];
  return {
    credentialClass: 'aws-inventory', provider: 'aws', credentialSource: 'aws-sso-assumed-role', accountId: expectation.accountId,
    instanceId: 'aws-session-inventory-0001', expiresAt: '2030-01-01T00:00:00.000Z',
    principalArn: 'arn:aws:sts::231136241959:assumed-role/ap-proof-20261018-inventory/session-0001',
    policyDigests: structuredClone(expectation.policyDigests),
    resourceBindings: structuredClone(expectation.resourceBindings),
    environment: { AWS_ACCESS_KEY_ID: 'fake-access', AWS_SECRET_ACCESS_KEY: 'fake-secret', AWS_SESSION_TOKEN: 'fake-session' },
    ...overrides,
  };
}

function awsProvisionerCredentialSource(overrides = {}) {
  const expectation = awsProvisionerPolicy().credentialExpectations['aws-provisioner'];
  return {
    credentialClass: 'aws-provisioner', provider: 'aws', credentialSource: 'aws-sso-assumed-role', accountId: expectation.accountId,
    instanceId: 'aws-session-provisioner-0001', expiresAt: '2030-01-01T00:00:00.000Z',
    principalArn: 'arn:aws:sts::231136241959:assumed-role/ap-proof-20261018-provisioner/session-0001',
    policyDigests: structuredClone(expectation.policyDigests),
    resourceBindings: structuredClone(expectation.resourceBindings),
    environment: { AWS_ACCESS_KEY_ID: 'fake-access', AWS_SECRET_ACCESS_KEY: 'fake-secret', AWS_SESSION_TOKEN: 'fake-session' },
    ...overrides,
  };
}

function awsSatelliteCredentialSource(overrides = {}) {
  const expected = awsSatellitePolicy().credentialExpectations['aws-satellite-a'];
  return {
    credentialClass: 'aws-satellite-a', provider: 'aws', credentialSource: 'github-actions-oidc', accountId: expected.accountId,
    instanceId: 'aws-oidc-satellite-a-0001', expiresAt: '2026-10-18T01:00:00.000Z',
    principalArn: 'arn:aws:sts::231136241959:assumed-role/ap-proof-20261018-a-publisher/hosted-run-0001',
    policyDigests: structuredClone(expected.policyDigests),
    resourceBindings: structuredClone(expected.resourceBindings),
    environment: { AWS_ACCESS_KEY_ID: 'fake-access', AWS_SECRET_ACCESS_KEY: 'fake-secret', AWS_SESSION_TOKEN: 'fake-session' },
    ...overrides,
  };
}

function cloudflareWriterCredentialSource(overrides = {}) {
  const expectation = cloudflareWriterPolicy().credentialExpectations['cloudflare-site-a-writer'];
  return {
    credentialClass: 'cloudflare-site-a-writer', provider: 'cloudflare', credentialSource: 'cloudflare-r2-temporary-session', accountId: expectation.accountId,
    instanceId: 'cf-session-site-a-0001', expiresAt: '2026-10-18T00:15:00.000Z',
    principalArn: 'cloudflare:verify:temporary-session:site-a-0001',
    policyDigests: structuredClone(expectation.policyDigests),
    resourceBindings: structuredClone(expectation.resourceBindings),
    environment: {
      CF_VERIFY_R2_ACCESS_KEY_ID: 'fake-r2-access',
      CF_VERIFY_R2_SECRET_ACCESS_KEY: 'fake-r2-secret',
      CF_VERIFY_R2_SESSION_TOKEN: 'fake-r2-session',
    },
    ...overrides,
  };
}

function awsInventoryReadback(expected, overrides = {}) {
  return {
    identity: { accountId: expected.accountId, principalArn: awsInventoryCredentialSource().principalArn, roleArn: expected.roleArn },
    policyDigests: structuredClone(expected.policyDigests),
    resourceBindings: { ...structuredClone(expected.resourceBindings), ...overrides },
  };
}

function awsProvisionerReadback(expected, overrides = {}) {
  return {
    identity: { accountId: expected.accountId, principalArn: awsProvisionerCredentialSource().principalArn, roleArn: expected.roleArn },
    policyDigests: structuredClone(expected.policyDigests),
    resourceBindings: { ...structuredClone(expected.resourceBindings), ...overrides },
  };
}

function cloudflareWriterReadback(expected, overrides = {}) {
  return {
    identity: { accountId: expected.accountId, principalArn: cloudflareWriterCredentialSource().principalArn },
    policyDigests: structuredClone(expected.policyDigests),
    resourceBindings: { ...structuredClone(expected.resourceBindings), ...overrides },
  };
}

function confirmedAwsPreservedObject() {
  return makeTargetConfirmation({
    provider: 'aws', accountId: '231136241959', bucket: 'artifact-pages-231136241959-us-east-1', key: 'evidence/existing-object.json',
  }, { requestId: 'inventory-object-readback', etag: '"existing-etag"', sha256: '5'.repeat(64) });
}

function confirmedAwsPreservedBucket() {
  return makeTargetConfirmation({
    provider: 'aws', accountId: '231136241959', bucket: 'artifact-pages-231136241959-us-east-1',
  }, { requestId: 'inventory-bucket-readback', etag: '"bucket-configuration-etag"', sha256: '7'.repeat(64) });
}

function confirmedAwsKey(site, key) {
  return makeTargetConfirmation({
    provider: 'aws', accountId: '231136241959', bucket: 'ap-proof-231136241959-20261018', site, key,
  }, { requestId: `inventory-${site}-${key}`, etag: '"proof-etag"', sha256: 'b'.repeat(64) });
}

function confirmedAwsPreservedDistribution() {
  return makeTargetConfirmation({
    provider: 'aws', accountId: '231136241959', distributionId: 'ECFTIR5GVPQDF',
  }, { requestId: 'inventory-distribution-readback', etag: '"distribution-etag"', sha256: '6'.repeat(64) });
}

async function makeAwsInventoryRecord(setup, credential, invocationDigest = 'e'.repeat(64)) {
  const expected = setup.manifest.policy.credentialExpectations['aws-inventory'];
  let record;
  const records = new Map();
  const recordStore = {
    async write(candidate) { record = candidate; records.set(candidate.digest, structuredClone(candidate)); },
    async read(digest) { return records.has(digest) ? structuredClone(records.get(digest)) : null; },
  };
  setup.recordStore = recordStore;
  await setup.modules.verification.verifyCredential({
    manifest: setup.manifest,
    capability: setup.capability,
    invocationId: 'aws.inventory.identity',
    invocationDigest,
    credential,
    policyInspector: async () => awsInventoryReadback(expected),
    probeTransport: async ({ probeId }) => ({ status: 200, requestId: `fake-${probeId}` }),
    recordStore,
    now: () => approvalNow,
  });
  return record;
}

function allPolicyStatements(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) allPolicyStatements(item, output);
  } else if (value && typeof value === 'object') {
    if (Array.isArray(value.Statement)) allPolicyStatements(value.Statement, output);
    else if (value.Effect) output.push(value);
    else for (const item of Object.values(value)) allPolicyStatements(item, output);
  }
  return output;
}

function asPolicyList(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function policyPatternMatches(pattern, value) {
  const expression = String(pattern).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\\*/gu, '.*').replace(/\\\?/gu, '.');
  return new RegExp(`^${expression}$`, 'iu').test(value);
}

function renderedDocumentsDeny(document, action, resource) {
  return allPolicyStatements(document).some((statement) => {
    if (statement.Effect !== 'Deny') return false;
    const actionPatterns = asPolicyList(statement.Action);
    const excludedActionPatterns = asPolicyList(statement.NotAction);
    const actionMatches = statement.NotAction !== undefined
      ? !excludedActionPatterns.some((pattern) => policyPatternMatches(pattern, action))
      : actionPatterns.some((pattern) => policyPatternMatches(pattern, action));
    if (!actionMatches) return false;
    if (statement.Resource !== undefined && !asPolicyList(statement.Resource).some((pattern) => policyPatternMatches(pattern, resource))) return false;
    if (statement.NotResource !== undefined && asPolicyList(statement.NotResource).some((pattern) => policyPatternMatches(pattern, resource))) return false;
    return true;
  });
}

function collectCredentialClassNames(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectCredentialClassNames(item, output);
  } else if (value && typeof value === 'object') {
    if (typeof value.credentialClass === 'string') output.push(value.credentialClass);
    for (const nested of Object.values(value)) collectCredentialClassNames(nested, output);
  }
  return output;
}

function policyTemplateBindings() {
  const proofBucket = 'arn:aws:s3:::ap-proof-231136241959-20261018';
  const proofDistribution = 'arn:aws:cloudfront::231136241959:distribution/E2PROOF20261018';
  const proofRoleBase = 'arn:aws:iam::231136241959:role/ap-proof-20261018-';
  const proofPolicyBase = 'arn:aws:iam::231136241959:policy/ap-proof-20261018-';
  return {
    OWNER_SSO_ROLE_ARN: 'arn:aws:iam::231136241959:role/aws-reserved/sso.amazonaws.com/us-east-1/Owner',
    INVENTORY_ROLE_ARN: `${proofRoleBase}inventory`,
    PROVISIONER_ROLE_ARN: `${proofRoleBase}provisioner`,
    TEST_OPERATOR_ROLE_ARN: `${proofRoleBase}test-operator`,
    OWNER_BOUNDARY_ARN: `${proofPolicyBase}boundary`,
    PRESERVED_BUCKET_ARN: 'arn:aws:s3:::artifact-pages-231136241959-us-east-1',
    PRESERVED_DISTRIBUTION_ARN: 'arn:aws:cloudfront::231136241959:distribution/ECFTIR5GVPQDF',
    PROOF_BUCKET_ARN: proofBucket,
    PROOF_DISTRIBUTION_ARN: proofDistribution,
    PROOF_OAC_ARN: 'arn:aws:cloudfront::231136241959:origin-access-control/E2OAC20261018',
    PROOF_FUNCTION_ARN: 'arn:aws:cloudfront::231136241959:function/ap-proof-20261018-viewer',
    PROOF_CACHE_POLICY_ARNS: ['1', '2', '3', '4'].map((suffix) => `arn:aws:cloudfront::231136241959:cache-policy/E2CACHE${suffix}`),
    PROOF_RESPONSE_HEADERS_POLICY_ARN: 'arn:aws:cloudfront::231136241959:response-headers-policy/E2HEADER20261018',
    TERRAFORM_ERROR_OBJECT_ARN: `${proofBucket}/terraform.tfstate.tflock`,
    PUBLISHER_ROLE_ARNS: ['admin-publisher', 'a-publisher', 'b-publisher', 'neighbor-publisher'].map((role) => `${proofRoleBase}${role}`),
    PROOF_ROLE_ARNS: ['inventory', 'provisioner', 'test-operator', 'admin-publisher', 'a-publisher', 'b-publisher', 'neighbor-publisher'].map((role) => `${proofRoleBase}${role}`),
    PROOF_POLICY_ARNS: [`${proofPolicyBase}boundary`, `${proofPolicyBase}operator`, `${proofPolicyBase}publisher`],
    INVENTORIED_CLOUDFRONT_RESOURCE_ARNS: ['arn:aws:cloudfront::231136241959:distribution/ECFTIR5GVPQDF', 'arn:aws:cloudfront::231136241959:origin-access-control/E2OLD'],
    INVENTORY_STATE_OBJECT_ARN: 'arn:aws:s3:::artifact-pages-231136241959-us-east-1/aws-verify/terraform.tfstate',
    ADMIN_OIDC_SUBJECT: 'repo:artifact-pages/provider-proof-20261018:environment:proof-admin',
    EXACT_SITE_OIDC_SUBJECT: 'repo:artifact-pages/provider-proof-20261018:environment:proof-site-a',
    SITE_ID: 'proof-a-20261018',
    VERIFIED_SHARED_BUCKET: 'artifact-pages-stream-verify',
    VERIFIED_ZONE_ID: 'zone-verify-20261018',
  };
}
