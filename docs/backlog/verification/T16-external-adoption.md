# T16 — Clean-room distribution and upgrade

- Status: Open
- Phase: Reusable distribution

## Proof needed

- [ ] From clean external admin and satellite repositories, use one coordinated release set: the CLI source and web bundle at `vX.Y.Z`, the optional Action pinned to the full commit SHA for that tag, and the selected provider module from the same tag or commit SHA. Do not copy OSS application or infrastructure source.
- [ ] Verify application bundle integrity, install/deploy, registry dry-run/publish, site dry-run/publish, and optional Action parity.
- [ ] Upgrade and roll back one app version without changing site objects; verify the release's schema compatibility expectations and retain the prior immutable component refs.
- [ ] Repeat the supported reference workflow locally and on AWS; Cloudflare adoption evidence is tracked by IMP-33/T15.

## Evidence

Not yet recorded. Documentation alone does not close this proof.
