# IMP-73 — `registry setup` command and admin templates

- Status: Open
- Lanes: CLI
- Owner: Codex (CLI)
- Depends on: [TD18](../technical-design/TD18-admin-provided-site-workflows.md), [TD17](../technical-design/TD17-config-pinned-component-versions.md)
- Blocks: IMP-75

## Goal

Generate the admin-side files of the official site onboarding path (TD18 decisions 1, 2, 3 and 7), so an operator does not hand-write them.

## Scope

- `artifact-pages registry setup [--check] ...` (name provisional; the owner may rename it). Idempotent generation of `.github/workflows/publish-site.yml`, `.github/workflows/preview-site.yml`, `.github/actions/site-sync/action.yml`, the admin's registry workflow and, for AWS, `.github/actions/site-sync/aws-roles.json` from a provided Terraform output file (`terraform output -json satellite_role_arns`, a map keyed by site ID).
- The reusable workflows take a required string input `site`, map the Cloudflare secrets to `env` and declare no permission wider than the caller's. The composite action reads `$GITHUB_ACTION_PATH/../../../artifact-pages.yaml`, selects the AWS role by site ID and calls the official Action with `config` set to that file.
- Each generated file has a header naming the CLI version and pins the official Actions to the versions recorded for that CLI release (TD17).
- `--check` exits non-zero when committed files differ from the generated ones.
- The command prints the remaining manual steps as copyable `gh` commands (Actions access level for private admins, secrets) and performs no GitHub API mutation.
- Specification §22 and the command tree are updated when the command ships (the planned note in §19 is replaced).

## Acceptance criteria

- [ ] Generated output is deterministic; a second run changes nothing, and `--check` passes on it and fails after a manual edit.
- [ ] The Cloudflare and AWS variants are covered by tests; no secret value is read or printed.
- [ ] The command makes no GitHub API call.
- [ ] A disposable admin/site repository pair runs a dry-run publish through the generated files (public and private admin).
