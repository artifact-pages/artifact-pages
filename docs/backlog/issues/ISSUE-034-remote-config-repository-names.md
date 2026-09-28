# Accept valid GitHub repository names in remote config locators

- Status: Open
- Priority: P2
- Area: CLI / remote configuration
- Review: 2026-09-28, finding 21, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-19](../implementation/IMP-19-config-resolution.md)

## Problem

A provider-name regex is reused for repository identity. Valid GitHub repositories such as `.github`, `platform.config`, and digit-leading names are rejected before remote config resolution.

## Evidence and reproduction

1. Select `github://acme/.github/.artifact-pages.yaml?ref=<full-40-character-SHA>` as the deployment-config locator.
2. Repeat with a dot-containing or digit-leading repository name.
3. The reviewed validator exits 2 with invalid repository before making a network request.

Reviewed source: [internal/config/config.go:602](../../../internal/config/config.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/codebase-review.md / pre-network locator validation reproduction`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

The documented GitHub locator can identify valid repositories without weakening path/ref or transport validation.

## Acceptance criteria

- [ ] Locator tests accept `.github`, dot-containing, and digit-leading repository names and preserve owner/repository spelling.
- [ ] Invalid repository components, traversal, empty segments, unsafe paths, and malformed refs remain rejected.
- [ ] Existing ref/path defaults and explicit-config precedence stay predictable.
- [ ] Use a deterministic remote-resolution test without depending on real credentials; align any duplicated repository validators with the same contract.
