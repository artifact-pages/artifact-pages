# IMP-46 — Marketplace-listed Action and released references

- Status: Open
- Update 2026-10-06 ([TD14](../technical-design/TD14-one-repository-per-action.md)): there is no root Action any more. Each of `artifact-pages/publish-action`, `preview-action`, `registry-action` and `app-deploy-action` is its own Marketplace listing with its own `name`, branding and README. Slice 1 (root Action) is historical; slice 3 (Go build cache) is historical because published Actions no longer build; slices 4-6 apply per Action repository (released references use `artifact-pages/<name>-action@v0.1.0`; immutable releases are enabled on each Action repository; the owner lists each repository from a release of that repository at the first non-pre-release).
- Remaining: slices 4-6 only (released references, immutable releases, Marketplace listing). Revisit at the first non-pre-release and T16.
- Lanes: CLI / release, Docs / Adoption
- Execution: Agent-led within the settled [TD4](../technical-design/TD4-action-marketplace-distribution.md). Accepting the Marketplace Developer Agreement, creating any new repository and ticking the Marketplace publish box are owner steps.
- Depends on: [TD4](../technical-design/TD4-action-marketplace-distribution.md) (Done) and [IMP-45](IMP-45-unified-release-and-compatibility.md). The listing slice also waits for [T16](../verification/T16-external-adoption.md) and the first full release.
- Proves: [T16](../verification/T16-external-adoption.md)

## Goal

Adopters find Artifact Pages on GitHub Marketplace and copy a workflow that references a real released Action. The listed Action behaves exactly like the existing sub-folder Actions and the CLI.

## Slices

1. **Root Action.** Add the root `action.yml` as the `site-publish` Action. Use `name: Artifact Pages`, `branding: { icon: book-open, color: blue }`, and the same typed inputs and outputs as `actions/site-publish`. Share the implementation with `actions/*` rather than copying it, and keep every `actions/*` entry point working. List the companion Actions in the README and the Marketplace description.
2. **Parity.** Extend `scripts/test-actions-parity.mjs` so that the root Action produces the same outputs, exit codes and dry-run immutability as `actions/site-publish` and the direct CLI.
3. **Build cache.** Cache Go modules and build output in every Action, keyed on the Action's pinned `go.mod`/`go.sum`. On a GitHub-hosted runner, measure cold and warm run times and record them in TD4.
4. **Released references.** After the first release, replace `<FULL_REVIEWED_ACTION_COMMIT_SHA>` in `examples/github-actions/*.yml` with the exact tag. Also update `docs/guides/github-actions.md`, `clean-room-adoption.md` and the public guide's publishing page to use the exact tag and to show the full-SHA-with-comment form.
5. **Immutable releases.** After the first release, the owner enables immutable releases on the repository.
6. **Listing.** Wait for the first full release after T16 passes. The owner edits the workflow-created release, ticks "Publish this Action to the GitHub Marketplace" with primary category Publishing and secondary category Deployment, and updates the release. If that fails, switch the tag workflow to a draft release, move its asset verification to after publication, and record the change in TD4. Record the listing URL and version.

## Progress

- 2026-10-03: slice 1 implemented. The root `action.yml` is the site-publish Action (`name: Artifact Pages`, `branding: book-open / blue`) with root-relative paths. `scripts/test-actions-parity.mjs` asserts that it matches `actions/site-publish` apart from metadata and paths, and checks the description length. The README and the GitHub Actions guide list the companion Actions. Slice 2 is covered by that equality check, which `npm run test:actions-parity` passed; the IMP-47 smoke also runs it through `uses: ./`.
- 2026-10-05: slice 3 implemented but not measured. `setup-go` `cache: true` cannot hash a `go.sum` outside the workspace (see the TD4 amendment), so every Action restores the Go caches with a SHA-pinned `actions/cache` step keyed on `go.mod`, `go.sum` and the Go version; `scripts/test-actions-parity.mjs` checks the wiring. Cold and warm hosted-runner times are still to be recorded, and the cache step has not run on a hosted runner.
- 2026-10-05: hosted measurement context. Since v0.2.0, a tag-pinned run installs the prebuilt binary ([IMP-56](IMP-56-prebuilt-cli-binaries.md)) and skips setup-go, the Go cache and the build (the `artifact-pages-docs` publish run logged those steps as skipped). The per-site publish step went from 129 s with an `af75645` source build (setup-go 9 s, go build 27 s) to 54-59 s for a first publish with state bootstrap and 9-10 s for a no-op publish. The Go cache therefore matters only to SHA or branch pins, which are not the documented path. The cache step itself has still not been measured cold and warm on a hosted runner, so the slice 3 criterion stays open; it can be measured with one SHA-pinned run pair, or dropped if the owner decides SHA pins need no cache.
- 2026-10-06: slice 3 measured on GitHub-hosted `ubuntu-24.04` runners. Source: the `Verify / Composite Actions smoke` job of this repository's CI, which runs every Action through `uses: ./actions/...` (the source-build path; a branch ref is not a release tag, so the prebuilt-binary step is skipped). One job invokes 10 Action steps, each with its own `actions/cache` step. The cache key was `artifact-pages-go-Linux-X64-c3e0ea0b...` (about 63 MB). Numbers come from the job logs (`gh api repos/.../actions/jobs/<id>/logs`).

  First Action invocation in the job (the one a single-Action adopter workflow pays for):

  | Sample | Run | Cache step | `setup-go` | `go build` |
  | --- | --- | --- | --- | --- |
  | Cold 1 | [37244001873](https://github.com/tasuku43/git-artifact-pages/actions/runs/37244001873) | miss, 0.3 s | 9.7 s | 26.3 s |
  | Cold 2 | [37245069280](https://github.com/tasuku43/git-artifact-pages/actions/runs/37245069280) | miss, 0.3 s | 10.3 s | 29.1 s |
  | Cold 3 | [37243841525](https://github.com/tasuku43/git-artifact-pages/actions/runs/37243841525) (job failed in an unrelated preview step, so no cache was saved) | miss, 0.4 s | 10.3 s | 26.9 s |
  | Warm (17 jobs) | [37245279312](https://github.com/tasuku43/git-artifact-pages/actions/runs/37245279312) to [37328700881](https://github.com/tasuku43/git-artifact-pages/actions/runs/37328700881) | hit, 1.4-3.0 s (median 2.1 s) | 8-10 s | 0.9-2.3 s (median 1.5 s) |

  Whole-job totals for the 10 Action invocations, summed over the job: cold `go build` 28.2-31.4 s and cache steps 14-15 s (miss plus one save); warm `go build` 3.1-5.3 s and cache steps 25-51 s. Job wall time is 65-72 s cold and 49-60 s warm in the runs taken before 2026-10-05 01:00 UTC, which share the same smoke workflow shape; later runs add steps and are not comparable (58-88 s).

  Findings:
  - A warm restore removes about 25-28 s of `go build` for the first invocation at a cost of about 2 s of restore, so a single-Action adopter job saves roughly 22-25 s. `setup-go` still costs 8-10 s either way because it downloads the Go toolchain; only the module and build caches are keyed here.
  - Within one job, every invocation after the first restores the same key into an already populated tree. `tar` fails with `Cannot open: File exists`, the step logs `Failed to restore` as a warning and then `Cache not found`, and each such step costs 2-4 s with the job still green. The 9 redundant restores add up to more than the 25-28 s the cache saves in a ten-Action job (warm job cache steps 25-51 s against 3-5 s of build), so the cache pays off only when a job runs about one Action. This is a defect of the repeated restore, not of the key. A fix (for example restoring only when `GOMODCACHE` is empty) is not part of this item; open an issue if the owner wants it.
  - Runs on a pull request ref did not hit a cache saved by a run on another ref (runs 37245069280 and 37243841525 were cold after 37244001873 had saved the same key); `actions/cache` scopes entries by branch, so the first run per branch or pull request is cold. This is the documented `actions/cache` scoping and was not otherwise verified.
  - Consumer evidence is unchanged from the 2026-10-05 note above: tag pins install the prebuilt binary and skip `setup-go`, the cache and the build, so only SHA or branch pins pay these costs.
- 2026-10-06: remaining scope. Slices 4-6 (released references, immutable releases, listing) wait for the first non-pre-release (v0.1.0-v0.2.1 are all pre-releases) and [T16](../verification/T16-external-adoption.md). Revisit at the first non-pre-release.

## Acceptance criteria

- [ ] The listed Action passes metadata validation in the release form ("Everything looks good!").
- [x] Parity tests cover the root Action and pass.
- [x] Cold and warm hosted-runner times are recorded in TD4. (Measured 2026-10-06; see Progress and TD4.)
- [ ] No placeholder Action reference remains in examples or guides. Every documented reference resolves to a published release.
- [ ] A workflow in a separate public repository runs the listed Action on a GitHub-hosted runner by the documented reference. The run's result is recorded here and in T16.
- [ ] The Marketplace listing URL and version are recorded in [release readiness](../release-readiness.md).
