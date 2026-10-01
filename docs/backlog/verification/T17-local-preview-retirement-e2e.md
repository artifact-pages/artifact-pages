# T17 — Local preview deletion and main-publish reconciliation E2E

- Status: Open
- Phase: Local verification of the accepted provider-neutral publishing contract
- Execution: Agent-led when assigned; queued, not started.
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

- [ ] Publish production and two distinct previews with the real CLI; verify both previews are discoverable and at least the selected document renders before deletion.
- [ ] Delete only one exact revision namespace through the local storage API; establish that its files/manifest are absent while its catalog entry initially remains.
- [ ] Run production publication from the synthetic main source. Its dry-run reports the selected missing group for removal, retains the live group and performs no storage writes; unchanged production has no artifact changes.
- [ ] Execute normal production publication and verify that only the missing group is pruned. Preserve the live revision's bytes/metadata and the neighboring site's projection.
- [ ] In a browser used before deletion, revalidate the preview list and verify the deleted group/document is absent. Revalidate its former logical URL and verify `Preview unavailable`, with no artifact content. Verify raw document and manifest paths return real 404 rather than the SPA shell.
- [ ] Cover an already-absent catalog without fabricating a removal: unchanged production may converge as a no-op. Origin read errors must not be interpreted as absence; link or run the relevant existing Go/adapter regressions.
- [ ] Add a documented repeatable local command, with isolated ports/storage and reliable cleanup. Normal invocation must not contact AWS/Cloudflare/GCP production endpoints or require their credentials. Generated fixtures and results stay ignored under `.local/`.
- [ ] Run the new regression and relevant existing tests, obtain independent review, and link actual command/results here before marking Done.

## Non-goals and evidence boundary

- No new application-managed expiry, PR-state cleanup or shipped cleanup workflow.
- No wait for real lifecycle deletion in ordinary CI; no scheduled public-cloud runs as a prerequisite.
- No claim that MinIO/nginx reproduces R2 IAM, lifecycle scheduling or Cloudflare's global cache propagation. A local warm-browser check proves reader/cache-contract behavior in that setup only.
- No automatic closure of T15, publication of official artifacts, or change to product models or viewer access policy.

## Evidence

Not executed. This item records the accepted verification gap; the existing manual and split-test evidence remains in T8/T13/T15 and the linked experiment.
