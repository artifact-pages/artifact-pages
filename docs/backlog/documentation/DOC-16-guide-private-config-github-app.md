# DOC-16 — Guide: GitHub App for private configuration repositories

- Status: Open
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

- [ ] `ja` and `en` pages describe the pattern with a workflow excerpt matching the `artifact-pages-docs` workflows.
- [ ] Every statement matches T23 results; nothing is claimed about the unverified error case.
- [ ] Renders in light and dark themes and at ~400px width; published locally with `site publish --dry-run` then `site publish`.
