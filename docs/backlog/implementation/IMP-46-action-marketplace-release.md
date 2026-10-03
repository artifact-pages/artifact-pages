# IMP-46 — Marketplace-listed Action and released references

- Status: Open
- Lanes: CLI / release, Docs / Adoption
- Execution: Agent-led within the settled [TD4](../technical-design/TD4-action-marketplace-distribution.md). Accepting the Marketplace Developer Agreement, creating any new repository and ticking the Marketplace publish box are owner steps.
- Depends on: [TD4](../technical-design/TD4-action-marketplace-distribution.md) (Done) and [IMP-45](IMP-45-unified-release-and-compatibility.md). The listing slice also waits for [T16](../verification/T16-external-adoption.md) and the first full release.
- Proves: [T16](../verification/T16-external-adoption.md)

## Goal

Adopters find Artifact Pages on GitHub Marketplace and copy a workflow that references a real released Action. The listed Action behaves exactly like the existing sub-folder Actions and the CLI.

## Slices

1. **Root Action.** Add the root `action.yml` as the `site-publish` Action. Use `name: Artifact Pages`, `branding: { icon: book-open, color: blue }`, and the same typed inputs and outputs as `actions/site-publish`. Share the implementation with `actions/*` rather than copying it, and keep every `actions/*` entry point working. List the companion Actions in the README and the Marketplace description.
2. **Parity.** Extend `scripts/test-actions-parity.mjs` so that the root Action produces the same outputs, exit codes and dry-run immutability as `actions/site-publish` and the direct CLI.
3. **Build cache.** Enable `actions/setup-go` caching keyed on the Action's `go.sum` in every Action. On a GitHub-hosted runner, measure cold and warm run times and record them in TD4.
4. **Released references.** After the first release, replace `<FULL_REVIEWED_ACTION_COMMIT_SHA>` in `examples/github-actions/*.yml` with the exact tag. Also update `docs/guides/github-actions.md`, `clean-room-adoption.md` and the public guide's publishing page to use the exact tag and to show the full-SHA-with-comment form.
5. **Immutable releases.** After the first release, the owner enables immutable releases on the repository.
6. **Listing.** Wait for the first full release after T16 passes. The owner edits the workflow-created release, ticks "Publish this Action to the GitHub Marketplace" with primary category Publishing and secondary category Deployment, and updates the release. If that fails, switch the tag workflow to a draft release, move its asset verification to after publication, and record the change in TD4. Record the listing URL and version.

## Progress

- 2026-10-03: slice 1 implemented. The root `action.yml` is the site-publish Action (`name: Artifact Pages`, `branding: book-open / blue`) with root-relative paths. `scripts/test-actions-parity.mjs` asserts that it matches `actions/site-publish` apart from metadata and paths, and checks the description length. The README and the GitHub Actions guide list the companion Actions. Slice 2 is covered by that equality check, which `npm run test:actions-parity` passed; the IMP-47 smoke also runs it through `uses: ./`.

## Acceptance criteria

- [ ] The listed Action passes metadata validation in the release form ("Everything looks good!").
- [x] Parity tests cover the root Action and pass.
- [ ] Cold and warm hosted-runner times are recorded in TD4.
- [ ] No placeholder Action reference remains in examples or guides. Every documented reference resolves to a published release.
- [ ] A workflow in a separate public repository runs the listed Action on a GitHub-hosted runner by the documented reference. The run's result is recorded here and in T16.
- [ ] The Marketplace listing URL and version are recorded in [release readiness](../release-readiness.md).
