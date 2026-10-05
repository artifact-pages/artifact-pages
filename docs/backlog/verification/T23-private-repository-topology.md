# T23 — Private-repository topology

- Status: Done
- Phase: Hosted-runner verification
- Related implementation: [IMP-58](../implementation/IMP-58-actions-shallow-checkout.md), [IMP-55](../implementation/IMP-55-consumer-workflow-migration.md)
- Related design: [TD5](../technical-design/TD5-verification-environment-and-operator-repositories.md), [TD13](../technical-design/TD13-shallow-clone-publish-and-preview.md), [TD12](../technical-design/TD12-action-consumer-contract.md)
- Done: 2026-10-05 on the owner's instruction, with the two partial items noted below and in Results. `[~]` means partly proven.
- Opened: 2026-10-05. The v0.2.0 pre-release ships with these paths recorded as known-unverified.

Every hosted-runner run so far used public repositories. Record actual runs, never inferred results, and never print tokens.

> **Update 2026-10-06:** `artifact-pages/admin` and `artifact-pages/docs` (transferred from `tasuku43/artifact-pages-admin` and `-docs`) are public in the organization, use `production`/`preview` environments for secrets, and read the admin config with the workflow token; the personal GitHub App is no longer used by them. The text below records the private-repository period as run on 2026-10-05. The private-config path (App or token through `github-token`) is still a supported consumer topology and is to be covered by a CI regression check against a fixture set up separately.

## Constraint and decided approach

The owner is on GitHub Free, which does not offer environment secrets or deployment branch policies for private repositories. Both production operator repositories (`artifact-pages-docs`, `artifact-pages-admin`) currently use environment-scoped secrets.

Decision (owner, 2026-10-05): make `artifact-pages-docs` and `artifact-pages-admin` private, and move their secrets from environment scope to repository scope, dropping `environment:` from their workflows. The separate private verification-repository proposal ([TD5](../technical-design/TD5-verification-environment-and-operator-repositories.md) environment) is dropped.

Accepted trade-off: branch-policy protection on the production secrets is lost. This is acceptable while the owner operates alone; revisit if collaborators join or the plan changes.

Steps, in order (owner steps need owner action; nothing has been changed yet):

1. After v0.2.0 is released, make the workflow edits together with the [IMP-55](../implementation/IMP-55-consumer-workflow-migration.md) migration: drop `environment:`, read secrets from repository scope.
2. Owner re-enters each secret value at repository scope (environment secret values are write-only and cannot be copied).
3. Owner issues a fine-grained personal access token with `Contents: read` on `artifact-pages-admin` only, stores it as a secret in `artifact-pages-docs`, and the docs workflows pass it through the Action's `github-token` input.
4. Switch the repositories' visibility to private.
5. Run the checks below.

## Proof needed

- [~] **Private site repository, depth-1 deepen (IMP-58 first criterion).** Preview head fetch and merge-base deepening shown; depth-0 comparison and token inspection not done (see Results). `site-publish` and `preview-publish` from a `fetch-depth: 1` checkout of a private repository with `permissions: contents: read` and the workflow token as `ARTIFACT_PAGES_FETCH_TOKEN` fetch the history they need. Per-document `updatedAt`/`lastCommitter` and the preview merge base equal a `fetch-depth: 0` run. The token appears in neither logs nor `.git/config`.
- [~] **Private admin config from a site workflow, including a clear error without a token.** Works with the App token; the error case was not run (see Results). A site workflow reads its config through a `github://OWNER/ADMIN_REPO/artifact-pages.yaml?ref=...` locator. The site repository's `GITHUB_TOKEN` is scoped to that repository only and cannot read another private repository, so the locator needs a separate credential. Establish which one works and the minimum scope: the decided fine-grained personal access token with `Contents: read` on the admin repository only (a GitHub App installation token is the alternative). Record how it is supplied (the Action's `github-token` input from a secret), that the fetch path still uses the workflow token (`ARTIFACT_PAGES_FETCH_TOKEN`) for the site repository, and what the failure looks like when the token is missing or too narrow.
- [x] **Preview pull-request checks.** The trust preflight (event head SHA against GitHub pull-request metadata), the base-ref checkout, the optional comment (`pull-requests: write`) and the same-repository gate behave as in the public case for a private repository, including a pull request from a fork-less branch.
- [x] **GitHub plan implications.** Recorded under Results. Environment secrets, required reviewers and deployment branch policies are available for private repositories only on GitHub Pro, Team or Enterprise plans (free plans: public repositories only). Per the decision above, the production repositories move to repository-scope secrets on GitHub Free. Record the protection lost compared with environment branch policies and how the workflow gate compensates. Do not change the plan or secrets as part of this ticket without owner approval.
- [ ] Update the guides' private-repository notes only from results recorded here. Moved to [DOC-16](../documentation/DOC-16-guide-private-config-github-app.md).

## Results

Recorded 2026-10-05, after the v0.2.0 migration ([IMP-55](../implementation/IMP-55-consumer-workflow-migration.md)).

**Topology.** Both repositories are private (GitHub Free). The secrets were already repository-scoped (`CF_R2_ACCESS_KEY_ID`, `CF_R2_SECRET_ACCESS_KEY`, `CF_API_TOKEN`); the environments hold no secrets. Decision change: the admin config is read with a GitHub App installation token instead of the planned fine-grained personal access token. App `artifact-pages-private` (id 5197457) is installed only on `artifact-pages-admin` and `artifact-pages-docs` with Contents read, Pull requests write and Metadata read; each job mints a scoped token with `actions/create-github-app-token` v3.2.0 and passes it through the Action's `github-token` input. The workflow token still serves the site-repository fetch.

**1. Private admin config.** [Publish run 37319639507](https://github.com/tasuku43/artifact-pages-docs/actions/runs/37319639507) (`workflow_dispatch`) read the private admin config through the App token and finished `no-op` with `configCommitSha` `9b8eedaf`.

**2. Preview pull request.** [Pull request #10](https://github.com/tasuku43/artifact-pages-docs/pull/10), labelled `preview-artifact`, ran [Preview run 37319833962](https://github.com/tasuku43/artifact-pages-docs/actions/runs/37319833962): depth-1 checkout; preflight `Preview head bb27d18d (event) -> fetched by the CLI; ... the CLI deepens a shallow checkout to the exact merge base`; `guide` published only the changed `getting-started.html` (`https://artifact-pages.dev/guide/_previews/bb27d18d4cb55a93f7075f7c6a3e95b94a964a5f/en/getting-started.html?group=pr%3A10`); `architecture` reported no preview; the comment was posted by `artifact-pages-private[bot]`. The pull request was closed without merging and its branch deleted.

**Not covered.** The negative test (a missing or too-narrow App token yields a clear error) was not run; it remains an optional follow-up. The depth-0 comparison and the `.git/config` token inspection are tracked in [IMP-58](../implementation/IMP-58-actions-shallow-checkout.md). Plan implications: repository-scope secrets replace environment branch policies, so the production secrets are no longer restricted by branch policy; this is the accepted trade-off recorded above, compensated by the workflow-level `publish-on` gate. The guides' private-repository notes are not yet updated; see [DOC-16](../documentation/DOC-16-guide-private-config-github-app.md).
