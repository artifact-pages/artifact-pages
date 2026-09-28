# T16 — Clean-room distribution and upgrade

- Status: Open
- Phase: Reusable distribution
- Execution: Collaborative; clean-consumer test preparation is agent-led. See [delegation](../delegation.md).
- Related implementation: [IMP-37](../implementation/IMP-37-cloudflare-entry-module.md), [IMP-38](../implementation/IMP-38-terraform-registry-publication.md).

## Proof needed

- [ ] From clean external admin and satellite repositories, select each deliverable independently: pin the optional Action (which builds the CLI) to a full commit SHA and select the web bundle by its `vX.Y.Z` app-release version. For a Registry-published provider module, select its actual Registry source and exact module version after IMP-38; record the corresponding tested module commit and resolved provider versions. A Git-SHA module source remains usable for pre-publication smoke, but does not prove Registry adoption. Do not copy OSS application or infrastructure source.
- [ ] Verify application bundle integrity, install/deploy, registry dry-run/publish, site dry-run/publish, and optional Action parity.
- [ ] Upgrade and roll back one app version without changing site objects; prove that changing the Action/CLI source ref does not require repackaging or deploying the web app, and verify the selected schema versions.
- [ ] Repeat the reference workflow locally and for each provider advertised as supported. Start live adoption with Cloudflare's new entry module from IMP-37/38; its deployed delivery proof remains T15. Keep AWS evidence separate and required before an AWS support claim; its readiness must not block the first Cloudflare module publication.

## Evidence

Not yet recorded. Documentation alone does not close this proof.
