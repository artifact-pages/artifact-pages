import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
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
import { GuardedTransport } from './guarded-transport.mjs';
import {
  appendSeal,
  approvalSigningBytes,
  canonicalDigest,
  readSealChain,
  verifyApprovalFile,
} from './seals.mjs';
import { main } from './proof.mjs';

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

test('redirects, retries, pagination, mixed-target batches, and raw bypasses are reauthorized', async () => {
  const redirect = fakeHarness('delivery:aws', fixtureManifest(), { responses: [{ status: 302, headers: { location: 'https://unrelated.invalid/_artifacts/proof-a-20261018/index.html' } }] });
  await assert.rejects(redirect.client.request(operation('aws-s3', 'GetObject', { accountId: TARGETS.awsAccount, bucket: TARGETS.proofAwsBucket }, { key: '_artifacts/proof-a-20261018/index.html' })), /ENDPOINT_MISMATCH/);
  assert.equal(redirect.credentialLoads, 1);
  assert.equal(redirect.outbound.length, 1, 'only the allowed pre-redirect request may be sent');
  assert.equal(redirect.outbound.some(({ operation: op }) => op.endpoint.includes('unrelated.invalid')), false);

  const retry = fakeHarness('delivery:aws', fixtureManifest(), { maxRetries: 1, responses: [
    { status: 503, retryable: true, retryOperation: preservedAwsGet() },
  ] });
  await assert.rejects(retry.client.request(proofAwsPut()), /PRESERVED_RESOURCE_DENIED_TO_PROOF/);
  assert.equal(retry.credentialLoads, 1);
  assert.equal(retry.outbound.length, 1, 'the retry target must be rejected before a second request');

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
  await assertDeniedBeforeCredential(serializedTarget, proofAwsPut(), 'PRESERVED_RESOURCE_DENIED_TO_PROOF');

  const signedTarget = fakeHarness('delivery:aws', fixtureManifest(), {
    signer: async (wire) => ({
      ...wire,
      operation: { ...wire.operation, resource: { ...wire.operation.resource, bucket: TARGETS.preservedAwsBucket } },
    }),
  });
  await assert.rejects(signedTarget.client.request(proofAwsPut()), /PRESERVED_RESOURCE_DENIED_TO_PROOF/);
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

test('seal and reseal produce an immutable chained ledger; tamper, skipped stages, and stale approvals fail', async (t) => {
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
    reviewKeys: {},
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

  const keyPair = generateKeyPairSync('ed25519');
  const pub = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const baseRecord = {
    id: 'A4', command: 'inventory', transition: 'inventory', sealDigest: third.record.digest,
    approvedAt: '2026-10-18T00:00:00.000Z', expiresAt: expiry,
    reviewerKeyId: 'owner', reviewerKeyFingerprint: fingerprintKey(pub),
  };
  const approval = { ...baseRecord, signature: sign(null, approvalSigningBytes(baseRecord), keyPair.privateKey).toString('base64') };
  const verifiedManifest = { ...manifest, activeSealDigest: third.record.digest, reviewKeys: { owner: pub } };
  assert.equal(verifyApprovalRecord(approval, verifiedManifest, 'A4', 'inventory', approvalNow), true);
  assert.equal(verifyApprovalRecord({ ...approval, sealDigest: 'stale' }, verifiedManifest, 'A4', 'inventory', approvalNow), false);
  assert.equal(verifyApprovalRecord({ ...approval, expiresAt: '2020-01-01T00:00:00Z' }, verifiedManifest, 'A4', 'inventory', approvalNow), false);
  assert.equal(verifyApprovalRecord(undefined, verifiedManifest, 'A4', 'inventory', approvalNow), false);
});

test('signed approval files are bound to the exact active seal and transition', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-approval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'source.txt'), 'sealed source\n');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Provider Proof Test']);
  git(['config', 'user.email', 'proof-test@example.invalid']);
  git(['add', 'source.txt']);
  git(['commit', '--quiet', '-m', 'approval fixture']);
  await mkdir(path.join(root, 'approvals'), { recursive: true });
  const manifestPath = path.join(root, 'manifest.json');
  const keyPair = generateKeyPairSync('ed25519');
  const pub = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const manifest = {
    schemaVersion: 1,
    runId: 'approval-test',
    policy: {},
    approvalPolicy: {},
    reviewKeys: { owner: pub },
    workspaceRoot: '.',
    baselineCommit: git(['rev-parse', 'HEAD']),
    sourceFiles: ['source.txt'],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const seal = await appendSeal({ manifestPath, artifacts: [], now: '2026-10-18T00:00:00Z' });
  const record = { id: 'A4', command: 'inventory', transition: 'inventory', sealDigest: seal.record.digest, approvedAt: '2026-10-18T00:00:00.000Z', expiresAt: expiry, reviewerKeyId: 'owner', reviewerKeyFingerprint: fingerprintKey(pub) };
  const signed = { ...record, signature: sign(null, approvalSigningBytes(record), keyPair.privateKey).toString('base64') };
  await writeFile(path.join(root, 'approvals', 'A4.json'), `${JSON.stringify(signed, null, 2)}\n`);
  assert.equal((await verifyApprovalFile({ manifestPath, approvalId: 'A4', command: 'inventory', now: approvalNow })).sealDigest, seal.record.digest);
  await assert.rejects(verifyApprovalFile({ manifestPath, approvalId: 'A4', command: 'gzip', now: approvalNow }), /OWNER_APPROVAL_INVALID/);
  const bad = { ...signed, sealDigest: 'old-seal' };
  await writeFile(path.join(root, 'approvals', 'A4.json'), `${JSON.stringify(bad, null, 2)}\n`);
  await assert.rejects(verifyApprovalFile({ manifestPath, approvalId: 'A4', command: 'inventory', now: approvalNow }), /OWNER_APPROVAL_INVALID/);
});

async function createShellGuardFixture(root, overrides = {}) {
  const workspace = path.join(root, 'workspace');
  const runtime = path.join(root, 'runtime');
  await mkdir(workspace, { recursive: true });
  await mkdir(runtime, { recursive: true });
  await mkdir(path.join(runtime, 'approvals'), { recursive: true });
  await writeFile(path.join(workspace, 'proof-source.js'), 'export const sealed = true;\n');
  await writeFile(path.join(runtime, 'evidence.txt'), 'local signed-approval fixture\n');
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
  const keyPair = generateKeyPairSync('ed25519');
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const manifest = {
    schemaVersion: 1,
    runId: `shell-guard-${path.basename(root)}`,
    testOnly: false,
    sealDirectory: 'seals',
    approvalDirectory: 'approvals',
    workspaceRoot: '../workspace',
    baselineCommit: git(['rev-parse', 'HEAD']),
    sourceFiles: ['proof-source.js'],
    policy: { version: 1, denyByDefault: true },
    approvalPolicy: { signaturesRequired: true },
    reviewKeys: { owner: publicKey },
    scopeExpiresAt: '2030-01-01T00:00:00.000Z',
    approvalWindows: { A5: { expiresAt: '2030-01-01T00:00:00.000Z' } },
    caps: { requests: 10, bytes: 1000, operatorMinutes: 60 },
    usage: { requests: 0, bytes: 0, operatorMinutes: 0 },
    bindings: {},
    endpoints: { 'aws-s3': { [TARGETS.preservedAwsBucket]: 'https://s3.us-east-1.amazonaws.com' } },
    ...overrides,
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
  await appendSeal({ manifestPath, stage: 'bootstrap' });
  for (const stage of ['discovery', 'inventory', 'create-plan', 'post-apply']) {
    const { record } = await appendSeal({ manifestPath, stage, artifacts: ['evidence.txt'] });
    if (stage === 'post-apply') {
      const approval = {
        id: 'A5',
        command: 'delivery:aws',
        transition: 'delivery:aws',
        sealDigest: record.digest,
        approvedAt: '2026-10-18T00:00:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z',
        reviewerKeyId: 'owner',
        reviewerKeyFingerprint: fingerprintKey(publicKey),
      };
      const signed = { ...approval, signature: sign(null, approvalSigningBytes(approval), keyPair.privateKey).toString('base64') };
      await writeFile(path.join(runtime, 'approvals', 'A5.json'), `${JSON.stringify(signed, null, 2)}\n`);
    }
  }
  return { workspace, runtime, manifestPath, operationPath };
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
  const commands = path.resolve('scripts/provider-proof/commands.sh');
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
  const collision = spawnSync('sh', [commands, 'guard', '--manifest', collisionFixture.manifestPath, '--command', 'delivery:aws', '--approval', 'A5', '--operation', collisionFixture.operationPath], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  assert.equal(collision.status, 2);
  assert.match(collision.stderr, /RESOURCE_COLLISION/);

  const expiredRoot = path.join(root, 'expired');
  const expiredFixture = await createShellGuardFixture(expiredRoot, { scopeExpiresAt: '2020-01-01T00:00:00Z' });
  const expired = spawnSync('sh', [commands, 'guard', '--manifest', expiredFixture.manifestPath, '--command', 'delivery:aws', '--approval', 'A5', '--operation', expiredFixture.operationPath], {
    cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  assert.equal(expired.status, 2);
  assert.match(expired.stderr, /SCOPE_EXPIRED/);

  const exhaustedRoot = path.join(root, 'exhausted');
  const exhaustedFixture = await createShellGuardFixture(exhaustedRoot, { usage: { requests: 11 } });
  const exhausted = spawnSync('sh', [commands, 'guard', '--manifest', exhaustedFixture.manifestPath, '--command', 'delivery:aws', '--approval', 'A5', '--operation', exhaustedFixture.operationPath], {
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
  assert.match(external.stderr, /UNMODIFIED_SUBPROCESS_BLOCKED_REQUIRES_ENFORCING_BROKER/);
});

test('commands.sh run recognizes every fixed phase interface and stops on testOnly manifests', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-proof-run-interface-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    runId: 'phase-interface-test',
    testOnly: true,
    policy: { denyByDefault: true },
    approvalPolicy: { signaturesRequired: true },
  })}\n`);
  const commands = path.resolve('scripts/provider-proof/commands.sh');
  const phases = [
    ['inventory', ['--manifest', manifestPath, '--approval', 'A4']],
    ['bootstrap-aws', ['--manifest', manifestPath, '--approval', 'A5']],
    ['delivery', ['--provider', 'aws', '--cases', 'P1', '--manifest', manifestPath, '--approval', 'A5']],
    ['failures', ['--provider', 'cloudflare', '--cases', 'P4', '--manifest', manifestPath, '--approval', 'A7']],
    ['lifecycle', ['--provider', 'aws', '--setup', '--manifest', manifestPath, '--approval', 'A8']],
    ['lifecycle', ['--provider', 'aws', '--observe-only', '--manifest', manifestPath, '--approval', 'A8']],
    ['lifecycle', ['--provider', 'cloudflare', '--reconcile', '--manifest', manifestPath, '--approval', 'A8']],
    ['gzip', ['--manifest', manifestPath, '--approval', 'A9']],
    ['cleanup', ['--phase', 'post-a7', '--manifest', manifestPath, '--approval', 'A7']],
    ['cleanup', ['--phase', 'final-a8', '--manifest', manifestPath, '--approval', 'A8']],
    ['cloudflare-api-get', ['--path', `/accounts/${TARGETS.cloudflareVerifyAccount}/r2/buckets/local-fake-r2-bucket/lifecycle`, '--manifest', manifestPath, '--approval', 'A4']],
  ];
  for (const [subcommand, args] of phases) {
    const result = spawnSync('sh', [commands, 'run', subcommand, ...args], {
      cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    assert.equal(result.status, 2, `${subcommand}: ${result.stderr}`);
    assert.match(result.stderr, /TEST_FIXTURE_CANNOT_AUTHORIZE_EXTERNAL_WORK/);
    assert.doesNotMatch(result.stdout, /credentials|token|secret/i);
    assert.doesNotMatch(result.stderr, /credentials|token|secret/i);
  }
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

test('subprocess execution stops without a sealed enforcing broker and rejects context overrides', async () => {
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
