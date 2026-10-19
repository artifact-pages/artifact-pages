import type { ArtifactIndexEntry } from './index'

const AVATAR_HOST = 'avatars.githubusercontent.com'

/**
 * Avatar URL policy (ISSUE-116 reader handoff): https only, the GitHub avatar host, no credentials,
 * port, or fragment, and a path beyond "/". The string is kept as given; nothing is derived from a
 * login, name or email.
 */
export function isAllowedAvatarUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'https:'
    && url.hostname.toLowerCase() === AVATAR_HOST
    && url.username === ''
    && url.password === ''
    && url.port === ''
    && url.hash === ''
    && url.pathname.length > 1
}

/**
 * The name shown beside "Updated <date>": the change's author, else the legacy committer. The
 * avatar belongs to the author only, so a committer fallback never carries one.
 */
export function artifactByline(artifact: Pick<ArtifactIndexEntry, 'lastAuthor' | 'lastCommitter'>): { name?: string, avatarUrl?: string } {
  const authorName = artifact.lastAuthor?.name.trim()
  if (authorName) {
    const avatarUrl = artifact.lastAuthor?.github?.avatarUrl
    return { name: authorName, avatarUrl: isAllowedAvatarUrl(avatarUrl) ? avatarUrl : undefined }
  }
  const committerName = artifact.lastCommitter?.name.trim()
  return committerName ? { name: committerName } : {}
}
