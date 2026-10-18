import { createHash } from 'node:crypto';
import { verifyApprovalSignature } from './seals.mjs';

export const TARGETS = Object.freeze({
  awsAccount: '231136241959',
  preservedAwsBucket: 'artifact-pages-231136241959-us-east-1',
  preservedAwsDistribution: 'ECFTIR5GVPQDF',
  preservedAwsHostname: 'd3qg4cc5j20soe.cloudfront.net',
  proofAwsBucket: 'ap-proof-231136241959-20261018',
  proofAwsPrefix: 'ap-proof-20261018',
  proofAwsDistributionAddress: 'aws_cloudfront_distribution.proof',
  cloudflareVerifyAccount: '21a0acb78621cc00cfa655a276d77b74',
  cloudflareProductionAccount: '9ac354c8aa31d424224d8c4f3aa8ba2a',
  cloudflareProductionBucket: 'artifact-pages',
  cloudflareProductionZone: 'artifact-pages.dev',
  cloudflareVerifyZoneName: 'artifact-pages.stream',
  proofSites: Object.freeze([
    'proof-a-20261018',
    'proof-b-20261018',
    'proof-neighbor-20261018',
    'proof-life-20261018',
  ]),
  lifeSite: 'proof-life-20261018',
  oldAwsVerifyAccount: '231136241959',
});

export const PHASE = Object.freeze({
  OFFLINE: 'offline-preparation',
  DISCOVERY: 'A4-discovery',
  INVENTORY: 'A4-inventory',
  PROVISION: 'A5-provisioning',
  A5_DELIVERY: 'A5-delivery',
  A6_DELIVERY: 'A6-delivery',
  A7: 'A7-proof',
  A8_SETUP: 'A8-setup',
  A8_OBSERVE: 'A8-observation',
  A8_RECONCILE: 'A8-reconciliation',
  A9: 'A9-gzip',
  FINAL: 'final-preservation',
});

export const PERMISSION_TABLE = Object.freeze([
  { phase: 'offline-preparation', inventory: 'none', preservation: 'none', provisioning: 'none', proof: 'none', lifecycle: 'none' },
  { phase: 'A4-discovery', inventory: 'AWS anchor reads; Cloudflare metadata discovery; no unbound bucket reads', preservation: 'none', provisioning: 'new-bucket availability only', proof: 'none', lifecycle: 'none' },
  { phase: 'A4-inventory', inventory: 'bound AWS/Cloudflare reads and exact verify-state reads', preservation: 'none', provisioning: 'none', proof: 'none', lifecycle: 'none' },
  { phase: 'A5-provisioning', inventory: 'none', preservation: 'separate preserved-resource reads', provisioning: 'reviewed new AWS create plan only', proof: 'none', lifecycle: 'none' },
  { phase: 'A5/A6-delivery', inventory: 'none', preservation: 'separate preserved-resource reads', provisioning: 'none', proof: 'proof-site writes; reviewed shared registry/app deltas', lifecycle: 'A8-only exact life-prefix exception' },
  { phase: 'A7-proof', inventory: 'none', preservation: 'separate preserved-resource reads', provisioning: 'none', proof: 'proof a/b/neighbor; life frozen; exact cache paths', lifecycle: 'denied' },
  { phase: 'A8-setup', inventory: 'none', preservation: 'separate preserved-resource reads', provisioning: 'none', proof: 'life setup under A8', lifecycle: 'dedicated Cloudflare lifecycle owner; exact add' },
  { phase: 'A8-observation', inventory: 'none', preservation: 'separate preserved-resource reads', provisioning: 'none', proof: 'life HEAD/list/version reads only', lifecycle: 'read only' },
  { phase: 'A8-reconciliation', inventory: 'none', preservation: 'separate preserved-resource reads', provisioning: 'none', proof: 'gated life cleanup/reconcile', lifecycle: 'exact reviewed restore and state keys' },
  { phase: 'A9', inventory: 'none', preservation: 'separate preserved-resource reads', provisioning: 'none', proof: 'new AWS proof resources only', lifecycle: 'denied' },
  { phase: 'final-preservation', inventory: 'none', preservation: 'separate bound read-only snapshots', provisioning: 'none', proof: 'none', lifecycle: 'none' },
]);

const CAPABILITY_MARK = Symbol('provider-proof capability');
const READ_ACTIONS = new Set([
  'GetObject', 'HeadObject', 'ListObjectsV2', 'ListObjectVersions',
  'GetBucketLifecycleConfiguration', 'GetBucketVersioning',
  'GetDistribution', 'GetDistributionConfig', 'GetCallerIdentity',
  'ListBuckets', 'GetStateObject', 'GetLifecycle', 'GetBucketMetadata',
  'GetZoneMetadata', 'GetDelivery', 'GetIdentityMetadata', 'HeadBucket',
]);
const WRITE_ACTIONS = new Set([
  'PutObject', 'DeleteObjects', 'DeleteObject', 'CopyObject', 'CreateInvalidation',
  'PublishSite', 'PublishRegistry', 'DeployApp', 'UnregisterSite',
  'UpdateLifecycle', 'TerraformCreate', 'TerraformDestroy', 'PutStateLock',
  'DeleteStateLock', 'PutStateObject', 'DeleteStateObject',
]);

const commandRules = Object.freeze({
  inventory: { phase: PHASE.INVENTORY, context: 'inventory', approval: 'A4' },
  'cloudflare-api-get': { phase: PHASE.INVENTORY, context: 'inventory', approval: 'A4' },
  'bootstrap-aws': { phase: PHASE.PROVISION, context: 'provisioning', approval: 'A5' },
  'delivery:aws': { phase: PHASE.A5_DELIVERY, context: 'proof', approval: 'A5' },
  'delivery:cloudflare': { phase: PHASE.A6_DELIVERY, context: 'proof', approval: 'A6' },
  'failures:aws': { phase: PHASE.A7, context: 'proof', approval: 'A7' },
  'failures:cloudflare': { phase: PHASE.A7, context: 'proof', approval: 'A7' },
  'lifecycle:aws:setup': { phase: PHASE.A8_SETUP, context: 'proof', approval: 'A8' },
  'lifecycle:cloudflare:setup': { phase: PHASE.A8_SETUP, context: 'lifecycle-owner', approval: 'A8' },
  'lifecycle:aws:observe-only': { phase: PHASE.A8_OBSERVE, context: 'observer', approval: 'A8' },
  'lifecycle:cloudflare:observe-only': { phase: PHASE.A8_OBSERVE, context: 'observer', approval: 'A8' },
  'lifecycle:aws:reconcile': { phase: PHASE.A8_RECONCILE, context: 'cleanup', approval: 'A8' },
  'lifecycle:cloudflare:reconcile': { phase: PHASE.A8_RECONCILE, context: 'lifecycle-owner', approval: 'A8' },
  gzip: { phase: PHASE.A9, context: 'gzip', approval: 'A9' },
  'cleanup:post-a7': { phase: PHASE.A7, context: 'cleanup-post-a7', approval: 'A7' },
  'cleanup:final-a8': { phase: PHASE.A8_RECONCILE, context: 'cleanup-final-a8', approval: 'A8' },
  'preserve:checkpoint': { phase: PHASE.FINAL, context: 'preservation', approval: null },
});

export class AuthorizationError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}

export function resolveCommandCapability(command, manifest, approvalRecord, now = Date.now()) {
  const rule = commandRules[command];
  if (!rule) throw new AuthorizationError('UNKNOWN_COMMAND');
  if (manifest?.testOnly === true) throw new AuthorizationError('TEST_FIXTURE_CANNOT_AUTHORIZE_EXTERNAL_WORK');
  if (!manifest?.activeSealDigest || !manifest?.sealChainVerified) throw new AuthorizationError('UNSEALED_MANIFEST');
  if (rule.approval && !verifyApprovalRecord(approvalRecord, manifest, rule.approval, command, now)) {
    throw new AuthorizationError('OWNER_APPROVAL_REQUIRED', rule.approval);
  }
  return Object.freeze({
    [CAPABILITY_MARK]: true,
    command,
    phase: rule.phase,
    context: rule.context,
    approval: rule.approval,
    approvalExpiresAt: approvalRecord?.expiresAt ?? manifest.scopeExpiresAt,
    sealDigest: manifest.activeSealDigest,
    manifest,
  });
}

export function capabilityForLocalTest(command, manifest) {
  const rule = commandRules[command];
  if (!rule) throw new AuthorizationError('UNKNOWN_COMMAND');
  if (manifest?.testOnly !== true || manifest?.allowLocalEmulator !== true) {
    throw new AuthorizationError('LOCAL_TEST_CAPABILITY_REQUIRES_TEST_FIXTURE');
  }
  return Object.freeze({
    [CAPABILITY_MARK]: true,
    localTest: true,
    command,
    phase: rule.phase,
    context: rule.context,
    approval: rule.approval,
    approvalExpiresAt: manifest.scopeExpiresAt ?? '2030-01-01T00:00:00.000Z',
    sealDigest: manifest.activeSealDigest ?? 'local-test-seal',
    manifest,
  });
}

export function verifyApprovalRecord(record, manifest, approvalId, command, now = Date.now()) {
  if (!record || record.testOnly === true || record.id !== approvalId) return false;
  if (record.sealDigest !== manifest.activeSealDigest || record.command !== command) return false;
  if (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= now) return false;
  if (!Number.isFinite(Date.parse(record.approvedAt)) || Date.parse(record.approvedAt) > now) return false;
  if (record.transition !== command || !record.signature || !record.reviewerKeyId) return false;
  const key = manifest.reviewKeys?.[record.reviewerKeyId];
  if (!key || fingerprintKey(key) !== record.reviewerKeyFingerprint) return false;
  return verifyApprovalSignature(record, key);
}

export function fingerprintKey(publicKey) {
  return createHash('sha256').update(String(publicKey)).digest('hex');
}

export function authorizeOperation(capability, operation) {
  if (!capability || capability[CAPABILITY_MARK] !== true) throw new AuthorizationError('UNTRUSTED_CAPABILITY');
  if (capability.phase === PHASE.OFFLINE) throw new AuthorizationError('OFFLINE_HAS_NO_REQUESTS');
  if (!operation || typeof operation !== 'object' || operation.rawRequest === true) {
    throw new AuthorizationError('RAW_REQUEST_BYPASS_DENIED');
  }
  if (operation.endpointOverride || operation.addressingAlias || operation.endpoint == null) {
    throw new AuthorizationError('UNSEALED_ENDPOINT');
  }
  if (!endpointMatches(capability.manifest, operation, capability.localTest === true)) throw new AuthorizationError('ENDPOINT_MISMATCH');
  if (!knownOperation(operation)) throw new AuthorizationError('UNKNOWN_OPERATION');
  if (operation.service === 'aws-sts' && operation.action === 'GetCallerIdentity') return authorizeIdentityProbe(capability, operation);

  const target = classifyTarget(capability.manifest, operation);
  if (target === 'production' || target === 'unrelated' || target === 'unknown') {
    throw new AuthorizationError('TARGET_NOT_ALLOWED', target);
  }

  const context = capability.context;
  if (target === 'preserved-aws') {
    if (isProofContext(context)) throw new AuthorizationError('PRESERVED_RESOURCE_DENIED_TO_PROOF');
    if (context === 'inventory') return authorizePreservedInventory(capability, operation);
    if (context === 'preservation') return authorizePreservation(capability, operation);
    throw new AuthorizationError('PRESERVED_RESOURCE_CONTEXT_DENIED');
  }

  if (target === 'cloudflare-verify') {
    if (context === 'inventory') return authorizeCloudflareInventory(capability, operation);
    if (context === 'preservation') return authorizePreservation(capability, operation);
    if (context === 'lifecycle-owner') return authorizeLifecycleOwner(capability, operation);
    if (operation.service === 'cloudflare-cache') return authorizeCloudflareCache(capability, operation);
    if (context === 'proof' || context === 'observer' || context === 'cleanup') {
      return authorizeCloudflareProof(capability, operation);
    }
    if (context === 'cleanup-post-a7') return authorizePostA7Cleanup(capability, operation);
    if (context === 'cleanup-final-a8') return authorizeFinalCleanup(capability, operation);
    throw new AuthorizationError('CLOUDFLARE_CONTEXT_DENIED');
  }

  if (target === 'new-aws-proof') {
    if (context === 'inventory') return authorizeNewAwsAvailability(operation);
    if (context === 'preservation') return authorizePreservation(capability, operation);
    if (context === 'provisioning') return authorizeProvisioning(capability, operation);
    if (context === 'lifecycle-owner') throw new AuthorizationError('LIFECYCLE_OWNER_AWS_DENIED');
    if (context === 'observer') return authorizeAwsObservation(capability, operation);
    if (context === 'cleanup-post-a7') return authorizePostA7Cleanup(capability, operation);
    if (context === 'cleanup-final-a8') return authorizeFinalCleanup(capability, operation);
    if (context === 'cleanup') return authorizeAwsReconciliation(capability, operation);
    if (context === 'proof' || context === 'gzip') return authorizeAwsProof(capability, operation);
    throw new AuthorizationError('AWS_CONTEXT_DENIED');
  }

  throw new AuthorizationError('TARGET_NOT_ALLOWED', target);
}

function isProofContext(context) {
  return ['proof', 'observer', 'cleanup', 'cleanup-post-a7', 'cleanup-final-a8', 'gzip'].includes(context);
}

function knownOperation(operation) {
  if (!operation.service || !operation.action || !operation.method) return false;
  const methods = {
    'aws-s3': {
      GetObject: ['GET'], HeadObject: ['HEAD'], ListObjectsV2: ['GET'], ListObjectVersions: ['GET'],
      GetBucketLifecycleConfiguration: ['GET'], GetBucketVersioning: ['GET'], HeadBucket: ['HEAD'], GetBucketMetadata: ['GET'],
      PutObject: ['PUT'], DeleteObject: ['DELETE'], DeleteObjects: ['POST'], CopyObject: ['PUT'],
    },
    'cloudflare-s3': {
      GetObject: ['GET'], HeadObject: ['HEAD'], ListObjectsV2: ['GET'], ListObjectVersions: ['GET'],
      GetBucketLifecycleConfiguration: ['GET'], GetBucketVersioning: ['GET'], HeadBucket: ['HEAD'], GetBucketMetadata: ['GET'],
      PutObject: ['PUT'], DeleteObject: ['DELETE'], DeleteObjects: ['POST'], CopyObject: ['PUT'],
    },
    'aws-query': {
      GetBucketLifecycleConfiguration: ['POST'], GetBucketVersioning: ['POST'], GetDistribution: ['POST'],
      GetDistributionConfig: ['POST'], GetCallerIdentity: ['POST'], ListBuckets: ['POST'], GetIdentityMetadata: ['POST'],
    },
    'aws-cloudfront': { GetDistribution: ['GET'], GetDistributionConfig: ['GET'], CreateInvalidation: ['POST'] },
    'aws-sts': { GetCallerIdentity: ['POST'] },
    'aws-iam': { GetIdentityMetadata: ['POST'] },
    'cloudflare-discovery': { GetZoneMetadata: ['GET'] },
    'cloudflare-api': {
      GetBucketMetadata: ['GET'], GetLifecycle: ['GET'], UpdateLifecycle: ['PUT'],
      PublishSite: ['POST'], PublishRegistry: ['POST'], UnregisterSite: ['POST'],
    },
    'cloudflare-cache': { CreateInvalidation: ['POST'] },
    delivery: { GetDelivery: ['GET', 'HEAD'] },
    state: {
      GetStateObject: ['GET'], PutStateLock: ['PUT'], DeleteStateLock: ['DELETE'],
      PutStateObject: ['PUT'], DeleteStateObject: ['DELETE'],
    },
    terraform: { TerraformCreate: ['POST'], TerraformDestroy: ['POST'], GetIdentityMetadata: ['POST'] },
  };
  const allowedMethods = methods[operation.service]?.[operation.action];
  if (!allowedMethods?.includes(operation.method)) return false;
  if (operation.service === 'aws-query') return queryOperationMatches(operation);
  return true;
}

function queryOperationMatches(operation) {
  const payload = operation.payload;
  if (!payload || payload.Action !== operation.action) return false;
  if (['GetBucketLifecycleConfiguration', 'GetBucketVersioning'].includes(operation.action)) {
    return payload.Bucket === operation.resource?.bucket;
  }
  if (['GetDistribution', 'GetDistributionConfig'].includes(operation.action)) {
    return payload.Id === operation.resource?.distributionId;
  }
  if (operation.action === 'ListBuckets') return payload.AccountId === operation.resource?.accountId;
  if (operation.action === 'GetIdentityMetadata') return payload.Arn === operation.resource?.oidcProviderArn;
  return operation.action === 'GetCallerIdentity' && Object.keys(payload).every((key) => key === 'Action');
}

function authorizeIdentityProbe(capability, op) {
  const manifest = capability.manifest;
  if (op.expectedAccountId !== TARGETS.awsAccount) throw new AuthorizationError('IDENTITY_ACCOUNT_MISMATCH');
  const expectedRole = manifest.identities?.[capability.context]?.roleArn;
  if (!expectedRole || op.expectedRoleArn !== expectedRole) throw new AuthorizationError('IDENTITY_ROLE_UNBOUND');
}

function classifyTarget(manifest, op) {
  const resource = op.resource ?? {};
  const account = String(resource.accountId ?? op.accountId ?? '');
  const bucket = String(resource.bucket ?? '');
  const distribution = String(resource.distributionId ?? '');
  const zoneName = String(resource.zoneName ?? '');
  const hostname = String(resource.hostname ?? '');
  const zoneId = String(resource.zoneId ?? '');
  const bound = manifest.bindings ?? {};

  if (account === TARGETS.cloudflareProductionAccount || (bucket === TARGETS.cloudflareProductionBucket && account !== TARGETS.cloudflareVerifyAccount)
    || zoneName === TARGETS.cloudflareProductionZone) return 'production';
  if (hostname === TARGETS.preservedAwsHostname) return 'preserved-aws';
  if (hostname && hostname === bound.cloudflare?.hostname) return 'cloudflare-verify';
  if (hostname && hostname === bound.aws?.hostname) return 'new-aws-proof';
  if ((bucket === TARGETS.preservedAwsBucket || distribution === TARGETS.preservedAwsDistribution)
    && (!account || account === TARGETS.awsAccount)) return 'preserved-aws';
  if (account === TARGETS.cloudflareVerifyAccount || (zoneId && zoneId === bound.cloudflare?.zoneId)
    || (bucket && bucket === bound.cloudflare?.bucket)) return 'cloudflare-verify';
  if (bucket === TARGETS.proofAwsBucket && (!account || account === TARGETS.awsAccount)) return 'new-aws-proof';
  if (distribution && distribution === bound.aws?.distributionId && (!account || account === TARGETS.awsAccount)) return 'new-aws-proof';
  if (op.service === 'aws-query' && op.action === 'ListBuckets' && account === TARGETS.awsAccount) return 'preserved-aws';
  if (op.service === 'cloudflare-discovery' && account === TARGETS.cloudflareVerifyAccount && zoneName === TARGETS.cloudflareVerifyZoneName) return 'cloudflare-verify';
  if (op.service === 'terraform' && account === TARGETS.awsAccount && resource.stack === 'new-aws-proof') return 'new-aws-proof';
  if (op.service === 'state' && resource.backend === 'cloudflare-verify') return 'cloudflare-verify';
  if (op.service === 'state' && resource.backend === 'preserved-aws-verify') return 'preserved-aws';
  return 'unknown';
}

function endpointMatches(manifest, op, localTest) {
  if (localTest) {
    if (manifest.testOnly !== true || op.localTest !== true) return false;
    if (op.endpoint.startsWith('fake://')) return true;
    if (manifest.allowLocalEmulator !== true) return false;
    try {
      const endpoint = new URL(op.endpoint);
      return endpoint.protocol === 'http:'
        && ['127.0.0.1', 'localhost'].includes(endpoint.hostname)
        && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
        && endpoint.pathname === '/';
    } catch {
      return false;
    }
  }
  const allowed = manifest.endpoints ?? {};
  const expected = allowed[op.service]?.[op.resource?.bucket ?? op.resource?.distributionId ?? op.resource?.zoneId ?? op.resource?.hostname ?? 'default'];
  if (!expected || op.endpoint !== expected) return false;
  if (op.endpoint.includes('@') || op.endpoint.includes('#') || op.endpoint.includes('?')) return false;
  return true;
}

function authorizePreservedInventory(capability, op) {
  if (op.service === 'aws-sts' && op.action === 'GetCallerIdentity') return;
  if (op.service === 'aws-query' && READ_ACTIONS.has(op.action) && !WRITE_ACTIONS.has(op.action)) {
    if (op.action === 'ListBuckets' && op.resource?.accountId === TARGETS.awsAccount) return;
    if (op.resource?.bucket === TARGETS.preservedAwsBucket) return authorizeReadPayload(op, { allowAnyKey: true });
    if (op.resource?.distributionId === TARGETS.preservedAwsDistribution
      && ['GetDistribution', 'GetDistributionConfig'].includes(op.action)) return;
  }
  if (op.service === 'aws-query' && op.action === 'ListBuckets' && op.resource?.accountId === TARGETS.awsAccount) return;
  if (op.service === 'aws-s3' && op.resource?.bucket === TARGETS.preservedAwsBucket && READ_ACTIONS.has(op.action)) return authorizeReadPayload(op, { allowAnyKey: true });
  if (op.service === 'aws-cloudfront' && op.resource?.distributionId === TARGETS.preservedAwsDistribution
    && ['GetDistribution', 'GetDistributionConfig'].includes(op.action)) return;
  if (op.service === 'delivery' && op.action === 'GetDelivery' && op.resource?.hostname === TARGETS.preservedAwsHostname
    && ['GET', 'HEAD'].includes(op.method) && approvedPath(op.path)) return;
  if (op.service === 'state' && op.action === 'GetStateObject' && exactStateKey(capability, op)) return;
  throw new AuthorizationError('INVENTORY_OPERATION_DENIED');
}

function authorizePreservation(capability, op) {
  if (op.service === 'aws-sts' && op.action === 'GetCallerIdentity') return;
  if (op.service === 'aws-query' && READ_ACTIONS.has(op.action) && !WRITE_ACTIONS.has(op.action)) {
    if (op.action === 'ListBuckets' && op.resource?.accountId === TARGETS.awsAccount) return;
    if (op.resource?.bucket === TARGETS.preservedAwsBucket) return authorizeReadPayload(op, { allowAnyKey: true });
    if (op.resource?.distributionId === TARGETS.preservedAwsDistribution
      && ['GetDistribution', 'GetDistributionConfig'].includes(op.action)) return;
  }
  if (op.service === 'aws-s3' && op.resource?.bucket === TARGETS.preservedAwsBucket && READ_ACTIONS.has(op.action)) return authorizeReadPayload(op, { allowAnyKey: true });
  if (op.service === 'aws-cloudfront' && op.resource?.distributionId === TARGETS.preservedAwsDistribution
    && ['GetDistribution', 'GetDistributionConfig'].includes(op.action)) return;
  if (op.service === 'delivery' && op.action === 'GetDelivery' && op.resource?.hostname === TARGETS.preservedAwsHostname
    && ['GET', 'HEAD'].includes(op.method) && approvedPath(op.path)) return;
  if (op.service === 'cloudflare-api' && op.action === 'GetLifecycle' && isBoundCfBucket(capability, op)) return;
  if (op.service === 'cloudflare-s3' && isBoundCfBucket(capability, op) && READ_ACTIONS.has(op.action)) return authorizeReadPayload(op, { allowAnyKey: true });
  if (op.service === 'state' && op.action === 'GetStateObject' && exactStateKey(capability, op)) return;
  throw new AuthorizationError('PRESERVATION_READ_ONLY_DENIED');
}

function authorizeCloudflareInventory(capability, op) {
  if (op.service === 'cloudflare-discovery' && op.action === 'GetZoneMetadata'
    && op.resource?.accountId === TARGETS.cloudflareVerifyAccount && op.resource?.zoneName === TARGETS.cloudflareVerifyZoneName) return;
  if (op.service === 'cloudflare-api' && op.action === 'GetBucketMetadata'
    && op.resource?.accountId === TARGETS.cloudflareVerifyAccount && op.resource?.discovery === true) {
    return;
  }
  if (!capability.manifest.bindings?.cloudflare?.reviewed) throw new AuthorizationError('DISCOVERY_BINDING_REVIEW_REQUIRED');
  if (!isBoundCfBucket(capability, op)) throw new AuthorizationError('UNBOUND_CLOUDFLARE_BUCKET');
  if (op.service === 'cloudflare-api' && op.action === 'GetLifecycle') return;
  if (op.service === 'cloudflare-s3' && READ_ACTIONS.has(op.action)) return authorizeReadPayload(op, { allowAnyKey: true });
  if (op.service === 'state' && op.action === 'GetStateObject' && exactStateKey(capability, op)) return;
  throw new AuthorizationError('INVENTORY_OPERATION_DENIED');
}

function authorizeNewAwsAvailability(op) {
  if (op.service === 'aws-s3' && op.resource?.bucket === TARGETS.proofAwsBucket
    && ['HeadBucket', 'GetBucketMetadata'].includes(op.action)) return;
  if (op.service === 'aws-query' && op.action === 'ListBuckets' && op.resource?.accountId === TARGETS.awsAccount) return;
  throw new AuthorizationError('NEW_AWS_INVENTORY_IS_AVAILABILITY_ONLY');
}

function authorizeProvisioning(capability, op) {
  if (op.service === 'aws-sts' && op.action === 'GetCallerIdentity') return;
  if (op.service === 'aws-iam' && op.action === 'GetIdentityMetadata'
    && op.resource?.accountId === TARGETS.awsAccount
    && op.resource?.oidcProviderArn === `arn:aws:iam::${TARGETS.awsAccount}:oidc-provider/token.actions.githubusercontent.com`) return;
  if (op.service === 'terraform' && op.action === 'TerraformCreate'
    && op.resource?.stack === 'new-aws-proof'
    && op.resource?.planDigest === capability.manifest.approvedCreatePlanDigest
    && sameExactList(op.resource?.addresses, capability.manifest.approvedCreateAddresses)) return;
  if (op.service === 'terraform' && op.action === 'GetIdentityMetadata'
    && op.resource?.stack === 'new-aws-proof') return;
  throw new AuthorizationError('PROVISIONING_OPERATION_DENIED');
}

function authorizeLifecycleOwner(capability, op) {
  const cf = capability.manifest.bindings?.cloudflare;
  const lifecycle = capability.manifest.lifecycle ?? {};
  if (!cf?.reviewed || !cf?.bucket) throw new AuthorizationError('DISCOVERY_BINDING_REVIEW_REQUIRED');
  if (op.service === 'cloudflare-api' && op.action === 'GetLifecycle' && isBoundCfBucket(capability, op)) return;
  if (op.service === 'cloudflare-api' && op.action === 'UpdateLifecycle' && isBoundCfBucket(capability, op)) {
    const restoring = op.planDigest === lifecycle.approvedRestorePlanDigest;
    if (op.viaTerraform !== true || op.resourceAddress !== lifecycle.terraformResourceAddress
      || !sameExactList(op.planAddresses, lifecycle.terraformAddresses)) {
      throw new AuthorizationError('LIFECYCLE_TERRAFORM_TRANSACTION_REQUIRED');
    }
    const expectedLiveDigest = restoring ? lifecycle.currentDigest : lifecycle.baselineDigest;
    if (op.liveCheck?.lockHeld !== true || op.liveCheck.lifecycleDigest !== expectedLiveDigest
      || op.liveCheck.stateDigest !== lifecycle.expectedStateDigest
      || op.liveCheck.writerFreezeDigest !== lifecycle.writerFreezeDigest) {
      throw new AuthorizationError('LIFECYCLE_PREFLIGHT_DRIFT');
    }
    if (restoring) {
      if (!lifecycle.observationClosedAt || !['complete', 'censored'].includes(lifecycle.observationOutcome)) {
        throw new AuthorizationError('PREMATURE_LIFECYCLE_RESTORATION');
      }
      if (op.baselineDigest !== lifecycle.currentDigest || op.stateDigest !== lifecycle.expectedStateDigest) {
        throw new AuthorizationError('LIFECYCLE_STATE_DRIFT');
      }
    } else if (op.planDigest !== lifecycle.approvedAddPlanDigest) {
      throw new AuthorizationError('LIFECYCLE_PLAN_HASH_MISMATCH');
    } else if (op.baselineDigest !== lifecycle.baselineDigest || op.stateDigest !== lifecycle.expectedStateDigest) {
      throw new AuthorizationError('LIFECYCLE_STATE_DRIFT');
    }
    validateLifecycleChange(op.payload, lifecycle.baseline, lifecycle.addition, { restore: restoring });
    return;
  }
  if (op.service === 'state' && ['GetStateObject', 'PutStateLock', 'DeleteStateLock', 'PutStateObject'].includes(op.action)) {
    const allow = capability.manifest.lifecycle?.backendKeys ?? [];
    if (op.resource?.migration || op.resource?.backendMigration) throw new AuthorizationError('LIFECYCLE_BACKEND_MIGRATION_DENIED');
    if (op.resource?.backend !== 'cloudflare-verify'
      || op.resource?.backendBucket !== capability.manifest.bindings?.cloudflare?.backendBucket
      || !allow.includes(op.resource?.key)) throw new AuthorizationError('LIFECYCLE_BACKEND_KEY_DENIED');
    if (op.action === 'PutStateObject' && op.resource?.key !== capability.manifest.lifecycle?.stateKey) throw new AuthorizationError('LIFECYCLE_BACKEND_KEY_DENIED');
    return;
  }
  if (op.service === 'state' && op.action === 'DeleteStateObject') throw new AuthorizationError('LIFECYCLE_BACKEND_DELETE_DENIED');
  if (op.service === 'terraform' && op.action === 'GetIdentityMetadata'
    && op.resource?.stack === 'cloudflare-lifecycle'
    && !op.resource?.migration && !op.resource?.deleteLifecycleResource) return;
  if (op.service === 'terraform' && op.action === 'TerraformCreate'
    && op.resource?.stack === 'cloudflare-lifecycle'
    && [lifecycle.approvedAddPlanDigest, lifecycle.approvedRestorePlanDigest].includes(op.resource?.planDigest)
    && sameExactList(op.resource?.addresses, lifecycle.terraformAddresses)
    && !op.resource?.migration && !op.resource?.deleteLifecycleResource) return;
  throw new AuthorizationError('LIFECYCLE_OWNER_OPERATION_DENIED');
}

function authorizeCloudflareCache(capability, op) {
  const binding = capability.manifest.bindings?.cloudflare;
  if (capability.context !== 'proof' || !binding?.reviewed || !binding?.zoneId
    || op.action !== 'CreateInvalidation' || op.resource?.accountId !== TARGETS.cloudflareVerifyAccount
    || op.resource?.zoneId !== binding.zoneId) throw new AuthorizationError('CLOUDFLARE_CACHE_CONTEXT_DENIED');
  return validateInvalidationPaths(op.payload?.paths, capability.manifest, capability.context, capability.command);
}

function authorizeCloudflareProof(capability, op) {
  const context = capability.context;
  if (!isBoundCfBucket(capability, op)) throw new AuthorizationError('UNBOUND_CLOUDFLARE_BUCKET');
  if (context === 'observer') {
    if (op.service === 'cloudflare-api' && op.action === 'GetLifecycle') return;
    if (op.service === 'cloudflare-s3' && ['HeadObject', 'ListObjectsV2', 'ListObjectVersions', 'GetObject'].includes(op.action)
      && isLifePrefix(op)) return authorizeReadPayload(op);
    throw new AuthorizationError('OBSERVATION_IS_READ_ONLY');
  }
  if (context === 'cleanup' && op.action === 'UpdateLifecycle') return authorizeLifecycleOwner(capability, op);
  return authorizeSiteData(capability, op, context);
}

function authorizeAwsObservation(capability, op) {
  if (op.service !== 'aws-s3' || op.resource?.bucket !== TARGETS.proofAwsBucket) throw new AuthorizationError('OBSERVATION_TARGET_DENIED');
  if (!['HeadObject', 'ListObjectsV2', 'ListObjectVersions', 'GetObject', 'GetBucketLifecycleConfiguration', 'GetBucketVersioning'].includes(op.action)) {
    throw new AuthorizationError('OBSERVATION_IS_READ_ONLY');
  }
  if (['HeadObject', 'GetObject'].includes(op.action)
    && (typeof op.key !== 'string' || !op.key.startsWith(`_previews/${TARGETS.lifeSite}/`))) {
    throw new AuthorizationError('OBSERVATION_PREFIX_DENIED');
  }
  if (['ListObjectsV2', 'ListObjectVersions'].includes(op.action)
    && (typeof op.prefix !== 'string' || !op.prefix.startsWith(`_previews/${TARGETS.lifeSite}/`))) {
    throw new AuthorizationError('OBSERVATION_PREFIX_DENIED');
  }
  return authorizeReadPayload(op);
}

function authorizeAwsProof(capability, op) {
  if (op.service === 'aws-cloudfront' && op.action === 'CreateInvalidation') {
    const expected = capability.manifest.bindings?.aws?.distributionId;
    if (!expected || op.resource?.distributionId !== expected) throw new AuthorizationError('UNBOUND_DISTRIBUTION');
    return validateInvalidationPaths(op.payload?.paths, capability.manifest, capability.context, capability.command);
  }
  if (op.service !== 'aws-s3' || op.resource?.bucket !== TARGETS.proofAwsBucket) throw new AuthorizationError('AWS_PROOF_TARGET_DENIED');
  return authorizeSiteData(capability, op, capability.context);
}

function authorizeSiteData(capability, op, context) {
  const read = READ_ACTIONS.has(op.action);
  const write = WRITE_ACTIONS.has(op.action);
  const site = siteFromOperation(op);
  if (site && !TARGETS.proofSites.includes(site)) throw new AuthorizationError('SITE_NAMESPACE_DENIED');
  if (context === 'proof' || context === 'gzip') {
    if (site === TARGETS.lifeSite && (capability.phase === PHASE.A7 || (isWriteOperation(op) && capability.manifest.lifecycle?.observationStartedAt))) {
      throw new AuthorizationError('LIFE_FROZEN_OR_CLEANUP_GATED');
    }
    if (site && site !== TARGETS.lifeSite && !read && !write) throw new AuthorizationError('OPERATION_DENIED');
    if (op.action === 'CreateInvalidation') return validateInvalidationPaths(op.payload?.paths, capability.manifest, context, capability.command);
    if (op.service === 'delivery' && op.action === 'GetDelivery') return authorizeDeliveryRead(capability, op);
    if (isProofObjectOperation(op) && (read || write)) return authorizeProofPayload(capability, op, context);
  }
  if (context === 'observer') throw new AuthorizationError('OBSERVATION_IS_READ_ONLY');
  if (context === 'cleanup') {
    if (site === TARGETS.lifeSite && write && !capability.manifest.lifecycle?.observationClosedAt) throw new AuthorizationError('OBSERVATION_NOT_CLOSED');
    if (op.action === 'UpdateLifecycle') return authorizeLifecycleOwner(capability, op);
    if (isProofObjectOperation(op) && (read || write)) return authorizeProofPayload(capability, op, context);
  }
  if (context === 'cleanup-post-a7') {
    if (site === TARGETS.lifeSite || op.service === 'terraform' || op.action === 'TerraformDestroy') throw new AuthorizationError('POST_A7_PRESERVES_LIFE_AND_STACK');
    if (op.action === 'DeleteObjects' || op.action === 'DeleteObject') {
      validateKeys(requestKeys(op), new Set(TARGETS.proofSites.filter((item) => item !== TARGETS.lifeSite)));
      return;
    }
    if (isProofObjectOperation(op) && read) return authorizeReadPayload(op);
  }
  if (context === 'cleanup-final-a8') {
    return authorizeFinalCleanup(capability, op);
  }
  throw new AuthorizationError('SITE_OPERATION_DENIED');
}

function authorizeDeliveryRead(capability, op) {
  if (!['GET', 'HEAD'].includes(op.method) || !approvedPath(op.path)) throw new AuthorizationError('DELIVERY_READ_DENIED');
  const host = op.resource?.hostname;
  const expected = capability.manifest.bindings?.aws?.hostname === host
    || capability.manifest.bindings?.cloudflare?.hostname === host;
  const reviewed = new Set(capability.manifest.reviewedDeliveryPaths?.[capability.command] ?? []);
  if (!expected || !reviewed.has(op.path)) throw new AuthorizationError('DELIVERY_PATH_NOT_REVIEWED');
}

function authorizePostA7Cleanup(capability, op) {
  if (op.service === 'aws-s3' && op.resource?.bucket === TARGETS.proofAwsBucket) {
    if (op.action === 'PutObject' && op.key === '_indexes/sites.json') return authorizeRegistryMutation(capability, op, 'cleanup-post-a7');
    const site = siteFromOperation(op);
    if (site === TARGETS.lifeSite || op.action === 'TerraformDestroy') throw new AuthorizationError('POST_A7_PRESERVES_LIFE_AND_STACK');
    if (op.action === 'DeleteObjects' || op.action === 'DeleteObject') {
      validateKeys(requestKeys(op), new Set(TARGETS.proofSites.filter((item) => item !== TARGETS.lifeSite)));
      return;
    }
    if (READ_ACTIONS.has(op.action)) return authorizeReadPayload(op, {
      allowedSites: new Set(TARGETS.proofSites.filter((site) => site !== TARGETS.lifeSite)),
    });
  }
  if (op.service === 'cloudflare-s3' && isBoundCfBucket(capability, op)) {
    if (op.action === 'PutObject' && op.key === '_indexes/sites.json') return authorizeRegistryMutation(capability, op, 'cleanup-post-a7');
    const site = siteFromOperation(op);
    if (site === TARGETS.lifeSite) throw new AuthorizationError('POST_A7_PRESERVES_LIFE_AND_STACK');
    if (op.action === 'DeleteObjects' || op.action === 'DeleteObject') {
      validateKeys(requestKeys(op), new Set(TARGETS.proofSites.filter((item) => item !== TARGETS.lifeSite)));
      return;
    }
    if (READ_ACTIONS.has(op.action)) return authorizeReadPayload(op, {
      allowedSites: new Set(TARGETS.proofSites.filter((site) => site !== TARGETS.lifeSite)),
    });
  }
  throw new AuthorizationError('POST_A7_CLEANUP_DENIED');
}

function authorizeAwsReconciliation(capability, op) {
  if (op.service !== 'aws-s3' || op.resource?.bucket !== TARGETS.proofAwsBucket) throw new AuthorizationError('AWS_RECONCILIATION_TARGET_DENIED');
  const site = siteFromOperation(op);
  if (site === TARGETS.lifeSite && !capability.manifest.lifecycle?.observationClosedAt) throw new AuthorizationError('OBSERVATION_NOT_CLOSED');
  if (op.action === 'TerraformDestroy') throw new AuthorizationError('DESTROY_REQUIRES_FINAL_A8');
  if (['DeleteObject', 'DeleteObjects', 'UnregisterSite', 'PublishRegistry'].includes(op.action)) return authorizeSiteData(capability, op, 'cleanup');
  if (READ_ACTIONS.has(op.action)) return authorizeReadPayload(op);
  return authorizeSiteData(capability, op, 'cleanup');
}

function authorizeFinalCleanup(capability, op) {
  const state = capability.manifest.lifecycle ?? {};
  if (!state.observationClosedAt || !['complete', 'censored'].includes(state.observationOutcome)) throw new AuthorizationError('OBSERVATION_OUTCOME_REQUIRED');
  if (!['completed', 'not-run'].includes(capability.manifest.a9Status)) throw new AuthorizationError('A9_OUTCOME_REQUIRED');
  if (!capability.manifest.cleanup?.acceptedDestroyPlanDigest
    || capability.manifest.cleanup.acceptedDestroyPlanDigest !== capability.manifest.approvedDestroyPlanDigest) {
    throw new AuthorizationError('DESTROY_PLAN_NOT_ACCEPTED');
  }
  if (capability.manifest.cleanup?.cfLifecycleRestored !== true) throw new AuthorizationError('CLOUDFLARE_LIFECYCLE_NOT_RESTORED');
  const writerVersion = capability.manifest.cleanup?.writerVersion;
  if (capability.manifest.cleanup?.requiredWriterRange && !writerVersion) throw new AuthorizationError('CLEANUP_WRITER_VERSION_REQUIRED');
  if (writerVersion && capability.manifest.cleanup?.requiredWriterRange
    && !versionInRange(writerVersion, capability.manifest.cleanup.requiredWriterRange)) throw new AuthorizationError('INCOMPATIBLE_CLEANUP_WRITER');
  if (op.service === 'terraform' && op.action === 'TerraformDestroy' && op.resource?.stack === 'new-aws-proof') {
    if (op.resource.planDigest !== capability.manifest.approvedDestroyPlanDigest
      || !sameExactList(op.resource.addresses, capability.manifest.approvedDestroyAddresses)
      || !sameExactList(capability.manifest.approvedDestroyAddresses, capability.manifest.createdResourceAddresses)
      || op.resource.addresses.includes('aws_iam_openid_connect_provider.github')) {
      throw new AuthorizationError('DESTROY_PLAN_NOT_ACCEPTED');
    }
    return;
  }
  if (op.service === 'aws-s3' && op.resource?.bucket === TARGETS.proofAwsBucket
    && op.action === 'PutObject' && op.key === '_indexes/sites.json') return authorizeRegistryMutation(capability, op, 'cleanup-final-a8');
  if (op.service === 'cloudflare-s3' && isBoundCfBucket(capability, op)
    && op.action === 'PutObject' && op.key === '_indexes/sites.json') return authorizeRegistryMutation(capability, op, 'cleanup-final-a8');
  if (op.service === 'aws-s3' && op.resource?.bucket === TARGETS.proofAwsBucket && ['DeleteObject', 'DeleteObjects', 'UnregisterSite'].includes(op.action)) {
    if (siteFromOperation(op) !== TARGETS.lifeSite) throw new AuthorizationError('FINAL_A8_LIFE_CLEANUP_ONLY');
    validateKeys(requestKeys(op), new Set([TARGETS.lifeSite]));
    return;
  }
  if (op.service === 'cloudflare-api' && op.action === 'UpdateLifecycle') return authorizeLifecycleOwner(capability, op);
  if (op.service === 'cloudflare-s3' && isBoundCfBucket(capability, op) && ['DeleteObject', 'DeleteObjects', 'UnregisterSite'].includes(op.action)) {
    if (siteFromOperation(op) !== TARGETS.lifeSite) throw new AuthorizationError('FINAL_A8_LIFE_CLEANUP_ONLY');
    validateKeys(requestKeys(op), new Set([TARGETS.lifeSite]));
    return;
  }
  if (READ_ACTIONS.has(op.action) && (op.resource?.bucket === TARGETS.proofAwsBucket || isBoundCfBucket(capability, op))) return authorizeReadPayload(op);
  throw new AuthorizationError('FINAL_CLEANUP_OPERATION_DENIED');
}

function authorizeReadPayload(op, { allowAnyKey = false, allowedSites = new Set(TARGETS.proofSites) } = {}) {
  if (op.action === 'DeleteObjects') throw new AuthorizationError('MUTATION_NOT_A_READ');
  if (op.action === 'CreateInvalidation') throw new AuthorizationError('MUTATION_NOT_A_READ');
  if (['GetObject', 'HeadObject'].includes(op.action) && typeof op.key !== 'string') throw new AuthorizationError('OBJECT_KEY_REQUIRED');
  if (['ListObjectsV2', 'ListObjectVersions'].includes(op.action)
    && (typeof op.prefix !== 'string' || op.prefix.length === 0)) throw new AuthorizationError('OBJECT_PREFIX_REQUIRED');
  if (allowAnyKey) return;
  if (Array.isArray(op.payload?.keys)) validateKeys(op.payload.keys, allowedSites);
  if (op.key != null) validateKey(op.key, allowedSites);
  if (['ListObjectsV2', 'ListObjectVersions'].includes(op.action)) validateKey(op.prefix, allowedSites);
}

function authorizeProofPayload(capability, op, context) {
  const allowedSites = new Set(TARGETS.proofSites);
  if (context === 'cleanup-post-a7' || capability.phase === PHASE.A7) allowedSites.delete(TARGETS.lifeSite);
  if ([PHASE.A5_DELIVERY, PHASE.A6_DELIVERY, PHASE.A7].includes(capability.phase) || context === 'gzip') {
    allowedSites.delete(TARGETS.lifeSite);
  }
  if (capability.phase === PHASE.A8_SETUP) {
    allowedSites.clear();
    allowedSites.add(TARGETS.lifeSite);
  }
  if (context === 'cleanup-final-a8' || context === 'cleanup') {
    allowedSites.clear();
    allowedSites.add(TARGETS.lifeSite);
  }
  if (['GetObject', 'HeadObject', 'PutObject', 'DeleteObject', 'CopyObject'].includes(op.action)
    && typeof op.key !== 'string') throw new AuthorizationError('OBJECT_KEY_REQUIRED');
  if (['ListObjectsV2', 'ListObjectVersions'].includes(op.action)
    && (typeof op.prefix !== 'string' || op.prefix.length === 0)) throw new AuthorizationError('OBJECT_PREFIX_REQUIRED');
  if (op.action === 'CopyObject' && typeof (op.payload?.copySourceKey ?? op.payload?.sourceKey) !== 'string') {
    throw new AuthorizationError('COPY_SOURCE_REQUIRED');
  }
  if (op.action === 'DeleteObjects') validateKeys(requestKeys(op), allowedSites);
  else if (Array.isArray(op.payload?.keys)) validateKeys(op.payload.keys, allowedSites);
  if (op.key != null) validateKey(op.key, allowedSites);
  if (['ListObjectsV2', 'ListObjectVersions'].includes(op.action)) validateKey(op.prefix, allowedSites);
  for (const sourceKey of [op.payload?.copySourceKey, op.payload?.sourceKey].filter(Boolean)) validateKey(sourceKey, allowedSites);
  for (const key of [op.key, ...requestKeys(op)].filter(Boolean)) {
    if (isSharedWriterKey(key) && isWriteOperation(op)) validateReviewedDelta(capability, op, key);
  }
  if (op.action === 'PublishRegistry' || op.key === '_indexes/sites.json') {
    if (isWriteOperation(op)) return authorizeRegistryMutation(capability, op, context);
  }
  return;
}

function authorizeRegistryMutation(capability, op, context) {
  validateReviewedDelta(capability, op, '_indexes/sites.json');
  validateRegistryTransition(capability, op, context);
}

function validateReviewedDelta(capability, op, key) {
  const digest = op.payload?.deltaDigest;
  const expected = capability.manifest.reviewedDeltas?.[capability.command]?.[key];
  if (!expected || digest !== expected) throw new AuthorizationError('UNREVIEWED_SHARED_DELTA', key);
}

function validateRegistryTransition(capability, op, context) {
  const baseline = capability.manifest.registryBaseline?.siteIds;
  const next = op.payload?.registrySiteIds;
  if (!Array.isArray(baseline) || !Array.isArray(next)) throw new AuthorizationError('REGISTRY_PRESERVATION_EVIDENCE_REQUIRED');
  if (baseline.some((site) => !next.includes(site))) throw new AuthorizationError('PREEXISTING_REGISTRATION_REMOVED');
  const proofSet = new Set(TARGETS.proofSites);
  if (next.some((site) => !baseline.includes(site) && !proofSet.has(site))) throw new AuthorizationError('UNRELATED_REGISTRATION_ADDED');
  const required = new Set(op.payload?.requiredProofSites ?? []);
  if (context === 'cleanup-post-a7') {
    for (const site of [TARGETS.lifeSite]) if (!next.includes(site)) throw new AuthorizationError('POST_A7_MUST_RETAIN_LIFE');
    for (const site of [TARGETS.proofSites[0], TARGETS.proofSites[1], TARGETS.proofSites[2]]) {
      if (next.includes(site)) throw new AuthorizationError('POST_A7_REGISTRATION_REMAINS');
    }
  } else if (context === 'cleanup-final-a8') {
    if (TARGETS.proofSites.some((site) => next.includes(site))) throw new AuthorizationError('FINAL_A8_PROOF_REGISTRATION_REMAINS');
  } else {
    for (const site of required) if (!next.includes(site)) throw new AuthorizationError('REQUIRED_PROOF_REGISTRATION_MISSING');
  }
}

function isSharedWriterKey(key) {
  return key === '_indexes/sites.json' || key === '_control/versions/registry.json'
    || key === '_control/versions/app.json' || key === 'index.html' || key === 'preview-bridge.js'
    || key.startsWith('assets/');
}

function isWriteOperation(op) {
  return WRITE_ACTIONS.has(op.action);
}

function isProofObjectOperation(op) {
  return ['aws-s3', 'cloudflare-s3', 'cloudflare-cache'].includes(op.service)
    || (op.service === 'cloudflare-api' && ['PublishSite', 'PublishRegistry', 'UnregisterSite'].includes(op.action));
}

function siteFromOperation(op) {
  const payloadPaths = Array.isArray(op.payload?.paths) ? op.payload.paths : [];
  const keys = [...requestKeys(op), op.key, op.prefix, ...payloadPaths].filter(Boolean);
  const match = String(keys[0] ?? '').match(/^_(?:indexes|artifacts|previews|control)\/(?:sites\/)?([^/]+)\//);
  return match?.[1];
}

function requestKeys(op) {
  if (op.action === 'DeleteObjects') {
    const keys = op.payload?.keys;
    const objects = op.payload?.objects;
    if (Array.isArray(keys) === Array.isArray(objects)) throw new AuthorizationError('UNVERIFIABLE_BATCH_OBJECTS');
    if (Array.isArray(keys)) return keys;
    if (!Array.isArray(objects) || objects.length === 0) throw new AuthorizationError('UNVERIFIABLE_BATCH_OBJECTS');
    return objects.map((item) => {
      if (!item || typeof item.Key !== 'string' || Object.keys(item).some((key) => !['Key', 'VersionId'].includes(key))
        || (item.VersionId !== undefined && (typeof item.VersionId !== 'string' || item.VersionId.length === 0))) {
        throw new AuthorizationError('UNVERIFIABLE_BATCH_OBJECTS');
      }
      return item.Key;
    });
  }
  if (Array.isArray(op.payload?.keys)) return op.payload.keys;
  return op.key ? [op.key] : [];
}

function validateKeys(keys, allowedSites) {
  if (!Array.isArray(keys) || keys.length === 0) throw new AuthorizationError('EMPTY_OR_UNVERIFIABLE_BATCH');
  for (const key of keys) validateKey(key, allowedSites);
}

function validateKey(key, allowedSites) {
  if (typeof key !== 'string' || key.startsWith('/') || key.includes('..') || key.includes('\\') || /%2f|%5c/i.test(key)
    || /[\u0000-\u001f]/.test(key)) {
    throw new AuthorizationError('UNSAFE_OBJECT_KEY');
  }
  if (key === '_indexes/sites.json' || key === '_control/locks/registry.json'
    || key === '_control/versions/registry.json' || key === '_control/versions/app.json'
    || key === 'index.html' || key === 'preview-bridge.js' || key.startsWith('assets/')) return;
  for (const site of allowedSites) {
    const prefixes = [`_indexes/${site}/`, `_artifacts/${site}/`, `_previews/${site}/`, `_control/sites/${site}/`];
    if (prefixes.some((prefix) => key.startsWith(prefix))) return;
  }
  if (key.endsWith('/') && key.startsWith('_previews/')) {
    const site = key.split('/')[1];
    if (allowedSites.has(site)) return;
  }
  throw new AuthorizationError('OBJECT_KEY_DENIED');
}

function validateInvalidationPaths(paths, manifest, context, command) {
  if (!Array.isArray(paths) || paths.length === 0) throw new AuthorizationError('INVALIDATION_PATHS_REQUIRED');
  const reviewed = new Set(manifest.reviewedInvalidationPaths?.[command] ?? []);
  for (const path of paths) {
    if (typeof path !== 'string' || !path.startsWith('/') || /[*\\?#\u0000-\u001f]/.test(path)
      || /%2f|%5c/i.test(path) || path.includes('..')) throw new AuthorizationError('INVALIDATION_PATH_DENIED');
    const allowed = ['/_indexes/sites.json', '/index.html', '/preview-bridge.js', '/assets/'];
    const siteMatch = path.match(/^\/_indexes\/(proof-[^/]+-20261018)\//)
      ?? path.match(/^\/_artifacts\/(proof-[^/]+-20261018)\//)
      ?? path.match(/^\/(proof-[^/]+-20261018)\//);
    const sitePath = Boolean(siteMatch && TARGETS.proofSites.includes(siteMatch[1]));
    if (!allowed.some((item) => path === item || path.startsWith(item)) && !sitePath) throw new AuthorizationError('INVALIDATION_PATH_DENIED');
    const phase = commandRules[command]?.phase;
    if (siteMatch?.[1] === TARGETS.lifeSite && ([PHASE.A5_DELIVERY, PHASE.A6_DELIVERY, PHASE.A7, PHASE.A9].includes(phase))) {
      throw new AuthorizationError('LIFE_FROZEN_OR_CLEANUP_GATED');
    }
    if (phase === PHASE.A8_SETUP && siteMatch && siteMatch[1] !== TARGETS.lifeSite) throw new AuthorizationError('OBJECT_KEY_DENIED');
    if (!reviewed.has(path)) throw new AuthorizationError('INVALIDATION_PATH_NOT_REVIEWED');
    if (context === 'proof' && path.includes(TARGETS.lifeSite)
      && (commandRules[command]?.phase === PHASE.A7 || manifest.lifecycle?.observationStartedAt)) {
      throw new AuthorizationError('LIFE_FROZEN_OR_CLEANUP_GATED');
    }
  }
}

function isLifePrefix(op) {
  const key = op.key ?? op.prefix ?? '';
  return key.startsWith(`_previews/${TARGETS.lifeSite}/`) || key === `_indexes/${TARGETS.lifeSite}/index.json`;
}

function isBoundCfBucket(capability, op) {
  const cf = op.resource ?? {};
  const binding = capability?.manifest?.bindings?.cloudflare;
  const expected = binding?.bucket;
  return Boolean(binding?.reviewed && expected && cf.accountId === TARGETS.cloudflareVerifyAccount
    && cf.bucket === expected && cf.zoneId === binding.zoneId);
}

function approvedPath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('/_control/') && !path.includes('..');
}

function exactStateKey(capability, op) {
  const expected = op.resource?.backend === 'preserved-aws-verify'
    ? capability.manifest.bindings?.aws?.preservedStateKey
    : capability.manifest.bindings?.cloudflare?.stateKey;
  return Boolean(expected) && op.resource?.key === expected;
}

export function validateLifecycleChange(next, baseline, addition, { restore = false } = {}) {
  if (!Array.isArray(next) || !Array.isArray(baseline)) throw new AuthorizationError('LIFECYCLE_RULES_REQUIRED');
  const ids = next.map((rule) => rule?.id);
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new AuthorizationError('DUPLICATE_OR_INVALID_LIFECYCLE_ID');
  const expectedRule = addition ?? {
    id: 'proof-life-20261018-expire',
    enabled: true,
    conditions: { prefix: '_previews/proof-life-20261018/' },
    delete_objects_transition: { condition: { type: 'Age', max_age: 86400 } },
    abort_multipart_uploads_transition: { condition: { type: 'Age', max_age: 604800 } },
  };
  const before = canonicalRules(baseline);
  const after = canonicalRules(next);
  if (restore) {
    if (after.some((rule) => rule.id === expectedRule.id) || !sameJson(after, before)) {
      throw new AuthorizationError('LIFECYCLE_RESTORE_DRIFT');
    }
    return;
  }
  if (after.filter((rule) => rule.id === expectedRule.id).length !== 1) throw new AuthorizationError('LIFECYCLE_ADDITION_MISSING');
  const filtered = after.filter((rule) => rule.id !== expectedRule.id);
  if (!sameJson(filtered, before)) throw new AuthorizationError('LIFECYCLE_UNRELATED_RULE_CHANGED');
  const actual = after.find((rule) => rule.id === expectedRule.id);
  if (!sameJson(actual, expectedRule)) throw new AuthorizationError('LIFECYCLE_RULE_SCOPE_MISMATCH');
}

function canonicalRules(rules) {
  return rules.map((rule) => structuredClone(rule)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function sameJson(a, b) {
  return JSON.stringify(canonicalValue(a)) === JSON.stringify(canonicalValue(b));
}

function sameExactList(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected) && actual.length > 0 && actual.length === expected.length
    && new Set(actual).size === actual.length && new Set(expected).size === expected.length
    && expected.every((item) => actual.includes(item));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}

export function validateDistributionBinding({ address, expectedAddress, accountId, expectedAccountId, distributionId, outputs, partialApply = false }) {
  if (partialApply) throw new AuthorizationError('PARTIAL_APPLY_REQUIRES_RECOVERY_REVIEW');
  if (address !== expectedAddress || accountId !== expectedAccountId || !distributionId) throw new AuthorizationError('DISTRIBUTION_BINDING_MISMATCH');
  if (distributionId === TARGETS.preservedAwsDistribution || distributionId === outputs?.preservedDistributionId) {
    throw new AuthorizationError('PRESERVED_DISTRIBUTION_SUBSTITUTION');
  }
  if (outputs?.distributionId !== distributionId || outputs?.resourceAddress !== expectedAddress) {
    throw new AuthorizationError('DISTRIBUTION_OUTPUT_SUBSTITUTION');
  }
  return Object.freeze({ address, accountId, distributionId, arn: `arn:aws:cloudfront::${accountId}:distribution/${distributionId}` });
}

export function validateDiscoveryCandidates({ candidates, approvedAccountId, trustedBinding }) {
  if (!Array.isArray(candidates) || candidates.length !== 1) throw new AuthorizationError('DISCOVERY_CANDIDATE_AMBIGUOUS');
  const candidate = candidates[0];
  if (candidate.accountId !== approvedAccountId || candidate.accountId === TARGETS.cloudflareProductionAccount
    || candidate.zoneName !== TARGETS.cloudflareVerifyZoneName || !candidate.zoneId || !candidate.bucket) {
    throw new AuthorizationError('DISCOVERY_CANDIDATE_NOT_BINDABLE');
  }
  const required = ['zoneId', 'bucket', 'endpoint', 'hostname', 'backendBucket', 'backendKey', 'configDigest', 'stateLineage', 'reviewedSealDigest'];
  if (!trustedBinding || trustedBinding.ownerReviewed !== true
    || trustedBinding.provenance !== 'verification-root+state+delivery-config'
    || required.some((field) => !trustedBinding[field])
    || trustedBinding.zoneId !== candidate.zoneId || trustedBinding.bucket !== candidate.bucket) {
    throw new AuthorizationError('TRUSTED_DISCOVERY_BINDING_REQUIRED');
  }
  return candidate;
}

export function validateChildEnvironment(environment, { allowProofCredentials = false } = {}) {
  const forbidden = [
    'AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_EC2_METADATA_SERVICE_ENDPOINT',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  ];
  for (const key of forbidden) {
    if (environment[key] && !(allowProofCredentials && ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'].includes(key))) {
      throw new AuthorizationError('INHERITED_CREDENTIAL_FALLBACK', key);
    }
  }
  if (environment.ARTIFACT_PAGES_PROOF_BUCKET_OVERRIDE
    && environment.ARTIFACT_PAGES_PROOF_BUCKET_OVERRIDE !== TARGETS.proofAwsBucket) {
    throw new AuthorizationError('SMOKE_BUCKET_OVERRIDE_DENIED');
  }
}

export function validateEffectiveConfig(config, { provider, target }) {
  if (!config || typeof config !== 'object' || config.provider !== provider) throw new AuthorizationError('CONFIG_PROVIDER_MISMATCH');
  const actual = provider === 'aws' ? config.aws?.bucket : config.cloudflare?.bucket;
  if (actual !== target) throw new AuthorizationError('CONFIG_TARGET_MISMATCH');
  if (provider === 'aws' && (config.aws?.endpointOverride || config.aws?.accessPointArn || config.aws?.useArnRegion)) {
    throw new AuthorizationError('AWS_ALTERNATE_ADDRESSING_DENIED');
  }
  if (config.credentialSource && config.credentialSource !== 'isolated-proof-session') throw new AuthorizationError('CONFIG_CREDENTIAL_SOURCE_DENIED');
}

export function validateCleanupState(manifest, phase, { now = Date.now(), writerVersion } = {}) {
  const lifecycle = manifest.lifecycle ?? {};
  if (phase === 'post-a7') {
    const approvalExpiry = timestamp(manifest.approvalState?.A7?.expiresAt);
    if (!Number.isFinite(approvalExpiry) || approvalExpiry <= now) throw new AuthorizationError('APPROVAL_EXPIRED');
    return { deleteSites: TARGETS.proofSites.filter((site) => site !== TARGETS.lifeSite), deleteLife: false, destroyStack: false };
  }
  if (phase !== 'final-a8') throw new AuthorizationError('UNKNOWN_CLEANUP_PHASE');
  if (!['complete', 'censored'].includes(lifecycle.observationOutcome) || !lifecycle.observationClosedAt) throw new AuthorizationError('OBSERVATION_OUTCOME_REQUIRED');
  if (!['completed', 'not-run'].includes(manifest.a9Status)) throw new AuthorizationError('A9_OUTCOME_REQUIRED');
  if (!manifest.cleanup?.acceptedDestroyPlanDigest || manifest.cleanup.acceptedDestroyPlanDigest !== manifest.approvedDestroyPlanDigest) {
    throw new AuthorizationError('DESTROY_PLAN_NOT_ACCEPTED');
  }
  if (manifest.cleanup?.cfLifecycleRestored !== true) throw new AuthorizationError('CLOUDFLARE_LIFECYCLE_NOT_RESTORED');
  const effectiveWriterVersion = writerVersion ?? manifest.cleanup?.writerVersion;
  if (manifest.cleanup?.requiredWriterRange && !effectiveWriterVersion) throw new AuthorizationError('CLEANUP_WRITER_VERSION_REQUIRED');
  if (effectiveWriterVersion && manifest.cleanup?.requiredWriterRange && !versionInRange(effectiveWriterVersion, manifest.cleanup.requiredWriterRange)) {
    throw new AuthorizationError('INCOMPATIBLE_CLEANUP_WRITER');
  }
  return { deleteSites: [TARGETS.lifeSite], deleteLife: true, destroyStack: true };
}

function versionInRange(version, range) {
  if (range === '>=0.5.0 <0.6.0') return /^0\.5\./.test(version);
  return version === range;
}

export function validateCapsAndExpiry(manifest, approval, usage, now = Date.now()) {
  const approvalExpiry = timestamp(approval?.expiresAt);
  if (!Number.isFinite(approvalExpiry) || approvalExpiry <= now) throw new AuthorizationError('APPROVAL_EXPIRED');
  const caps = manifest.caps ?? {};
  for (const [name, value] of Object.entries(usage ?? {})) {
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(caps[name]) || value > caps[name]) {
      throw new AuthorizationError('CAP_EXHAUSTED', name);
    }
  }
}

function timestamp(value) {
  return typeof value === 'number' ? value : Date.parse(value);
}

export function isReadOnlyAction(action) {
  return READ_ACTIONS.has(action);
}

export function policyAllows(policy, action, resource) {
  const statements = Array.isArray(policy?.Statement) ? policy.Statement : [policy?.Statement].filter(Boolean);
  let allowed = false;
  for (const statement of statements) {
    const effect = String(statement?.Effect ?? '').toLowerCase();
    if (!effect || !actionMatches(statement, action) || !resourceMatches(statement, resource)) continue;
    if (effect === 'deny' && !statement.Condition) return false;
    if (effect === 'allow') allowed = true; // Conditions are treated as potentially true.
  }
  return allowed;
}

export function assertPolicyExcludesPreserved(policy) {
  const cases = [
    ['s3:GetObject', `arn:aws:s3:::${TARGETS.preservedAwsBucket}/proof-containment-probe`],
    ['s3:PutObject', `arn:aws:s3:::${TARGETS.preservedAwsBucket}/proof-containment-probe`],
    ['s3:DeleteObject', `arn:aws:s3:::${TARGETS.preservedAwsBucket}/proof-containment-probe`],
    ['s3:DeleteObjects', `arn:aws:s3:::${TARGETS.preservedAwsBucket}/proof-containment-probe`],
    ['cloudfront:CreateInvalidation', `arn:aws:cloudfront::${TARGETS.awsAccount}:distribution/${TARGETS.preservedAwsDistribution}`],
  ];
  const allowed = cases.filter(([action, resource]) => policyAllows(policy, action, resource));
  if (allowed.length) throw new AuthorizationError('SESSION_POLICY_INCLUDES_PRESERVED_ARN');
  return true;
}

function actionMatches(statement, action) {
  if (statement.Action !== undefined) return toList(statement.Action).some((pattern) => iamMatch(pattern, action));
  if (statement.NotAction !== undefined) return !toList(statement.NotAction).some((pattern) => iamMatch(pattern, action));
  return false;
}

function resourceMatches(statement, resource) {
  if (statement.Resource !== undefined) return toList(statement.Resource).some((pattern) => iamMatch(pattern, resource));
  if (statement.NotResource !== undefined) return !toList(statement.NotResource).some((pattern) => iamMatch(pattern, resource));
  return false;
}

function toList(value) {
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function iamMatch(pattern, value) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i').test(String(value));
}
