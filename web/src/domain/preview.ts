export type PreviewDocument = {
  path: string
  title: string
  format: 'html' | 'markdown'
  /** Absent in records written before the field existed; read as 'changed'. */
  reason?: 'changed' | 'dependency'
  /** For dependency documents, the changed resources that pulled the document in. */
  changedResources?: string[]
}

export type PreviewGroup = {
  id: string
  kind: 'manual' | 'pull-request'
  headSha: string
  prUrl?: string
  updatedAt: string
  documents: PreviewDocument[]
}

export type PreviewCatalog = {
  schemaVersion: 1
  site: string
  groups: PreviewGroup[]
}

export type PreviewFile = {
  path: string
  sha256: string
  contentType: string
}

export type PreviewManifest = {
  schemaVersion: 1
  site: string
  headSha: string
  defaultHeadSha: string
  mergeBaseSha: string
  createdAt: string
  bundleDigest: string
  files: PreviewFile[]
  documents: PreviewDocument[]
}
