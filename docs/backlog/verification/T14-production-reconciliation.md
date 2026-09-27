# T14 — Production reconciliation and race safety

- Status: Open
- Phase: Provider-backed deployment

## Proof needed

- [ ] Deterministically test publish-first and unregister-first lock orderings, different-site concurrency, stale-lock recovery races, and interrupted operations.
- [ ] Interrupt upload, index/meta replacement, stale deletion, and unregister/cache invalidation; repeat the same desired operation and prove convergence.
- [ ] Test multi-page object listing, more than one delete batch, incomplete listing, per-object delete failures, and exact-prefix isolation.
- [ ] Reject symlinks and special filesystem entries; verify published bytes and MIME metadata for document and non-document resources.

## Evidence

Not yet recorded. Provider fakes and real conditional-write smoke are both required by the roadmap.
