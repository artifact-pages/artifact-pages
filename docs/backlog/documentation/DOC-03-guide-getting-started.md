# DOC-03 — Guide: getting started

- Status: Blocked
- Site: `guide`
- Page: `ja/getting-started.html`, `en/getting-started.html`
- Audience: Admins setting up a deployment for the first time
- Depends on: DOC-02

## Purpose

Take an admin from nothing to a first readable site: choose a delivery target, deploy the app, register sites, publish once, and open it.

## Scope

- Prerequisites and the admin repository's role.
- A local-first path (provider `local`) that can be tried without a cloud account, then where the cloud paths diverge.
- `app deploy`, `registry register`, first `site publish`, and how to confirm the result in the reader.

## Out of scope

- Provider-specific account setup beyond pointing to DOC-06 and the operator guides.

## Primary sources

- [Specification §11 Registry, §13 Local reference, §22](../../specification.md)
- [Clean-room adoption](../../guides/clean-room-adoption.md), [Local registered sites](../../guides/local-registered-sites.md), [App bundle deployment](../../guides/app-bundle-deployment.md)

## Acceptance criteria

- [ ] `ja/getting-started.html` and `en/getting-started.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [ ] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [ ] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [ ] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Notes

- Decide with the owner whether the local path or a cloud path is the primary walkthrough.

## Blocker (2026-10-01)

No public release exists yet (no tags or GitHub releases), so an external reader cannot follow `app deploy --version` or a pinned CLI install. Resume after the owner decides the minimal release shape: how the CLI is obtained (commit-pinned `go install github.com/tasuku43/git-artifact-pages/cli/cmd/artifact-pages@<sha>` or binaries) and whether a `v0.x` web bundle is published as a GitHub pre-release. Release-independent pages (DOC-05, DOC-07, DOC-08–12) proceed first.

### Update (2026-10-03)

Owner direction: the documentation is written as if releases are published. Pages use the placeholder version `x.y.z` and point to [GitHub Releases](https://github.com/tasuku43/git-artifact-pages/releases) once, without hard-coded versions, install commands for the CLI, or Action pin formats. Release details are expected to change while the owner finalizes the release setup, so release-dependent wording is kept to the overview step 01 note and one sentence each on Publishing and Configuration.

This page stays blocked only because a step-by-step walkthrough needs details that are still undecided: how the CLI is installed (binary assets, `go install`, or another channel) and how the optional Action is referenced. The web bundle side exists (`v0.1.0` pre-release, [release readiness](../release-readiness.md)). Resume when the owner settles those two points.
