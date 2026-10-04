# TD8 — Action consumer contract: summary, checkout, defaults, publish condition

- Status: Done
- Phase: Reusable distribution
- Decision: The owner decided on 2026-10-04, after an analysis of the consumer workflows in `artifact-pages-docs` and `artifact-pages-admin`, that the composite Actions absorb the boilerplate those workflows repeat. The decisions below are accepted. The owner also delegated the migration ordering (decision 8) and added the `pull-request` default (decision 6) the same day. The accepted behavior is in [specification §19 "Shared Action behavior"](../../specification.md#shared-action-behavior) and §22.
- Related design: [T2](T2-cli-action-interface.md), [T11](T11-command-surface.md), [TD4](TD4-action-marketplace-distribution.md)
- Related implementation: [IMP-50](../implementation/IMP-50-preview-defaults.md), [IMP-51](../implementation/IMP-51-publish-condition.md), [IMP-52](../implementation/IMP-52-job-summary.md), [IMP-53](../implementation/IMP-53-preview-pull-request-default.md), [IMP-54](../implementation/IMP-54-action-checkout.md), [IMP-55](../implementation/IMP-55-consumer-workflow-migration.md)

## Problem

Consumer workflows repeat the same steps around each Action call: a checkout, a "Summarize" step that parses outputs with `jq`, a `dry-run:` expression that encodes "real publish only on main", `source:` and `base-url:` values the registry and config already hold, and the pull-request number copied from the event. Each copy drifts, and the output rename to hyphen-case (`changes_json` to `changes`) breaks the Summarize steps.

## Settled contract

1. **Job Summary is built in and is a contract.** Every Action has `summary` (default `true`) and appends an operation-specific Markdown block to `GITHUB_STEP_SUMMARY` after writing its outputs, also on failure. The heading, labels and their order are stable within a release line. It is rendered only from the typed CLI result, in the shared wrapper, so the CLI is unchanged.
2. **`checkout` (default `auto`) and `fetch-depth` (default `0`).** `auto` runs a SHA-pinned `actions/checkout` only when `GITHUB_WORKSPACE` is not already a Git work-tree root; `true` always, `false` never. It uses the workflow token with `persist-credentials: false`, never the private-config `github-token`. The preview Action on `pull_request` checks out the base ref, never the PR head, matching the recommended workflow.
   - Ordering: checkout is the first step. In the preview Action it precedes the trust preflight, because the preflight reads Git refs (head, default ref, merge base). Checkout is not provider access: it needs no provider credential, reads only this repository's base ref with the workflow token, and does not invoke the CLI. A checkout before the preflight therefore does not weaken "trust verification before any provider access". The job-level same-repository `if:` still guards fork runs.
   - A shallow-repository check was considered and dropped: shallow-clone support is a separate effort, and `fetch-depth` is exposed so callers can override the default.
3. **Preview `base-url` resolves from config.** The CLI and the Action accept an explicit `--base-url` / `base-url`, which always wins. When empty, the origin comes from the deployment config, and the command exits two with guidance if none is available.
   - Finding: Cloudflare config already holds `cloudflare.publicBaseURL`. AWS config holds only `region`, `bucket`, `accountId` and `distributionId`; the CloudFront domain is not in it, and Artifact Pages never discovers identity from provider APIs.
   - Chosen design: a provider-neutral optional top-level `publicBaseURL` (HTTPS origin, or HTTP loopback origin for local development). It belongs to the target unit for layering: a layer that sets `provider` replaces it (omitted clears it), and a later layer without `provider` may set it alone. Cloudflare keeps its required `cloudflare.publicBaseURL`; when both are set they must be equal, so there is one answer. The field is used only to default `preview publish --base-url`.
   - Trade-offs, for owner review: this adds a config field (schema version 1 is unchanged, and existing configs stay valid), and there are now two spellings for Cloudflare. The alternative of a Cloudflare-only resolution was rejected as an asymmetry that would force AWS satellites to keep `base-url:`. Making the top-level field required, or deprecating `cloudflare.publicBaseURL`, was not attempted.
4. **Preview `source` defaults to the registered source path.** The CLI reads it from the deployed registry (as `site publish` does) when `--source` is omitted. An explicit value must still match exactly, and the exact-match check under the site lock is unchanged.
5. **Publish condition instead of dry-run automation.** The site-publish (and root) and admin Actions get `publish-on`, a newline-separated list of `event` or `event:ref` entries. A run that matches none becomes a dry-run; an explicit `dry-run: true` always wins; empty means no condition (previous behavior).
   - Design choices: matching is exact on `GITHUB_EVENT_NAME` and on the full `GITHUB_REF`, with `*` as the only wildcard (for tags and release branches). Short branch names such as `push:main` are rejected rather than guessed, because a branch and a tag may share a name. A malformed entry fails the run instead of silently dry-running. The logic is in the wrapper (the CLI keeps its `--dry-run` only), and the run logs a notice naming the reason.
   - Considered and rejected: a boolean expression language (more surface than the two shapes callers need), `branches:` and `events:` as separate inputs (cannot express "push on main or manual dispatch" without a cross product), and adding it to the preview Action. A preview is not a production write and has no dry-run versus real split to automate; callers gate it with workflow `on:` and job `if:`.
6. **Preview `pull-request` defaults from the `pull_request` event.** When empty, only a `pull_request` event supplies `pull_request.number`; `none` forces a manual preview and an explicit value wins. The number is verified by exactly the same trust preflight (base repository, same-repository head, head SHA). Never from `pull_request_target`, a branch, a commit or another event. The CLI stays explicit-only, and `comment: true` now works on pull-request events without the input. This replaces the earlier rule that the Action never infers the PR from the event; the specification and decision P6 are updated.
7. **Go build cache.** Recorded in [TD4](TD4-action-marketplace-distribution.md) question 6 and [IMP-46](../implementation/IMP-46-action-marketplace-release.md): `setup-go` cannot hash the Action's `go.sum` from outside the workspace, so `actions/cache` is keyed on the pinned source.
8. **Migration ordering (delegated to the agent).** The next release already renames outputs to hyphen-case. Ship the built-in summary in the same release, so consumers delete their Summarize steps rather than port them. Consumer cleanup follows the release and is tracked in [IMP-55](../implementation/IMP-55-consumer-workflow-migration.md).

9. **Prebuilt CLI (owner, 2026-10-05).** Recorded in [TD4](TD4-action-marketplace-distribution.md) and [IMP-56](../implementation/IMP-56-prebuilt-cli-binaries.md): a release-tag ref installs a verified released binary instead of building.

Reusable workflows remain out of scope.

## Exit criteria

- [x] Record decisions 1 to 9 as a settled contract.
- [x] Update the specification (§19 "Shared Action behavior", the preview paragraphs, §22 `publicBaseURL`) and the preview decision P6.
- [x] Hand implementation to IMP-50 through IMP-54 and the post-release migration to IMP-55.
