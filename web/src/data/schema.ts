/**
 * Reader compatibility rules (docs/backlog/technical-design/TD2):
 *  - unknown fields are ignored (no exact-key validation);
 *  - a missing optional field disables that feature;
 *  - an unknown integer `schemaVersion` is a confirmed but unreadable format,
 *    which is distinct from a network failure or malformed data.
 */
import supported from './supported-schema-versions.json' with { type: 'json' }

/**
 * The reader's supported-version table lives in supported-schema-versions.json
 * (plain JSON, so the web packaging script can copy it into the release
 * manifest as `reads`). Every reader decides acceptance from this table only.
 */
export type SchemaFormat = keyof typeof supported.reads

/** The schemaVersion values this build of the web app can read, per format. */
export const SUPPORTED_SCHEMA_VERSIONS: Readonly<Record<SchemaFormat, readonly number[]>> = supported.reads

/** True when `value` is a schemaVersion (or full-text `version`) this app reads for `format`. */
export function isSupportedSchema(format: SchemaFormat, value: unknown): boolean {
  return typeof value === 'number' && SUPPORTED_SCHEMA_VERSIONS[format].includes(value)
}

export class UnsupportedSchemaError extends Error {
  constructor(
    readonly format: SchemaFormat,
    readonly found: number,
    readonly url: string,
  ) {
    super(`Unsupported ${format} schemaVersion ${found} (supported: ${SUPPORTED_SCHEMA_VERSIONS[format].join(', ')}): ${url}.`)
    this.name = 'UnsupportedSchemaError'
  }
}

/**
 * Throws UnsupportedSchemaError when the payload declares an integer
 * schemaVersion this app does not read. A missing or non-integer value is left
 * for the caller's ordinary validation to report as invalid data.
 */
export function assertSupportedSchema(payload: unknown, format: SchemaFormat, url: string, field = 'schemaVersion') {
  if (!payload || typeof payload !== 'object') return
  const found = (payload as Record<string, unknown>)[field]
  if (typeof found === 'number' && Number.isSafeInteger(found) && !SUPPORTED_SCHEMA_VERSIONS[format].includes(found)) {
    throw new UnsupportedSchemaError(format, found, url)
  }
}
