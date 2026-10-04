# TD4 — GitHub Actions distribution and Marketplace listing

- Status: Done
- Phase: Reusable distribution
- Decision: The owner decided on 2026-10-03 to list Artifact Pages on GitHub Marketplace and to keep the listed Action, `site-publish`, at this repository's root, with the other Actions as unlisted sub-folder Actions. The owner accepted the decisions for questions 2–6 the same day.
- Related design: [TD2](TD2-component-release-policy.md), [T2](T2-cli-action-interface.md), [T11](T11-command-surface.md)
- Related implementation: [IMP-13](../implementation/IMP-13-action.md), [IMP-34](../implementation/IMP-34-actions.md), [IMP-45](../implementation/IMP-45-unified-release-and-compatibility.md), [IMP-46](../implementation/IMP-46-action-marketplace-release.md)
- Related verification: [T16](../verification/T16-external-adoption.md)

## Problem

IMP-13 and IMP-34 built the composite Actions under `actions/` (`admin`, `site-publish`, `preview-publish`, plus `shared` helpers; the standalone `preview-preflight` Action was later folded into `preview-publish`), and TD2 versions them with the product tag series. Nothing yet decides how adopters find and reference them. The workflow examples still use `<FULL_REVIEWED_ACTION_COMMIT_SHA>`, and no Action has run on a GitHub-hosted runner.

## Marketplace constraints (GitHub docs, checked 2026-10-03)

- Only one metadata file (`action.yml` or `action.yaml`) at the repository root is listed. The docs say metadata files in sub-folders "will not be automatically listed in the marketplace".
- The repository must be public, and the account must accept the Marketplace Developer Agreement and use two-factor authentication.
- The Action `name` must be unique. It cannot match an existing Marketplace action, another GitHub user or organization, or a Marketplace category.
- An Action is listed by drafting a GitHub release and selecting "Publish this Action to the GitHub Marketplace", choosing a primary category. Listing is per release.
- GitHub recommends release tags plus a moving major tag such as `v1`. With immutable releases, a moving tag must be a plain Git tag with no release. Full-SHA pinning is described as the most reliable reference.

The docs list no ban on workflow files in the repository. They recommend that the repository contain only the files the Action needs, but that is not a stated requirement.

## Design questions

1. **Listing shape — decided 2026-10-03.** The Action stays in this repository. Its root `action.yml` is the Marketplace listing, and the other Actions stay in `actions/*` sub-folders, usable as `tasuku43/git-artifact-pages/actions/<name>@<ref>` but not listed. The listing description and README point to them. `actions/cache` follows the same pattern, listing one Action and providing `restore` and `save` as sub-folder Actions, and so does `github/codeql-action` with `init`, `analyze` and `autobuild`. The listing, tags and CLI keep TD2's one product version, and the IMP-45 tag workflow produces the listed release. The rejected alternatives were a separate Action repository and one repository per Action: each needs its own version series, released in step with every product release.
   - Root Action content — decided 2026-10-03: `site-publish`, the Action satellite repositories use most. A dispatcher on a `command` input was rejected because it would replace typed inputs with mode-dependent ones. `actions/site-publish` remains as an equivalent sub-folder entry point. The preflight still runs in its own credential-free job before the provider job.
2. **Name and category — decided 2026-10-03.**
   - `name: Artifact Pages`, the product name. On 2026-10-03, while logged out, a Marketplace search for "artifact pages" returned no action with that name; the results were GitHub Pages actions such as "Upload GitHub Pages artifact". `/marketplace/actions/artifact-pages` and the `artifact-pages` and `artifactpages` accounts returned 404. A 404 does not rule out reserved or suspended names, so check again in the release form before the first listing.
   - Sub-folder Actions keep descriptive names such as "Artifact Pages site publish". Unlisted names do not need to be unique.
   - `branding: { icon: book-open, color: blue }`. `book-open` is in the allowed Feather icon list and matches the reading product. Every allowed icon is generic, so none is a brand mark.
   - Primary category **Publishing**, secondary **Deployment**. The Action publishes a site's documents; it does not deploy an application.
3. **References for adopters — decided 2026-10-03.**
   - Guides and examples use the exact release tag, for example `@v0.1.0`. They also show full-SHA pinning with a `# v0.1.0` comment as the hardened form, for adopters who want to rule out tag deletion.
   - No moving major tag while the product is `0.x`. TD2 makes no cross-version compatibility promise before `1.0.0`, so a `v0` alias could silently move adopters to a different contract. Revisit a `v1` alias as a plain Git tag at `1.0.0`; that would require a TD2 amendment.
   - Enable GitHub's immutable releases on this repository once IMP-45's first release is out. It enforces TD2's "tags and assets are never moved or replaced" and does not block later plain alias tags.
   - T16 changes from "full commit SHA" to "the documented reference form".
4. **Pre-releases — decided 2026-10-03.** List nothing while releases are marked pre-release. The first Marketplace listing is the first full release after [T16](../verification/T16-external-adoption.md) passes. T16 and the hosted-runner check use the tag directly and do not need Marketplace. As a result, the docs' silence on pre-release listing stops mattering, and Marketplace never advertises a version that has not passed adoption proof.
5. **Release automation versus manual listing — decided 2026-10-03.** GitHub documents no API for Marketplace publishing; the REST release endpoints have no Marketplace or category field, and listing is a 2FA-protected UI step.
   - The IMP-45 tag workflow keeps creating and verifying the release.
   - The owner then edits that release in the UI, ticks "Publish this Action to the GitHub Marketplace", confirms the categories and updates the release. This is repeated for every release that should appear on Marketplace.
   - At the first full release, verify that this works on a workflow-created release. If it does not, the workflow creates a draft and the owner publishes it with the box ticked. In that case, the post-publication asset verification moves to after the owner publishes, because draft assets are not publicly downloadable.
   - The release is created for an existing pushed tag, so the REST restriction on `GITHUB_TOKEN` for commits that change `.github/workflows/` should not apply. Record this explicitly in IMP-45 if its first run shows otherwise.
6. **Build model — decided 2026-10-03.** Keep building from source for `0.x` and add caching.
   - Use `actions/setup-go` with `cache: true` and `cache-dependency-path` set to the Action's `go.sum`. The cache lives in the adopting repository.
   - IMP-46 measures cold and warm run times on a GitHub-hosted runner and records them in this TD.
   - Amended 2026-10-05: the owner decided to distribute prebuilt CLI binaries without waiting for the measurement. The release workflow attaches `artifact-pages_vX.Y.Z_{linux,darwin}_{amd64,arm64}` binaries, a checksums file and the Go dependency notices to each release, and each Action installs the matching binary when its ref is the release tag of its own source tree, otherwise it builds from source (with the cache above). Windows stays source-built. The rule is in the specification ("Shared Action behavior"); [IMP-56](../implementation/IMP-56-prebuilt-cli-binaries.md) implements it. This amends TD2's "no standalone CLI binary" and keeps TD2's rule that dependency notices accompany it.
   - Revisit prebuilt CLI assets only if the measured warm overhead is unacceptable. That would amend TD2's "no standalone CLI binary" and add per-platform builds, checksums and Go dependency notices.
   - Amended 2026-10-05 (implementation finding, not yet measured on a hosted runner): `setup-go`'s `cache: true` with `cache-dependency-path` pointing at the Action's `go.sum` cannot work. The Action source lives under the runner's `_actions` directory, outside `GITHUB_WORKSPACE`, and `@actions/glob`'s `hashFiles` skips files outside the workspace, so `setup-go` finds no dependency file and fails with "unable to cache dependencies". The Actions instead keep `cache: false` on `setup-go` and restore `GOMODCACHE` and `GOCACHE` with a SHA-pinned `actions/cache` step whose key hashes the pinned `go.mod`, `go.sum` and Go version (`artifact-pages-go-<os>-<arch>-<hash>`). The cache still lives in the adopting repository. The measurement requirement is unchanged.
   - Building from source keeps one supply-chain path: the tagged source the adopter pinned.

## Exit criteria

- [x] Record the listing shape (this repository's root `action.yml`; sub-folder Actions unlisted).
- [x] Record the root Action's content (`site-publish`).
- [x] Record the name, branding and category.
- [x] Record the adopter reference policy. No moving tag in `0.x`, consistent with TD2's no-compatibility-guarantee policy.
- [x] Record the owner's listing step. Pre-releases are not listed, so their behavior no longer matters; [IMP-46](../implementation/IMP-46-action-marketplace-release.md) checks at the first full release that a workflow-created release can be listed.
- [x] Record the build model: build from source with a dependency cache. TD2 is unchanged.
- [x] Update the specification (§22) and hand implementation to [IMP-46](../implementation/IMP-46-action-marketplace-release.md).
