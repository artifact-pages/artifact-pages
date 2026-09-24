import type { ArtifactIndexEntry } from './index'

export type ArtifactSourceLinks = {
  sourceUrl?: string
  historyUrl?: string
}

export function artifactSourceLinks(artifact: ArtifactIndexEntry): ArtifactSourceLinks {
  const repositoryUrl = safeRepositoryUrl(artifact.source?.repositoryUrl)
  if (!repositoryUrl) return {}

  const provider = repositoryProvider(repositoryUrl.hostname)
  const repositoryPath = repositoryUrl.pathname.replace(/\/$/u, '')
  const filePath = safeRepositoryPath(artifact.source?.filePath)
  const ref = safeRepositoryPath(artifact.source?.ref.trim())
  if (!provider || !ref) return { sourceUrl: repositoryUrl.href }

  const encodedRef = encodePath(ref)
  const encodedFilePath = filePath ? encodePath(filePath) : ''
  const sourceSuffix = filePath ? provider.sourcePath(encodedRef, encodedFilePath) : ''
  const historySuffix = provider.historyPath(encodedRef, encodedFilePath)

  return {
    sourceUrl: sourceSuffix ? `${repositoryUrl.origin}${repositoryPath}${sourceSuffix}` : repositoryUrl.href,
    historyUrl: `${repositoryUrl.origin}${repositoryPath}${historySuffix}`,
  }
}

function safeRepositoryUrl(value?: string) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    url.pathname = url.pathname.replace(/\/+$/u, '').replace(/\.git$/u, '') || '/'
    url.search = ''
    url.hash = ''
    return url
  } catch {
    return undefined
  }
}

function safeRepositoryPath(value?: string) {
  if (!value || value.startsWith('/') || value.includes('\\')) return undefined
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return undefined
  return value
}

function repositoryProvider(hostname: string) {
  if (hostname === 'github.com') {
    return {
      sourcePath: (ref: string, file: string) => `/blob/${ref}/${file}`,
      historyPath: (ref: string, file: string) => `/commits/${ref}${file ? `/${file}` : ''}`,
    }
  }
  if (hostname === 'gitlab.com') {
    return {
      sourcePath: (ref: string, file: string) => `/-/blob/${ref}/${file}`,
      historyPath: (ref: string, file: string) => `/-/commits/${ref}${file ? `/${file}` : ''}`,
    }
  }
  if (hostname === 'bitbucket.org') {
    return {
      sourcePath: (ref: string, file: string) => `/src/${ref}/${file}`,
      historyPath: (ref: string, file: string) => `/history/${ref}${file ? `/${file}` : ''}`,
    }
  }
  return undefined
}

function encodePath(value: string) {
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}
