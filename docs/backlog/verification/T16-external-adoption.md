# T16 — Clean-room distribution and upgrade

- Status: Open
- Phase: Reusable distribution

## Proof needed

- [ ] From clean external admin and satellite repositories, select each deliverable by its own immutable reference: pin the optional Action (which builds the CLI) to a full commit SHA, select the web bundle by its `vX.Y.Z` app-release version, and pin the provider module to a full commit SHA. Do not copy OSS application or infrastructure source.
- [ ] Verify application bundle integrity, install/deploy, registry dry-run/publish, site dry-run/publish, and optional Action parity.
- [ ] Upgrade and roll back one app version without changing site objects; prove that changing the Action/CLI source ref does not require repackaging or deploying the web app, and verify the selected schema versions.
- [ ] Repeat the supported reference workflow locally and on AWS; Cloudflare adoption evidence is tracked by IMP-33/T15.

## Evidence

Not yet recorded. Documentation alone does not close this proof.
