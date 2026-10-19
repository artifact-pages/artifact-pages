import { AuthorizationError } from './policy.mjs';

export function requireSealedPreservationCheckpoint(manifest) {
  const checkpoint = manifest?.preservationCheckpoint;
  const artifact = manifest?.activeSeal?.artifacts?.find((item) => item.path === checkpoint?.path);
  if (manifest?.activeSealDigest !== manifest?.activeSeal?.digest
    || checkpoint?.status !== 'passed'
    || typeof checkpoint.path !== 'string'
    || !/^[a-f0-9]{64}$/u.test(checkpoint.sha256 ?? '')
    || artifact?.sha256 !== checkpoint.sha256) {
    throw new AuthorizationError('PRESERVATION_CHECKPOINT_REQUIRED');
  }
  return checkpoint.sha256;
}
