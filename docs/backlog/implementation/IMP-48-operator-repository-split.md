# IMP-48 — Split production operation into admin and docs repositories

- Status: In progress
- Assignee: Codex
- Lanes: Infra / Cloudflare, Docs / Adoption
- Execution: Collaborative. Creating repositories, adding the `artifact-pages.stream` zone, Terraform applies, credential setup and any production registry change need owner approval.
- Depends on: [TD5](../technical-design/TD5-verification-environment-and-operator-repositories.md) (Done); released references follow [IMP-45](IMP-45-unified-release-and-compatibility.md) and [IMP-38](IMP-38-terraform-registry-publication.md).
- Proves: [T16](../verification/T16-external-adoption.md)

## Goal

`artifact-pages.dev` is operated from `artifact-pages/admin` and the docs satellite `artifact-pages/docs`, which consume released packages like any adopter. This repository keeps a complete verification path on `artifact-pages.stream`.

## Slices

1. **Verification environment in this repository.** Owner adds the `artifact-pages.stream` zone to the Cloudflare account. Point `terraform/deployments/cloudflare` at it with a separate bucket and state. Replace `artifact-pages.cloudflare.yaml` with a verification config and test sites from fixtures or `examples/`. Prove apply, app deploy, publish and preview there before production moves.
2. **Admin repository (`artifact-pages-admin`).** Copy the production deployment config, registry `sites` and Terraform caller for `artifact-pages.dev`. Import the existing production state without replacing resources, and confirm with a no-change plan. Add registry and app-deploy workflows using the admin Action, pinned by SHA until the first release.
3. **Docs repository (`artifact-pages-docs`).** Copy `docs/public/sites/{guide,architecture}`, `docs/public/shared` and the local preview config. Add site-publish workflows with `--fulltext` equivalence and the sync step for shared assets.
4. **Registry cut-over.** Change the `repository` of `guide` and `architecture` to `tasuku43/artifact-pages-docs`, then publish from it. Site IDs and URLs stay the same; confirm both sites before and after.
5. **Cleanup in this repository.** Remove the copied production files, update the README, guides, `docs/public/sites/AGENTS.md` references and the local docs-publish procedure. Leave verification tooling in place.
6. **Released references.** After IMP-45 and IMP-38 publish, switch both repositories to the exact Action/CLI tag and Registry module version. T16 runs here.

## Progress

- 2026-10-03: created both repositories as public and empty: https://github.com/tasuku43/artifact-pages-admin and https://github.com/tasuku43/artifact-pages-docs.
- 2026-10-03, slice 1 (verification environment), this part only:
  - **Terraform:** `terraform/deployments/cloudflare-verify` (own state, bucket `artifact-pages-verify`, zone guard) was applied by the owner: 7 resources, all in the `artifact-pages.stream` zone and account.
  - **CLI (v0.1.2), using `artifact-pages.verify.yaml`:** `registry register`, `app deploy` (release bundle v0.1.2), `site publish --site smoke --fulltext` and a manual `preview publish` all succeeded against `https://artifact-pages.stream`.
  - **HTTP checks:** `/`, `/smoke`, registry and site indexes, the raw artifact and the preview list return 200. `meta.json` advertises `fullTextUrl`. The raw preview carries its revision-scoped CSP and `nosniff`. HTTP is blocked with 403. Requests for `_control/locks/*.json` return the app shell, not the lock object.
  - **Credential isolation:** the CLI key pair is denied on the production bucket `artifact-pages`, and the Terraform token sees only `artifact-pages.stream`.
  - **Problems found:** the first runs failed because the CLI token lacked Cache Purge; reruns converged. This surfaced the registry/app purge retry gap, later fixed and verified in [T22](../verification/T22-cache-purge-retry.md), plus [ISSUE-065](../issues/ISSUE-065-registry-dry-run-says-unchanged.md) and [ISSUE-067](../issues/ISSUE-067-single-cloudflare-publisher-token.md).
  - **Not yet covered:** a browser walk-through and the Action against this target.

- 2026-10-03: created both repositories as public and empty with `gh repo create`: https://github.com/tasuku43/artifact-pages-admin and https://github.com/tasuku43/artifact-pages-docs. Local clones are at `~/work/github.com/tasuku43/artifact-pages-{admin,docs}` (ghq).
- 2026-10-03: the owner reported that the `artifact-pages.stream` zone is registered. Public DNS returns Cloudflare nameservers `agustin` and `kenia`, the same pair as `artifact-pages.dev`, which suggests the same account. The current local `CLOUDFLARE_API_TOKEN` lists only `artifact-pages.dev`, so the zone ID, active status and account have not been checked through the API. A verification token scoped to `artifact-pages.stream` and the verification bucket is still needed. It should be separate from the production token, which must not gain access to the verification zone, and vice versa.

## Acceptance criteria

- [ ] This repository applies, deploys, publishes and previews on `artifact-pages.stream` without touching the `artifact-pages.dev` zone, bucket or state.
- [ ] The admin repository's first plan against production is a no-change plan, and the cut-over keeps both sites reachable at the same URLs.
- [x] The docs repository publishes `guide` and `architecture` through the Action; the registry names it as their repository (organization cutover 2026-10-06; subsequent released-component operator runs recorded in T15/IMP-38).
- [ ] No production config, Terraform caller or public-site source remains in this repository.

## Backend decision and reconciliation — 2026-10-18 (Sol)

**Delete the obsolete monorepo `docs/public` public-site sources in a follow-up cleanup.** The external docs repository is the source of truth; retaining a second editable source recreates drift. This PR records the decision only. Keep technical specifications, architecture contracts, backlog/evidence and independently useful test fixtures in the monorepo. Before deletion, enumerate references, move any actual test-only dependency into a named fixture, update local docs commands/config references, and verify no build/CI fixture depends on the removed source. Coordinate public-docs ownership with Claude; do not rewrite or migrate the live docs site in this cleanup.

The original progress entries are dated history, not current absence claims. The split/cutover shipped on 2026-10-06 into the organization repositories; production consumes released Actions and CLI, and admin #19 (`250c892b`) switched to Registry Cloudflare 0.1.1 with a No changes plan ([IMP-38](IMP-38-terraform-registry-publication.md)). The original cutover's first no-change plan is not located; the later plan is convergence evidence, not a retroactive first-plan claim. The October 3 credential/zone limitations were superseded by the shipped operator split and the October 17 isolated verification-account rebuild (#148); [T15](../verification/T15-provider-delivery.md) retains the live proof boundaries.

Remaining: source/reference cleanup above and attach the original cutover/no-change and isolated verification records to the unchecked criteria. Do not recreate repositories or repeat production cutover to repair bookkeeping. Account/secret/settings changes, applies, registry mutation, production deploys and any paid operation remain explicit owner gates.
