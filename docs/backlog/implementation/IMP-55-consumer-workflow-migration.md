# IMP-55 — Migrate consumer workflows to the slimmed Actions

- Status: Done
- Lanes: Docs / Adoption
- Execution: Owner-approved consumer repository edits after the release. Executed on 2026-10-05; see Results.
- Depends on: [IMP-50](IMP-50-preview-defaults.md) through [IMP-54](IMP-54-action-checkout.md) shipped in one release, and [TD12](../technical-design/TD12-action-consumer-contract.md)
- Related design: [TD12](../technical-design/TD12-action-consumer-contract.md)

## Why after the release, and why together

That release renames Action outputs to hyphen-case (`changes_json` becomes `changes`). `artifact-pages-admin`'s Summarize steps read `steps.<id>.outputs.changes_json` and would silently print nothing. Because the same release has the built-in summary, the consumers delete those steps instead of porting them. Do not bump the pin in `artifact-pages-admin` before the Summarize steps are removed in the same change.

## Cleanup per consumer

- Remove every Summarize step (`artifact-pages-docs` publish, `artifact-pages-admin` registry and app-deploy).
- Remove the `actions/checkout` steps (the Action's `checkout: auto` covers them, with `fetch-depth: 1` since IMP-58, and `persist-credentials: false`). Keep one only when the job needs the checkout before the Action for another reason.
- Remove the redundant `source: sites/${{ matrix.site }}` in `artifact-pages-docs` publish when it equals the registered source path.
- Remove the redundant `config: artifact-pages.yaml` in `artifact-pages-admin` (`artifact-pages.yaml` in the working directory is the implicit default).
- Unify every Action pin to the release tag (`artifact-pages-docs` pins a `main` commit, `artifact-pages-admin` pins `@v0.1.2`).
- Replace `dry-run: ${{ github.event_name == 'pull_request' }}` with `publish-on`.
- Drop the preview `base-url` where the config carries `publicBaseURL` or `cloudflare.publicBaseURL`, and drop `pull-request: ${{ github.event.pull_request.number }}`.

## Sketches

`artifact-pages-docs` `publish.yml`, before:

~~~yaml
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0  # IMP-58: removable; the Action defaults to a shallow checkout
          persist-credentials: false
      - name: Publish ${{ matrix.site }}
        id: publish
        uses: tasuku43/git-artifact-pages@af75645985fa35797942005ed177ecb583249103 # main
        with:
          site: ${{ matrix.site }}
          source: sites/${{ matrix.site }}
          config: github://tasuku43/artifact-pages-admin/artifact-pages.yaml
          dry-run: ${{ github.event_name == 'pull_request' }}
        env: { ... }
      - name: Summarize
        env:
          SITE: ${{ matrix.site }}
          OUTCOME: ${{ steps.publish.outputs.outcome }}
          CHANGES: ${{ steps.publish.outputs.changes }}
        run: |
          echo "### $SITE: $OUTCOME ($(jq length <<<"$CHANGES") changes)" >> "$GITHUB_STEP_SUMMARY"
~~~

After:

~~~yaml
    steps:
      - name: Publish ${{ matrix.site }}
        uses: tasuku43/git-artifact-pages@<release tag>
        with:
          site: ${{ matrix.site }}
          config: github://tasuku43/artifact-pages-admin/artifact-pages.yaml
          publish-on: |
            push:refs/heads/main
            workflow_dispatch
        env: { ... }
~~~

`artifact-pages-admin` `registry.yml`, before and after (`app-deploy.yml` is analogous, with `operation: app-deploy` and its `dry-run: ${{ inputs.dry-run }}` kept, because that is an explicit operator choice):

~~~yaml
# before
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Register the complete site set
        id: register
        uses: tasuku43/git-artifact-pages/actions/admin@v0.1.2
        with:
          operation: registry-register
          config: artifact-pages.yaml
          dry-run: ${{ github.event_name == 'pull_request' }}
      - name: Summarize
        run: ...   # reads outputs.changes_json

# after
      - name: Register the complete site set
        uses: tasuku43/git-artifact-pages/actions/admin@<release tag>
        with:
          operation: registry-register
          publish-on: |
            push:refs/heads/main
            workflow_dispatch
~~~

Satellite preview workflows, before and after:

~~~yaml
# before
        with:
          site: sre
          source: docs/artifacts
          pull-request: ${{ github.event.pull_request.number }}
          base-url: ${{ vars.ARTIFACT_PAGES_BASE_URL }}
          config: github://example/platform-admin/artifact-pages.yaml?ref=<SHA>
          comment: true
# after
        with:
          site: sre
          config: github://example/platform-admin/artifact-pages.yaml?ref=<SHA>
          comment: true
~~~

Keep the preview job gated with `if: github.event.pull_request.head.repo.full_name == github.repository` and the credential step before the Action. Keep `workflow_dispatch` in `publish-on` where manual runs should publish.

## Acceptance criteria

- [x] The release containing IMP-50 through IMP-54 is published, and its notes mention the hyphen-case output rename and the built-in summary. `v0.2.0` ([release run](https://github.com/tasuku43/git-artifact-pages/actions/runs/37291796170)); its notes received an "Upgrading from v0.1.2" section covering the output rename, the built-in summary and the Summarize-step removal.
- [x] The owner approves editing `artifact-pages-docs` and `artifact-pages-admin`.
- [x] Both repositories use the release tag, have no Summarize or redundant checkout steps, and their PR dry-runs and main publishes ran in hosted runs (see Results). The built-in summary was not separately inspected in this recording.
- [ ] `examples/github-actions/*.yml` and the GitHub Actions guide use the slimmed form once the release exists (with IMP-46 slice 4).

## Results

Recorded 2026-10-05.

- `artifact-pages-admin` [PR #3](https://github.com/tasuku43/artifact-pages-admin/pull/3) and `artifact-pages-docs` [PR #9](https://github.com/tasuku43/artifact-pages-docs/pull/9) are merged and pin `v0.2.0`.
- Workflow sizes on `main` (lines): `registry.yml` 49 to 35, `app-deploy.yml` 44 to 32, docs `publish.yml` 56 to 58 (it gained the App-token step and a `publish-on` list while losing checkout and Summarize steps), docs `preview.yml` 73.
- Credentials: `artifact-pages-docs` reads the private admin config with a GitHub App token (App `artifact-pages-private`, id 5197457, installed only on `artifact-pages-admin` and `artifact-pages-docs`, Contents read, Pull requests write, Metadata read). Tokens are minted per job with `actions/create-github-app-token` v3.2.0, scoped to the repositories that job needs. This replaces the fine-grained personal access token planned in [T23](../verification/T23-private-repository-topology.md).
- Production: Registry run ([37313258386](https://github.com/tasuku43/artifact-pages-admin/actions/runs/37313258386)) was a no-op. App deploy dry-run ([37313326368](https://github.com/tasuku43/artifact-pages-admin/actions/runs/37313326368)) planned 81 create, 20 update and 0 delete; the real deploy ([37313488062](https://github.com/tasuku43/artifact-pages-admin/actions/runs/37313488062)) succeeded. Docs publish after the merge ([push run 37313818261](https://github.com/tasuku43/artifact-pages-docs/actions/runs/37313818261), guide and architecture) was a no-op, and a second publish ([37314143880](https://github.com/tasuku43/artifact-pages-docs/actions/runs/37314143880)) was also a no-op. `https://artifact-pages.dev/`, `/guide` and `/_indexes/sites.json` return 200.
- Not done here: the open pull-request previews were not re-run (none were open besides the T23 verification pull request); the browser check of library, preview and search from the release checklist is not recorded in this item.
