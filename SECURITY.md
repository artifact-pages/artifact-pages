# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting: choose **Report a vulnerability** at <https://github.com/artifact-pages/artifact-pages/security/advisories/new>. Do not open public issues for vulnerabilities.

Report here for any of these components:

- the CLI and the web reader;
- the four GitHub Actions. The repositories `artifact-pages/{publish,preview,registry,app-deploy}-action` are generated from this repository, so report here, not there;
- the Terraform modules. The published package repositories are generated from `terraform/modules/`, so report here as well.

## Supported versions

The project is a 0.x pre-release. Fixes land on `main` and ship in the next release of the affected component (CLI, web, Actions, Terraform module). Only the latest released version of each component receives fixes. There are no backports.

## Response

The maintainer responds on a best-effort basis and aims to acknowledge a report within 7 days.

For dependency advisories found by the scheduled scans:

- High or critical: fix or record a triage within 7 days.
- Moderate or low in production dependencies: fix or record a triage within 30 days.

## By design, not vulnerabilities

- Published HTML runs as trusted same-origin code. It can read the parent DOM, local storage and other sites' files on the same origin, also in previews.
- A private Git repository does not make the website private. Viewer access control is the operator's responsibility, for example with Cloudflare Access.
- Everything in the configured source directory is published, including Git-ignored files.

See the user-facing trust documentation: [Access and trust (guide)](https://artifact-pages.dev/guide/en/access-and-trust.html) and [Trust model (architecture)](https://artifact-pages.dev/architecture/en/trust-model.html).
