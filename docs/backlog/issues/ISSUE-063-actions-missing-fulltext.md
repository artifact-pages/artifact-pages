# Publishing through the Actions cannot keep page text search

- Status: Done
- Priority: P1
- Area: GitHub Actions publishing

## Problem

Page text search is built only when `site publish` runs with `--fulltext`, and a publish without it withdraws the site's search data. The `site-publish` Action has no input that passes `--fulltext`. `preview publish` has no `--fulltext` flag in the CLI, so previews are out of scope. A site that relies on page text search therefore loses it as soon as it moves from local CLI publishing to the Actions. The planned `artifact-pages-docs` repository ([IMP-48](../implementation/IMP-48-operator-repository-split.md)) is the first such case: the guide is currently published with `--fulltext`.

## Evidence and reproduction

1. `grep -rni fulltext actions/` returns nothing; `actions/site-publish/action.yml` accepts only `site`, `source`, `config`, `github-token` and `dry-run`.
2. Specification §page text search: search data is "built/published with `--fulltext`".
3. Publishing a full-text site through `actions/site-publish` therefore produces `meta.json` without `fullTextUrl`. This is inferred from (1) and (2), not yet reproduced through the Action.

## Expected outcome

An operator publishing through any publish Action can keep or enable page text search exactly as with the CLI.

## Acceptance criteria

- [x] `site-publish` accepts a `fulltext` input (default `false`) that passes `--fulltext`. The root Action inherits it in [IMP-46](../implementation/IMP-46-action-marketplace-release.md).
- [x] The parity test covers a full-text publish (CLI and Action both advertise `fullTextUrl` in `meta.json`) and the withdrawal on the next publish without it. The hosted smoke ([IMP-47](../implementation/IMP-47-actions-hosted-smoke.md)) repeats this on a GitHub-hosted runner.
- [x] The GitHub Actions guide documents the input and the withdrawal behavior.

## Resolution

2026-10-03: added the input to `actions/site-publish/action.yml`, wired it in `actions/shared/invoke-cli.mjs` and extended `scripts/test-actions-parity.mjs`. `npm run test:actions-parity` passed locally.
