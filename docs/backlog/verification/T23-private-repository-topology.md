# T23 — Private-repository topology

- Status: Open
- Phase: Hosted-runner verification
- Related implementation: [IMP-58](../implementation/IMP-58-actions-shallow-checkout.md), [IMP-55](../implementation/IMP-55-consumer-workflow-migration.md)
- Related design: [TD5](../technical-design/TD5-verification-environment-and-operator-repositories.md), [TD13](../technical-design/TD13-shallow-clone-publish-and-preview.md), [TD12](../technical-design/TD12-action-consumer-contract.md)
- Opened: 2026-10-05. The v0.2.0 pre-release ships with these paths recorded as known-unverified.

Every hosted-runner run so far used public repositories. Record actual runs, never inferred results, and never print tokens.

## Constraint and proposed approach

The owner is on GitHub Free. Environment secrets with deployment branch policies are not available for private repositories on that plan, and both production operator repositories (`artifact-pages-docs`, `artifact-pages-admin`) use environment-scoped secrets. Making them private would break their publishing.

Proposal, pending owner approval (nothing below has been created or changed): keep the production repositories public. Verify with two new small private repositories, for example `artifact-pages-verify-admin` and `artifact-pages-verify-site`, that target the [TD5](../technical-design/TD5-verification-environment-and-operator-repositories.md) verification environment (`artifact-pages.stream`). They would use repository-level secrets holding verification credentials only (never production credentials), and a fine-grained personal access token or GitHub App installation token with `Contents: read` on the private verify-admin repository only, passed to the site workflow through the `github-token` input.

## Proof needed

- [ ] **Private site repository, depth-1 deepen (IMP-58 first criterion).** `site-publish` and `preview-publish` from a `fetch-depth: 1` checkout of a private repository with `permissions: contents: read` and the workflow token as `ARTIFACT_PAGES_FETCH_TOKEN` fetch the history they need. Per-document `updatedAt`/`lastCommitter` and the preview merge base equal a `fetch-depth: 0` run. The token appears in neither logs nor `.git/config`.
- [ ] **Private admin config from a site workflow.** A site workflow reads its config through a `github://OWNER/ADMIN_REPO/artifact-pages.yaml?ref=...` locator. The site repository's `GITHUB_TOKEN` is scoped to that repository only and cannot read another private repository, so the locator needs a separate credential. Establish which one works and the minimum scope: a fine-grained personal access token or a GitHub App installation token with `Contents: read` on the admin repository only. Record how it is supplied (the Action's `github-token` input from a secret), that the fetch path still uses the workflow token (`ARTIFACT_PAGES_FETCH_TOKEN`) for the site repository, and what the failure looks like when the token is missing or too narrow.
- [ ] **Preview pull-request checks.** The trust preflight (event head SHA against GitHub pull-request metadata), the base-ref checkout, the optional comment (`pull-requests: write`) and the same-repository gate behave as in the public case for a private repository, including a pull request from a fork-less branch.
- [ ] **GitHub plan implications.** Environment secrets, required reviewers and deployment branch policies are available for private repositories only on GitHub Pro, Team or Enterprise plans (free plans: public repositories only). Both production consumer repositories currently use environment-scoped secrets with branch policies, and the owner is on GitHub Free, so they must stay public. The private verification repositories use repository-level secrets; record what protection that loses compared with environment branch policies and how the workflow gate compensates. Do not change the plan or secrets as part of this ticket without owner approval.
- [ ] Update the guides' private-repository notes only from results recorded here.

## Results

Not yet run.
