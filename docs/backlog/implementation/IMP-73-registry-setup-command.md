# IMP-73 — `registry setup` command and admin templates

- Status: In progress
- Assignee: Codex
- Lanes: CLI
- Owner: Codex (CLI)
- Depends on: [TD18](../technical-design/TD18-admin-provided-site-workflows.md), [TD17](../technical-design/TD17-config-pinned-component-versions.md)
- Blocks: IMP-75

## Goal

Generate the admin-side files of the official site onboarding path (TD18 contract items 1, 2, 3 and 7), so an operator does not hand-write them.

## Scope

- `artifact-pages registry setup [--check] ...` (name provisional; the owner may rename it). Idempotent generation of `.github/workflows/publish-site.yml`, `.github/workflows/preview-site.yml`, `.github/actions/site-sync/action.yml`, the admin's registry workflow and, for AWS, `.github/actions/site-sync/aws-roles.json` from a provided Terraform output file (`terraform output -json satellite_role_arns`, a map keyed by site ID).
- The reusable workflows take a required string input `site` and an optional string input `environment`. Separate conditional jobs set the caller repository's environment only when non-empty; the alternate job has no environment. They map Cloudflare secrets to `env` and declare only the provider-specific minimum permissions; the preview job keeps the same-repository PR guard and its `pull-requests: write` permission. The composite action reads `${{ github.action_path }}/../../../artifact-pages.yaml` (`$GITHUB_ACTION_PATH` works only in shell steps, not in `with: config:`), selects the AWS role by site ID and calls the official Action with `config` set to that file.
- Each generated file has a header naming the CLI version and pins each official Action to an exact release (full SHA with a version comment) following TD17's independent Action series. This item decides where the generator gets those versions.
- Empty `environment` semantics: generated publish and preview workflows route to a separate job without an `environment:` key when the input is omitted or empty. The other job sets the caller repository's named environment. The generated registry job retains the operator's existing PR dry-run behavior by selecting `production` only outside `pull_request` events.
- `--config` and `--terraform-output` are local regular files under `--directory`; neither may traverse a symlink. Generated destinations are fixed under that root, and existing unmanaged files are never silently overwritten. Cloudflare and AWS action pins are embedded in source so setup is offline.
- `--check` exits non-zero when committed files differ from the generated ones.
- The command prints the remaining manual steps as copyable `gh` commands (Actions access level for private admins, secrets) and performs no GitHub API mutation.
- Specification §19/§22 and the command tree document the shipped source behavior and `registry setup` bootstrap exemption.

## Acceptance criteria

- [x] Generated output is deterministic; a second run changes nothing, and `--check` passes on it and fails after a manual edit.
- [x] The Cloudflare and AWS variants are covered by tests; no secret value is read or printed.
- [x] The command makes no GitHub API call; normal bootstrap bypasses config resolution, download/re-execution and bootstrap metadata for this local-only command.
- [ ] Environment secrets and protection rules of the caller repository apply through the `environment` input, and the empty-value behavior is recorded here.
- [x] `terraform output -json satellite_role_arns` is accepted as a plain string-valued site-to-role map; the generated JSON preserves that shape.
- [ ] A disposable admin/site repository pair runs a dry-run publish through the generated files (public and private admin).

## Pending live acceptance plan (not run)

The source and local tests do not establish GitHub reusable-workflow access, environment behavior, hosted-runner service connectivity, or the no-write provider result. After explicit owner approval, use only these disposable repositories:

- `artifact-pages/imp73-admin-fixture` (provider) and `artifact-pages/imp73-caller-fixture` (caller). Register site `docs` with repository `artifact-pages/imp73-caller-fixture` and source path `public`.
- Build a test-only overlay on the generated `publish-site.yml` and `registry.yml` jobs that adds a local MinIO service and a seed/assertion step. Keep generated conditions, Action pins, config path, permissions, and credential mapping unchanged. The only provider object written is the seed `/_indexes/sites.json`; snapshot the bucket after seeding and require its object keys, ETags, sizes, and metadata to be identical after each CLI dry-run.
- Configure the fixture-only Cloudflare target with paired loopback `r2Endpoint`/`apiBaseURL`, dummy R2 keys and a dummy API token. All endpoints target the job-local MinIO service or its unused API URL; no real Cloudflare or AWS endpoint is configured. The seeded registry must exactly match `docs`, the caller repository, and `public`, so the actual CLI can pass registry/source validation without registering a real site.
- **Public/public environment case:** keep both fixture repositories public. On the caller, create a `verification` environment with dummy-only credential secrets and restrict deployments to the dedicated `fixture-dry-run` branch. Dispatch the generated publish workflow from that branch with `environment: verification`; `publish-on` permits writes only on `main`, so the pinned publish Action must invoke the released CLI as a real dry-run. Confirm the environment secrets resolve, the result is `planned`, and MinIO has no post-seed changes.
- **Private/private omitted-environment case:** make both fixture repositories private and set provider Actions access to “Accessible from repositories in the organization.” Put dummy-only credentials in caller repository secrets, omit the reusable workflow's `environment` input, and repeat from `fixture-dry-run`. Confirm the no-environment job is selected, the private provider workflow is callable, the result is `planned`, and MinIO remains unchanged. Do not claim private environment support on GitHub Free.
- Run the generated registry workflow as a same-repository config PR, with only a comment change to `artifact-pages.yaml`; its PR path has no `production` environment and its `publish-on` keeps the registry Action in dry-run. Verify the registry projection matches the seeded registry and the MinIO snapshot stays unchanged.
- Exercise the generated pins: publish Action `d59b7eceb7431c998bd2338eede1137081a141a2`, registry Action `c5edcfaa4ae9a479cb52b3489daa8925cf5eec29`, and CLI `0.2.0`. The pinned release metadata for both Actions declares bootstrap CLI `0.2.0` and range `>=0.2.0 <0.3.0`. The generated preview workflow/pin is checked locally; do not run it in this no-write proof because its generated `comment: true` and preview publication are intentionally observable side effects.
- Cleanup targets are exactly the two named fixture repositories, their `verification` environment and fake secrets/variables, fixture Actions-access setting, temporary branches/PR, and workflow runs. No fixture is to be created, changed in visibility, configured, or deleted before the owner approves the exact plan.
