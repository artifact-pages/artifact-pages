# PR dry-run of site publish always reports index.json updates from source.ref

- Status: Open
- Priority: P3
- Area: site publish dry-run in pull request workflows

## Problem

Each artifact entry in `_indexes/<site>/index.json` carries `source.ref`. The CLI takes it from the current checkout's branch, or from `--ref`. Production is published from `main`, while a pull request dry-run builds on the PR ref, so every entry's `source.ref` differs from the deployed index. A `site publish --dry-run` on a pull request therefore always plans an `update` of `index.json`, even when the PR changes no site content. Reviewers cannot tell real index changes from ref noise, and the summary counts mislead.

## Evidence and reproduction

1. artifact-pages-docs PR #7 changed only a workflow. Its pull_request run of `site publish --dry-run` (run 37196376911) reported outcome `planned` with one change per site: `update _indexes/<site>/index.json`. `meta.json` and `search/*` were unchanged.
2. Local check, with the CLI at af75645985fa35797942005ed177ecb583249103: building the same tree on `main` matched the deployed `https://artifact-pages.dev/_indexes/guide/index.json` exactly except `generatedAt`. Building on another branch name differed only in `source.ref`.
3. After the PR merged, the `main` publish was `no-op` for both sites (run 37196583989). This confirms the dry-run change was noise.

Source of the value:

- `cli/cmd/artifact-pages/main.go:386` defines the `--ref` flag (empty by default, "inferred from the current branch or commit"); `main.go:410` passes it to `BuildOptions.Ref`.
- `cli/internal/indexer/build.go:1015-1022` (`resolveGitMetadata`) falls back to `git symbolic-ref --short HEAD`, then to `git rev-parse --short HEAD`.
- `cli/internal/indexer/build.go:299` writes it into each entry as `Ref: gitInfo.ref` (field declared at `build.go:120`).

Confirmed: the cause above. Not decided: which fix is right.

## Expected outcome

A dry-run on a pull request for a workflow-only change, against an up-to-date site, reports `no-op`, or the documentation states exactly how to get that result.

## Candidate directions (not decided)

- Document passing `--ref <default branch>`, or add an Action input for it, in PR dry-runs.
- Have a dry-run on a non-default ref compare while ignoring `source.ref`.
- Derive `source.ref` from the configured default branch instead of the checkout.

## Acceptance criteria

- [ ] A workflow-only PR dry-run against an up-to-date site reports `no-op`, or the documentation states exactly how to obtain that result.
- [ ] A test covers the chosen behavior (for example a different checkout ref producing a no-op plan against an index built from the default branch).
