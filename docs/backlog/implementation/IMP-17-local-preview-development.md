# IMP-17 — Local preview development mode

- Status: Done
- Phase: Phase 1 local product
- Depends on: [IMP-01](IMP-01-preview-records.md), [IMP-02](IMP-02-source-selection.md), [IMP-03](IMP-03-resource-bundle.md), [IMP-07](IMP-07-local-serving.md), [IMP-08](IMP-08-preview-reader.md)
- Proves: [T1](../technical-design/T1-preview-record-contract.md), [T4](../verification/T4-serving-boundary.md), [T5](../verification/T5-concurrency-recovery.md), [T6](../verification/T6-resources-navigation.md)

## Outcome

Give a contributor a focused local command that builds a changed-document preview from Git and opens it in the browser through local nginx. Keep it as a development path, not a general-purpose publisher CLI or provider implementation. Route writes through the shared `PreviewStore` contract so provider-specific object and lock mechanics remain isolated.

## Acceptance criteria

- The command reads the selected Git head tree, compares against the default branch merge-base, and writes under ignored `.local/previews` without changing the working tree.
- `PREVIEW_ROOT` lets local nginx serve either generated output or committed preview fixtures through the same static object keys and logical browser routes.
- PR provenance is explicit and validated against the registered repository and selected head; absent PR input produces a manual group.
- The browser supports list, direct revision route, HTML/Markdown rendering, relative resources, changed/unchanged document navigation, and missing-resource boundaries.
- `DirectoryStore` implements the provider-neutral read, immutable-create, mutable-replace, and per-site-lock operations; the local lock is documented as process-local.
- The guide states unsupported runtime-built/root-relative URLs and does not claim AWS/Cloudflare, provider retention, restricted access, or production cleanup.
- The local preview bytes cannot be read by an unrelated site through an opaque-origin sandbox; the app and executable preview document use separate origins without granting `Access-Control-Allow-Origin: null` to the preview store.

## Evidence

Go integration tests cover Git-tree selection, provenance validation, resource collection, immutable retries, and catalog updates. A smoke run against a temporary Git repository built a manual preview under `.local/previews`; Docker mounted that generated output and the browser opened its document. Re-running the same head succeeded, and after removing its manifest the direct route became unavailable and its group disappeared from discovery.

On 2026-09-27, `go test -count=1 ./internal/preview` passed. The focused Playwright checks passed 5/5, including an actual opaque-origin fetch of an HTML preview object, isolated-origin HTML/asset/font loading and navigation, external-frame rejection, and the non-loopback `srcDoc` fallback. No preview response grants CORS access to `Origin: null`, and Compose binds nginx to loopback. The current Go race suite passes with `go test -race -count=1 ./...`.

On 2026-09-28, `npm run test:e2e` passed 56/56. The suite includes a non-loopback `srcDoc` regression using malformed HTML with a late permissive CSP meta tag; it confirms the wrapper's earlier policy raises a `securitypolicyviolation` for an attempted external image load. AWS/Cloudflare origin behavior, provider serving policies, provider retention, and cross-process locking remain outside this ticket.
