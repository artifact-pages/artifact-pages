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
}
