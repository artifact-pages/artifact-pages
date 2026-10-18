import { canonicalDigest } from './canonical.mjs';

const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

export const INVOCATION_REGISTRY_VERSION = 1;

// These are argument vectors, never shell fragments. Dynamic values can only be
// read from the sealed runtime inputs named by an argument descriptor.
export const INVOCATIONS = freeze({
  'aws.inventory.identity': {
    transition: 'inventory', provider: 'aws', credentialClass: 'aws-inventory',
    executableRef: 'awsCli', cwdRoot: 'runtime',
    argv: ['sts', 'get-caller-identity', '--output', 'json'],
    outputs: ['evidence/aws-identity.json'], timeoutMs: 15000,
  },
  'aws.inventory.buckets': {
    transition: 'inventory', provider: 'aws', credentialClass: 'aws-inventory',
    executableRef: 'awsCli', cwdRoot: 'runtime',
    argv: ['s3api', 'list-buckets', '--output', 'json'],
    outputs: ['evidence/aws-buckets.json'], timeoutMs: 30000,
  },
  'aws.inventory.preserved-distribution': {
    transition: 'inventory', provider: 'aws', credentialClass: 'aws-inventory',
    executableRef: 'awsCli', cwdRoot: 'runtime',
    argv: ['cloudfront', 'get-distribution', '--id', 'ECFTIR5GVPQDF', '--output', 'json'],
    outputs: ['evidence/aws-preserved-distribution.json'], timeoutMs: 30000,
  },
  'aws.inventory.oidc-provider': {
    transition: 'inventory', provider: 'aws', credentialClass: 'aws-inventory',
    executableRef: 'awsCli', cwdRoot: 'runtime',
    argv: ['iam', 'get-open-id-connect-provider', '--open-id-connect-provider-arn', 'arn:aws:iam::231136241959:oidc-provider/token.actions.githubusercontent.com', '--output', 'json'],
    outputs: ['evidence/aws-oidc-provider.json'], timeoutMs: 30000,
  },
  'aws.inventory.terraform-version': {
    transition: 'inventory', provider: 'aws', credentialClass: 'aws-inventory',
    executableRef: 'terraform', cwdRoot: 'runtime',
    argv: ['version', '-json'], outputs: ['evidence/terraform-version.json'], timeoutMs: 15000,
  },
  'aws.provisioner.plan': {
    transition: 'bootstrap-aws', provider: 'aws', credentialClass: 'aws-provisioner',
    executableRef: 'terraform', cwdRoot: 'awsTerraformRoot',
    argv: ['plan', '-lockfile=readonly', '-out=../aws-create.plan', '-var-file=../aws-proof.tfvars'],
    inputs: ['awsTerraformRoot', 'aws-proof.tfvars'], outputs: ['aws-create.plan'], timeoutMs: 180000,
  },
  'aws.provisioner.apply': {
    transition: 'bootstrap-aws', provider: 'aws', credentialClass: 'aws-provisioner',
    executableRef: 'terraform', cwdRoot: 'awsTerraformRoot',
    argv: ['apply', '../aws-create.plan'], inputs: ['awsTerraformRoot', 'aws-create.plan'],
    outputs: ['evidence/aws-apply.json'], timeoutMs: 3600000,
  },
  'aws.delivery.site-a': {
    transition: 'delivery:aws', provider: 'aws', credentialClass: 'aws-satellite-a',
    executableRef: 'artifactPages', cwdRoot: 'sourceRepository',
    argv: ['site', 'sync', '--config', '../aws-proof.yaml', '--site', 'proof-a-20261018', '--source', 'sites/a', '--format', 'json'],
    inputs: ['sourceRepository', 'aws-proof.yaml'], outputs: ['evidence/aws-site-a-sync.json'], timeoutMs: 300000,
  },
  'cloudflare.delivery.site-a': {
    transition: 'delivery:cloudflare', provider: 'cloudflare', credentialClass: 'cloudflare-site-a-writer',
    executableRef: 'artifactPages', cwdRoot: 'sourceRepository',
    argv: ['site', 'sync', '--config', '../cloudflare-proof.yaml', '--site', 'proof-a-20261018', '--source', 'sites/a', '--format', 'json'],
    inputs: ['sourceRepository', 'cloudflare-proof.yaml'], outputs: ['evidence/cloudflare-site-a-sync.json'], timeoutMs: 300000,
  },
  'aws.reconciliation.site-a': {
    transition: 'lifecycle:aws:reconcile', provider: 'aws', credentialClass: 'aws-reconcile',
    executableRef: 'artifactPages', cwdRoot: 'sourceRepository',
    argv: ['site', 'sync', '--config', '../aws-proof.yaml', '--site', 'proof-life-20261018', '--source', 'sites/life', '--reconcile', '--format', 'json'],
    inputs: ['sourceRepository', 'aws-proof.yaml'], outputs: ['evidence/aws-life-reconcile.json'], timeoutMs: 300000,
  },
  'cloudflare.reconciliation.site-a': {
    transition: 'lifecycle:cloudflare:reconcile', provider: 'cloudflare', credentialClass: 'cloudflare-reconcile',
    executableRef: 'artifactPages', cwdRoot: 'sourceRepository',
    argv: ['site', 'sync', '--config', '../cloudflare-proof.yaml', '--site', 'proof-life-20261018', '--source', 'sites/life', '--reconcile', '--format', 'json'],
    inputs: ['sourceRepository', 'cloudflare-proof.yaml'], outputs: ['evidence/cloudflare-life-reconcile.json'], timeoutMs: 300000,
  },
  'aws.gzip.site-a': {
    transition: 'gzip', provider: 'aws', credentialClass: 'aws-a9-writer',
    executableRef: 'artifactPages', cwdRoot: 'sourceRepository',
    argv: ['site', 'sync', '--config', '../aws-gzip-proof.yaml', '--site', 'proof-a-20261018', '--source', 'sites/a', '--format', 'json'],
    inputs: ['sourceRepository', 'aws-gzip-proof.yaml'], outputs: ['evidence/aws-gzip-sync.json'], timeoutMs: 300000,
  },
  'aws.cleanup.versions': {
    transition: 'cleanup:final-a8', provider: 'aws', credentialClass: 'aws-final-cleanup',
    executableRef: 'awsCli', cwdRoot: 'runtime',
    argv: ['s3api', 'delete-objects', '--bucket', 'ap-proof-231136241959-20261018', '--delete', 'file://deletion-manifest.json', '--output', 'json'],
    inputs: ['deletion-manifest.json'], outputs: ['evidence/aws-delete-results.json'], timeoutMs: 300000,
  },
  'aws.cleanup.destroy': {
    transition: 'cleanup:final-a8', provider: 'aws', credentialClass: 'aws-provisioner',
    executableRef: 'terraform', cwdRoot: 'awsTerraformRoot',
    argv: ['apply', '../aws-destroy.plan'], inputs: ['awsTerraformRoot', 'aws-destroy.plan'],
    outputs: ['evidence/aws-destroy.json'], timeoutMs: 3600000,
  },
});

export const EXECUTION_PATHS = freeze({
  inventory: { implemented: true, invocationIds: ['aws.inventory.identity', 'aws.inventory.buckets', 'aws.inventory.preserved-distribution', 'aws.inventory.oidc-provider', 'aws.inventory.terraform-version'] },
  'bootstrap-aws': { implemented: true, invocationIds: ['aws.provisioner.plan', 'aws.provisioner.apply'] },
  'delivery:aws': { implemented: true, invocationIds: ['aws.delivery.site-a'] },
  // Cloudflare site sync may combine R2 publication and zone-wide purge; the two
  // credentials are deliberately separate and that multi-identity adapter is not implemented.
  'delivery:cloudflare': { implemented: false, invocationIds: [] },
  // Full bounded HEAD/list observation is not represented by a single listing call.
  'lifecycle:aws:observe-only': { implemented: false, invocationIds: [] },
  'lifecycle:cloudflare:observe-only': { implemented: false, invocationIds: [] },
  'lifecycle:aws:reconcile': { implemented: true, invocationIds: ['aws.reconciliation.site-a'] },
  'lifecycle:cloudflare:reconcile': { implemented: false, invocationIds: [] },
  gzip: { implemented: true, invocationIds: ['aws.gzip.site-a'] },
  'cleanup:final-a8': { implemented: true, invocationIds: ['aws.cleanup.versions', 'aws.cleanup.destroy'] },
  // Released CLI fault injection inside an opaque process has no reviewed path.
  'failures:aws': { implemented: false, invocationIds: [] },
  'failures:cloudflare': { implemented: false, invocationIds: [] },
  'lifecycle:aws:setup': { implemented: false, invocationIds: [] },
  'lifecycle:cloudflare:setup': { implemented: false, invocationIds: [] },
  'cleanup:post-a7': { implemented: false, invocationIds: [] },
});

export class InvocationError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'InvocationError';
    this.code = code;
  }
}

export function getInvocation(id) {
  const invocation = INVOCATIONS[id];
  if (!invocation) throw new InvocationError('EXECUTION_PATH_NOT_IMPLEMENTED', id ?? '');
  return invocation;
}

export function getExecutionPath(transition) {
  const path = EXECUTION_PATHS[transition];
  if (!path?.implemented) throw new InvocationError('EXECUTION_PATH_NOT_IMPLEMENTED', transition ?? '');
  return path;
}

export function assertInvocationMatchesTransition(id, transition) {
  const invocation = getInvocation(id);
  if (invocation.transition !== transition) throw new InvocationError('INVOCATION_TRANSITION_MISMATCH');
  if (!getExecutionPath(transition).invocationIds.includes(id)) throw new InvocationError('EXECUTION_PATH_NOT_IMPLEMENTED', id);
  return invocation;
}

export function invocationDefinitionDigest(id, resolved = {}) {
  const invocation = getInvocation(id);
  return canonicalDigest({ registryVersion: INVOCATION_REGISTRY_VERSION, id, invocation, resolved });
}
