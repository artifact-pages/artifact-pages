# Optional GitHub Actions

Artifact Pages provides four optional composite Actions, one repository each:

| Action | Runs | Source in this repository |
| --- | --- | --- |
| [`artifact-pages/publish-action`](https://github.com/artifact-pages/publish-action) | `artifact-pages site sync` for one required, explicit site ID | `actions/publish` |
| [`artifact-pages/preview-action`](https://github.com/artifact-pages/preview-action) | pull-request trust checks, then `preview publish` | `actions/preview` |
| [`artifact-pages/registry-action`](https://github.com/artifact-pages/registry-action) | `registry sync` | `actions/registry` |
| [`artifact-pages/app-deploy-action`](https://github.com/artifact-pages/app-deploy-action) | `app deploy` | `actions/app-deploy` |

Each Action runs one CLI operation, so none has an `operation` input. The registry Action runs `registry sync` against the complete `sites` mapping; to remove a site, edit it out of that mapping and run the same Action. A retry resumes cleanup left by a partial failure.

The Action repositories are generated from `actions/<name>/` here when an Action is released with its own tag (`<name>-action/vX.Y.Z` here, plain `@vX.Y.Z` in the Action repository), so each Action has its own version series. A published Action never builds anything: it downloads the CLI named in its generated `release.json` from the matching release of this repository, verifies the checksum, and fails if it cannot. The Action's `release.json` therefore decides the CLI version, also under a full-SHA pin. Pending amendment (IMP-70): [TD17](../backlog/technical-design/TD17-config-pinned-component-versions.md) sections 4, 5a and 6 (bootstrap re-exec, `cli-version` override, `release.json` schemaVersion 2) are not implemented yet; until then the config's `cli.version` does not change which CLI runs. Linux and macOS runners (x64, arm64) are supported; Windows runners are not. The Actions invoke the command with `--format json`. The CLI performs site synchronization and registry reconciliation; these wrappers keep their existing one-operation contract. Preview and app removal remain CLI-only, with no new Action operation inputs. No repository has a required reusable workflow; adopters choose their own triggers and approval rules. No Action infers a site from the repository, discovers PRs, or adds a separate preview cleanup workflow.

## Inputs and typed outputs

Every Action accepts `config`, `github-token`, `dry-run`, `publish-on` (not the preview Action), `summary`, `checkout` and `fetch-depth`. The publish Action also requires `site` and accepts `source`. The registry Action has no further input. The app-deploy Action deploys the web bundle named by the config's `web.version`, or a local `archive` when given (there is no `version` input; `repository` must stay `artifact-pages/artifact-pages` when `web.version` is set). Every publish builds and publishes the site's page text search data; there is no `fulltext` input.

The publish Action exposes `operation`, `outcome`, `site`, `changes`, `preview-changes`, `result`, `exit-code` and `error`. The registry Action exposes `operation`, `outcome`, `registry-updated`, `changes`, `result`, `exit-code` and `error`, and app-deploy the same without `registry-updated`. The preview Action exposes `operation`, `outcome`, `site`, `group-list-url`, `documents`, `result`, `exit-code`, `error`, and `comment-url`. `result` is the original CLI result and `exit-code` its process status. GitHub Action outputs are strings, so JSON arrays and objects are compact JSON text, `registry-updated` is `true`/`false`, and `exit-code` is an integer string. The invoke step writes outputs before returning a non-zero CLI exit code.

Output names are hyphen-case in every Action. The earlier underscore names (`result_json`, `changes_json`, `preview_changes_json`, `registry_updated`, `exit_code`) were renamed to `result`, `changes`, `preview-changes`, `registry-updated`, and `exit-code` without aliases. Update workflows that read the old names when moving to a release that contains this change.

## Pre-merge previews

`artifact-pages/preview-action` publishes one site's changed documents for a pull request or a manual run. There is no separate preflight Action.

### Trust model

Preview publication on pull requests rests on four layers:

1. The job's `if: github.event.pull_request.head.repo.full_name == github.repository` skips fork-origin pull requests before any step runs.
2. GitHub withholds secrets and OIDC tokens from workflow runs triggered by fork pull requests, so those runs cannot obtain provider credentials.
3. After its optional checkout and before the CLI download, any CLI call or provider access, `preview-action` verifies that the event's head repository is the workflow repository. When a pull request is resolved (the `pull-request` input, or on a `pull_request` event the event's own PR number), it also checks the PR through the GitHub API (base and head repository, head SHA). It rejects `pull_request_target`.
4. The provider trust policy should restrict which repository, workflow and ref can assume the publisher role (for AWS, the OIDC role's trust conditions).

Configure provider credentials in a step before `preview-action`; layers 1 and 2 keep untrusted runs away from them, and layer 3 runs before the provider is used.

### Git refs and the checkout

`head` and `default-ref` default to empty and are resolved at run time. An explicit input always wins. Otherwise, on a `pull_request` event, `head` is the event's `pull_request.head.sha` and `default-ref` is `origin/<pull_request.base.ref>`. On any other event they are `HEAD` and `origin/HEAD`, as in the CLI. `pull-request` follows its own rule: an explicit value wins, `none` forces a manual preview, and when it is empty a `pull_request` event supplies its own PR number, which is verified exactly like an explicit one. Other events (and `pull_request_target`, which is rejected) give a manual preview. The Action never infers a PR from a branch or commit.

The preview compares the head with the default branch through their merge base. A shallow checkout (`fetch-depth: 1`, the default) is enough: the CLI fetches a missing `origin/<branch>` default ref or full-SHA head at depth 1 and deepens both until the merge base is exact. With `checkout: auto` (the default) the Action runs `actions/checkout` itself when the workspace is not already a Git checkout (`fetch-depth: 1`, `persist-credentials: false`, workflow token; on `pull_request` the preview Action checks out the base ref, never the PR head). Set `checkout: false` to never check out, or `fetch-depth: 0` to clone full history. Before it sets up Go or touches a provider, the Action fails early only for a ref the CLI cannot fetch (a head that is not a full commit SHA and is not in the checkout, or a default ref that is not `origin/<branch>`), with the same typed failure outputs as the trust preflight.

### Shallow checkouts and the fetch token

The CLI deepens a shallow checkout from `origin` using the workflow token (`github.token`), which the Actions pass to the CLI step as `ARTIFACT_PAGES_FETCH_TOKEN`. The token is sent only to the fetch subprocess, for `github.com` or `GITHUB_SERVER_URL` HTTPS remotes; it is not written to `.git/config`, and `persist-credentials: false` still holds. It is never the `github-token` input, which may be a token for a separate config repository that cannot read this one. `permissions: contents: read` is enough. Per-document `updatedAt` and last committer are carried forward by content, so a byte-identical commit hidden beyond the fetched history (a revert to the published bytes, or a no-op rewrite) does not change them; use `fetch-depth: 0` when such commits must be reflected.

### Pull-request comment

Set `comment: true` to have the Action post the review links. It does so when a pull request is resolved, which on a `pull_request` event needs no `pull-request` input; with `pull-request: none` or another event it warns and writes nothing. The job needs `pull-requests: write`, and the comment uses `github-token` or the workflow token.

- The Action keeps one comment per site per PR, marked with a hidden `<!-- artifact-pages-preview:site=SITE -->` line. It creates the comment once and updates it in place on later pushes. It updates only its own comment: with a personal `github-token` it matches comments by that token's login, and with the workflow token or an app token (which cannot read `/user`) it matches Bot-authored comments. A marker comment posted by anyone else is ignored.
- After `published` or `no-op`, the comment lists the preview list URL, each changed page (title, path, fixed revision URL), and the head short SHA. A dry run writes nothing.
- When a later push leaves no changed pages, or a later run fails, the Action only updates an existing comment (to say so, with a link to the workflow run). It never creates a comment for those outcomes.
- The comment step runs even when the publish failed, and the Action still fails in that case.
- A missing permission or any other API error becomes a `::warning::` and never fails the publish.
- `comment-url` is the written comment's URL, or an empty string.

Without `comment`, the workflow can post the `group-list-url` and `documents` outputs itself.

### Label-triggered previews

[`satellite-preview-label.yml`](../../examples/github-actions/satellite-preview-label.yml) publishes only while a PR carries a `preview` label. It listens for `labeled`, `synchronize`, and `reopened`, filters by `paths`, and checks the label in the job `if:`.

Caveat: every `labeled` event of a PR belongs to the same concurrency group as the preview run. Adding an unrelated label would start a run that cancels an in-flight preview, and that run would then skip its job. The example adds `github.run_id` to the group only for `labeled` events of other labels, so those events get a separate group and leave the preview running.

For config in another private repository, the default token is this workflow's `GITHUB_TOKEN`. Give that workflow `contents: read` and ensure its token can read the admin repository; if repository-scoped `GITHUB_TOKEN` access is insufficient, pass a GitHub App installation token or fine-grained token with read-only contents access to that one repository through `github-token`. The config locator's `ref` should be a full commit SHA so one run uses a stable target config.

If the config cannot be read, the error names the locator and the cause: `cannot read deployment config github://OWNER/REPO/FILE: ...`. GitHub answers 404 (not 403) for a private repository the token cannot access, so a 404 with no token, or with a token lacking `contents: read` on that repository, means `github-token` must be set to a token that has it. A 401 means the token is invalid or expired; a 403 means missing permission or an exhausted rate limit.

## Credential boundaries

The examples use AWS OIDC with separate role ARNs. Grant only the workflow permissions `contents: read` and, when assuming an AWS role, `id-token: write`. Restrict each AWS role trust policy to the intended repository, branch or protected environment, and audience. Storage permissions belong to those provider roles, not the GitHub token.

- The satellite publisher role reads the deployed site registry and selected site's current projection, then reads/writes/deletes only that site's artifact and index prefixes, preview objects, per-site preview-cleanup journal, and site lock. Do not share this role with another site's repository.
- The admin registry role reconciles the complete desired registration set from the selected config and the registry lock. `registry sync` also cleans content prefixes for sites omitted from that config's `sites` mapping, so grant cleanup scope only to a protected admin workflow and require review/approval for registration changes.
- The application deployment role is separate and scoped to `/index.html`, `/assets/*`, and the required application cache revalidation. It does not need access to site indexes, artifacts, preview objects, or registry state.

The config and storage provider remain independent. Registry Actions use the selected deployment config's complete top-level `sites` mapping; registry sync fails when that field is absent. An explicit `sites: {}` means an empty desired set and syncing it removes all current registrations. Target-only configs may omit `sites` for other operations, and satellite sync remains eligible according to the deployed registry. For Cloudflare, pass only the target's named credential environment variables to the selected job and use separate admin, app, and per-site credentials with the same prefix boundaries. Do not put credential values in the deployment YAML.

## Workflow templates

The files under [`examples/github-actions`](../../examples/github-actions) are templates. They pin the third-party checkout and AWS credential Actions by full commit SHA and reference the Artifact Pages Actions by exact release tag (`artifact-pages/publish-action@v0.1.0`). For the strictest pin, use the full commit SHA of that tag with the tag in a comment (`@<sha> # v0.1.0`); because the Action's `release.json` is part of that commit, the CLI version it installs is fixed as well. No moving major tag exists while the product is `0.x`. The satellite template also uses a full commit SHA for the admin config locator.

The templates show registering the desired site set (`registry-action`), application deploy of the web bundle named by `web.version` (`app-deploy-action`), satellite publish for the explicit `sre` site (`publish-action`), and pull-request previews (`satellite-preview.yml`, always on pull requests; `satellite-preview-label.yml`, only with a label). The preview templates are a single job guarded by the same-repository `if:`, assume the AWS role, then run `preview-action`, and opt in to `comment: true` with `pull-requests: write`. For pull-request planning, run the registry Action with `dry-run: true` and a read-only provider role. Decide which PRs may receive read-only cloud credentials in the adopting repository's trust policy. A merge or another selected event can run the write operation; the Action does not choose one.

Each Action runs `actions/checkout` (when `checkout` allows) pinned to a full SHA. The consuming workflow's checkout should also disable persisted credentials unless later steps need Git authentication.

## Check CLI parity locally

Run:

```sh
node scripts/test-actions-parity.mjs
```

The parity test builds the CLI, creates separate temporary admin and satellite Git repositories with independent local targets for direct CLI and Action invocations, then compares the exact JSON results, typed outputs, stdout, and exit codes. It covers registry sync with the complete config `sites` set in dry-run and apply modes, including removal by omission through the registry Action; explicit-site sync in dry-run and apply modes; site sync that always advertises full-text data; app deploy in dry-run and apply modes; missing-`sites` and unregistered-site failures; and a stale preview reference whose missing completion manifest is planned without writes and then pruned on apply. It also checks the composite input/output wiring, workflow example names, scoped GitHub permissions, explicit site selection, separate registry/app/satellite role variables, and full-SHA pins for third-party Actions. It also asserts that no Action builds from source and that none has an `operation` input. The parity test exercises the shared Action invocation script used by the composites. Unit tests for the Git-ref resolution and the PR comment logic run with `npm run test:actions-shared`. The `actions-smoke` job in `.github/workflows/verify.yml` runs every Action by local path (`uses: ./actions/<name>`) on a GitHub-hosted runner, with the CLI built from the same commit and handed over through `ARTIFACT_PAGES_TEST_CLI` (unreleased source names no release; a published Action ignores that variable) against a runner-local target, on every pull request, on `main`, and before a release. It does not need provider credentials and does not assume OIDC roles or prove live AWS/Cloudflare behavior.

## Generating the Action repositories locally

`node scripts/build-action-repos.mjs --out .local/action-repos` writes the content of the four Action repositories (`--version` is the Action version; the CLI pin comes from the CLI version constant); `npm run test:action-repos` checks the generated layout and rehearses `scripts/sync-action-repos.sh` against local bare repositories. The release workflow runs the same two scripts for the selected Action when its `<name>-action/vX.Y.Z` tag is pushed, using the organization's release GitHub App (`RELEASE_APP_ID` variable, `RELEASE_APP_PRIVATE_KEY` secret, `contents: write` on the four Action repositories only).
