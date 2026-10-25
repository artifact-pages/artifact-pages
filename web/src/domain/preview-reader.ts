import type { PreviewCatalog, PreviewDocument, PreviewGroup } from './preview'

/**
 * What the reader knows about the preview a document belongs to (ISSUE-109). A PR number comes only
 * from a group id (`pr:<n>`); nothing here claims a PR the catalog does not know.
 */
export type PreviewIdentity =
  | { kind: 'pull-request'; groupId: string; number: string }
  | { kind: 'manual'; groupId: string }
  | { kind: 'unknown' }

export function identityFromGroupId(groupId: string | undefined): PreviewIdentity {
  const pr = groupId ? /^pr:([1-9][0-9]*)$/u.exec(groupId) : null
  if (groupId && pr) return { kind: 'pull-request', groupId, number: pr[1] }
  if (groupId && /^head:[0-9a-f]{40,64}$/u.test(groupId)) return { kind: 'manual', groupId }
  return { kind: 'unknown' }
}

/**
 * The catalog group a reader's link refers to: the group the link names, or, for a link without one,
 * the manual group of the revision (`head:<sha>`). A link without a group never resolves to a PR.
 */
export function findPreviewGroup(catalog: PreviewCatalog, headSha: string, groupId?: string): PreviewGroup | undefined {
  return catalog.groups.find((group) => group.id === (groupId ?? `head:${headSha}`))
}

/** The PR link is shown only when the catalog says this exact revision is the pull request's head. */
export function verifiedPullRequest(group: PreviewGroup | undefined, headSha: string) {
  if (!group || group.kind !== 'pull-request' || group.headSha !== headSha || !group.prUrl) return undefined
  return { number: group.id.slice(3), url: group.prUrl }
}

/** A group whose current head is another revision: the reader opened an older one. */
export function isSupersededRevision(group: PreviewGroup | undefined, headSha: string) {
  return Boolean(group) && group!.headSha !== headSha
}

/**
 * The identity a reader may state: a PR only when the loaded catalog verifies this revision as that PR group's
 * current head; a manual group, whose id is the revision itself; otherwise nothing beyond the revision.
 */
export function verifiedIdentity(group: PreviewGroup | undefined, headSha: string, urlGroupId?: string): PreviewIdentity {
  const pr = verifiedPullRequest(group, headSha)
  if (pr && group) return { kind: 'pull-request', groupId: group.id, number: pr.number }
  const manualId = `head:${headSha}`
  if (group?.id === manualId || (!group && urlGroupId === manualId)) return { kind: 'manual', groupId: manualId }
  return { kind: 'unknown' }
}

export function previewTagLabel(identity: PreviewIdentity, headSha: string) {
  if (identity.kind === 'pull-request') return `Preview · PR #${identity.number}`
  if (identity.kind === 'manual') return 'Preview · manual'
  return `Preview · ${headSha.slice(0, 8)}`
}

/** The group's name in breadcrumbs and the preview list. */
export function previewGroupLabel(identity: PreviewIdentity, headSha: string) {
  if (identity.kind === 'pull-request') return `PR #${identity.number}`
  return identity.kind === 'manual' ? `Revision ${headSha.slice(0, 8)}` : `Preview ${headSha.slice(0, 8)}`
}

/** Changed pages first, then the documents pulled in by a changed resource. A record without a reason reads as changed. */
export function splitPreviewDocuments(documents: readonly PreviewDocument[]) {
  return {
    changed: documents.filter(({ reason }) => reason !== 'dependency'),
    affected: documents.filter(({ reason }) => reason === 'dependency'),
  }
}


/** Resources used by every affected page; a single page has no repeated group context to deduplicate. */
export function sharedChangedResources(documents: readonly PreviewDocument[]): string[] {
  if (documents.length < 2) return []
  return [...new Set(documents[0].changedResources ?? [])].filter((resource) => documents.every((document) => document.changedResources?.includes(resource)))
}
