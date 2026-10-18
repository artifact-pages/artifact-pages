# Hosted fixture preparation — October 18, 2026

Plan only, prepared by Codex Sol for [workstream item 2](../workstreams.md#backend-next-wave-2026-10-18). [IMP-64](../implementation/IMP-64-generate-sync-terraform-packages.md) and [IMP-73](../implementation/IMP-73-registry-setup-command.md) remain In progress / Codex. No fixture, settings or credential mutation was executed. Approval IDs and the consolidated request list are in the [coordinated plan](provider-proof-plan-2026-10-18.md#owner-approvals-requested).

## Immutable inputs and preparation gate

- Planning/source baseline: `b0d314e590cbb19aa563d56882527b47d5c44eb3`.
- Generator and writer: released CLI **0.4.4**, source `060f28883abb25442f3cb1e9108f0de4570362fa`. Verify the downloaded binary against its release checksums; require `version` to name that version/revision. Do not use the historical 0.2 fixture or migrate this proof to ISSUE-112's future 0.5 writer.
- Generated official Action pins: publish `8d66d7a606fc047715d25e8acdb8f09309ad4991`, registry `47ff737c5751748608afc3a1cd4763696f319f45`, preview `d4d96885d0d430bbe1591d3cc11207d92e680339` (all v0.2.0). Check each published `release.json`: bootstrap 0.4.0, range `>=0.4.0 <0.5.0`. Preview is inspected, never run in F73.
- Checkout `3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1); Ubuntu 24.04 runner; Node 24. Record runner image revision. Build job-local MinIO from [docker/edge/minio.Dockerfile](../../../docker/edge/minio.Dockerfile) at the baseline SHA, with `MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z`; resolve base-image digests and MinIO source commit before building, then seal the resulting image ID and dependency inventory. No floating MinIO service tag.
- Local-only preparation by Luna: generate the four managed files with CLI 0.4.4; save pristine output, overlay diff, source tree digest and local MinIO proof under `.local/hosted-fixtures/20261018/`. Use `registry setup --directory DIR --config artifact-pages.yaml --repository artifact-pages/imp73-admin-fixture`, then the same command with `--check`. Keep `--check` on the pristine copy because the test overlay intentionally changes managed files.
- Freeze all fixture commits, image ID and workflow SHA references in `manifest.json` **before pushing or dispatching**. Review it against this plan. Branch names below designate these sealed commits; every reusable `uses: owner/repo/path@...` must use its full commit SHA. Numeric PR/run IDs are assigned by GitHub and recorded after creation, never guessed here. If pins cannot be retrieved or differ, stop; do not substitute latest.
- Evidence: private raw logs in a mode-0700 local evidence directory; publish only sanitized manifest, overlay, run/PR URLs, assertions and snapshot hashes. Never print secrets, token responses or GitHub OIDC JWTs.

## F64 — Both generated package guards (approval A1)

Credit existing generator tests, actual syncs and module tags in IMP-64. Do not release or sync packages again. The ticket records package mains `40b0ed7f` (AWS) and `6fcd1de5` (Cloudflare); local clones are older and cannot establish current hosted mains. After approval, use read-only GitHub queries to resolve each full main SHA, save `release.json`, README and `.github/workflows/close-generated-pull-requests.yml`. Require module 0.1.1, source `f7096315531d2c124f9b2f64ff5f2393ff63ea7b`, generated notice and exact guard semantics from [the generator](../../../scripts/build-terraform-package-repos.mjs). An unexpected main requires review of its diff before proceeding.

For **each** of `artifact-pages/terraform-aws-artifact-pages` and `artifact-pages/terraform-cloudflare-artifact-pages`:

1. Create branch `codex-imp64-guard-20261018` from that repository's captured main, with exactly one new file `guard-proof-20261018.txt` containing `Disposable hosted guard proof; do not merge.\n`. No workflow, module, README, release metadata, default-branch or tag change.
2. Push that branch and open one same-repository PR, base `main`, title `Test: generated repository PR guard (do not merge)`. The branch commit must be authored by the authorized operator using normal git credentials, not a workflow `GITHUB_TOKEN` (which could suppress downstream workflow triggering).
3. Require the `pull_request_target: opened` run of `close-generated-pull-requests.yml` on the captured **base** workflow; its job has `contents: read` and `pull-requests: write`, no checkout of PR code, and uses `github.token`. Require success, exactly one redirect comment linking `https://github.com/artifact-pages/artifact-pages`, and PR state CLOSED with `mergedAt: null`. Save actor, timestamps, workflow SHA, run and comment URLs. The App does not need a permission extension.
4. If not closed after 10 minutes, stop, save permissions/error evidence, and manually close this test PR under A1. Do not enable workflows, change token defaults, branch protection, App installation or repository settings to force success. Request a separate settings decision if needed.
5. Delete only this test branch after recording evidence. Keep closed PR, comment and workflow run as durable evidence (do not delete logs/runs).

Execution template, once `$R`, `$BASE` and the local one-file `$FIXTURE` commit are sealed:

```sh
gh api "repos/$R/commits/main" --jq .sha
git -C "$FIXTURE" push origin HEAD:refs/heads/codex-imp64-guard-20261018
gh pr create --repo "$R" --base main --head codex-imp64-guard-20261018 --title 'Test: generated repository PR guard (do not merge)' --body-file "$E/guard-pr-body.md"
gh run list --repo "$R" --workflow close-generated-pull-requests.yml --event pull_request_target --limit 10 --json databaseId,headSha,status,conclusion,url
gh pr view "$PR" --repo "$R" --json state,mergedAt,comments,url
git -C "$FIXTURE" push origin --delete codex-imp64-guard-20261018
```

Correlate run by event payload PR number and creation window, not `headSha` alone (`pull_request_target` uses the base). Mutations authorized by A1: two branch creates/deletes, two PR creates, two automatic redirect comments/closures, fallback close of those PRs only. Maximum 2 runs / 20 runner-minutes / 45 minutes operator time; estimated incremental spend $0–2, hard cap $2; stop before billed overage.

## F73 — Only uncovered generated-workflow cases

Credit public Stage D run `38114003134` (planned five creates, unchanged MinIO) and the caller branch-denial result. The old registry run `d0818…` has no recorded completed assertion; do not relabel it successful. The historical harness digest and 0.2 pins in IMP-73 remain history. Re-inventory both exact fixture names after A2 approval: existence, visibility, main SHA, open PRs, workflow runs, environments, secret **names**, Actions access and deployment branch policies. Do not query secret values. Existing resources not provably disposable and owner-controlled cause a stop. Creation after a confirmed 404 is covered by A2; no deletion/recreation of an occupied fixture is implicit.

### Exact branch/PR graph and mutations (A2, then A3 separately)

| Repository | Branch / PR | Exact purpose and authorized delta |
| --- | --- | --- |
| `artifact-pages/imp73-admin-fixture` | `codex-imp73-harness-20261018` → `main` preparation PR | Add fixture `artifact-pages.yaml`, four generated files, MinIO-only overlay and seed/assert script; merge this fixture-only PR once reviewed. Disable its automatic run during bootstrap via an explicit fixture-only gate until seed wiring is present; do not weaken generated environment/event/publish conditions. |
| `artifact-pages/imp73-caller-fixture` | `codex-imp73-harness-20261018` → `main` preparation PR | Add `public/overview.html`, `public/notes.md`, one `fixture.yml` workflow_dispatch caller and no cloud credentials. Merge only these fixture files. |
| caller | `fixture-dry-run` from sealed caller main | Manual workflow dispatch with `environment: verification`, then a distinct omitted-input caller job for private stage; publish-on still permits writes only on main. |
| admin | `codex-imp73-registry-20261018` → `main`, title `Test: registry PR dry-run (do not merge)` | Exactly one YAML comment added to `artifact-pages.yaml`; require a completed registry PR run; close without merging. |

Bootstrap preparation PR runs are setup evidence, never acceptance. No generated preview run/comment, real provider target, org App, repository deletion, tag, release, production environment, or operator repo mutation is in F73. Disable unused fixture triggers rather than run preview. A2 permits branch/PR creation, fixture-only preparation merges, Actions runs, closures and branch cleanup listed above; repository creation **only if absent**, public visibility while preparing, and the settings/secrets below. Main replacement/force push and deletion of pre-existing work are excluded.

### Test-only overlay contract

The fixture target is provider `cloudflare`, site `docs`, repository `artifact-pages/imp73-caller-fixture`, source `public`; CLI pin 0.4.4 and web pin 0.3.2. R2 endpoint `http://127.0.0.1:19000` and API base `http://127.0.0.1:18787` must be paired loopback overrides. Use bucket `imp73-fixture`. The dummy API endpoint is a counting refusal server; **zero cache API requests** are expected. No account credential or inherited cloud environment reaches either job.

The called publish job and registry job each start an independent MinIO container before the generated Action, using the sealed image. Seed exactly `_indexes/sites.json` with the registered `docs` mapping. Record a fully paginated, sorted post-seed snapshot of keys, ETags, sizes, HTTP/user metadata and object SHA-256. Add an `always()` post-step comparing the after snapshot and API-call count even when the Action fails. Count mutating S3 requests after seed and require zero PUT/DELETE/COPY and no locks or control state. Bucket setup/seed are the only allowed storage writes and are job-local. Stop the container in `always()`; no host Docker volumes or other projects touched.

Keep generated jobs' `if:`, `environment`, permissions, secrets mapping, config path, `publish-on`, bundled role helper and official Action pins unchanged. Save a machine-checked allowlist diff for only MinIO start/seed/snapshot/stop steps and fixture trigger gating. Preserve Actions' actual release downloads and CLI execution. Do not replace the Action with a mock. MinIO contact and result assertions distinguish missing-credential failure from a real no-write dry-run.

### F73-R: Registry PR completion (A2)

Both repos public. Dummy repository secrets on **admin**: `CF_R2_ACCESS_KEY_ID`, `CF_R2_SECRET_ACCESS_KEY`, `CF_API_TOKEN` (values only usable by the local fixture). Create the comment-only PR above as a human-authorized git push. Run generated registry `pull_request` path; require no production deployment/environment, outcome `planned` or converged dry-run `no-op`, correct unchanged registry projection and unchanged post-seed snapshot. Save job summary showing executed CLI 0.4.4, full Action SHA, effective event/ref and selected config SHA. Fail if a push-to-main live path is accidentally selected. No environment named production is created.

### F73-E: Successful caller environment selection (A2)

Create caller environment `verification` **before dispatch**, restrict deployment branches to exact `fixture-dry-run`, enable one owner required reviewer and explicitly set `prevent_self_review: false`. **Choice:** the owner dispatches using their own `gh` credentials and manually approves the waiting deployment; self-review prevention stays off to avoid a single-reviewer deadlock. This proves the required manual gate, not separation of duties. Its three dummy credential secrets use **different values** from deliberately invalid caller repository secret sentinels. Compare expected credential fingerprints in memory; output only equality booleans and source label, never hashes of secrets. Admin has no usable publish credentials. The called job must resolve the caller environment's values.

Dispatch from `fixture-dry-run` with input `environment: verification`. Require `publish-with-environment` selected, other job skipped, caller repository environment/deployment record, and job WAITING with **no MinIO/CLI start** until the owner approves that deployment. Owner approval is A2's runtime interruption point; it cannot be supplied by the agent. After approval require secret equality, outcome `planned`, nonempty site create plan, CLI 0.4.4 and unchanged snapshot. If a protection feature is unavailable, stop and ask the owner whether to accept a narrower proof; do not silently remove it. Historical branch denial is credited; repeat only if this exact protection configuration changed, with one dispatch from `fixture-denied` expected to be rejected before job execution.

### F73-P: Private/private, omitted environment (A3 after R/E pass)

Explicitly change **both fixture repositories** from public to private; record GitHub's visibility warning and current features first. Set provider Actions access to `organization` only (not `all`), and caller repository Actions permissions to allow this exact reusable workflow/official dependencies if currently blocked (any org-wide policy change is excluded and stops execution). Replace caller repository dummy secret sentinels with usable local-MinIO dummy values. Do not use an environment, `secrets: inherit` workaround, PAT config download, or private environment support claim.

The sealed caller's `private-omitted` job invokes the same pinned provider workflow with `site: docs` and **no `environment` key at all**; assert `publish-without-environment` selected and no deployment/environment association. Require actual private provider checkout/access, repository-secret equality, planned creates and identical snapshot. The named environment is not exercised while private. Cap one acceptance dispatch plus one diagnosis rerun; no access broadening on failure.

Exact dispatch/inspection shapes (F73 workflow inputs are test harness inputs, not new product commands):

```sh
gh pr create --repo artifact-pages/imp73-admin-fixture --base main --head codex-imp73-registry-20261018 --title 'Test: registry PR dry-run (do not merge)' --body-file "$E/registry-pr-body.md"
gh workflow run fixture.yml --repo artifact-pages/imp73-caller-fixture --ref fixture-dry-run -f case=public-environment -f environment=verification
gh run view "$RUN" --repo artifact-pages/imp73-caller-fixture --json jobs,conclusion,url,headSha
gh api --method PUT repos/artifact-pages/imp73-admin-fixture/actions/permissions/access --field access_level=organization
gh workflow run fixture.yml --repo artifact-pages/imp73-caller-fixture --ref fixture-dry-run -f case=private-omitted
```

Use structured API payload files for environment/protection policy and `gh secret set NAME --repo REPO [--env verification] < DUMMY_FILE`; no value on command line. Save the exact pre/post settings JSON excluding secrets in the sealed manifest. Visibility changes use `gh repo edit REPO --visibility private --accept-visibility-change-consequences` only at A3. No command in this document has been executed.

### Cleanup / failure boundaries

At each failed assertion stop before the next stage; preserve logs and snapshots. A failed private-access run does not authorize a settings repair. Under A2/A3 close only created test PRs, delete only created branches, remove created environment/dummy secrets and restore pre-existing fixture settings from the recorded inventory. Revert the fixture-only preparation commits using normal commits if repositories existed. Newly created repos remain **private and inert** with workflows disabled after evidence capture; deletion needs separate owner approval. Never restore a private repo to public merely as cleanup; that would re-expose content. A3 requests persistent private retention of these two repos. Keep workflow/PR evidence, and report residual resources by name.

A2 bound: 90 minutes operator time, <=6 runs, <=60 runner-minutes, estimate $0–3 / hard cap $3. A3: 45 minutes, <=2 runs, <=20 runner-minutes, estimate $0–2 / hard cap $2; private runners may be billable. Record actual usage, stop before any cap, no paid-plan upgrade. Custom-prefix AWS acceptance is P2 in the coordinated provider plan, not another MinIO fixture or duplicated criterion here.
