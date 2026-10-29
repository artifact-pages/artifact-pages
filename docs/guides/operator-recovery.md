# Operator recovery

This runbook is for the operator of a Cloudflare-first deployment who did not write the tooling. It covers the common failures: a web upgrade that has to be undone, a publish that stopped part-way, drift between Git and storage, a lock left behind, credential rotation, and a lost Terraform state. AWS operators can follow the CLI parts (see the [AWS deployment guide](aws-deployment.md)), but the provider-specific steps (R2 credentials, Terraform and zone rules) are Cloudflare only.

None of the scenarios below has been exercised on the verification environment yet. Each one ends with its exercise status. Treat the steps as reviewed procedure, not as proven procedure, and use `--dry-run` first.

## Principles

- Git is the source of truth. The storage bucket is a projection of it, so the usual repair is to publish again from Git.
- Every writer takes a lock first: one per site, one for the registry, one for the application. Locks are cooperative records in the private `_control/` namespace; they are not a security boundary.
- Writes to locks, journals and state are conditional (compare-and-swap on the ETag). A writer that lost a race fails instead of overwriting.
- Interrupted operations leave a journal (`_control/sites/<site>/site-cache.json` for a site's origin transaction, `_control/registry-cleanup.json` for registry omission, `_control/sites/<site>/preview-cleanup.json` for preview removal). The next run of the same operation replays it and converges.
- The CLI never purges the CDN. Freshness comes from the `Cache-Control` the CLI writes on every object (see the [specification](../specification.md)); a retry never needs a cache token.
- Journals written by a CLI that still purged are migrated by the current CLI under the same lock, and the exact bytes of an old `site-cache.json` are saved under `_control/sites/<site>/legacy/` first. Never delete a journal by hand to get past an error: an unreadable or unsupported journal stops the command on purpose. To go back to such a CLI, follow the rollback in the [cache policy migration guide](cache-policy-migration.md).
- Look before you write. `--dry-run` shows the plan without taking a lock or writing.

The examples use the site `sre` and the config `artifact-pages.yaml`. See [Cloudflare deployment](cloudflare-deployment.md) for credentials and the full command flow.

## 1. Web upgrade and rollback

**Symptoms.** The new web release misbehaves, `app deploy` refuses to run because stored formats are unreadable by the new bundle, or an `app deploy` stopped part-way.

**Steps.**

1. Set `web.version` in the admin config to the release you want: the new one for an upgrade, the previous one for a rollback. The value is an exact `MAJOR.MINOR.PATCH`. There is no `--version` option, and the app-deploy Action has no `version` input; the config chooses the release.
2. Check that the named web release reads every format this CLI writes and every format recorded in storage:

   ```sh
   artifact-pages config check --config artifact-pages.yaml
   ```

3. Plan, then deploy:

   ```sh
   artifact-pages app deploy --config artifact-pages.yaml --dry-run
   artifact-pages app deploy --config artifact-pages.yaml
   ```

   A real deploy needs the R2 credentials (or `CF_API_TOKEN` in single-token mode, for R2 derivation only). Running the app-deploy workflow in the admin repository does the same thing.
4. If `app deploy` fails with a list of sites that the new bundle cannot read, the upgrade is breaking. Use `--accept-breaking` only for a planned breaking upgrade, in this order: `registry sync --accept-breaking`, then `app deploy --accept-breaking`, then republish every site with the new CLI. Until a site is republished, readers show "needs to be republished" for it. `config check` is expected to fail for a breaking upgrade, so that path skips it. See [Upgrading versions](../specification.md#upgrading-versions).

   ```sh
   artifact-pages registry sync --config artifact-pages.yaml --accept-breaking
   artifact-pages app deploy --config artifact-pages.yaml --accept-breaking
   ```

5. If a deploy was interrupted, run `app deploy` again. The next run checks the complete bundle again and repairs missing or stale objects. A purge-only `_control/app-cache/retry.json` left by an older CLI is validated and deleted by the next real run.
6. If the command stops because the application lock is held, see scenario 4 with `--scope application`.
7. Reload the application in a browser and confirm the shell loads. The shell is revalidated on every request, but a tab that is already open keeps what it loaded until it reloads.

**Warm browsers and old tabs.** `app deploy` only uploads application objects (writing `index.html` last). It does not delete anything under `assets/`. Hashed assets from earlier releases therefore stay in the bucket on purpose, so a tab that still runs an old shell can fetch its lazy chunks, and a rollback finds its old assets in place. Hashed assets use the immutable one-year cache policy; `index.html` is revalidated by the browser. Only `app remove` deletes application objects, and nothing garbage-collects old assets.

**What is not touched.** The command writes the application plane and its private lock and version controls only. It neither lists nor deletes site indexes, artifacts or previews, so published site bytes stay as they are.

Exercised: not yet exercised.

## 2. Interrupted publish

**Symptoms.** A `site sync` (or the publish Action) failed or was cancelled part-way. Viewers can see old content, or a mix of old and new.

**Steps.**

1. Fix the underlying cause (for example expired R2 credentials, a provider outage, a cancelled job).
2. Run the same sync again, from the same source, with a plan first:

   ```sh
   artifact-pages site sync --site sre --source docs/artifacts --config artifact-pages.yaml --dry-run
   artifact-pages site sync --site sre --source docs/artifacts --config artifact-pages.yaml
   ```

   The publish Action runs the same operation.
3. Expect convergence even when the run reports zero file differences. The journal at `_control/sites/<site>/site-cache.json` records the keys that may have been written or deleted during the interrupted origin transaction, and the next run replays them before it commits.
4. If a previous run died while holding the site lock, the next run waits for the lock and then times out. Use scenario 4.
5. For an interrupted `registry sync`, run the same `registry sync` again. Its cleanup journal lets the retry resume and finish.
6. Once the sync succeeds, a fresh request sees the new content within the CLI's freshness bound: up to 5 seconds for the site index and metadata, immediately for artifacts. A tab that is already open keeps what it loaded until it reloads.

**What is not touched.** A site sync writes only that site's `_artifacts/<site>/`, `_indexes/<site>/`, its own control objects and, for preview housekeeping, its `_previews/<site>/` catalog and any revisions an interrupted `preview remove` journaled (see scenario 3). Neighbouring sites, the shared registry and the application files are not changed, and private `_control/` objects are never served.

Exercised: not yet exercised.

## 3. Source/projection drift

**Symptoms.** Pages are missing or differ from Git, but `site sync` reports `no-op`. This happens after someone edited, deleted or replaced objects in the bucket by hand, or after a bad generated input was published.

**Steps.**

1. Check the target prefix. A site owns `_artifacts/<site>/` and `_indexes/<site>/`. Look at both before deciding what is wrong.
2. Plan an explicit origin check without writing anything:

   ```sh
   artifact-pages site sync --site sre --source docs/artifacts --config artifact-pages.yaml --reconcile --dry-run
   ```

   `--reconcile` lists the complete `_artifacts/<site>/` and `_indexes/<site>/` prefixes and HEAD-checks the listed objects against the committed SHA metadata and HTTP representation policy. It does not download object bodies. It cannot detect another writer replacing bytes while keeping the stored SHA metadata. Ordinary `site sync` uses the publish-state fast path, does not detect out-of-band edits, and a reported `no-op` is not an integrity audit.
3. Apply the repair:

   ```sh
   artifact-pages site sync --site sre --source docs/artifacts --config artifact-pages.yaml --reconcile
   ```

   It repairs missing objects, stale keys and metadata drift. If any listing or HEAD fails, it stops before stale deletion.
4. If the content itself is wrong, regenerate it from Git. Check out the commit you want published and run the same `site sync` from that checkout. The source directory must be inside the Git working tree. `--ref` only records metadata and does not select the checkout or the content.
5. Rebuild generated output the same way before every publish. Generated files that are untracked or Git-ignored can still be indexed, but their `updatedAt` falls back to the filesystem modification time and `lastCommitter` is omitted, so rebuilding at a different time changes the metadata. Run the same generator at the source commit, then sync.
6. If the command reports malformed or unsupported publish state, it fails closed and never treats the record as missing. The specification's reset procedure is to back up both exact per-site control keys, confirm no publish is in progress, and delete only those keys; see [Per-site sync state and reconciliation](../specification.md#per-site-sync-state-and-reconciliation). The publisher never does this on its own.

**What is not touched.** The reconcile check itself works on one site's `_artifacts/<site>/` and `_indexes/<site>/` prefixes. Other sites, the registry and the application are outside it. A `site sync` run (with or without `--reconcile`) also does two preview-related things for that site. First, a real run resumes a pending preview-cleanup journal left by an interrupted `preview remove`; that can delete the revision objects the journal lists under `_previews/<site>/revisions/`. Second, it plans preview-catalog pruning (stale preview references, for example a revision whose completion manifest is missing) and applies it on a real run, which rewrites `_previews/<site>/catalog.json`. `--dry-run` reports the pruning plan under the preview changes and writes nothing.

Exercised: not yet exercised.

## 4. Stale lock

**Symptoms.** A publish, registry sync or app deploy fails with `timed out waiting for site "..." lock`, or an earlier job was killed. Locks do not expire automatically.

**Steps.**

1. Inspect the lock for the right scope. Use `--site` for a site, or `--scope registry` or `--scope application`. These two forms are exclusive: `--site` cannot be combined with `--scope registry` or `--scope application`.

   ```sh
   artifact-pages lock inspect --site sre --config artifact-pages.yaml
   artifact-pages lock inspect --scope registry --config artifact-pages.yaml
   artifact-pages lock inspect --scope application --config artifact-pages.yaml
   ```

   The result shows the lock's `state` (`free`, `held`, or `uninitialized` when the record does not exist yet), the opaque `owner` and `acquiredAt` of a held lock, and the `etag`. Add `--format json` for machine-readable output.
2. Decide whether the lock is stale or the operation is still running. Several operations can hold each lock, so check all of them, in the admin repository and in every satellite repository that publishes to this deployment, plus any local `artifact-pages` process on an operator's machine:
   - Site lock (`--site`): `site sync` and `preview publish` / `preview remove` for that site (publish and preview workflows in that site's satellite repository). Also `registry sync` when the site's registry entry changes or the site is omitted, and `app deploy` when the web bundle declares the formats it reads or the config pins versions, because that transition locks every registered site.
   - Registry lock (`--scope registry`): `registry sync`, and the same `app deploy` transition.
   - Application lock (`--scope application`): `app deploy` and `app remove`.

   So an app-deploy or registry workflow in the admin repository can hold site locks that look like they belong to a satellite. Compare `acquiredAt` with the start time of the runs you find. If anything is still running, wait for it.
3. Recover with the ETag you inspected:

   ```sh
   artifact-pages lock recover --site sre --observed-etag ETAG --config artifact-pages.yaml
   ```

   For the other scopes use `--scope registry` or `--scope application` instead of `--site`. `--observed-etag` is required.
4. Run the interrupted operation again (scenario 1 or 2). Its journals pick up where it stopped.

**Why the ETag prevents a double operation.** `lock recover` reads the lock again and compares its ETag with the one you passed. If they differ, it fails with a precondition error and changes nothing. Otherwise it replaces the record with a free one using a conditional write (`If-Match` on the same ETag), so a concurrent change between the read and the write also fails. If another job released the lock and a new operation acquired it after your inspection, the ETag changed, recovery fails, and you must inspect again. Recovery also refuses a lock that is not held. The ETag guard does not tell you whether the original process is still alive. That check in step 2 is yours.

**What is not touched.** Recovery only rewrites the lock record to free. It does not touch the journals, the projection or any other lock. `lock inspect` and `lock recover` need the primary R2 credential and not `CF_API_TOKEN`. In single-token mode (no explicit R2 key pair), the CLI derives the R2 credentials from `CF_API_TOKEN` when it opens the backend, so these commands need the token too.

Exercised: not yet exercised.

## 5. Credential and GitHub App key rotation

**Symptoms.** A credential expired, leaked or is due for rotation. This section covers the operator's credentials only, not the product's own release credentials.

**Which credentials, and where they live.**

| Credential | Used for |
| --- | --- |
| `CF_R2_ACCESS_KEY_ID` and `CF_R2_SECRET_ACCESS_KEY` (plus `CF_R2_SESSION_TOKEN` for temporary credentials) | The primary R2 identity of every CLI operation that touches storage |
| The optional registry-reader pair (`CF_R2_REGISTRY_READER_ACCESS_KEY_ID`, `CF_R2_REGISTRY_READER_SECRET_ACCESS_KEY`, and the optional session token) | Reads of `_indexes/sites.json` and `_control/versions/app.json` in a delegated publisher |
| `CF_API_TOKEN` | Single-token mode only: the CLI derives the primary R2 credentials from it. Not used with an explicit R2 key pair. |
| The GitHub App or token passed through `github-token` | Reading a private deployment config from another repository |

They live in the environment or repository secrets of the admin repository and of each satellite repository. The credential boundaries keep them separate: admin registry, application deployment and each site's publisher have their own identity, so rotate each one where it is used. See [Optional GitHub Actions](github-actions.md#credential-boundaries) and [Cloudflare deployment](cloudflare-deployment.md#2-configure-the-cli). R2 temporary credentials are minted and renewed outside this CLI.

**Steps.**

1. Create the new credential first: a new R2 key pair with the same scope, a new `CF_API_TOKEN` with the same R2 permission (single-token mode), or a new key or token for the GitHub App. Keep the old one active.
2. Update the secrets in every environment or repository that uses it. Do not put credential values in the deployment YAML or the repository.
3. Run the smallest operation that verifies the new value:
   - Primary R2 key pair or session token: a dry-run uses the R2 read credentials. Run `registry sync --dry-run` from the admin repository, or `site sync --dry-run` from the affected satellite:

     ```sh
     artifact-pages registry sync --config artifact-pages.yaml --dry-run
     artifact-pages site sync --site sre --source docs/artifacts --config artifact-pages.yaml --dry-run
     ```

   - Registry-reader pair: `registry sync` uses the primary credential only and does not exercise the reader pair. Verify the pair with `site sync --dry-run` (or `preview publish`) in a satellite whose config names the reader environment variables; only those commands read through the reader credential.

     A dry-run writes nothing.
   - GitHub App or `github-token`: any command that resolves a `github://` config locator reads the config with the token, so the same dry-run through that locator verifies it. A wrong or missing token shows as an HTTP 401, 403 or 404 error that names the locator.
   - `CF_API_TOKEN` (single-token mode): every command that touches the provider derives the R2 credentials from it, so a dry-run such as `registry sync --dry-run` verifies that the new token is active and can derive and read with them. A real operation then confirms write access. With an explicit R2 key pair the token is not used; a leftover `CF_API_TOKEN` secret that only served cache purge for an older CLI can be retired as described in the [cache policy migration guide](cache-policy-migration.md).
4. Revoke the old credential only after the verifying operation succeeded.
5. If a leaked credential cannot wait, revoke first and accept that operations fail until the new secret is in place. Journals make the interrupted operations converge afterwards.

**What is not touched.** Rotation changes secrets only. Stored content, locks and journals stay as they are.

Exercised: not yet exercised.

## 6. Terraform state restore and zone rules

**Symptoms.** The Terraform state is missing, or a plan wants to recreate resources that already exist, or an apply would overwrite zone rules that other people rely on.

**Steps.**

1. Stop. Never apply against an empty state: Terraform would try to create resources that already exist.
2. Look for a copy of the state. Local state can be lost together with an ignored directory such as `.local/` when a clone is deleted, and `git status` does not show ignored files. Prefer a remote backend with locking, and keep periodic copies of the state outside the account.
3. With no copy, rebuild the state by `terraform import`, one resource at a time, and recreate the variables. The import addresses, the provider IDs and the `existing_*_rules` inputs are in the module README: [Resource ownership and apply review](../../terraform/modules/cloudflare/README.md#resource-ownership-and-apply-review) and the [delivery module](../../terraform/modules/cloudflare/modules/delivery/README.md). In short:
   - Import each existing zone phase root (transform, cache, response headers, configuration settings, and the optional WAF root) into its resource, set the matching `*_ruleset_name` input to the current name (names are immutable), and pass every existing rule through the matching `existing_*_rules` input.
   - Import the R2 bucket with the `<account_id>/<bucket_name>/<jurisdiction>` ID.
   - The R2 custom domain cannot be imported. Set `connect_custom_domain = false` when the connection already exists, and verify its enabled and TLS settings separately.
   - The R2 bucket lifecycle cannot be imported either. Its plan shows as one create, and the apply would rewrite the live lifecycle configuration. Pass every other rule through `additional_lifecycle_rules` and compare the planned rule with the live one before applying.
   - The `r2.dev` managed domain cannot be imported. Confirm separately that it is disabled.
4. Accept only a plan with no changes, or whose only differences you can explain (the unimportable resources above), before any apply. Review the plan for replacements and removals.
5. Re-run the checks in [Cloudflare deployment](cloudflare-deployment.md#4-verify-the-deployed-boundary).

**What is not touched.** Terraform manages infrastructure, not content. The state restore does not change bucket objects, and the CLI credentials are separate from the Terraform token.

Exercised: not yet exercised.

## 7. Detection

**Symptoms.** Something is broken and nobody noticed. Artifact Pages has no built-in health check or alerting, so detection is the operator's job.

**Steps.**

1. Turn on GitHub notifications for failed runs of your publish, registry and app-deploy workflows, in the admin repository and in every satellite repository.
2. Add an external check that these URLs return 200:
   - `https://<host>/index.html`
   - `https://<host>/_indexes/sites.json`
3. When a check fails, start with the matching scenario above, and look at the failed workflow run's job summary first.

**What is not touched.** Checks only read public URLs. The private `_control/` objects are not served.

Exercised: not yet exercised.

### Missing preview catalog

This is a monitoring note, not a recovery scenario. Site pages request `/_previews/<site>/catalog.json` for the Previews count. For a site without previews the catalog may be absent and the request returns 404: browsers report a failed resource in the console, and 4xx monitoring counts the response, while the reader shows an empty list and count 0.

A 404 alone does not prove that the site never had previews. If the site is expected to have previews:

1. Check the preview publishing workflow and its latest result.
2. Check whether retention could have expired the catalog.
3. Compare the response at the storage origin with the response through the delivery hostname; a missing origin object and a delivery-side failure need different investigation.

Keep alerting on unexpected missing catalogs for sites that publish previews and on other preview errors, including non-404 failures; do not suppress all preview errors.
