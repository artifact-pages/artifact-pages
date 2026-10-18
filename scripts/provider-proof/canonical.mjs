import { createHash } from 'node:crypto';

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function canonicalDigest(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}
