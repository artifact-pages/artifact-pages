# IMP-55 — Migrate consumer workflows to the slimmed Actions

- Status: Open
- Lanes: Docs / Adoption
- Execution: Owner-approved consumer repository edits after the release. This item records the plan only; nothing here has been executed.
- Depends on: [IMP-50](IMP-50-preview-defaults.md) through [IMP-54](IMP-54-action-checkout.md) shipped in one release, and [TD12](../technical-design/TD12-action-consumer-contract.md)
- Related design: [TD12](../technical-design/TD12-action-consumer-contract.md)

## Why after the release, and why together

That release renames Action outputs to hyphen-case (`changes_json` becomes `changes`). `artifact-pages-admin`'s Summarize steps read `steps.<id>.outputs.changes_json` and would silently print nothing. Because the same release has the built-in summary, the consumers delete those steps instead of porting them. Do not bump the pin in `artifact-pages-admin` before the Summarize steps are removed in the same change.

## Cleanup per consumer

- Remove every Summarize step (`artifact-pages-docs` publish, `artifact-pages-admin` registry and app-deploy).
- Remove the `actions/checkout` steps (the Action's `checkout: auto` covers them, with `fetch-depth: 0` and `persist-credentials: false`). Keep one only when the job needs the checkout before the Action for another reason.
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
          fetch-depth: 0
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

- [ ] The release containing IMP-50 through IMP-54 is published, and its notes mention the hyphen-case output rename and the built-in summary.
- [ ] The owner approves editing `artifact-pages-docs` and `artifact-pages-admin`.
- [ ] Both repositories use the release tag, have no Summarize or redundant checkout steps, and their PR dry-runs and main publishes show the built-in summary in a hosted run.
- [ ] `examples/github-actions/*.yml` and the GitHub Actions guide use the slimmed form once the release exists (with IMP-46 slice 4).
