# Clean-room adoption and recovery walkthrough

This walkthrough exercises Artifact Pages from the perspective of an adopter. It creates separate, temporary Git repositories for an admin and a satellite, then uses a local directory as their shared object target. The repositories contain only adopter-owned configuration and site content; neither copies the Artifact Pages application source.

## Run the local walkthrough

From the Artifact Pages checkout, run:

```sh
node scripts/test-clean-room-adoption.mjs
```

The runner needs Node.js, Go, Git, and `tar`. It needs no cloud credentials, network access, Docker, or changes to `artifact-pages-example`. It builds the CLI from this checkout and creates all adoption state under ignored `.local/clean-room-adoption-*` storage. A successful run removes that temporary state; a failed run prints and retains its path for inspection.

The run performs these steps in one clean-room scenario:

1. Initializes and commits an `acme/platform-admin` repository and an independent `acme/sre-docs` repository. The admin owns one `artifact-pages.yaml` containing provider settings and its `sites` mapping; the satellite has no admin registry config.
2. Plans registration of the complete `sites` mapping with an explicit admin config, then reconciles from the admin checkout's committed default config.
3. Plans and publishes the `sre` and `neighbor` sites from the satellite checkout with the explicit config path `../platform-admin/artifact-pages.yaml`. The CLI checks the satellite Git identity and exact source path against the registry.
4. Runs a site publish dry-run and checks the object target remains byte-for-byte unchanged.
5. Simulates a process that left the SRE site lock held. It confirms that recovery with an ETag captured before the lock changed fails, then inspects and recovers with the current ETag.
6. Creates two local test app archives with different bytes. It checks the app dry-run is read-only, verifies that a tampered archive is rejected before writes, deploys version one, upgrades to version two, and rolls back to version one. It compares `/_indexes/`, `/_artifacts/`, and `/_previews/` byte-for-byte after each app deployment.
7. Changes the SRE source and removes a stale file, plans the update, and publishes it. It checks that the neighbor site's index and artifacts are unchanged.
8. Removes SRE from the admin config's `sites` mapping, plans and applies `registry unregister --site sre`, then verifies SRE discovery and content prefixes are removed while the neighbor's indexes, artifacts, and previews remain unchanged.
9. Runs `scripts/test-actions-parity.mjs` in its own temporary repositories. This checks CLI and shared Action-invoker results and static workflow wiring; it does not run GitHub's hosted composite runner.

The two app archives are generated test fixtures, not published Artifact Pages releases. They exercise the archive manifest and SHA-256 checks that `app deploy --archive` performs. The run does not verify a public release download, an OSS license, a release/versioning policy, or a provider account.

## Roles and trust boundaries

- The **admin repository** owns one deployment config containing the target and the complete desired `sites` mapping. `registry register` reconciles that full set and cleans content prefixes for omitted sites; an absent `sites` field is an input error, while `sites: {}` explicitly requests an empty registry. `registry unregister` requires the config to omit the selected site before performing its cleanup. Restrict those workflows to reviewed changes and protected environments.
- A **satellite workflow** publishes an explicitly selected site ID and source path. The publisher checks the Git origin identity and the exact registered source path. The site is never inferred from the repository name.
- The **web app bundle** contains only the stable application plane (`index.html` and assets). Deploying it leaves site indexes, artifacts, and previews alone. Keep app deployment credentials separate from registry and per-site credentials.
- Published HTML artifacts execute in an unsandboxed iframe. Treat HTML and its referenced JavaScript as trusted executable code and review the source before publication. Markdown is sanitized before it is rendered in the application.

Local mode proves command behavior against the shared object projection and directory-backed conditional writes. It does not prove provider IAM boundaries or turn the cooperative site locks into a security boundary. A caller with direct write access to an object target can bypass those locks.

## Select and verify released components

An adopter should consume reviewed, immutable Artifact Pages component revisions rather than copying the application source into either adopter repository. The optional composite Actions build the CLI from the Action source, so pin the Action path to the full reviewed 40-character commit SHA. Pin a private admin config locator to a full commit SHA as well. See [GitHub Actions](github-actions.md) for workflow inputs and scoped role guidance.

For a locally supplied app archive, `artifact-pages app deploy --archive` validates the release manifest, archive file list, and SHA-256 checksum before it writes. For the published app release, `artifact-pages app deploy` (without `--archive`) downloads the release that matches the CLI's own version (`artifact-pages version`), i.e. it downloads the archive, manifest, and checksum from the selected GitHub release and performs the same validation. The `artifact-pages-example` repository also demonstrates checksum-verified installation without copying the React app source.

The local walkthrough uses deployment-config schema version 1 and release-manifest schema version 1. It builds the CLI from this checkout and exercises the Action wrapper from that same source revision, so it proves a matched-revision local flow only; it does not validate a public release. Select each deliverable independently: pin a composite Action (and the CLI it builds) to a full commit SHA, and pin a Terraform module to a full commit SHA. The single `vX.Y.Z` tag series versions the CLI, the Actions and the web bundle together, and the CLI deploys the web bundle of its own version, so pinning the CLI or Action pins a tested CLI/web pair; a new tag or CLI upgrade never deploys the app by itself, and Terraform modules keep their own versions. A remote admin-config locator is user-owned configuration and should also be pinned independently. Serialized compatibility is tracked by each format's `schemaVersion`; do not treat local test labels as public app versions.

## Upgrade, rollback, and recovery

Upgrade the web application by moving to the CLI (or Action ref) of the next release and running `app deploy`. Roll back by running the previously verified CLI release, or by deploying a previously verified archive with `--archive`. App deploy validates the full bundle before starting writes, writes `index.html` after its assets, and revalidates the shell route. It is not a multi-object transaction: if a provider write fails partway through, repeat the chosen deployment to converge the app plane. Site objects remain a separate content plane.

Site publish and unregister are desired-state operations. If one stops after partial writes, retry the same publish or unregister after correcting the underlying cause; the operation reconciles the remaining changes. Locks do not expire automatically. Before recovering a retained lock, confirm the original process is no longer active, inspect the lock, and pass the exact inspected ETag to `artifact-pages lock recover`. If the lock changes after inspection, the old ETag must fail and the operator must inspect again. The local runner exercises the ETag guard using a synthetic interrupted-run record; it does not simulate killing a live cloud publisher.

## What still needs external evidence

This walkthrough is local evidence only. Its source and local-adoption criteria are tracked by [IMP-35](../backlog/implementation/IMP-35-external-adoption.md). External adoption with pinned released components is tracked separately by [T16](../backlog/verification/T16-external-adoption.md), AWS provider delivery by [T15](../backlog/verification/T15-provider-delivery.md), and Cloudflare parity by [IMP-33](../backlog/implementation/IMP-33-cloudflare-deployment.md). The coordinated versioning and compatibility policy is recorded in [TD2](../backlog/technical-design/TD2-component-release-policy.md), but no public release or provider account has been exercised.
