import { AuthorizationError, authorizeOperation, validateCapsAndExpiry } from './policy.mjs';

export class GuardedTransport {
  #capability;
  #credentialLoader;
  #transport;
  #serializer;
  #signer;
  #maxRetries;
  #usage;
  #startedAt;
  #baseOperatorMinutes;

  constructor({ capability, credentialLoader, transport, serializer = defaultSerializer, signer = passthroughSigner, maxRetries = 0 }) {
    if (typeof credentialLoader !== 'function' || typeof transport !== 'function') {
      throw new TypeError('guarded transport needs a credential loader and transport');
    }
    this.#capability = capability;
    this.#credentialLoader = credentialLoader;
    this.#transport = transport;
    this.#serializer = serializer;
    this.#signer = signer;
    this.#maxRetries = Math.max(0, Math.min(maxRetries, 5));
    this.#usage = { ...(capability?.manifest?.usage ?? { requests: 0, bytes: 0, operatorMinutes: 0 }) };
    this.#startedAt = Date.now();
    this.#baseOperatorMinutes = this.#usage.operatorMinutes ?? 0;
  }

  async request(operation) {
    let current = cloneOperation(operation);
    for (let attempt = 0; ; attempt += 1) {
      authorizeOperation(this.#capability, current);
      const wire = await this.#serializer(current);
      const finalOperation = operationFromWire(wire, current);
      authorizeOperation(this.#capability, finalOperation);
      assertWireTarget(wire, finalOperation);
      const reservedBytes = this.#reserveBudget(wire);
      const credentials = await this.#credentialLoader({
        identityClass: this.#capability.context,
        phase: this.#capability.phase,
        sealDigest: this.#capability.sealDigest,
      });
      const signed = await this.#signer(wire, credentials, finalOperation);
      const signedOperation = operationFromWire(signed, current);
      authorizeOperation(this.#capability, signedOperation);
      assertWireTarget(signed, signedOperation);
      this.#reconcileSignedBudget(signed, reservedBytes);
      const response = await this.#transport(signed, signedOperation);

      if (isRedirect(response)) {
        const redirected = redirectOperation(current, response);
        // The source request has already completed. The redirected target is
        // independently checked before credentials are loaded or a second
        // request is dispatched.
        authorizeOperation(this.#capability, redirected);
        current = redirected;
        continue;
      }

      if (isRetryable(response) && attempt < this.#maxRetries) {
        current = response.retryOperation ? cloneOperation(response.retryOperation) : cloneOperation(current);
        continue;
      }
      return response;
    }
  }

  #reserveBudget(wire) {
    const bytes = Buffer.byteLength(wire.body ?? '', 'utf8');
    const next = this.#usageSnapshot({ requests: 1, bytes });
    this.#validateBudget(next);
    this.#usage = next;
    return bytes;
  }

  #reconcileSignedBudget(wire, reservedBytes) {
    const bytes = Buffer.byteLength(wire.body ?? '', 'utf8');
    if (bytes === reservedBytes) return;
    const next = this.#usageSnapshot({ bytes: bytes - reservedBytes });
    this.#validateBudget(next);
    this.#usage = next;
  }

  #usageSnapshot(delta) {
    const elapsedMinutes = Math.ceil((Date.now() - this.#startedAt) / 60_000);
    return {
      ...this.#usage,
      requests: (this.#usage.requests ?? 0) + (delta.requests ?? 0),
      bytes: (this.#usage.bytes ?? 0) + (delta.bytes ?? 0),
      operatorMinutes: Math.max(this.#usage.operatorMinutes ?? 0, this.#baseOperatorMinutes + elapsedMinutes),
    };
  }

  #validateBudget(usage) {
    const manifest = this.#capability.manifest;
    const approvalExpiry = this.#capability.approvalExpiresAt
      ?? manifest.approvalWindows?.[this.#capability.approval]?.expiresAt
      ?? manifest.scopeExpiresAt;
    validateCapsAndExpiry(manifest, { expiresAt: approvalExpiry }, usage);
  }

  async listAll(firstOperation, { next = (response) => response?.nextOperation, collect = (response) => response?.items ?? [] } = {}) {
    const items = [];
    let operation = cloneOperation(firstOperation);
    const seen = new Set();
    while (operation) {
      const pageToken = operation.payload?.continuationToken ?? '';
      const pageIdentity = JSON.stringify([operation.service, operation.action, operation.resource, operation.key, operation.prefix, pageToken]);
      if (seen.has(pageIdentity)) throw new AuthorizationError('PAGINATION_LOOP');
      seen.add(pageIdentity);
      const response = await this.request(operation);
      if (response?.status >= 400) throw new AuthorizationError('PAGINATION_REQUEST_FAILED');
      items.push(...collect(response));
      operation = next(response);
    }
    return items;
  }
}

function cloneOperation(operation) {
  if (!operation || typeof operation !== 'object') throw new AuthorizationError('INVALID_OPERATION');
  return structuredClone(operation);
}

function defaultSerializer(operation) {
  return {
    method: operation.method,
    url: `${operation.endpoint}${operation.path ?? ''}`,
    endpoint: operation.endpoint,
    body: operation.payload === undefined ? undefined : JSON.stringify(operation.payload),
    operation: structuredClone(operation),
  };
}

function operationFromWire(wire, original) {
  if (!wire || typeof wire !== 'object' || !wire.operation || wire.rawRequest === true) {
    throw new AuthorizationError('RAW_REQUEST_BYPASS_DENIED');
  }
  const operation = structuredClone(wire.operation);
  if (wire.method !== operation.method) throw new AuthorizationError('SERIALIZED_METHOD_MISMATCH');
  if (wire.endpoint !== operation.endpoint) throw new AuthorizationError('SERIALIZED_ENDPOINT_MISMATCH');
  if (wire.body !== undefined) {
    let payload;
    try {
      payload = JSON.parse(wire.body);
    } catch {
      throw new AuthorizationError('UNPARSEABLE_REQUEST_PAYLOAD');
    }
    operation.payload = payload;
  }
  if (operation.service !== original.service || operation.action !== original.action) {
    throw new AuthorizationError('SERIALIZED_OPERATION_MISMATCH');
  }
  return operation;
}

function assertWireTarget(wire, operation) {
  let url;
  try {
    url = new URL(wire.url);
  } catch {
    throw new AuthorizationError('INVALID_WIRE_URL');
  }
  const endpoint = new URL(operation.endpoint);
  if (url.origin !== endpoint.origin || url.username || url.password || url.hash) {
    throw new AuthorizationError('WIRE_TARGET_MISMATCH');
  }
  const expectedPath = operation.path ?? '/';
  const actualPath = `${url.pathname}${url.search}`;
  if (actualPath !== expectedPath) throw new AuthorizationError('WIRE_PATH_MISMATCH');
}

function isRedirect(response) {
  return [301, 302, 303, 307, 308].includes(response?.status) && Boolean(response?.headers?.location);
}

function redirectOperation(operation, response) {
  const redirectedUrl = new URL(response.headers.location, operation.endpoint);
  return {
    ...operation,
    endpoint: redirectedUrl.origin,
    path: `${redirectedUrl.pathname}${redirectedUrl.search}`,
    endpointOverride: false,
  };
}

function isRetryable(response) {
  return response?.retryable === true || [408, 429, 500, 502, 503, 504].includes(response?.status);
}

async function passthroughSigner(wire) {
  return wire;
}
