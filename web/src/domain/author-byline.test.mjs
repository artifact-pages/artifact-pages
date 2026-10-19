// Checks the avatar URL policy and the Details byline choice (ISSUE-117).
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import { artifactByline, isAllowedAvatarUrl } from './author-byline.ts'

const good = 'https://avatars.githubusercontent.com/u/583231?v=4'

test('accepts the GitHub avatar host, ASCII case-insensitively', () => {
  assert.equal(isAllowedAvatarUrl(good), true)
  assert.equal(isAllowedAvatarUrl('https://Avatars.GitHubUserContent.com/u/1'), true)
  assert.equal(isAllowedAvatarUrl('HTTPS://AVATARS.GITHUBUSERCONTENT.COM/u/1'), true)
})

test('rejects other schemes, hosts, credentials, ports, fragments and a bare path', () => {
  for (const value of [
    'http://avatars.githubusercontent.com/u/1',
    'https://example.com/u/1',
    'https://avatars.githubusercontent.com.evil.test/u/1',
    'https://evil.test/avatars.githubusercontent.com/u/1',
    'https://user@avatars.githubusercontent.com/u/1',
    'https://user:pw@avatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com:8443/u/1',
    'https://avatars.githubusercontent.com/u/1#x',
    'https://avatars.githubusercontent.com/',
    'https://avatars.githubusercontent.com',
    '//avatars.githubusercontent.com/u/1',
    'not a url',
    '',
    undefined,
    null,
    42,
  ]) assert.equal(isAllowedAvatarUrl(value), false, String(value))
})

test('the author is preferred and carries its avatar; the avatar URL is kept as given', () => {
  const byline = artifactByline({
    lastAuthor: { name: '  Octocat ', commitSha: 'a'.repeat(40), github: { login: 'octocat', avatarUrl: good } },
    lastCommitter: { name: 'GitHub' },
  })
  assert.deepEqual(byline, { name: 'Octocat', avatarUrl: good })
})

test('an author without a usable avatar keeps the name only', () => {
  assert.deepEqual(artifactByline({ lastAuthor: { name: 'Bot', commitSha: 'a'.repeat(40), github: { login: 'bot' } } }), { name: 'Bot', avatarUrl: undefined })
  assert.deepEqual(artifactByline({ lastAuthor: { name: 'X', commitSha: 'a'.repeat(40), github: { login: 'x', avatarUrl: 'http://avatars.githubusercontent.com/u/1' } } }), { name: 'X', avatarUrl: undefined })
})

test('the legacy committer never gets an avatar, and no identity yields an empty byline', () => {
  assert.deepEqual(artifactByline({ lastCommitter: { name: ' Maya Chen ' } }), { name: 'Maya Chen' })
  assert.deepEqual(artifactByline({ lastAuthor: { name: '   ', commitSha: 'a'.repeat(40), github: { login: 'x', avatarUrl: good } }, lastCommitter: { name: 'Maya' } }), { name: 'Maya' })
  assert.deepEqual(artifactByline({}), {})
})
