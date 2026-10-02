/**
 * Reader compatibility rules (docs/backlog/technical-design/TD2):
 *  - unknown fields are ignored (no exact-key validation);
 *  - a missing optional field disables that feature;
 *  - an unknown integer `schemaVersion` is a confirmed but unreadable format,
 *    which is distinct from a network failure or malformed data.
 */
export type SchemaFormat = 'registry' | 'site-metadata' | 'artifact-index' | 'preview-catalog' | 'preview-manifest' | 'full-text'

/** The schemaVersion values this build of the web app can read, per format. */
export const SUPPORTED_SCHEMA_VERSIONS: Readonly<Record<SchemaFormat, readonly number[]>> = {
  registry: [1],
  'site-metadata': [1],
  'artifact-index': [1],
  'preview-catalog': [1],
  'preview-manifest': [1],
  'full-text': [1],
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
