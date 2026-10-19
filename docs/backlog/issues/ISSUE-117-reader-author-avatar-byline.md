# The reader's Details byline ignores `lastAuthor` and shows no GitHub avatar

- Status: In progress
- Assignee: Claude
- Priority: P2
- Area: Reader Details

## Problem

The CLI now writes `lastAuthor` (name, commit SHA and an optional GitHub login and avatar URL) into the artifact index (ISSUE-116), but the reader still shows `lastCommitter.name`, which for squash and web merges is GitHub's committer service rather than the person who made the change, and it only ever draws an initial letter in the byline circle.

## Evidence and reproduction

1. Open `/sre/incidents/checkout-latency/index.html` with Details visible: the byline shows the committer "Maya Chen" with an "M" circle although the index carries the author "Octocat" with a resolved avatar (`fixtures/storage/_indexes/sre/index.json`).
2. The reader's index validation and types do not know `lastAuthor`.

## Expected outcome

Details name the latest change's Git author and, when the index carries a valid GitHub avatar URL, show that avatar in the byline circle. Everything else keeps working when the data is absent, malformed or blocked. This is the reader half of ISSUE-116; see its "Reader handoff" section and specification sections 5.2 and 8.

## Acceptance criteria

- [ ] `ArtifactIndexEntry` has an optional `lastAuthor` (`name`, `commitSha`, optional `github.login` and `github.avatarUrl`). A malformed `lastAuthor` never rejects a row: the whole value is dropped when it is not an object, `name` or `commitSha` is not a string, or `name` is blank; only `github` is dropped when it is not an object or its `login` is not a non-empty string; only `avatarUrl` is dropped when it fails the URL policy. Indexes without `lastAuthor` work unchanged.
- [ ] The displayed name is the trimmed `lastAuthor.name`, else the trimmed `lastCommitter.name`; with neither, the name and avatar are omitted and "Updated <date>" remains. The date always comes from `updatedAt`. The login is not shown and not linked. The directory page's row meta uses the same name rule and shows no avatar.
- [ ] The avatar URL policy is one pure helper with unit tests: protocol `https:`, hostname equal to `avatars.githubusercontent.com` ignoring ASCII case, no username, password, port or fragment, and a path longer than `/`. The URL string is used as given and is never built from a login, name or email.
- [ ] Details show the avatar only when the displayed name comes from `lastAuthor` and its `github.avatarUrl` passes the policy: an `<img>` with empty `alt`, `referrerPolicy="no-referrer"`, `crossOrigin="anonymous"`, `decoding="async"` and 24 px size, clipped to the existing aria-hidden circle in light and dark themes. A load error switches to the initial-letter fallback with name and date unchanged and no broken-image icon; a new URL resets the error. A legacy committer name never carries an avatar. The reader makes no GitHub API call.
- [ ] Preview Details are unchanged.
- [ ] Unit tests cover index parsing (full, name-only, malformed values dropped without rejecting the row, legacy committer-only) and the URL policy; Storybook has Details variants (avatar, load failure, author name only, legacy committer, no identity); e2e proves the avatar request with a stubbed route (`no-referrer`), the initial fallback when the request is blocked, and a legacy committer page without an image.
- [ ] Specification section 8 states the implemented behaviour.
