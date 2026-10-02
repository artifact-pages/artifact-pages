# Optional GitHub Actions

Artifact Pages provides two optional composite Action entry points:

- `actions/admin` wraps `artifact-pages registry register`, `registry unregister`, and `app deploy`.
- `actions/site-publish` wraps `artifact-pages site publish` for one required, explicit site ID.

They build the CLI from the same pinned Action source and invoke the command with `--format json`. They do not implement site publication, registry reconciliation, preview cleanup, or event timing. No repository has a required reusable workflow; adopters choose their own triggers and approval rules. Neither Action infers a site from the repository, discovers PRs, or adds a separate preview cleanup workflow.

## Inputs and typed outputs

The admin Action accepts `operation: registry-register | registry-unregister | app-deploy`. All three operations accept `dry-run`; `registry-unregister` requires `site`, and `app-deploy` deploys the web bundle that matches the pinned Action's CLI version, or a local `archive` when given (there is no `version` input; the pinned Action ref selects the CLI and therefore the web bundle; `repository` overrides the release source). The site Action requires `site` and accepts `source`, `config`, and `dry-run`.

Both Actions expose the original CLI result through `result_json` and preserve its process status through `exit_code`. They also expose the common result fields: `operation`, `outcome`, `site`, `changes_json`, `preview_changes_json`, and `error`; registry operations expose `registry_updated`. GitHub Action outputs are strings, so JSON arrays and objects are compact JSON text, `registry_updated` is `true`/`false`, and `exit_code` is an integer string. The invoke step writes outputs before returning a non-zero CLI exit code.

For config in another private repository, the default token is this workflow's `GITHUB_TOKEN`. Give that workflow `contents: read` and ensure its token can read the admin repository; if repository-scoped `GITHUB_TOKEN` access is insufficient, pass a GitHub App installation token or fine-grained token with read-only contents access to that one repository through `github-token`. The config locator's `ref` should be a full commit SHA so one run uses a stable target config.

## Credential boundaries

The examples use AWS OIDC with separate role ARNs. Grant only the workflow permissions `contents: read` and, when assuming an AWS role, `id-token: write`. Restrict each AWS role trust policy to the intended repository, branch or protected environment, and audience. Storage permissions belong to those provider roles, not the GitHub token.

- The satellite publisher role reads the deployed site registry and selected site's current projection, then reads/writes/deletes only that site's artifact and index prefixes, its preview catalog, and its site lock. Do not share this role with another site's repository.
- The admin registry role reconciles the complete desired registration set from the selected config and the registry lock. `registry register` also cleans content prefixes for sites omitted from that config's `sites` mapping, so grant cleanup scope only to a protected admin workflow and require review/approval for registration changes.
- The application deployment role is separate and scoped to `/index.html`, `/assets/*`, and the required application cache revalidation. It does not need access to site indexes, artifacts, preview objects, or registry state.

The config and storage provider remain independent. Registry Actions use the selected deployment config's complete top-level `sites` mapping; registry operations fail when that field is absent. An explicit `sites: {}` means an empty desired set and registering it removes all current registrations. Target-only configs may omit `sites` for other operations, and satellite publishing remains eligible according to the deployed registry. For Cloudflare, pass only the target's named credential environment variables to the selected job and use separate admin, app, and per-site credentials with the same prefix boundaries. Do not put credential values in the deployment YAML.

## Workflow templates

The files under [`examples/github-actions`](../../examples/github-actions) are templates. They pin the third-party checkout, Go setup, and AWS credential Actions by full commit SHA. The Artifact Pages Action itself has not been published as a release in this checkout; replace `<FULL_REVIEWED_ACTION_COMMIT_SHA>` with the full 40-character commit SHA of the reviewed release that contains the action files before adopting a template. The satellite template also uses a full commit SHA for the admin config locator.

The templates show registering the desired site set, application deploy of the web bundle pinned by the Action ref, and satellite publish for the explicit `sre` site. The admin Action's `registry-register` operation value maps to the `registry register` CLI command. For pull-request planning, use the same operation with `dry-run: true` and a read-only provider role. Decide which PRs may receive read-only cloud credentials in the adopting repository's trust policy. A merge or another selected event can run the write operation; the Action does not choose one.

The component uses `actions/setup-go` pinned to commit `b7ad1dad31e06c5925ef5d2fc7ad053ef454303e` (v7.0.0) and reads the Go version from this repository's `go.mod`. The consuming workflow's checkout should also disable persisted credentials unless later steps need Git authentication.

## Check CLI parity locally

Run:

```sh
node scripts/test-actions-parity.mjs
```

The smoke test builds the CLI, creates separate temporary admin and satellite Git repositories with independent local targets for direct CLI and Action invocations, then compares the exact JSON results, typed outputs, stdout, and exit codes. It covers registering the complete config `sites` set and unregistering a site in dry-run and apply modes; explicit-site publish in dry-run and apply modes; app deploy in dry-run and apply modes; missing-`sites` and unregistered-site failures; and a stale preview reference whose missing completion manifest is planned without writes and then pruned on apply. It also checks the composite input/output wiring, workflow example names, scoped GitHub permissions, explicit site selection, separate registry/app/satellite role variables, and full-SHA pins for third-party Actions. The smoke test exercises the shared Action invocation script used by the composites, not GitHub's hosted composite runner. It does not need provider credentials and does not assume OIDC roles or prove live AWS/Cloudflare behavior.
