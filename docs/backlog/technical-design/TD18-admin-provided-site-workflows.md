# TD18 — Admin-provided site workflows

- Status: Done
- Assignee: Claude
- Phase: Reusable distribution
- Decision: Decided by the owner on 2026-10-10 with live evidence (below). The specification (§19 "Official site onboarding") records the settled path; the implementation slices are IMP-73 to IMP-76.
- Amends: [T10](T10-config-location.md) (official satellite path; addendum)
- Related design: [T10](T10-config-location.md) (config layers and the `github://` locator), [TD12](TD12-action-consumer-contract.md) (Action consumer contract), [TD17](TD17-config-pinned-component-versions.md) (config-pinned versions), [TD5](TD5-verification-environment-and-operator-repositories.md) (operator repositories)

## Design question

How does a site repository start publishing with the least setup, without reading the admin config through a GitHub App or token?

Until now a satellite repository passed the admin config to the Actions as a `github://` locator and, for a private admin repository, a `github-token` from a GitHub App or a personal token. That path needs an App per organization, token plumbing in every site, and a copy of the target settings in the site's workflow. The admin repository already holds everything a site needs: the config, the pinned Action versions and the registry.

## Settled contract

### 1. The admin repository provides two reusable workflows

The admin repository carries `.github/workflows/publish-site.yml` and `.github/workflows/preview-site.yml`, both `on: workflow_call`. A site repository calls them:

~~~yaml
jobs:
  publish:
    permissions:
      contents: read
      id-token: write   # AWS only
    uses: acme/admin/.github/workflows/publish-site.yml@main
    with:
      site: sre
    secrets: inherit
~~~

- `site` is `type: string, required: true`. It is never inferred from the repository name, the same rule as the publish Action.
- The caller job declares `permissions`. The generated workflows omit job `permissions` (inheriting the caller's) or declare only the provider-specific minimum, because a called workflow that requests more than the caller grants fails at startup; it is not silently capped. The caller's minimum is `contents: read`, plus `id-token: write` for AWS, plus `pull-requests: write` for preview.
- A preview call keeps the same-repository `if:` gate in the caller job, as the caller-owned preview workflow does today (TD12).

### 2. A composite action in the admin repository reads the bundled config

The reusable workflows call a composite action in the same repository with GitHub's self-repository syntax, `uses: $/.github/actions/site-sync`. The reference resolves to the same commit as the called workflow, must not carry `@ref`, needs runner version 2.336.0 or later, and is not available on GitHub Enterprise Server ([GitHub changelog, 2026-07-30](https://github.blog/changelog/2026-07-30-reference-same-repository-actions-with-self-repository-syntax/)).

- The action reads the admin's single `artifact-pages.yaml` through `$GITHUB_ACTION_PATH/../../../artifact-pages.yaml` and passes it as `config` to the official `artifact-pages/publish-action` or `preview-action`.
- There is no checkout of the admin repository, no token and no copied config value. The config the site runs is the config at the called commit.
- The official Action version pin lives only in the admin repository.

### 3. Credentials

- **Cloudflare:** the keys come from organization or site-repository secrets, passed with `secrets: inherit` (same organization or enterprise only) and mapped to `env` in the reusable workflow, because composite actions cannot read `secrets`. Secrets stored only on the admin repository are not passed to callers.
- **Environment secrets:** a caller job that uses a reusable workflow cannot set `environment:`, and `secrets: inherit` does not pass environment secrets; only a job-level `environment:` inside the called workflow reads them, resolved against the caller repository's environments. The generated reusable workflows therefore take an optional string input `environment`, and the generated job sets `environment: ${{ inputs.environment }}`. This lets a site keep protected `production` and `preview` environments. How an empty value behaves is verified in IMP-73: if an empty name is not treated as no environment, the job is generated so that the environment is set only when given, or the input is documented as required.
- **AWS:** OIDC, with no stored secret. The admin repository commits `.github/actions/site-sync/aws-roles.json`, the Terraform output `satellite_role_arns` (role ARNs are not secret), and the action selects the role by site ID.

### 4. Ref policy

The official procedure recommends `@main`. Admin pull requests must run dry-runs, because a broken admin `main` stops every site. Tag pinning is allowed but not recommended. The site side takes only the provider target identifiers from the bundled config; publish eligibility still comes from the deployed `/_indexes/sites.json` (T10), so a stale ref does not delay registration changes.

### 5. Pre-registration stays

Admin YAML `sites` plus `registry sync` remains required and unchanged. Self-registration was considered and deferred; revisit it after the M3 cold-start adoption trial.

### 6. Private admin repositories and trust

- For a private admin repository, set Settings, Actions, General, Access to "Accessible from repositories in the organization". This was verified on GitHub Free.
- Outside collaborators of a calling repository can then view workflow logs (GitHub's documented warning). Config values are not secret, so this is acceptable, but the guide must say so.
- Admin code runs with each calling site's token, secrets and OIDC identity. The admin is the operator, so this is the intended trust direction.

### 7. Setup command

`artifact-pages registry setup` (name provisional; the owner may rename it) generates, idempotently, the admin-side files: the two reusable workflows, the `site-sync` composite action, the admin's registry workflow, and for AWS `aws-roles.json` from a provided Terraform output file.

- Generated files carry a header naming the generating CLI version and pin each official Action to an exact release (full SHA with a version comment) following TD17's independent Action series. IMP-73 decides where the generator gets those versions.
- `--check` exits non-zero when the committed files differ from what would be generated, for admin CI.
- It prints the remaining manual steps as copyable `gh` commands (the Actions access level for private admins, secrets) and performs no GitHub API mutation.

The project rule against a general-purpose CLI surface does not block this command: the owner asked for it, and this design records the request. Owner: Codex (CLI), IMP-73.

### 8. Private-config fixture retirement

After `admin` and `docs` migrate to this path, the Action `github-token` private-config topology leaves the official procedure. The `artifact-pages/fixture-private-config` repository, the `artifact-pages-ci-fixture` GitHub App and `.github/workflows/private-config.yml` are retired (IMP-76). The CLI `github://` locator stays for local and admin use.

### 9. Operator repositories follow

`artifact-pages/admin` and `artifact-pages/docs` migrate once the template ships. `docs` is a site repository calling admin's workflows (IMP-75).

## Evidence

Live runs on 2026-10-10 in disposable public, then private, organization repositories (since deleted; runner 2.337.0; organization plan `free`):

- `$/` resolved the provider action at the called workflow's commit SHA.
- The action read a root file of the provider repository through `$GITHUB_ACTION_PATH/../../../`.
- `secrets: inherit` passed the caller's secret; a secret stored only on the provider repository was empty.
- Omitting a required `with` input gave `startup_failure` with no jobs.
- Private-to-private worked with access `organization`; access `none` rejected the dispatch with "workflow was not found".
- OIDC claims: `sub` = `repo:artifact-pages@338198830/claude-verify-reusable-caller@1413183594:ref:refs/heads/main`; `job_workflow_ref` = `artifact-pages/claude-verify-reusable-provider/.github/workflows/publish-site.yml@refs/heads/main`.

### Finding: the OIDC `sub` is ID-qualified

The ID-qualified form comes from the repository OIDC setting `use_immutable_subject: true`. On 2026-10-10 `gh api repos/artifact-pages/admin/actions/oidc/customization/sub` returned `{"use_default":true,"use_immutable_subject":true,"sub_claim_prefix":"repo:artifact-pages@338198830/admin@1402509181"}`, and the organization-level template returned 404. With that setting the `sub` has the form `repo:<owner>@<owner-id>/<repo>@<repo-id>:ref:...`. The AWS module examples and tests use `repo:owner/repo:ref:...`. An exact-match trust subject written in the documented form would not match in a real deployment. IMP-74 aligns the examples, documentation and verification subjects and decides whether the module accepts or documents both forms.

Optional future hardening, not decided here: customize `sub` to include `job_workflow_ref`, so only the admin's official workflow can assume the roles.

## Alternatives considered

- **Organization Variable carrying inline config ("plan A").** Rejected: it duplicates the config the admin repository already commits, and the copy drifts.
- **Reusable workflow alone.** Rejected: a called workflow cannot read files of its own repository without a checkout and a token. The composite action with `$/` is what makes the bundled config readable.
- **Self-registration by site repositories.** Deferred (contract item 5); pre-registration through `sites` stays the only path.

## Consequences

- A site repository needs one short workflow file and a `site` value; no App, token or config copy.
- The admin repository becomes a distribution point: a broken `main` stops every site, so its pull requests must dry-run.
- The self-repository syntax ties the path to github.com runners of version 2.336.0 or later; GitHub Enterprise Server adopters keep the caller-owned workflow examples.
- T10 keeps `github://`, but the official satellite path no longer uses it.

## Follow-up items

- [IMP-73](../implementation/IMP-73-registry-setup-command.md): `registry setup` command and templates (Codex).
- [IMP-74](../implementation/IMP-74-aws-oidc-subject-alignment.md): align OIDC subject examples and verification with the ID-qualified `sub` (Codex).
- [IMP-75](../implementation/IMP-75-migrate-operator-repositories.md): migrate `admin` and `docs` (Codex).
- [IMP-76](../implementation/IMP-76-retire-private-config-fixture.md): retire the private-config fixture, App and workflow (Codex, owner approval for deletions).
