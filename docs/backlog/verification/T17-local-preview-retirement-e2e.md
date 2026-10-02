# T17 — Local preview deletion and main-publish reconciliation E2E

- Status: Done
- Phase: Local verification of the accepted provider-neutral publishing contract
- Execution: Agent-led; completed October 2, 2026 (JST), including independent review.
- Related: [T8](T8-stale-reference-cleanup.md), [T13](T13-registered-flow.md), [T15](T15-provider-delivery.md)

## Contract to prove

After a preview revision's completion manifest and files disappear from storage, the next ordinary production publication removes its surviving catalog reference. The preview list no longer offers that revision, and a revalidated old logical document URL reports unavailability. Live previews, production artifacts and neighboring sites are preserved. Confirmed absence, not PR merge state or an application expiry calculation, controls reconciliation.

## Background

The [October 2 Cloudflare experiment](../cloudflare-preview-lifecycle-proof.md) manually verified this flow. Existing Go tests cover missing-manifest reconciliation, dry-run, provider-error retention and retry convergence. Browser E2E covers missing candidates, unavailable documents and real raw 404s. The registered-flow runner invokes the actual CLI and checks generated previews in a browser, but does not yet connect publication, storage deletion, subsequent production publication and browser withdrawal as one regression.

The purpose of this item is to make that complete regression repeatable without a cloud account, real credentials or a day-long wait. It does not replace real R2 lifecycle, credential or CDN proof.

## Scope

- Extend the existing local registered-flow/emulator testing path rather than creating a second application or bespoke cloud test framework.
- Use isolated temporary admin/satellite repositories, explicit source paths and actual CLI/config resolution.
- Serve generated projections through the local edge and object-storage analogue. For the object-backed case, create and delete objects through its API, not by editing fixture bind mounts.
- Represent expiry as an explicit test-only deletion of the selected revision's objects. Keep the shared catalog intact until ordinary `site publish` reconciles it.
- Exercise browser list and document behavior against those actual projections, not only mocked successful HTTP responses.
- Keep failure injection explicitly local. Reuse existing unit/adapter coverage where appropriate instead of duplicating every failure scenario in an expensive browser test.

## Acceptance criteria

- [x] Publish production and two distinct previews with the real CLI; verify both previews are discoverable and at least the selected document renders before deletion.
- [x] Delete only one exact revision namespace through the local storage API; establish that its files/manifest are absent while its catalog entry initially remains.
- [x] Run production publication from the synthetic main source. Its dry-run reports the selected missing group for removal, retains the live group and performs no storage writes; unchanged production has no artifact changes.
- [x] Execute normal production publication and verify that only the missing group is pruned. Preserve the live revision's bytes/metadata and the neighboring site's projection.
- [x] In a browser used before deletion, revalidate the preview list and verify the deleted group/document is absent. Revalidate its former logical URL and verify `Preview unavailable`, with no artifact content. Verify raw document and manifest paths return real 404 rather than the SPA shell.
- [x] Cover an already-absent catalog without fabricating a removal: unchanged production may converge as a no-op. Origin read errors must not be interpreted as absence; link or run the relevant existing Go/adapter regressions.
- [x] Add a documented repeatable local command, with isolated ports/storage and reliable cleanup. Normal invocation must not contact AWS/Cloudflare/GCP production endpoints or require their credentials. Generated fixtures and results stay ignored under `.local/`.
- [x] Run the new regression and relevant existing tests, obtain independent review, and link actual command/results here before marking Done.

## Non-goals and evidence boundary

- No new application-managed expiry, PR-state cleanup or shipped cleanup workflow.
- No wait for real lifecycle deletion in ordinary CI; no scheduled public-cloud runs as a prerequisite.
- No claim that MinIO/nginx reproduces R2 IAM, lifecycle scheduling or Cloudflare's global cache propagation. A local warm-browser check proves reader/cache-contract behavior in that setup only.
- No automatic closure of T15, publication of official artifacts, or change to product models or viewer access policy.

## Evidence

### Repeatable local regression — October 2, 2026 (JST)

[`npm run test:preview-retirement`](../../guides/local-registered-sites.md) passed after review corrections. The command builds the real web app and CLI, then selects the object-backed scenario in [`scripts/test-registered-flow.mjs`](../../../scripts/test-registered-flow.mjs), implemented in [`scripts/registered-preview-retirement.mjs`](../../../scripts/registered-preview-retirement.mjs). It reuses the registered-flow repository/CLI helpers and the existing `edge-gcp` nginx + fake-gcs-server Compose profile; there are no successful browser-response stubs or Node HTTP substitutes for nginx.

The reviewed run completed at `2026-10-02T07:30:30.065Z` (16:30:30 JST). Its isolated edge was `http://127.0.0.1:58372`, origin was `http://127.0.0.1:58373`, and Compose project was `artifact-pages-retirement-qogdki`. The CLI resolved the shared admin config from separate temporary admin/satellite repositories, with explicit `sites/sre/content` and `sites/neighbor/content` sources. The bucket started empty and all registry/production/preview writes and test deletions used the local JSON API. nginx was inspected to have only the app and config mounts, with no dynamic storage mount.

| Stage | Actual result |
| --- | --- |
| Initial publication | Production and neighboring site published; two distinct manual previews appeared in the real browser list. `Retired review` rendered in an iframe with its published CSS before deletion. |
| Exact revision deletion | Deleted `f685689a1fe2cf97ab0d06ca4d13a6ae08a19b16`'s three objects: changed HTML, copied CSS and completion manifest. Full origin snapshots proved all other objects, including the stale catalog, remained unchanged. |
| Main-source dry-run | `outcome: planned`, `changes: []`; exactly one `remove` / `manifest-missing` and one `keep` / `manifest-present`. Only `/_previews/sre/catalog.json` was invalidated in the plan; all object bytes and full API metadata were unchanged. |
| Ordinary production publication | `outcome: published`, no production changes; catalog contained only live revision `d8c22435b7cabf4d5e44e5a7b88c1a836bdacec9` with unchanged group metadata. All production, neighbor and live-revision bytes/API metadata (including generations, timestamps, MIME/cache and custom fields) matched the pre-publication snapshot. Control lock updates are intentionally excluded from this preservation assertion. |
| Warm browser revalidation | Reloaded the same list and document pages used before deletion, without cache-busting or a new browser context. The retired group/document link disappeared; the live group remained. The old logical URL showed `Preview unavailable` with no iframe. |
| Real missing-object responses | Raw retired HTML and manifest returned 404 through both nginx and the origin API; their edge bodies differed from the app shell. |
| Catalog also absent | Deleted the catalog separately through the API. Dry-run and normal main publication returned `no-op`, empty production and preview changes, did not recreate the catalog (origin 404), and preserved all remaining content objects. |
| Cleanup | Successful reviewed run removed both containers and its unique network. The earlier failed browser-assertion run also executed cleanup. State/evidence remains only in ignored `.local/`; SIGINT/SIGTERM handlers request the same cleanup. |

Generated stage JSON, full object snapshots, screenshots and the Playwright trace are retained locally in `.local/preview-retirement-QogDKI/`; the reviewed command log is `.local/t17-reviewed-run.log`. These are reproducible ignored run artifacts, not committed fixtures or public-cloud evidence. `summary.json`, `before-deletion.json`, `deletion.json`, `dry-run.json`, `reconciliation.json`, and `missing-catalog.json` separate the deletion and reconciliation stages. The initial harness attempt stopped before deletion because a link-name assertion incorrectly used exact matching; it was corrected to match the actual title/path label before the successful runs.

### Regressions and review

- `go test -race -count=1 ./cli/internal/preview ./cli/internal/publisher ./cli/cmd/artifact-pages` passed all three packages (6.758 s / 18.403 s / 15.288 s); log: `.local/t17-go-regressions.log`. This includes [`TestPlanAndReconcileCatalogRetainLiveGroupsAndRemoveOnlyConfirmedMissing`](../../../cli/internal/preview/store_test.go), which keeps an origin-error group, and [`TestMapS3ConditionErrorRequiresConfirmedMissingKey`](../../../cli/internal/publisher/aws_reconcile_adapter_test.go) / [`TestS3CompatibleHeadObjectConfirmsAmbiguous404ByExactKey`](../../../cli/internal/publisher/s3_compatible_head_test.go), which reject bucket/auth/list errors as absence. Publisher dry-run, production-write failure and catalog-retry regressions in [`site_publish_preview_test.go`](../../../cli/internal/publisher/site_publish_preview_test.go) also passed.
- `npm run test:registered-flow` passed the existing nginx flow: pre-publication browser check 1/1; generated projection and encoded preview checks 2/2 (the stage-only pre-publication case was correctly skipped in the second invocation), plus its failure/retry Go tests and scoped unregister. Log: `.local/t17-registered-regression.log`.
- Independent subagent review (`review_t17`) found one P2: the missing-catalog no-op comparison excluded the catalog and could miss erroneous recreation. Fixed by comparing all content objects, excluding only private control records, and explicitly asserting origin catalog 404. The reviewer confirmed the correction and reported no additional actionable findings. `npm run test:preview-retirement` passed again after the fix; both script syntax checks and `git diff --check` passed.

This closes the local integration gap only. T15 remains In progress; the retained natural R2 lifecycle experiment, provider rules, credentials and public data were not contacted or modified.
