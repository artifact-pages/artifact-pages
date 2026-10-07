# PR dry-run of site publish always reports index.json updates from source.ref

- Status: Done
- Assignee: Codex
- Priority: P3
- Area: site publish dry-run in pull request workflows

## Problem

Each artifact entry in `_indexes/<site>/index.json` carries `source.ref`. At filing time, the index builder inferred it from the current checkout's branch, while only `index build` exposed a `--ref` override; provider-backed `site publish` did not. Production was published from `main`, while a pull request dry-run built on the PR ref, so every entry's `source.ref` differed from the deployed index. A `site publish --dry-run` on a pull request therefore planned an `update` of `index.json`, even when the PR changed no site content. Reviewers could not tell real index changes from ref noise, and the summary counts misled.

## Evidence and reproduction

1. artifact-pages-docs PR #7 changed only a workflow. Its pull_request run of `site publish --dry-run` (run 37196376911) reported outcome `planned` with one change per site: `update _indexes/<site>/index.json`. `meta.json` and `search/*` were unchanged.
2. Local check, with the CLI at af75645985fa35797942005ed177ecb583249103: building the same tree on `main` matched the deployed `https://artifact-pages.dev/_indexes/guide/index.json` exactly except `generatedAt`. Building on another branch name differed only in `source.ref`.
3. After the PR merged, the `main` publish was `no-op` for both sites (run 37196583989). This confirms the dry-run change was noise.

Source of the value:

- `cli/cmd/artifact-pages/main.go:386` defines the `--ref` flag (empty by default, "inferred from the current branch or commit"); `main.go:410` passes it to `BuildOptions.Ref`.
- `cli/internal/indexer/build.go:1015-1022` (`resolveGitMetadata`) falls back to `git symbolic-ref --short HEAD`, then to `git rev-parse --short HEAD`.
- `cli/internal/indexer/build.go:299` writes it into each entry as `Ref: gitInfo.ref` (field declared at `build.go:120`).

Confirmed: the cause above. The fix direction was open when this issue was filed; the selected behavior is recorded below.

## Chosen behavior

Add an explicit metadata-ref override to `site sync` and the publish Action. The override controls only the `source.ref` value written into the site index; it does not select a Git checkout, commit, or document content. When a PR dry-run should compare with production metadata, the caller supplies the same ref that the production publish uses. Empty input preserves the current inferred checkout ref.

## Acceptance criteria

- [x] `artifact-pages site sync --ref REF` records `REF` in `source.ref` without changing the checked-out source revision or document bytes; an empty value preserves inferred metadata.
- [x] The publish Action has an optional `ref` input that forwards to `site sync --ref`; the new input is documented as available after the next Action release, and the README does not imply that `v0.1.0` supports it.
- [x] A workflow-only PR branch produces an `index.json` ref-only dry-run update without an override and a `no-op` when given the production ref; an actual document edit remains planned with that same override.
- [x] Changing the explicit metadata ref invalidates the publish fingerprint and updates the published `source.ref`.

## Resolution

`site sync --ref` now overrides only the `source.ref` value generated for the artifact index. The publish Action's optional `ref` input forwards to that CLI flag; empty input preserves inferred metadata. The Action README says the input first becomes available in the release after `v0.1.0`, which does not accept it. The regression `TestPublishSiteRefOverrideIsMetadataOnlyAndPartOfFingerprint` covers a default-branch publish, a workflow-only PR branch, the ref-only dry-run update, the production-ref no-op, a changed ref updating the published index, and a document edit that remains planned and published from the current checkout.

## Verification

- `go test ./internal/publisher -run TestPublishSiteRefOverrideIsMetadataOnlyAndPartOfFingerprint -count=1`
- `go test ./... -count=1`
- `go vet ./...`
- `node scripts/test-actions-parity.mjs`
- `git diff --check`
- Independent Luna max review passed with no findings on implementation commit `370c3b224501f8100b65a53e3669f28ddbeebdf5`.
