# Cloudflare deployment

This guide connects an existing private R2 bucket to a Cloudflare custom domain, applies preview retention, and publishes the Artifact Pages application and registered content to it. It follows the selected provider mapping in [T12](../backlog/technical-design/T12-cloudflare-production-mapping.md); it does not claim a live Cloudflare deployment has been verified.

## 1. Prepare Cloudflare

Create one private R2 bucket for the application and the changing projection. The bucket holds `index.html`, `preview-bridge.js`, `assets/*`, `/_indexes/*`, `/_artifacts/*`, `/_previews/*`, and private `/_control/*` coordination objects.

Use [the Cloudflare delivery Terraform reference](../../terraform/modules/cloudflare/delivery/README.md) to attach `artifacts.example.com` (replace it with your hostname), disable the alternate `r2.dev` endpoint, and configure the route, control-boundary, and origin-cache rules. The Cloudflare provider cannot import an existing R2 custom domain, so set `connect_custom_domain = false` when the hostname is already connected and verify its enabled/TLS settings separately. Terraform also cannot import or destroy the managed-domain setting; keep it in one Terraform state and update its `enabled` value explicitly if the policy changes. Configure a Cloudflare Access application separately if the whole hostname should require authentication. Access is a host-level viewer boundary; the publisher does not implement per-site authorization.

The in-repository [Cloudflare caller example](../../examples/cloudflare/terraform) composes the delivery and [Cloudflare R2 retention module](../../terraform/modules/cloudflare/retention/README.md) against the same existing bucket. The local deployment root under `terraform/deployments/cloudflare` instead calls the independently versioned sibling Terraform module repository. Set `preview_retention_days` in the caller's `terraform.tfvars`; preview retention belongs to provider infrastructure and is not a CLI YAML setting. The retention resource owns the complete bucket lifecycle rule set. Inspect existing rules and merge every rule that must remain before applying it; lifecycle deletion is asynchronous and is not an immediate revocation mechanism.

The delivery module owns the complete zone root rulesets for the transform, custom firewall, cache, response-header, and configuration-settings phases. The configuration-settings rule turns off the edge features that rewrite HTML (email obfuscation, Rocket Loader, Automatic HTTPS Rewrites, Fonts, analytics injection, Polish) for the Artifact Pages hostname only, so artifacts and previews are delivered byte-for-byte; a zone that already has Configuration Rules must import that root and pass its rules through `existing_config_rules`. Review existing rules and import/merge them before applying; see its README for the exact resource addresses and preservation inputs. A Terraform apply uses `CLOUDFLARE_API_TOKEN` through the environment or a secret manager, with only the R2 custom/managed domain, R2 lifecycle, and zone Rulesets permissions needed by these modules, which include Transform Rules Edit, Cache Rules Edit, Zone WAF Edit, and Config Rules Edit. This infrastructure credential is separate from runtime CLI credentials. A normal CLI publisher starts with only the primary R2 access key and secret; `CF_API_TOKEN` is an optional runtime zone-scoped credential with cache purge permission for app or registry operations that actually invalidate public URLs. None of these credential values belong in Terraform variables, YAML, or the repository.

## 2. Configure the CLI

Copy the [minimal config template](../../examples/cloudflare/artifact-pages.cloudflare.yaml.example) or the [full deployment example](../../examples/cloudflare/deployment.yaml.example) to `artifact-pages.yaml` and replace the placeholder account, zone, and public URL values. The Cloudflare bucket defaults to `artifact-pages`; set `bucket` only when using another R2 bucket. You can instead keep the ignored local file `artifact-pages.cloudflare.yaml` and pass it with `--config artifact-pages.cloudflare.yaml`; `artifact-pages.yaml` remains the implicit local default. Add the admin's `sites` mapping before running `registry register` or `registry unregister`; an omitted `sites` field is an input error, not an empty registry. The same YAML file contains the provider target and the registry mapping rather than using a second manifest file. The deployment config contains environment-variable names only, never credential values.

For the normal setup, provide only the two primary R2 secrets:

```sh
export CF_R2_ACCESS_KEY_ID=...
export CF_R2_SECRET_ACCESS_KEY=...
```

The CLI defaults to those names, so the deployment YAML and Terraform output omit them. The default cache token name is `CF_API_TOKEN`, also omitted from generated YAML. Its value is needed only for a real operation that requests cache invalidation; dry-runs and no-op deployments do not need it. If using temporary primary R2 credentials, set `CF_R2_SESSION_TOKEN` and add `sessionTokenEnv` to the config.

| CLI operation | Primary R2 credential | Registry-reader credential | `CF_API_TOKEN` |
| --- | --- | --- | --- |
| `index build`, `config set-default` | Not needed | Not needed | Not needed |
| `site publish` | Required | Optional; used only when reader env names are configured | Required when a real publish changes content or retries pending invalidation (cache purge) |
| `preview publish` | Required | Optional; used only when reader env names are configured | Not needed |
| `app deploy` | Required | Not used | Required only when a real deploy requests invalidation |
| `registry register`, `registry unregister` | Required | Not used | Required only when a real operation requests invalidation |
| `lock inspect`, `lock recover` | Required | Not used | Not needed |

If registry-reader env names are present, `site publish` and `preview publish` require the corresponding access key and secret values before making provider requests, and use that identity only for `GetObject("_indexes/sites.json")`. Without those names, these commands read the registry with the primary credential. Other commands ignore configured reader env values. Registry, app, and site-publish mutations check that the API token is configured before changing projection objects.

### Optional delegated publisher

Use this when a satellite publisher should not be able to read or write the whole registry. Add the following fields to that publisher's deployment config only; do not add them to the ordinary admin config:

```yaml
cloudflare:
  registryReaderAccessKeyIdEnv: CF_R2_REGISTRY_READER_ACCESS_KEY_ID
  registryReaderSecretAccessKeyEnv: CF_R2_REGISTRY_READER_SECRET_ACCESS_KEY
  registryReaderSessionTokenEnv: CF_R2_REGISTRY_READER_SESSION_TOKEN # only for temporary reader credentials
```

R2 temporary credentials support one bucket-level operation scope (`object-read-only` or `object-read-write`) plus exact object and prefix restrictions. Give the delegated publisher a read-only credential scoped to the exact `_indexes/sites.json` object and a read/write credential scoped to `_indexes/<site>/`, `_artifacts/<site>/`, `_previews/<site>/`, and the exact `_control/locks/sites/<site>.json`, `_control/site-cache/<site>.json`, and `_control/publish-state/<site>.json.gz` objects. The writer must be able to list and read its site prefixes, HEAD/GET/PUT its site objects, and delete stale artifacts and generated index/search objects under those prefixes; the exact cache retry and publish-state objects also need read/write/delete support for retries and unregister cleanup. The `object-read-write` scope supports read, write, and list; when minting locally with explicit action scopes, allow `ListObjectsV2`, `HeadObject`, `GetObject`, `PutObject`, `DeleteObject`, and `DeleteObjects`. Do not widen this to another site's paths, `/_indexes/sites.json`, or the application plane. The CLI uses the reader only for the registry read and the primary credential for site writes. Do not put the parent R2 secret or the API token used to mint temporary credentials in the satellite repository or workflow. Set the primary credential's session token through `CF_R2_SESSION_TOKEN`; set the reader credential's session token through `CF_R2_REGISTRY_READER_SESSION_TOKEN`. The CLI does not mint or refresh either credential.

### Publish-state fast path and explicit repair

Each registered site has a private publisher record at `/_control/publish-state/<site>.json.gz`. It stores a deterministic gzip snapshot of the last successful input root and each committed site's object hash, size, and HTTP representation metadata. A sorted pending-key journal is written before origin mutations and retained after a partial failure so a later invocation can replay the touched keys and converge. The compressed state is `application/octet-stream`, has no `Content-Encoding`, uses `Cache-Control: no-store`, and carries schema, site, input-root, pending, and compressed-body SHA-256 metadata. The compressed state is limited to 16 MiB and its decoded JSON to 64 MiB. State is private control data: the delivery boundary must never serve its bytes to viewers. See the [publisher state contract](../specification.md#per-site-publish-state-and-reconciliation) for the exact JSON schema and metadata names.

After the registry and lock checks, a normal publish may compare the current prepared-input root with validated state HEAD metadata. When the root matches, no pending journal exists, and the prepared input is reusable, the publisher trusts its previous successful commit: it skips Build and the per-object origin checks and does not GET the state body. JSON reports `buildSkipped: true`; the whole operation reports `no-op` when preview cleanup, cache retry, and other publication duties also have no work. This fast path does not detect manual deletion, replacement, or HTTP metadata edits made directly in R2.

Use `--reconcile` for an explicit origin check or repair. It completely lists the selected site's `_artifacts/<site>/` and `_indexes/<site>/` prefixes and HEAD-checks the listed objects against the committed SHA metadata and HTTP representation policy. It repairs missing objects, stale keys, and metadata drift. It does not download object bodies, so it cannot verify body integrity if another writer replaced bytes but retained the stored SHA metadata. Both prefix listings must complete before stale deletion. If state is absent, the publisher migrates by completely listing both prefixes and HEAD-checking existing objects; a list/HEAD failure aborts before writes. Malformed state or a newer unsupported state schema is an error, never a reason to treat the record as missing.

The input root includes full-text mode and the output-affecting builder, index, HTTP, and cache policies. Turning full-text on or off therefore changes the root. Policy versions must advance when those semantics change; the state schema version changes only for a breaking record-format change. A tracked dependency deletion can make an affected document's `updatedAt` depend on the current build time; such a prepared snapshot is deliberately non-reusable, so that case rebuilds on later invocations.

To inspect the plan without writing, use `--reconcile --dry-run`. For example:

```sh
artifact-pages site publish --site sre --source docs/artifacts --config artifact-pages.yaml --reconcile --dry-run
artifact-pages site publish --site sre --source docs/artifacts --config artifact-pages.yaml --reconcile
```

Ordinary `site publish` keeps the fast path. Use explicit reconciliation after a suspected out-of-band origin edit or when checking for drift; a reported normal no-op is not an origin-integrity audit.

For a changed production site publish or a pending cache retry, `CF_API_TOKEN` must authorize cache purge for the configured zone. Dry-run and a fully converged no-op do not require the token. The CLI checks token presence before mutating the projection, then purges changed URLs after synchronization; provider rejection reports failure and preserves the exact retry record. When a site has more than 100 unique changed URLs under an artifact or index prefix, the Cloudflare adapter submits a prefix purge for that site's trailing-slash prefix. This reduces purge requests for large publishes and can refresh unchanged cached objects inside that site's artifact or index prefix; application paths, the shared registry, previews, and other sites stay exact. Cloudflare's prefix purge supports 100 prefixes per request on all plans, and provider rate limits still apply. Retry the same site publish to complete a rejected cache request, even if it reports zero file differences. Successful purge submission does not reload an already-open application; reload to fetch its fresh catalog/index. See [Cloudflare's prefix purge documentation](https://developers.cloudflare.com/cache/how-to/purge-cache/purge_by_prefix/) for current limits.

Make two separate R2 temporary-credential requests. Substitute a registered site ID and use a short TTL appropriate for the publish job:

```json
{
  "bucket": "artifact-pages-production",
  "parentAccessKeyId": "<parent-r2-access-key-id>",
  "permission": "object-read-only",
  "ttlSeconds": 3600,
  "objects": ["_indexes/sites.json"]
}
```

```json
{
  "bucket": "artifact-pages-production",
  "parentAccessKeyId": "<parent-r2-access-key-id>",
  "permission": "object-read-write",
  "ttlSeconds": 3600,
  "objects": ["_control/locks/sites/sre.json", "_control/site-cache/sre.json", "_control/publish-state/sre.json.gz"],
  "prefixes": ["_indexes/sre/", "_artifacts/sre/", "_previews/sre/"]
}
```

The site prefixes must permit complete `ListObjectsV2` inventory for migration and `--reconcile`; include stale-object deletion for `_indexes/sre/` as well as `_artifacts/sre/`. Do not infer provider request counts from CLI object-change counts.

For a satellite repository, pin the admin config to a reviewed commit so the provider endpoint and bucket cannot silently change during a run:

```sh
artifact-pages site publish \
  --site sre \
  --source docs/artifacts \
  --config 'github://acme/platform-admin/artifact-pages.yaml?ref=0123456789abcdef0123456789abcdef01234567'
```

The deployed registry remains the source of publication eligibility. The remote config locator is deployment input, not an authorization boundary. The object-level reader credential keeps registry reads separate from the satellite's scoped write credential; R2 path restrictions still apply to a single bucket and permission scope per credential.

### Preview-only publisher role

A job that only runs `preview publish` (for example a pull-request workflow) can use a narrower role than a production publisher. It needs these environment variables and no others: `CF_R2_ACCESS_KEY_ID` and `CF_R2_SECRET_ACCESS_KEY` (plus `CF_R2_SESSION_TOKEN` for temporary credentials), or the optional registry-reader pair described above for the one registry read. `CF_API_TOKEN` is not needed, because preview publication never requests cache invalidation.

The paths below come from the CLI code (`cli/internal/preview`, the `ObjectPreviewStore` adapter and the site lock manager in `cli/internal/publisher`). A real publish uses only object `GET` and `PUT` (including conditional `PUT`); it never lists the bucket and never deletes objects.

| Object | Access | Why |
| --- | --- | --- |
| `_indexes/sites.json` | read | Confirms the site is registered and its source matches. Through the registry-reader credential when one is configured. |
| `_control/locks/sites/<site>.json` | read and write | The per-site publication lock: conditional create, acquire, release, and the pre-write ownership check before a catalog replacement. |
| `_previews/<site>/catalog.json` | read and write | The preview catalog, replaced under the lock. |
| `_previews/<site>/revisions/<head-sha>/manifest.json` | read and write | Immutable revision manifest, created once; also read for other groups when the catalog is pruned of revisions whose manifest is gone. |
| `_previews/<site>/revisions/<head-sha>/files/*` | read and write | Immutable preview bundle files, created once and compared byte-for-byte when a head is published again. |

A role scoped to the exact registry object, the exact lock object, and the `_previews/<site>/` prefix is therefore sufficient; a `--dry-run` needs only the read side, takes no lock, and writes nothing. No production prefix is written: `_artifacts/`, `_indexes/<site>/`, `_control/site-cache/`, the application files, and the registry are never modified, and `_indexes/sites.json` is read only. Because the preview role can write the lock object, grant it per site so that a pull-request job cannot take the lock of another site. As with the delegated publisher above, the object-level scope is enforced by R2, not by the CLI.

## 3. Deploy the app and register sites

From the admin repository, configure the Terraform provider token for infrastructure changes and then deploy the application bundle and reconcile the complete site registration set:

```sh
terraform -chdir=examples/cloudflare/terraform init
cp examples/cloudflare/terraform/terraform.tfvars.example examples/cloudflare/terraform/terraform.tfvars
# Edit terraform.tfvars with your account, zone, bucket, and hostname values.
terraform -chdir=examples/cloudflare/terraform plan -var-file=terraform.tfvars
terraform -chdir=examples/cloudflare/terraform apply -var-file=terraform.tfvars

artifact-pages app deploy --config artifact-pages.yaml --dry-run
artifact-pages app deploy --config artifact-pages.yaml
artifact-pages registry register --config artifact-pages.yaml --dry-run
artifact-pages registry register --config artifact-pages.yaml
```

The versioned app bundle is verified before deployment. `registry register` writes the deterministic registry projection for the complete desired set in `artifact-pages.yaml` and cleans content prefixes for sites omitted from its `sites` mapping. Registry commands require `sites`; omitting it is an input error, while `sites: {}` explicitly means the empty desired registry and registering it removes all current registrations. Provide the R2 credentials for registry operations, and provide the Cloudflare zone API token when the operation will invalidate public URLs; dry-runs and no-op operations do not need the API token.

With the separate read-only registry and read/write site credentials configured, each satellite repository can run the dry-run, inspect its site change plan, and publish one explicit registered site:

```sh
artifact-pages site publish --site sre --source docs/artifacts --config artifact-pages.yaml --dry-run
artifact-pages site publish --site sre --source docs/artifacts --config artifact-pages.yaml
```

An ordinary successful no-op trusts the state written by the last publisher success and can skip object-by-object checks. To force missing/stale/metadata-drift checks, include `--reconcile` as shown above; this still checks HEAD metadata rather than downloading every artifact body.

The satellite publishes only its site projection and does not need the zone token. To remove a site, first remove it from the admin config's `sites` mapping, then run `registry unregister --site sre --config artifact-pages.yaml` from the admin repository; unregister requires the selected config to omit that site and deletes its exact content prefixes. If viewer access should be restricted, configure Cloudflare Access or another edge policy independently; Artifact Pages does not store site visibility or authorize viewers. The commands document the external flow; [T16](../backlog/verification/T16-external-adoption.md) records clean-room adoption evidence.

## 4. Verify the deployed boundary

After publishing, verify the hostname directly. A successful local MinIO/purge-mock run is not a substitute for these checks.

- `/` loads the app; `/sre` and a nested logical path such as `/sre/reliability/summary` keep their browser URL while serving the app shell.
- `/assets/<hashed-file>` is served as the original object. Missing objects under `/_indexes/`, `/_artifacts/`, and `/_previews/` return 404 rather than the SPA shell.
- `/_control`, `/_control/locks/sites/sre.json`, and `/_control/publish-state/sre.json.gz` are blocked or return only the SPA shell, with no private object bytes exposed. Confirm the R2 `r2.dev` domain is disabled.
- Inspect origin and edge response headers for `index.html`, a mutable index, an artifact, and a hashed asset. Confirm browser and edge behavior respect the published origin `Cache-Control` bounds. Check `CF-Cache-Status` on a cold request and a warm request.
- If the operator enables Cloudflare Access, verify its cold/warm request behavior in that deployment; this is an operator-owned edge policy, not an Artifact Pages product check.
- Publish a change, confirm new bytes at origin, request the site through the custom domain, and confirm purge/revalidation reaches the updated content within the expected bound.
- Exercise real R2 conditional creation and a simultaneous `If-Match` race. Exactly one competing lock update must win, the other must map to a precondition failure, and the final object must match the winner.
- Verify complete R2 list pagination and delete behavior, including a partial-delete retry, before relying on unregister for cleanup.

## Limitations

R2 temporary credentials must be minted and renewed outside this CLI. Viewer access is configured and verified independently by the operator at the edge; Artifact Pages has no user identity or per-site permission model. Cache purge cannot clear a viewer's browser cache; origin/browser TTLs therefore stay part of the contract. The post-change state fast path and `--reconcile` behavior still need candidate measurements against the same target and fixture source used for the recorded pre-change baseline; [T18](../backlog/verification/T18-publish-scale-baseline.md) keeps those results separate. [T15](../backlog/verification/T15-provider-delivery.md) owns live delivery/cache evidence, and [T16](../backlog/verification/T16-external-adoption.md) owns the external clean-room flow.

## References

[R2 temporary credential scopes and supported operation permissions](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/), [Cloudflare Transform Rules with Terraform](https://developers.cloudflare.com/terraform/additional-configurations/transform-rules/), [Cache Rules with Terraform](https://developers.cloudflare.com/cache/how-to/cache-rules/terraform-example/), [R2 custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/), and [Cloudflare Ruleset phases](https://developers.cloudflare.com/ruleset-engine/reference/phases-list/).
