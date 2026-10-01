# T16 — Clean-room distribution and upgrade

- Status: Open
- Phase: Reusable distribution
- Execution: Collaborative; clean-consumer test preparation is agent-led. See [delegation](../delegation.md).
- Related implementation: [IMP-37](../implementation/IMP-37-cloudflare-entry-module.md), [IMP-38](../implementation/IMP-38-terraform-registry-publication.md).

## Proof needed

- [ ] From clean external admin and satellite repositories, select each deliverable independently: pin the optional Action (which builds the CLI) to a full commit SHA and select the web bundle by its `vX.Y.Z` app-release version. For a Registry-published provider module, select its actual Registry source and exact module version after IMP-38; record the corresponding tested module commit and resolved provider versions. A Git-SHA module source remains usable for pre-publication smoke, but does not prove Registry adoption. Do not copy OSS application or infrastructure source.
- [ ] Verify application bundle integrity, install/deploy, complete-manifest registry register dry-run/apply, site dry-run/publish, and optional Action parity.
- [ ] Upgrade and roll back one app version without changing site objects; prove that changing the Action/CLI source ref does not require repackaging or deploying the web app, and verify the selected schema versions.
- [ ] Repeat the reference workflow locally and for each provider advertised as supported. Start live adoption with Cloudflare's new entry module from IMP-37/38; its deployed delivery proof remains T15. Keep AWS evidence separate and required before an AWS support claim; its readiness must not block the first Cloudflare module publication.

## Evidence

Local pre-release preparation was verified on October 1, 2026; see the [distribution preflight](../distribution-preflight.md) for exact pins, bundle digest, commands and limitations. Clean source `eba726a128bac0db98f1578e1c282ed1bbb8a3ff` passed the separate-admin/satellite walkthrough and local Action parity. A real clean-source 100-file Vite archive was deployed from a separate temporary admin checkout with identical bytes. A warm-browser synthetic app upgrade/rollback preserved site content. Cloudflare module `25b6e97031a6fe5202077fe781dc4f14617b0ceb` passed package/contracts and independent pinned local Git consumer initialization/validation. These are preparation results; no Registry version, remote released asset, hosted Action or live released-app rollback was exercised. Keep the released-component acceptance checks above open.

The fixed source's local nginx browser suite passed 83/83 with retries disabled and one worker after explicitly checking server readiness. An initial manually launched server run had a startup `ECONNREFUSED` on its first request and succeeded on retry; that result was not used as the clean browser regression proof. The Go suite and publisher/preview race tests also passed in this clean clone. Later shared-checkout UI changes are outside this pin and require their own regression/review before any release selection.
