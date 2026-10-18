#!/usr/bin/env node

import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { attachApproval, prepareApproval } from './approval-helpers.mjs';
import { appendSeal, requireActiveSeal, verifyApprovalFile } from './seals.mjs';
import {
  AuthorizationError,
  TARGETS,
  capabilityForLocalTest,
  resolveCommandCapability,
  authorizeOperation,
  validateCapsAndExpiry,
  validateCleanupState,
  validateChildEnvironment,
} from './policy.mjs';

const valueOptions = new Set([
  '--manifest', '--stage', '--artifact', '--provider', '--cases', '--approval', '--path', '--out',
  '--command', '--operation', '--phase', '--writer-version', '--plan-digest', '--expires-at', '--signature', '--payload',
]);
const booleanOptions = new Set(['--offline', '--setup', '--observe-only', '--reconcile', '--plan-only']);

export async function main(argv = process.argv.slice(2), environment = process.env) {
  try {
    const [subcommand, ...rest] = argv;
    if (!subcommand) throw new Error('USAGE: proof.mjs <seal|approval-prepare|approval-attach|inventory|bootstrap-aws|delivery|failures|lifecycle|gzip|cleanup|cloudflare-api-get|guard|external>');
    const args = parseOptions(rest);
    rejectContextOverrides(environment);
    if (subcommand === 'seal') return await commandSeal(args);
    if (subcommand === 'approval-prepare') return await commandApprovalPrepare(args);
    if (subcommand === 'approval-attach') return await commandApprovalAttach(args);
    if (subcommand === 'guard') return await commandGuard(args, environment);
    if (subcommand === 'external') {
      validateChildEnvironment(environment);
      return commandExternal(args);
    }
    return await commandPhase(subcommand, args, environment);
  } catch (error) {
    const code = error?.code ?? 'PROOF_HARNESS_ERROR';
    process.stderr.write(`${code}\n`);
    return 2;
  }
}

async function commandSeal(args) {
  requireValues(args, ['--manifest']);
  if (args['--offline'] !== true) throw new AuthorizationError('SEAL_REQUIRES_OFFLINE');
  const artifactList = normalizeMulti(args['--artifact']);
  const result = await appendSeal({
    manifestPath: args['--manifest'],
    stage: args['--stage'] ?? 'bootstrap',
    artifacts: artifactList,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, stage: result.record.stage, sequence: result.record.sequence, digest: result.record.digest, seal: path.relative(process.cwd(), result.path) })}\n`);
  return 0;
}

async function commandGuard(args, environment) {
  requireValues(args, ['--manifest', '--command', '--operation']);
  validateChildEnvironment(environment);
  const { manifest, capability } = await loadCapability(args['--manifest'], args['--command'], args['--approval']);
  const operation = JSON.parse(await readFile(args['--operation'], 'utf8'));
  authorizeOperation(capability, operation);
  validateCapsAndExpiry(manifest, manifest.approvalWindows?.[args['--approval']] ?? { expiresAt: manifest.scopeExpiresAt }, manifest.usage);
  process.stdout.write(`${JSON.stringify({ ok: true, command: capability.command, phase: capability.phase, context: capability.context, sealDigest: capability.sealDigest })}\n`);
  return 0;
}

async function commandPhase(subcommand, args, environment) {
  requireValues(args, ['--manifest']);
  const { command, approval } = commandFor(subcommand, args);
  if (approval && args['--approval'] !== approval) throw new AuthorizationError('APPROVAL_ID_MISMATCH');
  if (args['--approval'] && args['--approval'] !== approval) throw new AuthorizationError('APPROVAL_ID_MISMATCH');
  validateChildEnvironment(environment);
  const { manifest, capability } = await loadCapability(args['--manifest'], command, args['--approval']);
  validateCommandSpecificArgs(subcommand, args, manifest);
  if (subcommand === 'cleanup') {
    validateCleanupState(manifest, args['--phase'], { writerVersion: args['--writer-version'] ?? manifest.cleanup?.writerVersion });
  }
  if (subcommand === 'cloudflare-api-get') validateCloudflareGet(args, manifest);
  if (args['--plan-only'] === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, command, phase: capability.phase, context: capability.context, sealDigest: capability.sealDigest, planOnly: true })}\n`);
    return 0;
  }
  throw new AuthorizationError('ENFORCING_BROKER_REQUIRED');
}

function commandExternal(args) {
  requireValues(args, ['--manifest', '--command']);
  throw new AuthorizationError('UNMODIFIED_SUBPROCESS_BLOCKED_REQUIRES_ENFORCING_BROKER');
}

async function commandApprovalPrepare(args) {
  requireValues(args, ['--manifest', '--approval', '--command', '--expires-at']);
  const prepared = await prepareApproval({
    manifestPath: args['--manifest'],
    approvalId: args['--approval'],
    command: args['--command'],
    expiresAt: args['--expires-at'],
    outPath: args['--out'],
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    approvalId: prepared.record.id,
    command: prepared.record.command,
    scopeDigest: prepared.scopeDigest,
    activeSealDigest: prepared.activeSealDigest,
    artifactHashes: prepared.artifacts,
    expiresAt: prepared.record.expiresAt,
    payloadPath: path.relative(process.cwd(), prepared.payloadPath),
    payloadDigest: prepared.payloadDigest,
    signCommand: prepared.signCommand,
  })}\n`);
  return 0;
}

async function commandApprovalAttach(args) {
  requireValues(args, ['--manifest', '--approval', '--command']);
  const attached = await attachApproval({
    manifestPath: args['--manifest'],
    approvalId: args['--approval'],
    command: args['--command'],
    payloadPath: args['--payload'],
    signaturePath: args['--signature'],
    outPath: args['--out'],
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    approvalId: args['--approval'],
    command: args['--command'],
    sealDigest: attached.sealDigest,
    payloadDigest: attached.payloadDigest,
    approvalFile: path.relative(process.cwd(), attached.approvalFile),
  })}\n`);
  return 0;
}

async function loadCapability(manifestPath, command, approvalId) {
  const absolute = path.resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absolute, 'utf8'));
  if (manifest.testOnly === true) throw new AuthorizationError('TEST_FIXTURE_CANNOT_AUTHORIZE_EXTERNAL_WORK');
  if (Object.hasOwn(manifest, 'reviewKeys')) throw new AuthorizationError('MANIFEST_REVIEW_KEYS_REJECTED');
  const scopeExpiry = Date.parse(manifest.scopeExpiresAt);
  if (!Number.isFinite(scopeExpiry) || scopeExpiry <= Date.now()) throw new AuthorizationError('SCOPE_EXPIRED');
  if ((manifest.collisions?.length ?? 0) > 0 || (manifest.inventory?.collisions?.length ?? 0) > 0) throw new AuthorizationError('RESOURCE_COLLISION');
  if (!manifest.caps || !manifest.usage) throw new AuthorizationError('CAP_USAGE_REQUIRED');
  validateCapsAndExpiry(manifest, manifest.approvalWindows?.[approvalId] ?? { expiresAt: manifest.scopeExpiresAt }, manifest.usage);
  const active = await requireActiveSeal(absolute);
  const verifiedManifest = {
    ...manifest,
    activeSealDigest: active.digest,
    activeSeal: active,
    sealChainVerified: true,
  };
  let approvalRecord = null;
  if (approvalId) approvalRecord = await verifyApprovalFile({ manifestPath: absolute, approvalId, command });
  const capability = resolveCommandCapability(command, verifiedManifest, approvalRecord);
  return { manifest: verifiedManifest, capability };
}

function commandFor(subcommand, args) {
  if (subcommand === 'inventory') return { command: 'inventory', approval: 'A4' };
  if (subcommand === 'bootstrap-aws') return { command: 'bootstrap-aws', approval: 'A5' };
  if (subcommand === 'delivery') {
    if (!['aws', 'cloudflare'].includes(args['--provider'])) throw new AuthorizationError('PROVIDER_REQUIRED');
    return { command: `delivery:${args['--provider']}`, approval: args['--provider'] === 'aws' ? 'A5' : 'A6' };
  }
  if (subcommand === 'failures') {
    if (!['aws', 'cloudflare'].includes(args['--provider'])) throw new AuthorizationError('PROVIDER_REQUIRED');
    return { command: `failures:${args['--provider']}`, approval: 'A7' };
  }
  if (subcommand === 'lifecycle') {
    if (!['aws', 'cloudflare'].includes(args['--provider'])) throw new AuthorizationError('PROVIDER_REQUIRED');
    const modes = ['--setup', '--observe-only', '--reconcile'].filter((mode) => args[mode] === true);
    if (modes.length !== 1) throw new AuthorizationError('LIFECYCLE_MODE_REQUIRED');
    return { command: `lifecycle:${args['--provider']}:${modes[0].slice(2)}`, approval: 'A8' };
  }
  if (subcommand === 'gzip') return { command: 'gzip', approval: 'A9' };
  if (subcommand === 'cleanup') {
    if (!['post-a7', 'final-a8'].includes(args['--phase'])) throw new AuthorizationError('CLEANUP_PHASE_REQUIRED');
    return { command: `cleanup:${args['--phase']}`, approval: args['--phase'] === 'post-a7' ? 'A7' : 'A8' };
  }
  if (subcommand === 'cloudflare-api-get') return { command: 'cloudflare-api-get', approval: 'A4' };
  throw new AuthorizationError('UNKNOWN_COMMAND');
}

function validateCommandSpecificArgs(subcommand, args, manifest) {
  if (['delivery', 'failures'].includes(subcommand)) {
    const cases = String(args['--cases'] ?? '').split(',').filter(Boolean);
    if (!cases.length || cases.some((item) => !/^P(?:[1-9]|10)$/.test(item))) throw new AuthorizationError('INVALID_CASE_SELECTOR');
  }
  if (subcommand === 'cleanup' && args['--plan-digest'] && args['--plan-digest'] !== manifest.approvedDestroyPlanDigest) {
    throw new AuthorizationError('DESTROY_PLAN_NOT_ACCEPTED');
  }
}

function validateCloudflareGet(args, manifest) {
  const expected = manifest.bindings?.cloudflare;
  if (!expected?.reviewed || !expected.bucket || !expected.zoneId) throw new AuthorizationError('DISCOVERY_BINDING_REVIEW_REQUIRED');
  const pathValue = args['--path'];
  const exact = `/accounts/${TARGETS.cloudflareVerifyAccount}/r2/buckets/${expected.bucket}/lifecycle`;
  if (pathValue !== exact) throw new AuthorizationError('CLOUDFLARE_GET_PATH_DENIED');
  if (args['--out']) {
    const out = path.resolve(args['--out']);
    const runtime = path.dirname(path.resolve(args['--manifest']));
    if (!out.startsWith(`${runtime}${path.sep}`)) throw new AuthorizationError('OUTPUT_OUTSIDE_RUNTIME');
  }
}

function parseOptions(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (booleanOptions.has(name)) {
      if (result[name] !== undefined) throw new Error('DUPLICATE_OPTION');
      result[name] = true;
      continue;
    }
    if (!valueOptions.has(name) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error('UNKNOWN_OR_MISSING_OPTION');
    const value = argv[++i];
    if (name === '--artifact') result[name] = [...(result[name] ?? []), value];
    else if (result[name] !== undefined) throw new Error('DUPLICATE_OPTION');
    else result[name] = value;
  }
  return result;
}

function requireValues(args, names) {
  if (names.some((name) => !args[name])) throw new Error('MISSING_REQUIRED_OPTION');
}

function normalizeMulti(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function rejectContextOverrides(environment) {
  for (const name of ['ARTIFACT_PAGES_PROOF_CONTEXT', 'ARTIFACT_PAGES_PROOF_IDENTITY', 'ARTIFACT_PAGES_PROOF_TARGET', 'ARTIFACT_PAGES_PROOF_ENDPOINT']) {
    if (environment[name]) throw new AuthorizationError('CONTEXT_OVERRIDE_DENIED', name);
  }
}

const invokedModulePath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
const currentModulePath = await realpath(new URL(import.meta.url)).catch(() => null);
if (invokedModulePath && currentModulePath && invokedModulePath === currentModulePath) {
  process.exitCode = await main();
}
