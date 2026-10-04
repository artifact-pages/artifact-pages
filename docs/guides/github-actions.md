# Optional GitHub Actions

Artifact Pages provides these optional composite Action entry points:

- The repository root (`tasuku43/git-artifact-pages@<ref>`) is the GitHub Marketplace entry point. It is the same Action as `actions/site-publish`.
- `actions/admin` wraps `artifact-pages registry register`, `registry unregister`, and `app deploy`.
- `actions/site-publish` wraps `artifact-pages site publish` for one required, explicit site ID.
- `actions/preview-preflight` and `actions/preview-publish` verify pull-request trust and publish pre-merge previews.

They build the CLI from the same pinned Action source and invoke the command with `--format json`. They do not implement site publication, registry reconciliation, preview cleanup, or event timing. No repository has a required reusable workflow; adopters choose their own triggers and approval rules. Neither Action infers a site from the repository, discovers PRs, or adds a separate preview cleanup workflow.

## Inputs and typed outputs

The admin Action accepts `operation: registry-register | registry-unregister | app-deploy`. All three operations accept `dry-run`; `registry-unregister` requires `site`, and `app-deploy` deploys the web bundle that matches the pinned Action's CLI version, or a local `archive` when given (there is no `version` input; the pinned Action ref selects the CLI and therefore the web bundle; `repository` overrides the release source). The site Action requires `site` and accepts `source`, `config`, `fulltext`, and `dry-run`. Set `fulltext: true` on every publish of a site that uses page text search. A publish without it withdraws the site's search data, exactly like the CLI without `--fulltext`.

The admin and site Actions expose the original CLI result through `result` and preserve its process status through `exit-code`. They also expose `operation`, `outcome`, `site`, `changes`, `preview-changes`, and `error`; registry operations expose `registry-updated`. The preview Action exposes `operation`, `outcome`, `site`, `group-list-url`, `documents`, `result`, `exit-code`, `error`, and `comment-url`. GitHub Action outputs are strings, so JSON arrays and objects are compact JSON text, `registry-updated` is `true`/`false`, and `exit-code` is an integer string. The invoke step writes outputs before returning a non-zero CLI exit code.

Output names are hyphen-case in every Action. The earlier underscore names (`result_json`, `changes_json`, `preview_changes_json`, `registry_updated`, `exit_code`) were renamed to `result`, `changes`, `preview-changes`, `registry-updated`, and `exit-code` without aliases. Update workflows that read the old names when moving to a release that contains this change.

## Pre-merge previews

`actions/preview-publish` publishes one site's changed documents for a pull request or a manual run. It runs the same trust preflight as `actions/preview-preflight` first, so `preview-publish` alone is enough for most workflows. Add `preview-preflight` as a separate earlier step or job only when you obtain provider credentials before the publish step (for example an OIDC role assumption), or when you want to reject untrusted pull requests before an environment approval gate.

### Git refs and the checkout

`head` and `default-ref` default to empty and are resolved at run time. An explicit input always wins. Otherwise, on a `pull_request` event, `head` is the event's `pull_request.head.sha` and `default-ref` is `origin/<pull_request.base.ref>`. On any other event they are `HEAD` and `origin/HEAD`, as in the CLI. The Action uses the event only to choose these Git refs. It never infers the pull request: `pull-request` stays explicit-only, and without it the preview is manual.

The preview compares the head with the default branch through their merge base, so the checkout must contain both. Use `actions/checkout` with `fetch-depth: 0`. The default pull_request checkout is a shallow merge commit that contains neither the head SHA nor `origin/<base>`. Before it sets up Go or touches a provider, the Action verifies that both refs resolve to commits and share a merge base. If they do not, it fails with a message that names the missing ref and points to `fetch-depth: 0`. It returns the same typed failure outputs as the trust preflight and never fetches by itself.

### Pull-request comment

Set `comment: true` to have the Action post the review links. It does so only when `pull-request` is also given; otherwise it warns and writes nothing. The job needs `pull-requests: write`, and the comment uses `github-token` or the workflow token.

- The Action keeps one comment per site per PR, marked with a hidden `<!-- artifact-pages-preview:site=SITE -->` line. It creates the comment once and updates it in place on later pushes.
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

## Credential boundaries

The examples use AWS OIDC with separate role ARNs. Grant only the workflow permissions `contents: read` and, when assuming an AWS role, `id-token: write`. Restrict each AWS role trust policy to the intended repository, branch or protected environment, and audience. Storage permissions belong to those provider roles, not the GitHub token.

- The satellite publisher role reads the deployed site registry and selected site's current projection, then reads/writes/deletes only that site's artifact and index prefixes, its preview catalog, and its site lock. Do not share this role with another site's repository.
- The admin registry role reconciles the complete desired registration set from the selected config and the registry lock. `registry register` also cleans content prefixes for sites omitted from that config's `sites` mapping, so grant cleanup scope only to a protected admin workflow and require review/approval for registration changes.
- The application deployment role is separate and scoped to `/index.html`, `/assets/*`, and the required application cache revalidation. It does not need access to site indexes, artifacts, preview objects, or registry state.

The config and storage provider remain independent. Registry Actions use the selected deployment config's complete top-level `sites` mapping; registry operations fail when that field is absent. An explicit `sites: {}` means an empty desired set and registering it removes all current registrations. Target-only configs may omit `sites` for other operations, and satellite publishing remains eligible according to the deployed registry. For Cloudflare, pass only the target's named credential environment variables to the selected job and use separate admin, app, and per-site credentials with the same prefix boundaries. Do not put credential values in the deployment YAML.

## Workflow templates

The files under [`examples/github-actions`](../../examples/github-actions) are templates. They pin the third-party checkout, Go setup, and AWS credential Actions by full commit SHA. The Artifact Pages Action itself has not been published as a release in this checkout; replace `<FULL_REVIEWED_ACTION_COMMIT_SHA>` with the full 40-character commit SHA of the reviewed release that contains the action files before adopting a template. The satellite template also uses a full commit SHA for the admin config locator.

The templates show registering the desired site set, application deploy of the web bundle pinned by the Action ref, satellite publish for the explicit `sre` site, and pull-request previews (`satellite-preview.yml`, always on pull requests; `satellite-preview-label.yml`, only with a label). The preview templates run the preflight before assuming the AWS role and opt in to `comment: true` with `pull-requests: write`. The admin Action's `registry-register` operation value maps to the `registry register` CLI command. For pull-request planning, use the same operation with `dry-run: true` and a read-only provider role. Decide which PRs may receive read-only cloud credentials in the adopting repository's trust policy. A merge or another selected event can run the write operation; the Action does not choose one.

The component uses `actions/setup-go` pinned to commit `b7ad1dad31e06c5925ef5d2fc7ad053ef454303e` (v7.0.0) and reads the Go version from this repository's `go.mod`. The consuming workflow's checkout should also disable persisted credentials unless later steps need Git authentication.

## Check CLI parity locally

Run:

```sh
node scripts/test-actions-parity.mjs
```

The smoke test builds the CLI, creates separate temporary admin and satellite Git repositories with independent local targets for direct CLI and Action invocations, then compares the exact JSON results, typed outputs, stdout, and exit codes. It covers registering the complete config `sites` set and unregistering a site in dry-run and apply modes; explicit-site publish in dry-run and apply modes; full-text publish and its withdrawal when `fulltext` is omitted; app deploy in dry-run and apply modes; missing-`sites` and unregistered-site failures; and a stale preview reference whose missing completion manifest is planned without writes and then pruned on apply. It also checks the composite input/output wiring, workflow example names, scoped GitHub permissions, explicit site selection, separate registry/app/satellite role variables, and full-SHA pins for third-party Actions. The parity test exercises the shared Action invocation script used by the composites. Unit tests for the Git-ref resolution and the PR comment logic run with `npm run test:actions-shared`. The `actions-smoke` job in `.github/workflows/verify.yml` runs every Action, including the root entry point, through `uses:` on a GitHub-hosted runner against a runner-local target, on every pull request, on `main`, and before a release. It does not need provider credentials and does not assume OIDC roles or prove live AWS/Cloudflare behavior.
