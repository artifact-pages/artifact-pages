import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalDigest } from './canonical.mjs';
import { AuthorizationError } from './policy.mjs';

const POLICY_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'policies');
const PLACEHOLDER = /^\{\{([A-Z0-9_]+)\}\}$/u;

export const AWS_POLICY_TEMPLATE_FILES = Object.freeze({
  inventory: 'aws-inventory-role-policy.json',
  provisioner: 'aws-provisioner-role-policy.json',
  testOperatorBoundary: 'aws-test-operator-boundary.json',
  cloudfrontCreation: 'aws-cloudfront-creation-session.json',
  publisherBoundaries: 'aws-publisher-boundaries.json',
  sessions: 'aws-session-profiles.json',
  trusts: 'aws-trust-documents.json',
});

export async function readPolicyTemplate(name) {
  const filename = AWS_POLICY_TEMPLATE_FILES[name] ?? name;
  if (typeof filename !== 'string' || filename.includes('/') || filename.includes('..')) throw new AuthorizationError('POLICY_TEMPLATE_UNKNOWN');
  return JSON.parse(await readFile(path.join(POLICY_DIRECTORY, filename), 'utf8'));
}

export function renderPolicyTemplate(template, bindings) {
  if (!template || typeof template !== 'object' || !bindings || typeof bindings !== 'object') throw new TypeError('template and bindings are required');
  const rendered = renderValue(template, bindings);
  const unresolved = findUnresolved(rendered);
  if (unresolved.length) throw new AuthorizationError('POLICY_TEMPLATE_UNBOUND', unresolved.join(','));
  return rendered;
}

export function policyDocumentDigest(document) {
  return canonicalDigest(document);
}

export function assertNoWildcardAllows(document, { allowedWildcardActions = [] } = {}) {
  const allowWildcard = new Set(allowedWildcardActions);
  for (const statement of statements(document)) {
    if (statement.Effect !== 'Allow') continue;
    if (Object.hasOwn(statement, 'NotAction') || Object.hasOwn(statement, 'NotResource')) {
      throw new AuthorizationError('WILDCARD_ALLOW_NOT_REVIEWED');
    }
    const actions = asList(statement.Action);
    if (actions.some((action) => typeof action !== 'string' || action.includes('*') || action.includes('?'))) {
      throw new AuthorizationError('WILDCARD_ALLOW_NOT_REVIEWED');
    }
    const resources = asList(statement.Resource);
    for (const resource of resources) {
      if (typeof resource !== 'string') throw new AuthorizationError('WILDCARD_ALLOW_NOT_REVIEWED');
      if (resource === '*') {
        if (actions.some((action) => !allowWildcard.has(action))) throw new AuthorizationError('WILDCARD_ALLOW_NOT_REVIEWED');
      } else if (/[*?]/u.test(resource) && !isS3TerminalObjectWildcard(resource)) {
        throw new AuthorizationError('WILDCARD_ALLOW_NOT_REVIEWED');
      }
    }
  }
  return true;
}

export function assertProofPolicyContainsDenies(document, proofBindings = {}) {
  const all = statements(document);
  const unconditionalDenies = all.filter((item) => item.Effect === 'Deny' && !Object.hasOwn(item, 'Condition'));
  const denyResources = unconditionalDenies.flatMap((item) => asList(item.Resource));
  const denyNotResources = unconditionalDenies.flatMap((item) => asList(item.NotResource));
  const policyText = JSON.stringify({ denyResources, denyNotResources });
  const protectedTargets = [
    'arn:aws:s3:::artifact-pages-231136241959-us-east-1',
    'arn:aws:s3:::artifact-pages-231136241959-us-east-1/*',
    'arn:aws:cloudfront::231136241959:distribution/ECFTIR5GVPQDF',
  ];
  const allActionDenies = unconditionalDenies.filter((item) => asList(item.Action).includes('*'));
  if (protectedTargets.some((target) => !allActionDenies.some((statement) => denyMatchesResource(statement, target)))) {
    throw new AuthorizationError('PRESERVED_RESOURCE_DENY_MISSING');
  }
  if (protectedTargets.some((target) => !policyText.includes(target))) throw new AuthorizationError('PRESERVED_RESOURCE_DENY_MISSING');
  const proofBucketArn = proofBindings.PROOF_BUCKET_ARN;
  const proofDistributionArn = proofBindings.PROOF_DISTRIBUTION_ARN;
  if (proofBucketArn && !policyText.includes(proofBucketArn)) throw new AuthorizationError('PROOF_BUCKET_BOUNDARY_MISSING');
  if (proofDistributionArn && !policyText.includes(proofDistributionArn)) throw new AuthorizationError('PROOF_DISTRIBUTION_BOUNDARY_MISSING');
  return true;
}

function isS3TerminalObjectWildcard(resource) {
  return /^arn:[^:*?]+:s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](?:\/[^*?]*)?\/\*$/u.test(resource);
}

export async function renderAwsPolicySet(bindings) {
  const [inventory, provisioner, testOperatorBoundary, cloudfrontCreation, publisherBoundaries, sessionFile, trusts] = await Promise.all([
    readPolicyTemplate('inventory'),
    readPolicyTemplate('provisioner'),
    readPolicyTemplate('testOperatorBoundary'),
    readPolicyTemplate('cloudfrontCreation'),
    readPolicyTemplate('publisherBoundaries'),
    readPolicyTemplate('sessions'),
    readPolicyTemplate('trusts'),
  ]);
  const rendered = {
    inventory: renderPolicyTemplate(inventory, bindings),
    provisioner: renderPolicyTemplate(provisioner, bindings),
    testOperatorBoundary: renderPolicyTemplate(testOperatorBoundary, bindings),
    cloudfrontCreation: renderPolicyTemplate(cloudfrontCreation, bindings),
    publisherAdminBoundary: renderPolicyTemplate(publisherBoundaries.admin, bindings),
    publisherSatelliteBoundary: renderPolicyTemplate(publisherBoundaries.satellite, bindings),
    sessionProfiles: renderPolicyTemplate(sessionFile.profiles, bindings),
    trustDocuments: renderPolicyTemplate(trusts, bindings),
  };
  assertNoWildcardAllows(rendered.inventory, { allowedWildcardActions: ['sts:GetCallerIdentity', 's3:ListAllMyBuckets'] });
  assertNoWildcardAllows(rendered.provisioner, {
    allowedWildcardActions: [
      'sts:GetCallerIdentity', 'cloudfront:CreateDistribution', 'cloudfront:CreateFunction', 'cloudfront:TagResource',
      'cloudfront:CreateOriginAccessControl', 'cloudfront:CreateCachePolicy', 'cloudfront:CreateResponseHeadersPolicy',
    ],
  });
  assertNoWildcardAllows(rendered.testOperatorBoundary, { allowedWildcardActions: ['sts:GetCallerIdentity'] });
  assertNoWildcardAllows(rendered.cloudfrontCreation, {
    allowedWildcardActions: [
      'cloudfront:CreateDistribution', 'cloudfront:CreateFunction', 'cloudfront:CreateOriginAccessControl',
      'cloudfront:CreateCachePolicy', 'cloudfront:CreateResponseHeadersPolicy', 'cloudfront:TagResource',
    ],
  });
  assertNoWildcardAllows(rendered.publisherAdminBoundary, { allowedWildcardActions: ['sts:GetCallerIdentity'] });
  assertNoWildcardAllows(rendered.publisherSatelliteBoundary, { allowedWildcardActions: ['sts:GetCallerIdentity'] });
  for (const policy of Object.values(rendered.sessionProfiles)) assertNoWildcardAllows(policy, { allowedWildcardActions: ['sts:GetCallerIdentity'] });
  assertProofPolicyContainsDenies(rendered.provisioner, bindings);
  assertProofPolicyContainsDenies(rendered.testOperatorBoundary, bindings);
  assertProofPolicyContainsDenies(rendered.publisherAdminBoundary, bindings);
  assertProofPolicyContainsDenies(rendered.publisherSatelliteBoundary, bindings);
  return Object.freeze({
    documents: rendered,
    digests: Object.fromEntries(Object.entries(rendered).map(([key, value]) => [key, policyDocumentDigest(value)])),
  });
}

function renderValue(value, bindings) {
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) {
      const rendered = renderValue(item, bindings);
      if (Array.isArray(rendered)) result.push(...rendered);
      else result.push(rendered);
    }
    return result;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, renderValue(nested, bindings)]));
  if (typeof value !== 'string') return value;
  const exact = PLACEHOLDER.exec(value);
  if (exact) {
    if (!Object.hasOwn(bindings, exact[1])) throw new AuthorizationError('POLICY_TEMPLATE_UNBOUND', exact[1]);
    return structuredClone(bindings[exact[1]]);
  }
  return value.replace(/\{\{([A-Z0-9_]+)\}\}/gu, (_match, key) => {
    if (!Object.hasOwn(bindings, key) || Array.isArray(bindings[key]) || typeof bindings[key] !== 'string') {
      throw new AuthorizationError('POLICY_TEMPLATE_UNBOUND', key);
    }
    return bindings[key];
  });
}

function findUnresolved(value, output = []) {
  if (Array.isArray(value)) for (const item of value) findUnresolved(item, output);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) findUnresolved(item, output);
  else if (typeof value === 'string' && /\{\{[A-Z0-9_]+\}\}/u.test(value)) output.push(value);
  return output;
}

function statements(document) {
  if (Array.isArray(document)) return document.flatMap(statements);
  if (!document || typeof document !== 'object') return [];
  if (Array.isArray(document.Statement)) return document.Statement.flatMap(statements);
  if (document.profiles && typeof document.profiles === 'object') return Object.values(document.profiles).flatMap(statements);
  if (document.Effect) return [document];
  return Object.values(document).flatMap(statements);
}

function asList(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function denyMatchesResource(statement, resource) {
  if (statement.Resource !== undefined) return asList(statement.Resource).some((pattern) => wildcardMatch(pattern, resource));
  if (statement.NotResource !== undefined) return !asList(statement.NotResource).some((pattern) => wildcardMatch(pattern, resource));
  return false;
}

function wildcardMatch(pattern, value) {
  if (typeof pattern !== 'string') return false;
  const expression = pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\\*/gu, '.*').replace(/\\\?/gu, '.');
  return new RegExp(`^${expression}$`, 'u').test(value);
}
