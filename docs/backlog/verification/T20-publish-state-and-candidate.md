# T20 — Fused publish-state recovery and candidate validation

- Status: In progress
- Phase: Local verification and isolated Cloudflare verification target
- Related implementation: [IMP-49](../implementation/IMP-49-fused-publish-state-journal.md)
- Related design: [TD6](../technical-design/TD6-fused-publish-state.md)
- Related baseline: [T19](T19-publish-state-layout-cost.md)

## Proof needed

- [x] Verify older private-control shapes fail closed with exact-site reset guidance; current schema-1 state bootstraps only when the state key is absent.
- [x] Simulate journal and final-root conditional writes that persist but return errors; create a fresh publisher wrapper and prove retry classifies the persisted records correctly.
- [x] Verify pending journal monotonicity across changed/reverted desired inputs, stale deletions, newly added keys, cache invalidation retry, journal cleanup, and dry-run.
- [x] Verify Cloudflare R2 state GET returns all HTTP metadata needed for decoding with no state HEAD; preserve AWS HEAD+GET and ETag behavior.
- [x] Measure operation/body counts for whole publish while reporting private-state/journal and common registry/lock/projection duties separately.
- [ ] Run Go package and race suites, compat-gate unit tests, web package/consumer checks, and candidate preflight at the final source SHA.
- [x] Publish a bounded content change and a no-op only on the existing `artifact-pages-verify` target; verify the full registry remains intact, public objects match desired bytes/metadata, and private control records are not served.

No production target, infra apply, push, tag, or public release is part of this verification.

## Results

The production state and recovery suites cover the pending-key union on changed/reverted input, stale deletion, newly introduced objects, cache retry, journal clearing, dry-run, and conditional-write responses lost after persistence. A fresh wrapper over the same object store recovers both journal-write and final-root-write ambiguity. R2 uses GET-only state reads; AWS keeps HEAD-first clean-state reads and HEAD/GET ETag agreement. `go test ./...`, `go test -race ./internal/publisher ./internal/preview`, `node --test scripts/compat-gate.test.mjs`, `npm run test:web-packaging`, and the rebased `npm run build` passed. Provider request/body accounting is asserted by `TestPublishSiteWholeControlRequestsCompareR2GetOnlyAndAWSHeadThenGet`; this is adapter-level SDK-fake instrumentation, not live R2 wire telemetry. The actual R2 CLI run below reports object changes and cache paths, not inferred network request counts.

The live target was `artifact-pages-verify` at `artifact-pages.stream`. Before any write, `registry register --dry-run` returned `no-op`; its six entries remained `smoke` and `verify-scale-{10,100,1000,5000,10000}`. `lock inspect` reported the `verify-scale-10` site lock free. That site's old private root lacked the required committed generation, so the candidate failed closed. Under the acquired site lock, the old root was saved to `cli/.local/remote-control-backups/verify-scale-10/20261004T123655Z/publish-state.json.json`, all three cache prefixes scoped to that site were purged, and only `_control/publish-state/verify-scale-10.json.gz` was deleted. No journal existed; no projection or registry key was deleted. The backup/reset record is `cli/.local/remote-control-backups/verify-scale-10/20261004T123655Z/reset-report.json`.

The first current-schema publish rebuilt five generated index/search objects; a repeated publish returned `no-op` with `buildSkipped: true`. Appending a temporary marker to `assets/styles/site.css` published exactly that one artifact update and invalidated only its URL. The next publish was a no-op. Restoring the original tracked file (including its original mode and mtime) published one restoration update, followed by another no-op. The fixture source was clean afterward. Public CDN GETs for all ten `verify-scale-10` source objects matched the local source bytes exactly (10,750 bytes total), including the Unicode and reserved-character paths. The live index lists two pages, discovery metadata links the six-entry full-text manifest, and that manifest is publicly readable. The catalog still contains all six expected sites.

The committed state was read directly from R2 after the round trip: schema 1, site `verify-scale-10`, a valid generation, 15 object rows, 1,358 compressed bytes, and `artifact-pages-publish-pending: false`. Requests to the two public `_control` URLs returned a 453-byte `text/html` SPA fallback, not the 1,358-byte private state body; the bodies had different SHA-256 digests. This records the observed route behavior rather than claiming those paths return HTTP 404.

The web archive and release verifier are being regenerated from the final committed source SHA. Local candidate preflight uses `--main-ref main`; the branch is 42 commits ahead of `origin/main`, so the remote ancestry check remains pending the separately authorized push. The `v0.2.0` tag is not created or pushed. The current state reader intentionally accepts only the new schema-1 envelope; it does not migrate earlier prerelease control shapes. No live AWS credentials or AWS target were used; AWS behavior is covered by the SDK-fake integration tests above. The Cloudflare target is a live provider measurement, but this CLI run does not expose its wire-level object request counts.
