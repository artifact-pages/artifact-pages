import type { PreviewCatalog, PreviewDocument, PreviewGroup, PreviewManifest } from '../domain/preview'
import { isValidSiteId } from './indexes'
import { assertSupportedSchema, UnsupportedSchemaError } from './schema'

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const SHA256 = /^[0-9a-f]{64}$/u
const BUNDLE_DIGEST = /^sha256:[0-9a-f]{64}$/u

export const PREVIEW_EXPLANATION =
  'Previews are review copies of changed documents, from pull requests or manual builds, kept apart from the published site.'

export class PreviewLoadError extends Error {
  readonly status?: number
  readonly kind: 'network' | 'http' | 'invalid'

  constructor(message: string, readonly url: string, options?: ErrorOptions & { status?: number; kind?: 'network' | 'http' | 'invalid' }) {
    super(message, options)
    this.name = 'PreviewLoadError'
    this.status = options?.status
    this.kind = options?.kind ?? 'invalid'
  }
}

export type PreviewGroupAvailability = 'available' | 'missing' | 'unknown' | 'invalid' | 'unsupported'

export type PreviewCandidate = {
  group: PreviewGroup
  availability: PreviewGroupAvailability
}

export function previewCatalogUrl(siteId: string) {
  return `/_previews/${encodeURIComponent(siteId)}/catalog.json`
}

export function previewManifestUrl(siteId: string, headSha: string) {
  return `/_previews/${encodeURIComponent(siteId)}/revisions/${encodeURIComponent(headSha)}/manifest.json`
}

export function previewFileUrl(siteId: string, headSha: string, sourcePath: string) {
  const encodedPath = sourcePath.split('/').map(encodeURIComponent).join('/')
  return `/_previews/${encodeURIComponent(siteId)}/revisions/${encodeURIComponent(headSha)}/files/${encodedPath}`
}

export function previewRouteHref(siteId: string, headSha: string, documentPath: string, groupId?: string) {
  const encodedPath = documentPath.split('/').map(encodeURIComponent).join('/')
  const query = groupId ? `?group=${encodeURIComponent(groupId)}` : ''
  return `/${encodeURIComponent(siteId)}/_previews/${encodeURIComponent(headSha)}/${encodedPath}${query}`
}

export async function loadPreviewCatalog(siteId: string, fetcher: typeof fetch = fetch): Promise<PreviewCatalog> {
  if (!isValidSiteId(siteId)) throw new PreviewLoadError(`Invalid preview site: ${siteId}`, previewCatalogUrl(siteId))
  const url = previewCatalogUrl(siteId)
  const payload = await fetchJson(url, fetcher)
  assertSupportedSchema(payload, 'preview-catalog', url)
  if (!isRecord(payload) || payload.schemaVersion !== 1 || payload.site !== siteId || !Array.isArray(payload.groups)) {
    throw new PreviewLoadError(`Invalid preview catalog: ${url}`, url)
  }
  const groups = payload.groups.map(parseGroup)
  const seen = new Set<string>()
  for (const group of groups) {
    if (seen.has(group.id)) throw new PreviewLoadError(`Duplicate preview group: ${group.id}`, url)
    seen.add(group.id)
  }
  return { schemaVersion: 1, site: siteId, groups }
}

export async function loadPreviewCandidates(siteId: string, fetcher: typeof fetch = fetch): Promise<PreviewCandidate[]> {
  const catalog = await loadPreviewCatalog(siteId, fetcher)
  const availabilityByHead = new Map<string, Promise<PreviewGroupAvailability>>()
  const candidates = await Promise.all(catalog.groups.map(async (group) => {
    let availability = availabilityByHead.get(group.headSha)
    if (!availability) {
      availability = loadPreviewManifest(siteId, group.headSha, fetcher).then((manifest) => (
        sameDocuments(group.documents, manifest.documents) ? 'available' as const : 'invalid' as const
      )).catch((error: unknown) => {
        if (error instanceof PreviewLoadError && error.status === 404) return 'missing' as const
        if (error instanceof UnsupportedSchemaError) return 'unsupported' as const
        if (error instanceof PreviewLoadError && error.kind === 'invalid') return 'invalid' as const
        return 'unknown' as const
      })
      availabilityByHead.set(group.headSha, availability)
    }
    return { group, availability: await availability }
  }))
  return candidates.sort((left, right) => right.group.updatedAt.localeCompare(left.group.updatedAt))
}

export async function loadPreviewManifest(siteId: string, headSha: string, fetcher: typeof fetch = fetch): Promise<PreviewManifest> {
  if (!isValidSiteId(siteId) || !isFullSha(headSha)) {
    throw new PreviewLoadError('Invalid preview site or revision identifier', previewManifestUrl(siteId, headSha))
  }
  const url = previewManifestUrl(siteId, headSha)
  const payload = await fetchJson(url, fetcher)
  assertSupportedSchema(payload, 'preview-manifest', url)
  if (
    !isRecord(payload) || payload.schemaVersion !== 1 || payload.site !== siteId || payload.headSha !== headSha ||
    !isFullSha(payload.defaultHeadSha) || !isFullSha(payload.mergeBaseSha) ||
    !isTimestamp(payload.createdAt) || typeof payload.bundleDigest !== 'string' || !BUNDLE_DIGEST.test(payload.bundleDigest) ||
    !Array.isArray(payload.files) || !Array.isArray(payload.documents)
  ) {
    throw new PreviewLoadError(`Invalid preview manifest: ${url}`, url)
  }
  const files = payload.files.map((item) => {
    if (!isRecord(item) || !isSafeSourcePath(item.path) || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256) ||
      typeof item.contentType !== 'string' || item.contentType.trim() === '') {
      throw new PreviewLoadError(`Invalid file record in preview manifest: ${url}`, url)
    }
    return { path: item.path, sha256: item.sha256, contentType: item.contentType }
  })
  const documents = payload.documents.map(parseDocument)
  if (hasDuplicates(files.map(({ path }) => path)) || hasDuplicates(documents.map(({ path }) => path))) {
    throw new PreviewLoadError(`Duplicate path in preview manifest: ${url}`, url)
  }
  const filePaths = new Set(files.map(({ path }) => path))
  if (documents.some(({ path }) => !filePaths.has(path))) {
    throw new PreviewLoadError(`A preview document is absent from its file bundle: ${url}`, url)
  }
  return {
    schemaVersion: 1,
    site: siteId,
    headSha,
    defaultHeadSha: payload.defaultHeadSha,
    mergeBaseSha: payload.mergeBaseSha,
    createdAt: payload.createdAt,
    bundleDigest: payload.bundleDigest,
    files,
    documents,
  }
}

async function fetchJson(url: string, fetcher: typeof fetch): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(url)
  } catch (error) {
    throw new PreviewLoadError(`Could not fetch ${url}`, url, { cause: error, kind: 'network' })
  }
  if (!response.ok) {
    throw new PreviewLoadError(`Request failed with status ${response.status}: ${url}`, url, { status: response.status, kind: 'http' })
  }
  try {
    return await response.json() as unknown
  } catch (error) {
    throw new PreviewLoadError(`Invalid JSON response: ${url}`, url, { cause: error })
  }
}

function parseGroup(value: unknown): PreviewGroup {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.kind !== 'string' ||
    !isFullSha(value.headSha) || !isTimestamp(value.updatedAt) || !Array.isArray(value.documents)) {
    throw new PreviewLoadError('Invalid group in preview catalog', previewCatalogUrl('invalid'))
  }
  const documents = value.documents.map(parseDocument)
  if (hasDuplicates(documents.map(({ path }) => path))) throw new PreviewLoadError(`Duplicate document in group ${value.id}`, '')
  if (value.kind === 'manual') {
    if (value.id !== `head:${value.headSha}` || value.prUrl !== undefined) throw new PreviewLoadError(`Invalid manual group ${value.id}`, '')
    return { id: value.id, kind: 'manual', headSha: value.headSha, updatedAt: value.updatedAt, documents }
  }
  const prMatch = /^pr:([1-9][0-9]*)$/u.exec(value.id)
  if (value.kind !== 'pull-request' || !prMatch || typeof value.prUrl !== 'string' || !isCanonicalPullUrl(value.prUrl, prMatch[1])) {
    throw new PreviewLoadError(`Invalid pull-request group ${value.id}`, '')
  }
  return { id: value.id, kind: 'pull-request', headSha: value.headSha, prUrl: value.prUrl, updatedAt: value.updatedAt, documents }
}

function parseDocument(value: unknown): PreviewDocument {
  if (!isRecord(value) || !isSafeSourcePath(value.path) || typeof value.title !== 'string' || value.title.trim() === '') {
    throw new PreviewLoadError('Invalid document in preview record', '')
  }
  const extension = value.path.slice(value.path.lastIndexOf('.')).toLowerCase()
  const expectedFormat = extension === '.md' ? 'markdown' : ['.html', '.htm'].includes(extension) ? 'html' : ''
  if (!expectedFormat || value.format !== expectedFormat) throw new PreviewLoadError(`Invalid document format for ${value.path}`, '')
  const document: PreviewDocument = { path: value.path, title: value.title, format: expectedFormat }
  if (value.reason === 'changed' || value.reason === 'dependency') document.reason = value.reason
  if (document.reason === 'dependency' && Array.isArray(value.changedResources)) {
    document.changedResources = value.changedResources.filter((resource): resource is string => isSafeSourcePath(resource))
  }
  return document
}

function isCanonicalPullUrl(value: string, expectedNumber: string) {
  try {
    const url = new URL(value)
    return url.href === value && url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password &&
      !url.search && !url.hash && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u.test(url.pathname) &&
      url.pathname.endsWith(`/pull/${expectedNumber}`)
  } catch {
    return false
  }
}

function isSafeSourcePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.includes('\\')) return false
  const segments = value.split('/')
  return segments[0] !== '_previews' && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function isFullSha(value: unknown): value is string {
  return typeof value === 'string' && FULL_SHA.test(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameDocuments(left: PreviewDocument[], right: PreviewDocument[]) {
  return left.length === right.length && left.every((document, index) => (
    document.path === right[index]?.path && document.title === right[index]?.title && document.format === right[index]?.format
  ))
}

function hasDuplicates(values: string[]) {
  return new Set(values).size !== values.length
}
