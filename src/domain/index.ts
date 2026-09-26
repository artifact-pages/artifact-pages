export type SiteSummary = {
  id: string
  title: string
}

export type SiteDiscoveryMetadata = {
  schemaVersion: number
  site: SiteSummary
  generatedAt: string
  artifactCount: number
  artifactIndexUrl: string
}

export type TocEntry = {
  level: number
  text: string
  id: string
}

export type ArtifactCommitter = {
  name: string
}

export type ArtifactSource = {
  repository: string
  repositoryUrl?: string
  ref: string
  /** Repository-root-relative path of this source file, when the indexer provides it. */
  filePath?: string
}

export type ArtifactFormat = 'html' | 'markdown'

export type ArtifactIndexEntry = {
  id: string
  title: string
  path: string
  format: ArtifactFormat
  filename?: string
  artifactUrl: string
  updatedAt: string
  lastCommitter?: ArtifactCommitter
  source?: ArtifactSource
  toc?: TocEntry[]
}

export type SiteIndex = {
  schemaVersion: number
  site: SiteSummary
  generatedAt: string
  artifacts: ArtifactIndexEntry[]
  paletteScoringProfile?: PaletteScoringProfile
}

export type PaletteScoringProfile = {
  version: 1
  wordOffsets: number[] | Uint32Array
  wordIds: number[] | Uint16Array | Uint32Array
  wordIdWidth: 16 | 32
  folderOffsets: number[] | Uint32Array
  folderIds: number[] | Uint16Array | Uint32Array
  folderIdWidth: 16 | 32
}
