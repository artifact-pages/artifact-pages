# DOC-16 — Guide: GitHub App for private configuration repositories

- Status: Done
- Site: `guide`
- Page: addition to `ja/` and `en/` `configuration.html` or `access-and-trust.html` (choose when drafting); optional pointer from `publishing.html`
- Audience: Adopters whose admin (config) repository is private and whose site repositories publish through `github://` config locators
- Depends on: [T23](../verification/T23-private-repository-topology.md) (Done) and the v0.2.0 release

The public docs live in the separate `artifact-pages-docs` repository; this ticket records the change to make there.

## Purpose

Show how a site workflow reads a private admin configuration: a site repository's `GITHUB_TOKEN` cannot read another private repository, so the workflow mints a GitHub App installation token and passes it as the Action's `github-token` input.

## Scope

- The pattern as proven in T23: one App installed only on the admin and site repositories, with Contents read, Pull requests write (for preview comments) and Metadata read; a per-job token from `actions/create-github-app-token`, scoped to the repositories that job needs; `github-token` for the config read; the workflow token still used for the site-repository fetch.
- Why not a personal access token (tied to a person, broader reach), and that a fine-grained token with Contents read on the admin repository only also works in principle but was not the tested route.
- Repository-scope secrets on GitHub Free and the lost environment branch policies.
- What was not verified: the error shown when the token is missing or too narrow (do not describe it until recorded).

## Acceptance criteria

- [x] `ja` and `en` pages describe the pattern with a workflow excerpt matching the `artifact-pages-docs` workflows.
- [x] Every statement matches T23 results; nothing is claimed about the unverified error case.
- [x] Renders in light and dark themes and at ~400px width; published locally with `site publish --dry-run` then `site publish`.

## Result

Published on 2026-10-05 after owner approval. Pages: [`configuration.html#remote-private`](https://artifact-pages.dev/guide/en/configuration.html#remote-private) (ja: `/guide/ja/configuration.html`){extra}. Docs PR: https://github.com/tasuku43/artifact-pages-docs/pull/12. Publish run on main (guide `published`, architecture `no-op`): https://github.com/tasuku43/artifact-pages-docs/actions/runs/37327799565. Example workflows pin `@v0.2.1`.

The 404 error text for a private repository the token cannot access was verified on a hosted runner with v0.2.1 and is quoted in the page, so the earlier "do not describe the error" restriction no longer applies.
