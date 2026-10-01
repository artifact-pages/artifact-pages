# Cloudflare preview lifecycle and reconciliation — October 2, 2026

Live evidence for [T15](verification/T15-provider-delivery.md) and [T8](verification/T8-stale-reference-cleanup.md). This test retains an explicitly approved disposable preview to observe provider deletion. It does not change retention policy or add an application expiry mechanism.

## Natural deletion observation — in progress

The owner approved leaving a preview under the existing one-day R2 lifecycle rule. The existing `guide` registration and application were preserved; a temporary `release-smoke` site was registered and published using the clean CLI source `eba726a128bac0db98f1578e1c282ed1bbb8a3ff`.

| Input | Recorded value |
| --- | --- |
| Bucket / delivery | `artifact-pages` / `https://artifact-pages.dev` |
| Site / revision | `release-smoke` / `df741e32ce5205411f494f9f9c571cef03f93e2f` |
| Revision namespace | `_previews/release-smoke/revisions/df741e32ce5205411f494f9f9c571cef03f93e2f/` |
| Retained objects | Two documents, four copied resources and the completion manifest: seven objects |
| Catalog | `_previews/release-smoke/catalog.json`, outside the revision namespace |
| Upload timestamps | October 1, 2026, 23:12:51–53 UTC |
| Origin expiration metadata | `expiry-date="Fri, 02 Oct 2026 23:12:51–53 GMT"`, varying by object; `rule-id="expire-preview-objects"` |
| Eligibility in JST | October 3, 2026, 08:12:51–53 |
| Initial observation | October 1, 2026, 23:17:49 UTC: all seven origin HEADs returned 200; catalog returned 200 |

An additional origin observation at October 1, 23:22:16 UTC found that **the catalog is also covered by the deployed rule**: its header was `expiry-date="Fri, 02 Oct 2026 23:17:23 GMT", rule-id="expire-preview-objects"`. Being outside the revision namespace does not exempt it from the actual bucket lifecycle configuration. Do not assume the catalog will survive revision deletion; if it disappears too, the next publish may have no stale reference to remove. Record this separately from the simulated test, which deliberately preserved the catalog. No lifecycle-rule change was made.

The expiry value indicates eligibility, not an exact deletion deadline. Cloudflare documents that objects are [typically removed within 24 hours of their expiration value](https://developers.cloudflare.com/r2/buckets/object-lifecycles/). Actual origin absence has not yet been observed; do not mark the natural lifecycle proof complete from the header alone.

Generated state and read-only observations are in ignored `.local/cloudflare-release-smoke.LxCbo4/lifecycle/`. `lifecycle-check.mjs observe` validates the exact seven-key state, HEADs those keys through the authenticated S3 endpoint, and cross-checks missing keys against a successful complete revision-prefix listing. An empty/corrupt state, listing failure, or disagreement fails closed. It records timestamps and does not treat authorization/network failures as absence. The helper's `setup` mode is mutating and must not be rerun: rewriting a revision could refresh lifecycle age. The original seven ETags, LastModified values and expiration headers are recorded in `state.json`.

A thread heartbeat named **Observe R2 preview lifecycle** (`observe-r2-preview-lifecycle`) checks every three hours, stays quiet on unchanged state, and reports meaningful progress/failure/completion. This is temporary development verification, not a shipped product workflow. Once all seven are confirmed absent by HEAD and successful listing, the authorized follow-up is main-source publish to prune any surviving missing catalog reference, followed by removal of only the disposable site. If the catalog itself is already absent, record that and accept an ordinary converged no-op rather than claiming pruning occurred. Preserve all other live registrations. Stop this heartbeat after cleanup. Record the interval between last-present and first-absent observations rather than inventing an exact deletion time.

## Simulated deletion followed by main publish — origin/catalog checks passed

The owner additionally requested proof that the next main publish removes references to a deleted preview. A separate synthetic revision, `19c64819b058042540e52f5df5d07902a2eb6751`, added `expired-simulation.html` with the visible title **Expired preview simulation**. It did not change the retained natural-lifecycle revision.

1. Dry-run then preview publication succeeded. The browser preview list displayed both revisions and the new document; its HTML rendered successfully.
2. All eight objects under only the simulation revision namespace were explicitly deleted to emulate completed provider deletion. The shared catalog was deliberately left untouched and still referenced that revision. This is simulated absence, not natural lifecycle evidence.
3. The synthetic satellite was switched back to its `main` branch. `site publish --site release-smoke --source docs --dry-run` reported **zero production changes**, one `remove` with `reason: manifest-missing`, one `keep` with `reason: manifest-present`, and only the catalog URL for invalidation.
4. Normal main-source publish succeeded at October 1, 2026, 23:17:27 UTC. An authenticated origin catalog read contained only the retained natural-lifecycle revision. All seven retained objects' ETags, upload timestamps and expiration headers were unchanged.
5. Reloading the existing browser preview-list tab showed only the retained revision: **Expired preview simulation** and its group were no longer listed. Sampled canonical raw simulation document and manifest HEADs returned real 404s, not the SPA shell.

Evidence provenance: the initial deletion invocation printed `objectsDeleted: 8` and `staleCatalogReferencePresent: true` after its empty-prefix check. Its local dry-run assertion then stopped because the harness expected the retained action to be named `retain`, whereas the real contract uses `keep`. The corrected `reconcile` retry performed no further deletion and produced the saved `simulation-proof.json`, whose original `objectsDeleted: 0` describes that retry only. The eight-object deletion claim comes from the initial observed invocation, not from relabeling this saved zero-count retry. Future helper runs keep deletion-stage and reconciliation-stage records separate. No product implementation was changed by these harness corrections.

This establishes automatic missing-group catalog reconciliation during ordinary main-source publication, without an extra cleanup workflow. The algorithm uses completion-manifest absence, not PR merge state or an independently calculated expiry date. A missing individual resource with an intact completion manifest is not the same case.

The already-warm former logical document URL initially continued rendering cached content after the catalog update; immediate direct-link withdrawal is therefore not claimed from list pruning or the origin 404. At approximately October 1, 2026, 23:20 UTC, reloading that same URL showed **Preview unavailable** and **This preview document is no longer available**, with no document iframe content. No manual revision purge or cache-busting query was used. This is a sampled revalidation observation after main publication, not a universal cache propagation bound or proof that an already-open page self-dismisses without navigation/reload.

## Guard and cleanup boundary

Before setup, SHA-256 guards were recorded for the app shell, Guide index, Guide metadata and the public Japanese Guide document. They matched after setup. No Guide or application publication was performed. The simulation revision has been deleted; the natural-lifecycle revision, its catalog entry and the disposable production site intentionally remain until observation finishes. Unlike the preceding scoped-credential test, this run is not yet fully cleaned up. T15 remains **In progress**.
