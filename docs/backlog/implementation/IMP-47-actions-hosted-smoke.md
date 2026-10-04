# IMP-47 — Hosted-runner smoke workflow for the composite Actions

- Status: Done
- Lanes: CLI / release
- Execution: Agent-led. No cloud credentials or secrets are required.
- Depends on: [IMP-34](IMP-34-actions.md), [IMP-13](IMP-13-action.md); the root Action case follows [IMP-46](IMP-46-action-marketplace-release.md) slice 1.
- Related design: [TD4](../technical-design/TD4-action-marketplace-distribution.md), [TD5](../technical-design/TD5-verification-environment-and-operator-repositories.md)

## Problem

`scripts/test-actions-parity.mjs` runs `actions/shared/invoke-cli.mjs` and `verify-preview-pr.mjs` as Node scripts and checks the text of each `action.yml`. No test executes the Actions through the GitHub Actions runtime. The following are unverified: the composite steps (`setup-go`, `go build`), expression evaluation of `inputs.*`, `github.action_path` resolution, the mapping from `$GITHUB_OUTPUT` to Action outputs, and preflight decisions on a real `pull_request` event.

## Outcome

A workflow in this repository calls each Action with `uses: ./actions/<name>` (and `uses: ./` once the root Action exists) against a runner-local storage target. It runs on pull requests, on pushes to `main` and inside the release workflow before any release is created.

## Slices

1. **Workflow.** Add `.github/workflows/actions-smoke.yml`, reusable from `verify.yml`. Prepare a temporary registry and site in the workspace with a local deployment config, as the parity script does.
2. **Admin.** Run registry register (dry-run, then apply), app deploy with `--archive` of a packaged test bundle, and registry unregister.
3. **Site publish.** Run `actions/site-publish` and the root Action in dry-run and apply. Assert the outputs (`operation`, `outcome`, `changes_json`, `exit_code`), the written objects and no writes in dry-run.
4. **Preview.** On `pull_request` from this repository, run `preview-publish`, which verifies trust itself. Assert the typed URLs and outputs. Cover the rejection path with an explicit mismatched `pull-request` input, and assert that the step fails before any provider operation.
5. **Failure classes.** Run one invalid-input case and one unregistered-site case. Assert the relayed exit codes and `error` output.

## Acceptance criteria

- [x] Every Action in `actions/` (and the root Action once added) runs through `uses:` on a GitHub-hosted runner, and the run is green on a pull request and on `main`.
- [x] Assertions cover outputs, written objects, dry-run immutability and failure exit codes, as listed in the slices.
- [x] The release workflow requires the smoke job before creating a release (via `verify.yml`).
- [x] Run links are recorded here.

## Progress

2026-10-03: implemented as the `actions-smoke` job in `.github/workflows/verify.yml`, so CI and the release workflow both require it. `scripts/actions-smoke-prepare.mjs` writes the local-provider configs and a packaged test bundle. `fixtures/actions-smoke/site` holds the committed smoke site. The job covers:

- admin register (dry-run and apply), app deploy from an archive, and unregister
- site-publish dry-run with a storage digest check
- the root Action with `fulltext: true` and its withdrawal by site-publish
- the unregistered-site (exit 1) and invalid-input (exit 2) failure classes
- the manual and explicit-PR preflight
- preview-publish of a committed change, and a mismatched-PR rejection

`ci.yml` and `release.yml` grant `pull-requests: read` to the reusable workflow for the explicit-PR check. Before pushing, the same CLI sequence was replayed locally through `actions/shared/invoke-cli.mjs` in a scratch clone, and every assertion's assumption held: file layout, output shapes, exit codes, preview documents and unregister cleanup. That replay does not exercise the composite runtime. Hosted runs (all 40 steps successful):

- Pull request #2, `pull_request` event including the explicit-PR preflight, 51 s: https://github.com/tasuku43/git-artifact-pages/actions/runs/37091816417/job/111113567208
- `main` after the merge (`ae017b1`): https://github.com/tasuku43/git-artifact-pages/actions/runs/37092025051
