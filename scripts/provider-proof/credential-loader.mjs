import { AuthorizationError } from './policy.mjs';

const CREDENTIAL_CLASSES = Object.freeze({
  'aws-inventory': {
    provider: 'aws', accountId: '231136241959', credentialSource: 'aws-sso-assumed-role',
    variables: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
  },
  'aws-provisioner': {
    provider: 'aws', accountId: '231136241959', credentialSource: 'aws-sso-assumed-role',
    variables: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
  },
  'aws-test-operator': {
    provider: 'aws', accountId: '231136241959', credentialSource: 'aws-sso-assumed-role',
    variables: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
  },
  'aws-admin-publisher': {
    implemented: false,
    provider: 'aws', accountId: '231136241959', credentialSource: 'github-actions-oidc',
    variables: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
  },
  'aws-satellite-a': {
    provider: 'aws', accountId: '231136241959', credentialSource: 'github-actions-oidc',
    variables: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
  },
  'aws-observer': {
    implemented: false,
    provider: 'aws', accountId: '231136241959', credentialSource: 'aws-sso-assumed-role',
    variables: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
  },
  'aws-reconcile': {
    implemented: false,
    provider: 'aws', accountId: '231136241959', credentialSource: 'github-actions-oidc',
    variables: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
  },
  'aws-a9-writer': {
    implemented: false,
    provider: 'aws', accountId: '231136241959', credentialSource: 'aws-sso-assumed-role',
    variables: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
  },
  'aws-final-cleanup': {
    implemented: false,
    provider: 'aws', accountId: '231136241959', credentialSource: 'aws-sso-assumed-role',
    variables: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
  },
  'cloudflare-registry-reader': {
    provider: 'cloudflare', accountId: '21a0acb78621cc00cfa655a276d77b74', credentialSource: 'cloudflare-r2-temporary-session',
    variables: ['CF_VERIFY_R2_REGISTRY_READER_ACCESS_KEY_ID', 'CF_VERIFY_R2_REGISTRY_READER_SECRET_ACCESS_KEY', 'CF_VERIFY_R2_REGISTRY_READER_SESSION_TOKEN'],
  },
  'cloudflare-site-a-writer': {
    provider: 'cloudflare', accountId: '21a0acb78621cc00cfa655a276d77b74', credentialSource: 'cloudflare-r2-temporary-session',
    variables: ['CF_VERIFY_R2_ACCESS_KEY_ID', 'CF_VERIFY_R2_SECRET_ACCESS_KEY', 'CF_VERIFY_R2_SESSION_TOKEN'],
  },
  'cloudflare-cache-purge': {
    implemented: false,
    provider: 'cloudflare', accountId: '21a0acb78621cc00cfa655a276d77b74', credentialSource: 'cloudflare-zone-api-token',
    variables: ['CF_VERIFY_API_TOKEN'],
  },
  'cloudflare-life-observer': {
    provider: 'cloudflare', accountId: '21a0acb78621cc00cfa655a276d77b74', credentialSource: 'cloudflare-r2-temporary-session',
    variables: ['CF_VERIFY_R2_ACCESS_KEY_ID', 'CF_VERIFY_R2_SECRET_ACCESS_KEY', 'CF_VERIFY_R2_SESSION_TOKEN'],
  },
  'cloudflare-reconcile': {
    implemented: false,
    provider: 'cloudflare', accountId: '21a0acb78621cc00cfa655a276d77b74', credentialSource: 'cloudflare-r2-temporary-session',
    variables: ['CF_VERIFY_R2_ACCESS_KEY_ID', 'CF_VERIFY_R2_SECRET_ACCESS_KEY', 'CF_VERIFY_R2_SESSION_TOKEN'],
  },
});

const SECRET_KEYS = new Set([
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'CF_VERIFY_R2_ACCESS_KEY_ID', 'CF_VERIFY_R2_SECRET_ACCESS_KEY', 'CF_VERIFY_R2_SESSION_TOKEN',
  'CF_VERIFY_R2_REGISTRY_READER_ACCESS_KEY_ID', 'CF_VERIFY_R2_REGISTRY_READER_SECRET_ACCESS_KEY',
  'CF_VERIFY_R2_REGISTRY_READER_SESSION_TOKEN', 'CF_VERIFY_API_TOKEN',
]);

export const CREDENTIAL_CLASS_NAMES = Object.freeze(Object.keys(CREDENTIAL_CLASSES));

export function credentialClassDefinition(credentialClass) {
  const definition = CREDENTIAL_CLASSES[credentialClass];
  if (!definition || definition.implemented === false) throw new AuthorizationError('EXECUTION_PATH_NOT_IMPLEMENTED', credentialClass);
  return definition;
}

// The source is deliberately injected and kept out of policy/proof modules.
// Production integrations can read the protected host store or assume a role;
// tests supply an in-memory source and never read real credentials.
export class PrivateCredentialLoader {
  constructor({ loadPrivateCredential, now = () => Date.now() }) {
    if (typeof loadPrivateCredential !== 'function') throw new TypeError('private credential source is required');
    this.loadPrivateCredential = loadPrivateCredential;
    this.now = now;
  }

  async load(credentialClass, { minimumLifetimeMs = 60000 } = {}) {
    const definition = credentialClassDefinition(credentialClass);
    const sourceRecord = await this.loadPrivateCredential(credentialClass);
    if (!sourceRecord || sourceRecord.credentialClass !== credentialClass
      || sourceRecord.provider !== definition.provider
      || sourceRecord.credentialSource !== definition.credentialSource
      || sourceRecord.accountId !== definition.accountId
      || typeof sourceRecord.instanceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(sourceRecord.instanceId)
      || !isCanonicalUtc(sourceRecord.expiresAt)
      || Date.parse(sourceRecord.expiresAt) - this.now() < minimumLifetimeMs) {
      throw new AuthorizationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED', 'credential identity, target, or lifetime mismatch');
    }
    if (!sourceRecord.resourceBindings || typeof sourceRecord.resourceBindings !== 'object'
      || !sourceRecord.policyDigests || typeof sourceRecord.policyDigests !== 'object') {
      throw new AuthorizationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED', 'credential policy binding is incomplete');
    }
    const values = sourceRecord.environment;
    if (!values || typeof values !== 'object' || Array.isArray(values)
      || Object.keys(values).some((key) => !definition.variables.includes(key))
      || definition.variables.some((key) => typeof values[key] !== 'string' || values[key] === '')) {
      throw new AuthorizationError('LEAST_PRIVILEGE_CREDENTIALS_REQUIRED', 'credential material does not match the fixed class');
    }
    const credential = {
      credentialClass,
      provider: sourceRecord.provider,
      credentialSource: sourceRecord.credentialSource,
      accountId: sourceRecord.accountId,
      instanceId: sourceRecord.instanceId,
      expiresAt: sourceRecord.expiresAt,
      principalArn: sourceRecord.principalArn,
      policyDigests: structuredClone(sourceRecord.policyDigests),
      resourceBindings: structuredClone(sourceRecord.resourceBindings),
      environment: Object.fromEntries(Object.entries(values).filter(([key]) => SECRET_KEYS.has(key))),
      inspector: sourceRecord.inspector ? structuredClone(sourceRecord.inspector) : null,
    };
    deepFreeze(credential);
    return credential;
  }
}

export function credentialMaterialKeys(credential) {
  return Object.keys(credential?.environment ?? {}).filter((key) => SECRET_KEYS.has(key));
}

export function isCredentialMaterialKey(key) {
  return SECRET_KEYS.has(key);
}

function isCanonicalUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
