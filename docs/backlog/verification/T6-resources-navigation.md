# T6 — Preview resources and navigation

- Status: Open
- Phase: Post-MVP preview

## Contract to prove

Changed HTML and Markdown documents render from their head snapshot with local dependencies. Links to changed documents stay in that revision; links to unchanged documents open production routes.

## Exit criteria

- [ ] Exercise HTML and Markdown fixtures with relative CSS, JavaScript, images, and fonts.
- [ ] Verify changed-document links, unchanged-document links, and parent-app navigation from an iframe.
- [ ] Exercise explicit non-document resource includes and reject missing or out-of-tree paths.
- [ ] Document and test the unsupported boundary for runtime-built and root-relative URLs.

## Evidence

The Phase 1 serving substrate was checked on 2026-09-27. Added a normal-artifact fixture with spaces, Unicode, `#`, `?`, `%`, and `+` in its route and resource names. The focused E2E verifies direct logical-route load, relative CSS/JavaScript/image loading, and route preservation after reload. It passed alongside existing HTML/Markdown resource tests, which cover site-scoped relative files, Markdown links, and a missing raw artifact resource returning 404.

These checks do not exercise preview snapshot rewriting, changed-document navigation within a revision, production navigation for unchanged documents, parent-app navigation from HTML, explicit resource includes, or rejection of missing/out-of-tree includes. Those preview-specific exit criteria remain unchecked. See [the local E2E fixture and tests](../../../e2e/local-serving.spec.ts) and the [preview selection and resource contract](../../specification.md#post-mvp-pre-publish-preview-contract).
