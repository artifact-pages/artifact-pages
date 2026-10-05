# A private deployment config the token cannot read fails with an unactionable HTTP status

- Status: Done
- Priority: P2
- Area: `github://` config locator resolution (CLI and the Actions wrapper)

## Problem

When the token cannot read the repository named by a `github://` config locator, `site publish` fails with `GitHub repository metadata request failed (HTTP 404)` or `(HTTP 401)`. The message does not name the config locator or repository, does not say the failure is an authentication or authorization problem, and does not say what to do. GitHub returns 404 (not 403) for a private repository the token cannot see, so the 404 reads as "not found" and points users at the wrong cause. The same applies to the follow-up requests: `GitHub ref could not be resolved to a commit (HTTP %d)` and `GitHub config fetch failed for <file> (HTTP %d)` (the latter names only the file).

## Evidence and reproduction

Run on 2026-10-05 with the CLI built from tag v0.2.0 and the config `github://tasuku43/artifact-pages-admin/artifact-pages.yaml`, whose repository is private. Exit code was 2 in every case.

1. Local, `GITHUB_TOKEN` and `GH_TOKEN` unset: `error: GitHub repository metadata request failed (HTTP 404)`.
2. Local, `GITHUB_TOKEN=invalid`: `error: GitHub repository metadata request failed (HTTP 401)`.
3. Hosted (artifact-pages-docs `publish.yml`, `workflow_dispatch` on a branch, dry-run), `github-token: ${{ github.token }}` (cannot read the admin repository): `error: GitHub repository metadata request failed (HTTP 404)`, followed by `##[error]Process completed with exit code 2.`
4. Hosted, App token minted with `repositories: artifact-pages-docs` only: the same 404 message.
5. Control: the App token with `repositories: artifact-pages-admin` and `contents: read` produced `outcome: planned`.

The messages are produced in `cli/internal/config/config.go` (`readRemoteConfig`, around lines 818, 830 and 847). The token is read from `GITHUB_TOKEN`, then `GH_TOKEN` (`getGitHubJSON`), and the response body is discarded for non-2xx statuses.

Confirmed: the messages above. Not decided: whether to read the GitHub error body (`message`) for extra detail.

## Expected outcome

A user who sees the error can tell which locator failed and that a token problem is the likely cause, and knows the fix without reading source.

Proposed text, by status:

- 404 (token absent or present): `cannot read deployment config github://tasuku43/artifact-pages-admin/artifact-pages.yaml: GitHub returned HTTP 404. GitHub also returns 404 for a private repository the token cannot access. Check the locator, and pass a token with contents:read on tasuku43/artifact-pages-admin (GITHUB_TOKEN or GH_TOKEN; in GitHub Actions, the github-token input).` When no token is set, replace the last sentence with `No GITHUB_TOKEN or GH_TOKEN is set.`
- 401: `cannot read deployment config <locator>: GitHub rejected the token (HTTP 401). The token is invalid or expired. Pass a valid token with contents:read on <owner>/<repo>.`
- 403: `... GitHub denied access (HTTP 403): the token lacks contents:read on <owner>/<repo>, or rate limiting applies.`

Apply the same prefix to the ref-resolution and contents-fetch failures. Never print the token.

## Acceptance criteria

- [x] Each failing status (401, 403, 404) at each of the three requests names the locator or `<owner>/<repo>` and states the authentication or authorization cause and the action to take.
- [x] The message distinguishes "no token set" from "a token was sent".
- [x] Unit tests cover the messages with a stub GitHub API, and assert that the token value never appears in the error.
- [x] The Actions README or specification mentions that a private config repository needs `github-token` with `contents: read` on it.

Verified 2026-10-05: `cli/internal/config/remote_access_error_test.go` (`TestRemoteConfigAccessErrors`: no-token 404, token 404, 401, 403 rate limited, 403 permission, contents 404 after metadata, ref 401; asserts the token never appears) and `cd cli && go vet ./... && go test ./... -count=1` pass. Specification (config locator section) and `docs/guides/github-actions.md` updated.
