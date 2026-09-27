# T4 — Serving routes, cache, and access control

- Status: Open
- Phase: Post-MVP preview

## Contract to prove

Direct preview URLs work without catalog membership; a missing raw file is a real 404 rather than the SPA shell. A restricted site authorizes catalog, manifest, documents, and resources before shared-cache delivery.

## Exit criteria

- [ ] Exercise direct load and reload of a fixed preview URL after its group leaves discovery.
- [ ] Verify that missing manifests are hidden in the Previews list and missing raw resources return 404.
- [ ] Verify browser/CDN cache behavior for mutable catalog responses and removed objects.
- [ ] Verify public and restricted sites at the serving boundary, including catalog, manifest, HTML/Markdown, and local resources.

## Evidence

Not yet run. See the [proof matrix](../../architecture/preview-publishing-contract.html#proof).
