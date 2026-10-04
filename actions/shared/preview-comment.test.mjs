import assert from 'node:assert/strict'
import test from 'node:test'
import { escapeMarkdown, markerFor, renderPublishedComment, runPreviewComment } from './preview-comment.mjs'

const marker = '<!-- artifact-pages-preview:site=sre -->'
const published = {
  outcome: 'published',
  headSha: 'abcdef0123456789abcdef0123456789abcdef01',
  groupListUrl: 'https://pages.example.test/sre/_previews?group=pr%3A7',
  documents: [
    { path: 'docs/a|b.html', title: 'Alpha | *Beta* [x](y)', url: 'https://pages.example.test/sre/_previews/abc/a.html?group=pr%3A7' },
  ],
}

function environment(overrides = {}) {
  return {
    ARTIFACT_PAGES_INPUT_COMMENT: 'true',
    ARTIFACT_PAGES_INPUT_SITE: 'sre',
    ARTIFACT_PAGES_INPUT_PULL_REQUEST: '7',
    ARTIFACT_PAGES_COMMENT_RESULT: JSON.stringify(published),
    ARTIFACT_PAGES_COMMENT_EXIT_CODE: '0',
    GITHUB_REPOSITORY: 'example/satellite',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '99',
    GITHUB_TOKEN: 'secret-token',
    ...overrides,
  }
}

// A fake GitHub issue-comments API. `pages` holds existing comments split by page.
function fakeApi({ existing = [], status, login } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url)
    calls.push({ method: init.method, path: parsed.pathname, page: parsed.searchParams.get('page'), body: init.body ? JSON.parse(init.body).body : undefined, auth: init.headers.Authorization })
    const json = (value, code = 200) => ({ ok: code < 400, status: code, json: async () => value })
    if (parsed.pathname === '/user') return login ? json({ login }) : json({}, 403)
    if (status) return json({}, status)
    if (init.method === 'GET') {
      const page = Number(parsed.searchParams.get('page'))
      return json(existing.slice((page - 1) * 100, page * 100))
    }
    if (init.method === 'POST') return json({ html_url: 'https://github.com/example/satellite/pull/7#issuecomment-1' }, 201)
    return json({ html_url: `https://github.com/example/satellite/pull/7#issuecomment-${parsed.pathname.split('/').pop()}` })
  }
  return { calls, fetchImpl }
}

test('creates one marker comment when none exists', async () => {
  const api = fakeApi()
  const result = await runPreviewComment({ env: environment(), fetchImpl: api.fetchImpl })
  assert.equal(result.action, 'created')
  assert.match(result.commentUrl, /issuecomment-1$/)
  const post = api.calls.find((call) => call.method === 'POST')
  assert.equal(post.path, '/repos/example/satellite/issues/7/comments')
  assert.ok(post.body.startsWith(marker))
  assert.match(post.body, /pages\.example\.test\/sre\/_previews\?group=pr%3A7/)
  assert.match(post.body, /abcdef0/)
  assert.equal(post.auth, 'Bearer secret-token')
})

test('updates the existing marker comment in place, searching later pages', async () => {
  const filler = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `chat ${index}` }))
  const api = fakeApi({ existing: [...filler, { id: 4242, user: { type: 'Bot' }, body: `${marker}\nold` }] })
  const result = await runPreviewComment({ env: environment(), fetchImpl: api.fetchImpl })
  assert.equal(result.action, 'updated')
  assert.deepEqual(api.calls.filter((call) => call.method === 'GET' && call.page).map((call) => call.page), ['1', '2'])
  const patch = api.calls.find((call) => call.method === 'PATCH')
  assert.equal(patch.path, '/repos/example/satellite/issues/comments/4242')
  assert.equal(api.calls.some((call) => call.method === 'POST'), false)
})

test('a human-authored marker comment is ignored and a new comment is created', async () => {
  const api = fakeApi({ existing: [{ id: 3, user: { type: 'User' }, body: `${marker}\nhijack` }] })
  const result = await runPreviewComment({ env: environment(), fetchImpl: api.fetchImpl })
  assert.equal(result.action, 'created')
  assert.equal(api.calls.some((call) => call.method === 'PATCH'), false)
})

test('with a personal token, only comments by that login are matched', async () => {
  const api = fakeApi({
    login: 'octo-pat',
    existing: [
      { id: 3, user: { type: 'User', login: 'someone-else' }, body: `${marker}\nhijack` },
      { id: 4, user: { type: 'User', login: 'octo-pat' }, body: `${marker}\nmine` },
    ],
  })
  const result = await runPreviewComment({ env: environment(), fetchImpl: api.fetchImpl })
  assert.equal(result.action, 'updated')
  assert.equal(api.calls.find((call) => call.method === 'PATCH').path, '/repos/example/satellite/issues/comments/4')
  const noOwn = fakeApi({ login: 'octo-pat', existing: [{ id: 3, user: { type: 'Bot', login: 'github-actions[bot]' }, body: `${marker}\nbot` }] })
  assert.equal((await runPreviewComment({ env: environment(), fetchImpl: noOwn.fetchImpl })).action, 'created')
})

test('when /user is denied, falls back to Bot-authored comments', async () => {
  const api = fakeApi({
    existing: [
      { id: 3, user: { type: 'User', login: 'someone-else' }, body: `${marker}\nhijack` },
      { id: 4, user: { type: 'Bot', login: 'github-actions[bot]' }, body: `${marker}\nbot` },
    ],
  })
  const result = await runPreviewComment({ env: environment(), fetchImpl: api.fetchImpl })
  assert.equal(result.action, 'updated')
  assert.equal(api.calls.find((call) => call.method === 'GET' && call.path === '/user').path, '/user')
  assert.equal(api.calls.find((call) => call.method === 'PATCH').path, '/repos/example/satellite/issues/comments/4')
})

test('a marker for another site is not matched', async () => {
  const api = fakeApi({ existing: [{ id: 5, user: { type: 'Bot' }, body: '<!-- artifact-pages-preview:site=other -->\nx' }] })
  const result = await runPreviewComment({ env: environment(), fetchImpl: api.fetchImpl })
  assert.equal(result.action, 'created')
})

test('skips when disabled, without pull-request, or on dry-run', async () => {
  for (const [overrides, reason] of [
    [{ ARTIFACT_PAGES_INPUT_COMMENT: 'false' }, 'disabled'],
    [{ ARTIFACT_PAGES_INPUT_PULL_REQUEST: '' }, 'no-pull-request'],
    [{ ARTIFACT_PAGES_COMMENT_RESULT: JSON.stringify({ ...published, outcome: 'planned' }) }, 'dry-run'],
  ]) {
    const api = fakeApi()
    const result = await runPreviewComment({ env: environment(overrides), fetchImpl: api.fetchImpl })
    assert.equal(result.action, 'none')
    assert.equal(result.reason, reason)
    assert.equal(api.calls.length, 0, reason)
  }
})

test('no-preview and failure only update an existing comment', async () => {
  const noPreview = { ARTIFACT_PAGES_COMMENT_RESULT: JSON.stringify({ outcome: 'no-preview', headSha: published.headSha }) }
  const failure = { ARTIFACT_PAGES_COMMENT_RESULT: JSON.stringify({ outcome: 'failed', error: 'boom' }), ARTIFACT_PAGES_COMMENT_EXIT_CODE: '1' }
  for (const overrides of [noPreview, failure]) {
    const none = fakeApi()
    assert.equal((await runPreviewComment({ env: environment(overrides), fetchImpl: none.fetchImpl })).action, 'none')
    assert.equal(none.calls.some((call) => call.method !== 'GET'), false)

    const some = fakeApi({ existing: [{ id: 9, user: { type: 'Bot' }, body: `${marker}\nold` }] })
    assert.equal((await runPreviewComment({ env: environment(overrides), fetchImpl: some.fetchImpl })).action, 'updated')
  }
  const some = fakeApi({ existing: [{ id: 9, user: { type: 'Bot' }, body: `${marker}\nold` }] })
  await runPreviewComment({ env: environment(failure), fetchImpl: some.fetchImpl })
  const body = some.calls.find((call) => call.method === 'PATCH').body
  assert.match(body, /failed/)
  assert.match(body, /https:\/\/github\.com\/example\/satellite\/actions\/runs\/99/)
  assert.doesNotMatch(body, /boom/)
})

test('a non-zero exit code counts as failure even with a published-looking result', async () => {
  const api = fakeApi({ existing: [{ id: 9, user: { type: 'Bot' }, body: `${marker}\nold` }] })
  await runPreviewComment({ env: environment({ ARTIFACT_PAGES_COMMENT_EXIT_CODE: '1' }), fetchImpl: api.fetchImpl })
  assert.match(api.calls.find((call) => call.method === 'PATCH').body, /failed/)
})

test('permission and other API errors warn but never throw', async () => {
  for (const status of [403, 404, 500]) {
    const lines = []
    const original = process.stdout.write
    process.stdout.write = (chunk) => { lines.push(String(chunk)); return true }
    let result
    try {
      result = await runPreviewComment({ env: environment(), fetchImpl: fakeApi({ status }).fetchImpl })
    } finally {
      process.stdout.write = original
    }
    assert.equal(result.action, 'none')
    const warning = lines.join('')
    assert.match(warning, /^::warning/)
    if (status !== 500) assert.match(warning, /pull-requests: write/)
    assert.doesNotMatch(warning, /secret-token/)
  }
})

test('markdown from titles and paths cannot break the comment', () => {
  assert.equal(escapeMarkdown('a | b\n*c* [d](e) <script>'), 'a \\| b \\*c\\* \\[d\\]\\(e\\) &lt;script&gt;')
  const body = renderPublishedComment({ site: 'sre', result: { ...published, documents: [{ ...published.documents[0], url: 'javascript:alert(1)' }] } })
  assert.doesNotMatch(body, /javascript:/)
  const rows = body.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Page') && !line.startsWith('| ---'))
  assert.equal(rows.length, 1)
  assert.throws(() => markerFor('bad --> site'), /marker/)
})

test('very long document lists are truncated', () => {
  const documents = Array.from({ length: 80 }, (_, index) => ({ path: `d${index}.html`, title: `Doc ${index}`, url: `https://pages.example.test/d${index}` }))
  const body = renderPublishedComment({ site: 'sre', result: { ...published, documents } })
  assert.match(body, /and 30 more changed pages/)
})

test('dependency-affected pages are listed separately with the changed resource', () => {
  const documents = [
    { path: 'a.html', title: 'Page A', url: 'https://pages.example.test/a', reason: 'dependency', changedResources: ['assets/site.css'] },
    { path: 'b.md', title: 'Page B', url: 'https://pages.example.test/b', reason: 'changed' },
  ]
  const body = renderPublishedComment({ site: 'sre', result: { ...published, documents } })
  assert.match(body, /\*\*Changed pages\*\*/)
  assert.match(body, /\*\*Affected by a resource change\*\*/)
  assert.ok(body.indexOf('Page B') < body.indexOf('Page A'))
  assert.match(body, /\| \[Page A\]\(https:\/\/pages\.example\.test\/a\) \| `a\.html` \| `assets\/site\.css` \|/)
})

test('the row cap is shared and counts omitted affected pages', () => {
  const documents = [
    ...Array.from({ length: 40 }, (_, index) => ({ path: `c${index}.md`, title: `C ${index}`, url: `https://pages.example.test/c${index}`, reason: 'changed' })),
    ...Array.from({ length: 30 }, (_, index) => ({ path: `d${index}.html`, title: `D ${index}`, url: `https://pages.example.test/d${index}`, reason: 'dependency', changedResources: ['x.css'] })),
  ]
  const body = renderPublishedComment({ site: 'sre', result: { ...published, documents } })
  const rows = body.split('\n').filter((line) => line.startsWith('| [') )
  assert.equal(rows.length, 50)
  assert.match(body, /and 20 more affected pages/)
})
