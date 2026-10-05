# T23 — Private-repository topology

- Status: Open
- Phase: Hosted-runner verification
- Related implementation: [IMP-58](../implementation/IMP-58-actions-shallow-checkout.md), [IMP-55](../implementation/IMP-55-consumer-workflow-migration.md)
- Related design: [TD5](../technical-design/TD5-verification-environment-and-operator-repositories.md), [TD13](../technical-design/TD13-shallow-clone-publish-and-preview.md), [TD12](../technical-design/TD12-action-consumer-contract.md)
- Opened: 2026-10-05. The v0.2.0 pre-release ships with these paths recorded as known-unverified.

Every hosted-runner run so far used public repositories. Record actual runs, never inferred results, and never print tokens.

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

- [ ] **Private site repository, depth-1 deepen (IMP-58 first criterion).** `site-publish` and `preview-publish` from a `fetch-depth: 1` checkout of a private repository with `permissions: contents: read` and the workflow token as `ARTIFACT_PAGES_FETCH_TOKEN` fetch the history they need. Per-document `updatedAt`/`lastCommitter` and the preview merge base equal a `fetch-depth: 0` run. The token appears in neither logs nor `.git/config`.
- [ ] **Private admin config from a site workflow, including a clear error without a token.** A site workflow reads its config through a `github://OWNER/ADMIN_REPO/artifact-pages.yaml?ref=...` locator. The site repository's `GITHUB_TOKEN` is scoped to that repository only and cannot read another private repository, so the locator needs a separate credential. Establish which one works and the minimum scope: the decided fine-grained personal access token with `Contents: read` on the admin repository only (a GitHub App installation token is the alternative). Record how it is supplied (the Action's `github-token` input from a secret), that the fetch path still uses the workflow token (`ARTIFACT_PAGES_FETCH_TOKEN`) for the site repository, and what the failure looks like when the token is missing or too narrow.
- [ ] **Preview pull-request checks.** The trust preflight (event head SHA against GitHub pull-request metadata), the base-ref checkout, the optional comment (`pull-requests: write`) and the same-repository gate behave as in the public case for a private repository, including a pull request from a fork-less branch.
- [ ] **GitHub plan implications.** Environment secrets, required reviewers and deployment branch policies are available for private repositories only on GitHub Pro, Team or Enterprise plans (free plans: public repositories only). Per the decision above, the production repositories move to repository-scope secrets on GitHub Free. Record the protection lost compared with environment branch policies and how the workflow gate compensates. Do not change the plan or secrets as part of this ticket without owner approval.
- [ ] Update the guides' private-repository notes only from results recorded here.

## Results

Not yet run.
