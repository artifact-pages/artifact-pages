# Documentation

Start with the [thesis](thesis.md) for the product's purpose, the [specification](specification.md) for its contract, and the [roadmap](roadmap.md) for implementation status. The specification takes precedence over exploratory diagrams and UI studies.

## Repository and product architecture

- [Static full-text search core](architecture/fulltext-search.md) — optional build/publish, callable browser API and versioned format; detailed palette UX deferred.
- [Repository layout](architecture/repository-layout.md) — component ownership, entry commands, local output paths, and Terraform module boundaries.

## Domain and publishing

- [Domain model](architecture/domain-model.html) — SiteRegistry, Site, Artifact, and the operations that change them.
- [Site publication from a user's actions](architecture/site-user-journey.html) — the visible effect of registering, publishing, finding, and reading a site.
- [Publishing object map](architecture/publish-object-map.html) — repositories, operations, and stored objects in the proposed deployment.
- [Publishing object flow](architecture/publish-object-flow.html) — the same proposed deployment as a step-by-step flow.
- [Preview publishing contract](architecture/preview-publishing-contract.html) — proposed static objects, write order, retention, and verification for post-MVP previews.
- [Preview decision register](architecture/preview-decisions.md) — accepted behavior and open product choices.

## Guides

- [Application bundle deployment](guides/app-bundle-deployment.md) — package, deploy, upgrade, and roll back the static application plane.
- [Clean-room adoption and recovery](guides/clean-room-adoption.md) — exercise separate adopter repositories, local deployment, app rollback, and guarded lock recovery.
- [Cloudflare deployment](guides/cloudflare-deployment.md) — connect an R2 bucket and Cloudflare edge policy, then deploy the app and registered content.
- [Local registered-site development](guides/local-registered-sites.md) — work across an admin checkout and a satellite checkout locally.
- [Local full-text load verification](guides/local-fulltext-load.md) — generate actual pages, deploy an isolated nginx lab, and measure submit-to-search behavior.
- [Optional GitHub Actions](guides/github-actions.md) — thin admin and explicit-site entry points, outputs, credential boundaries, and workflow templates.

## Backlog

- [Backlog index and status legend](backlog/README.md) — product issues, technical design, and verification in separate tracks.
- [Product issues](backlog/issues/README.md) — issue-specific priority, acceptance criteria, and the current active issue index; no issues are currently open.

## UI studies

These are design explorations, not the current application contract.

- [Overall directions](ui/ui-direction.html), [early concepts](ui/ui-concepts.html), [concept gallery](ui/ui-concept-gallery.html), and [content neutrality](ui/ui-content-neutrality.html)
- [Collapsed sidebar](ui/ui-collapsed-sidebar-concepts.html)
- [Command palette](ui/ui-command-palette-concepts.html) and [context-dependent search](ui/ui-command-palette-context-concepts.html)
- [Artifact details](ui/ui-index-metadata-concepts.html) and [Markdown preview](ui/ui-markdown-preview-concepts.html)
- [Preview identity placement](ui/ui-preview-identity-concepts.html) — compare list-only, header, and reader-strip treatments before changing the product UI.

## Research

- [Palette search benchmark](research/palette-search-benchmark.md)
- [Full-text feasibility](research/fulltext-search-feasibility.md), [capacity-focused design](research/fulltext-search-cost.md), and [actual local load benchmark](research/fulltext-local-load-benchmark.md)
