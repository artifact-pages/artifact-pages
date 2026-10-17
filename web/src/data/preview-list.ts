import type { PreviewGroup } from '../domain/preview'
import { UnsupportedSchemaError } from './schema'
import { loadPreviewCatalog, loadPreviewManifest, PreviewLoadError } from './previews'

export type GroupAvailability = 'available' | 'missing' | 'unknown' | 'invalid' | 'unsupported'
export type CheckedGroup = { group: PreviewGroup; availability: GroupAvailability }

/** The whole catalog with each group's manifest checked: what the Previews list and the section badge share. */
export type PreviewListResult =
  | { status: 'success'; checked: CheckedGroup[] }
  | { status: 'needs-republish' }
  | { status: 'error'; error: Error }

type Entry = { promise: Promise<PreviewListResult>; result?: PreviewListResult }

// One load of the catalog and its manifest checks per site and visit (ISSUE-107). A load still in progress
// is joined; "Try again" and leaving the site call `resetPreviewList` so the next reader starts a fresh one.
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function notify() {
  for (const listener of [...listeners]) listener()
}

export function subscribePreviewList(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The settled result of the site's current load, if there is one. */
export function peekPreviewList(siteId: string): PreviewListResult | undefined {
  return entries.get(siteId)?.result
}

export function resetPreviewList(siteId: string) {
  if (entries.delete(siteId)) notify()
}

/** Starts the site's load, or joins the one already started or settled in this visit. */
export function loadPreviewList(siteId: string): Promise<PreviewListResult> {
  const existing = entries.get(siteId)
  if (existing) return existing.promise
  const entry: Entry = { promise: undefined as unknown as Promise<PreviewListResult> }
  entry.promise = fetchPreviewList(siteId).then((result) => {
    entry.result = result
    if (entries.get(siteId) === entry) notify()
    return result
  })
  entries.set(siteId, entry)
  return entry.promise
}

async function fetchPreviewList(siteId: string): Promise<PreviewListResult> {
  try {
    const catalog = await loadPreviewCatalog(siteId)
    const manifestsByHead = new Map<string, Promise<GroupAvailability>>()
    const checked = await Promise.all(catalog.groups.map(async (group) => {
      let availability = manifestsByHead.get(group.headSha)
      if (!availability) {
        availability = loadPreviewManifest(siteId, group.headSha).then((manifest) => (
          sameDocuments(group.documents, manifest.documents) ? 'available' as const : 'invalid' as const
        )).catch((error: unknown) => {
          if (error instanceof PreviewLoadError && error.status === 404) return 'missing' as const
          if (error instanceof UnsupportedSchemaError) return 'unsupported' as const
          if (error instanceof PreviewLoadError && error.kind === 'invalid') return 'invalid' as const
          return 'unknown' as const
        })
        manifestsByHead.set(group.headSha, availability)
      }
      return { group, availability: await availability }
    }))
    return { status: 'success', checked }
  } catch (error: unknown) {
    if (error instanceof Error && 'status' in error && error.status === 404) return { status: 'success', checked: [] }
    if (error instanceof UnsupportedSchemaError) return { status: 'needs-republish' }
    return { status: 'error', error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/** The groups a reader is offered: available (or not checkable) ones, newest first. */
export function listedGroups(checked: readonly CheckedGroup[]) {
  return checked
    .filter(({ availability }) => availability === 'available' || availability === 'unknown')
    .sort((left, right) => right.group.updatedAt.localeCompare(left.group.updatedAt))
}

function sameDocuments(left: PreviewGroup['documents'], right: PreviewGroup['documents']) {
  return left.length === right.length && left.every((document, index) => (
    document.path === right[index]?.path && document.title === right[index]?.title && document.format === right[index]?.format
  ))
}
