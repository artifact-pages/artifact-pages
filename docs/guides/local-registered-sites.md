# Local registered-site development

This workflow exercises registry registration and site publishing across two Git checkouts without cloud credentials. The local provider writes the same `/_indexes/`, `/_artifacts/`, and `/_previews/` object keys as the remote adapters. `DeploymentBackend` owns the filesystem mapping and cross-process conditional writes; the registry and site reconciliation code does not branch on local, AWS, or Cloudflare.

Build the command from the Git Artifact Pages product checkout and make it available on `PATH` before using it in the admin and satellite repositories:

~~~sh
cd /path/to/git-artifact-pages
go install ./cli/cmd/artifact-pages
~~~

## Admin checkout

In the admin checkout, configure the local projection root and the registered site in one file:

~~~yaml
# artifact-pages.yaml — provider target and complete desired site set
schemaVersion: 1
provider: local
local:
  root: .local/storage
sites:
  sre:
    name: SRE & Platform
    description: Runbooks and reliability documentation.
    repository: acme/sre-docs
    sourcePath: docs/artifacts
~~~

`registry register` reads the complete desired site set from the selected config's `sites` mapping and cleans content prefixes for sites omitted from it. Registry commands fail if `sites` is absent; `sites: {}` explicitly means an empty registry and registering it removes every current registration. Then, from the Git Artifact Pages product checkout, start nginx against the admin checkout's output and leave it running. Publish from the satellite checkout in a second terminal, and browse through `http://localhost:4173/`. The examples assume `platform-admin` and `git-artifact-pages` are sibling directories:

~~~sh
artifact-pages registry register --config artifact-pages.yaml --dry-run
artifact-pages registry register --config artifact-pages.yaml
cd /path/to/git-artifact-pages
STORAGE_ROOT=../platform-admin/.local/storage npm run serve:local
~~~

The browser is available at `http://localhost:4173/`. The admin checkout owns the unified config. Satellite publishing checks eligibility against the deployed `/_indexes/sites.json`; it does not use or need a copy of the admin `sites` mapping.

## Satellite checkout

In the separate `acme/sre-docs` checkout, use a local target pointing at the admin checkout's generated directory. The example below assumes the two checkout directories are siblings; adjust the relative path for your workspace.

~~~yaml
# artifact-pages.yaml in the satellite checkout
schemaVersion: 1
provider: local
local:
  root: ../platform-admin/.local/storage
~~~

Publish the registered source from the satellite checkout:

~~~sh
artifact-pages site publish --site sre --source docs/artifacts --dry-run
artifact-pages site publish --site sre --source docs/artifacts --format json
~~~

The publisher reads `/_indexes/sites.json` from the selected target and checks both the Git repository identity and exact source path before writing. The source directory defaults to the registry's `sourcePath` when `--source` is omitted. Changed or removed artifact files, `index.json`, and `meta.json` are reconciled by the same operation used for remote providers.

Reopen `http://localhost:4173/sre` or an artifact route to inspect the result. Deep links and relative resources use the normal browser routes. A second registered site remains outside the selected site's publish prefix.

To prove the full two-checkout flow from clean temporary repositories, run this from the product checkout:

~~~sh
npm run build
node scripts/test-registered-flow.mjs
~~~

The runner creates an admin checkout and a separate satellite checkout under ignored `.local/`, shares the admin deployment config with the satellite, and keeps the admin `sites` mapping out of satellite ownership. It checks that admin and site dry-runs leave storage unchanged, publishes two sites, edits a page and removes a stale file before republishing, serves the generated storage through nginx for Playwright deep-link/reload and relative HTML/Markdown resource checks, exercises publisher failure/retry tests, and unregisters one site while asserting the selected site's artifact, index, and preview prefixes are empty and the neighboring site's objects remain byte-for-byte unchanged. The preview assertions use revision-file objects rather than catalogs. Successful runs remove their temporary checkouts; failed runs retain the path they print for inspection.

To verify preview retirement across actual CLI publication, object deletion and a warm browser, run:

~~~sh
npm run test:preview-retirement
~~~

This registered-flow scenario requires Docker Compose, Go, Node dependencies and Playwright Chromium (`npx playwright install chromium` if needed). It starts the existing `gcp-local` fake-gcs-server and nginx profile with a unique Compose project, two allocated loopback ports and isolated storage. It skips fixture seeding: an empty bucket is created through the local API and the real CLI publishes the registry, two production sites and two previews from separate disposable admin/satellite Git repositories with explicit source paths.

The runner deletes only one revision's files and manifest through the JSON API, keeps its catalog reference, verifies an unchanged main-source dry-run has no writes, and runs ordinary production publication to prune only that reference. Object snapshots compare SHA-256 bytes and full API metadata (including generations and timestamps) for production, the neighbor and the live revision. The same browser pages used before deletion reload the list and old document URL; the latter must show `Preview unavailable` without an iframe. Raw document/manifest requests must return real nginx/origin 404s. Deleting the catalog separately must converge to a production no-op without inventing a removal.

Success and failure both remove the scenario's containers/network; SIGINT/SIGTERM also request cleanup. Generated repositories, storage, stage JSON, browser screenshots and trace remain ignored under the printed `.local/preview-retirement-*/` directory for inspection; remove that directory when no longer needed. No cloud credentials or public cloud endpoints are used. This proves the local JSON API/nginx/browser contract, not GCP production support, R2 lifecycle scheduling or global CDN propagation. [T17](../backlog/verification/T17-local-preview-retirement-e2e.md) records the results and related origin-error regressions.

For a manual update in an existing satellite checkout, edit a document, remove an obsolete file, and repeat the same explicit publish:

~~~sh
artifact-pages site publish --site sre --source docs/artifacts --dry-run
artifact-pages site publish --site sre --source docs/artifacts --format json
~~~

The dry-run reports creates, updates, and removals without writing. The publish updates the selected site's projection and leaves other registered site prefixes intact.

Text output separates artifact changes from index changes and labels the result `DRY RUN`, `PUBLISHED`, or `UP TO DATE`. Each group shows at most 12 paths; `--format json` preserves the complete change list. Preview reconciliation counts appear only when there are preview references. Successful publishing reports files as synced, including for local storage. Muted semantic colors are used only on terminal output; redirected output and `NO_COLOR` are plain text. This is a final change report, not a live progress indicator.

Text failures appear on stderr with `FAILED` or `DRY RUN FAILED`, the error reason, and recovery guidance, never successful sync counts. An unregistered-site error lists up to 12 site IDs from the deployed registry, not the local config. Select the correct ID and target, or ask the registry owner to register a new site. A failure after a change plan may have partially completed writes; it is not reported as a successful publish. JSON failure envelopes and exit codes are unchanged.

## Unregister

Remove `sre` from the admin config's `sites` mapping, then run the explicit unregister operation. The selected config must already omit the site:

~~~sh
artifact-pages registry unregister --site sre --config artifact-pages.yaml --dry-run
artifact-pages registry unregister --site sre --config artifact-pages.yaml --format json
~~~

Unregister withdraws the registry entry, deletes only the selected site's artifact, index, and preview prefixes, and revalidates the corresponding routes. If the site mapping has no remaining entries, keep the explicit `sites: {}` field. If a site publish or unregister process exits while holding a retained lock, inspect it with `artifact-pages lock inspect --site sre`; recover only after confirming the owner is stale and supply the exact observed ETag.

## Limits of the local proof

Local mode verifies the shared projection, eligibility checks, command flow, directory-backed conditional writes, and browser routes. It does not prove AWS IAM boundaries, Cloudflare Access, CDN cache behavior, remote service consistency, or provider retention. Those remain linked adapter and verification work.
