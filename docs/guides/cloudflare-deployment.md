# Cloudflare deployment

This guide connects an existing private R2 bucket to a Cloudflare custom domain, applies preview retention, and publishes the Artifact Pages application and registered content to it. It follows the selected provider mapping in [T12](../backlog/technical-design/T12-cloudflare-production-mapping.md); it does not claim a live Cloudflare deployment has been verified.

## 1. Prepare Cloudflare

Create one private R2 bucket for the application and the changing projection. The bucket holds `index.html`, `preview-bridge.js`, `assets/*`, `/_indexes/*`, `/_artifacts/*`, `/_previews/*`, and private `/_control/*` coordination objects.

Use [the Cloudflare delivery Terraform reference](../../terraform/modules/cloudflare/delivery/README.md) to attach `artifacts.example.com` (replace it with your hostname), disable the alternate `r2.dev` endpoint, and configure the route, control-boundary, and origin-cache rules. The Cloudflare provider cannot import an existing R2 custom domain, so set `connect_custom_domain = false` when the hostname is already connected and verify its enabled/TLS settings separately. Terraform also cannot import or destroy the managed-domain setting; keep it in one Terraform state and update its `enabled` value explicitly if the policy changes. Configure a Cloudflare Access application separately if the whole hostname should require authentication. Access is a host-level viewer boundary; the publisher does not implement per-site authorization.

The in-repository [Cloudflare caller example](../../examples/cloudflare/terraform) composes the delivery and [Cloudflare R2 retention module](../../terraform/modules/cloudflare/retention/README.md) against the same existing bucket. The local deployment root under `terraform/deployments/cloudflare` instead calls the independently versioned sibling Terraform module repository. Set `preview_retention_days` in the caller's `terraform.tfvars`; preview retention belongs to provider infrastructure and is not a CLI YAML setting. The retention resource owns the complete bucket lifecycle rule set. Inspect existing rules and merge every rule that must remain before applying it; lifecycle deletion is asynchronous and is not an immediate revocation mechanism.

The delivery module owns the complete zone root rulesets for the transform, custom firewall, and cache phases. Review existing rules and import/merge them before applying; see its README for the exact resource addresses and preservation inputs. A Terraform apply uses `CLOUDFLARE_API_TOKEN` through the environment or a secret manager, with only the R2 custom/managed domain, R2 lifecycle, and zone Rulesets permissions needed by these modules. This infrastructure credential is separate from runtime CLI credentials. A normal CLI publisher starts with only the primary R2 access key and secret; `CF_API_TOKEN` is an optional runtime zone-scoped credential with cache purge permission for app or registry operations that actually invalidate public URLs. None of these credential values belong in Terraform variables, YAML, or the repository.

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
| `site publish`, `preview publish` | Required | Optional; used only when reader env names are configured | Not needed |
| `app deploy` | Required | Not used | Required only when a real deploy requests invalidation |
| `registry register`, `registry unregister` | Required | Not used | Required only when a real operation requests invalidation |
| `lock inspect`, `lock recover` | Required | Not used | Not needed |

If registry-reader env names are present, `site publish` and `preview publish` require the corresponding access key and secret values before making provider requests, and use that identity only for `GetObject("_indexes/sites.json")`. Without those names, these commands read the registry with the primary credential. Other commands ignore configured reader env values. Registry and app mutations check that the API token is configured before changing registry or application objects.

### Optional delegated publisher

Use this when a satellite publisher should not be able to read or write the whole registry. Add the following fields to that publisher's deployment config only; do not add them to the ordinary admin config:

```yaml
cloudflare:
  registryReaderAccessKeyIdEnv: CF_R2_REGISTRY_READER_ACCESS_KEY_ID
  registryReaderSecretAccessKeyEnv: CF_R2_REGISTRY_READER_SECRET_ACCESS_KEY
  registryReaderSessionTokenEnv: CF_R2_REGISTRY_READER_SESSION_TOKEN # only for temporary reader credentials
```

R2 temporary credentials support one bucket-level operation scope (`object-read-only` or `object-read-write`) plus exact object and prefix restrictions. Give the delegated publisher a read-only credential scoped to the exact `_indexes/sites.json` object and a read/write credential scoped to `_indexes/<site>/`, `_artifacts/<site>/`, `_previews/<site>/`, and the exact `_control/locks/sites/<site>.json` and `_control/site-cache/<site>.json` objects. The latter is a private cache-request retry record and must support deletion as well as reads/writes. The CLI uses the reader only for the registry read and the primary credential for site writes. Do not put the parent R2 secret or the API token used to mint temporary credentials in the satellite repository or workflow. Set the primary credential's session token through `CF_R2_SESSION_TOKEN`; set the reader credential's session token through `CF_R2_REGISTRY_READER_SESSION_TOKEN`. The CLI does not mint or refresh either credential.

For a changed production site publish or a pending cache retry, `CF_API_TOKEN` must authorize cache purge for the configured zone. Dry-run and a fully converged no-op do not require the token. The CLI checks token presence before mutating the projection, then purges changed URLs after synchronization; provider rejection reports failure and preserves the retry record. Retry the same site publish to complete the cache request, even if it reports zero file differences. Successful purge submission does not reload an already-open application; reload to fetch its fresh catalog/index.

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
  "objects": ["_control/locks/sites/sre.json", "_control/site-cache/sre.json"],
  "prefixes": ["_indexes/sre/", "_artifacts/sre/", "_previews/sre/"]
}
```

For a satellite repository, pin the admin config to a reviewed commit so the provider endpoint and bucket cannot silently change during a run:

```sh
artifact-pages site publish \
  --site sre \
  --source docs/artifacts \
  --config 'github://acme/platform-admin/artifact-pages.yaml?ref=0123456789abcdef0123456789abcdef01234567'
```

The deployed registry remains the source of publication eligibility. The remote config locator is deployment input, not an authorization boundary. The object-level reader credential keeps registry reads separate from the satellite's scoped write credential; R2 path restrictions still apply to a single bucket and permission scope per credential.

## 3. Deploy the app and register sites

From the admin repository, configure the Terraform provider token for infrastructure changes and then deploy the application bundle and reconcile the complete site registration set:

```sh
terraform -chdir=examples/cloudflare/terraform init
cp examples/cloudflare/terraform/terraform.tfvars.example examples/cloudflare/terraform/terraform.tfvars
# Edit terraform.tfvars with your account, zone, bucket, and hostname values.
terraform -chdir=examples/cloudflare/terraform plan -var-file=terraform.tfvars
terraform -chdir=examples/cloudflare/terraform apply -var-file=terraform.tfvars

artifact-pages app deploy --version 1.2.3 --config artifact-pages.yaml --dry-run
artifact-pages app deploy --version 1.2.3 --config artifact-pages.yaml
artifact-pages registry register --config artifact-pages.yaml --dry-run
artifact-pages registry register --config artifact-pages.yaml
```

The versioned app bundle is verified before deployment. `registry register` writes the deterministic registry projection for the complete desired set in `artifact-pages.yaml` and cleans content prefixes for sites omitted from its `sites` mapping. Registry commands require `sites`; omitting it is an input error, while `sites: {}` explicitly means the empty desired registry and registering it removes all current registrations. Provide the R2 credentials for registry operations, and provide the Cloudflare zone API token when the operation will invalidate public URLs; dry-runs and no-op operations do not need the API token.

With the separate read-only registry and read/write site credentials configured, each satellite repository can run the dry-run, inspect its site change plan, and publish one explicit registered site:

```sh
artifact-pages site publish --site sre --source docs/artifacts --config artifact-pages.yaml --dry-run
artifact-pages site publish --site sre --source docs/artifacts --config artifact-pages.yaml
```

The satellite publishes only its site projection and does not need the zone token. To remove a site, first remove it from the admin config's `sites` mapping, then run `registry unregister --site sre --config artifact-pages.yaml` from the admin repository; unregister requires the selected config to omit that site and deletes its exact content prefixes. If viewer access should be restricted, configure Cloudflare Access or another edge policy independently; Artifact Pages does not store site visibility or authorize viewers. The commands document the external flow; [T16](../backlog/verification/T16-external-adoption.md) records clean-room adoption evidence.

## 4. Verify the deployed boundary

After publishing, verify the hostname directly. A successful local MinIO/purge-mock run is not a substitute for these checks.

- `/` loads the app; `/sre` and a nested logical path such as `/sre/reliability/summary` keep their browser URL while serving the app shell.
- `/assets/<hashed-file>` is served as the original object. Missing objects under `/_indexes/`, `/_artifacts/`, and `/_previews/` return 404 rather than the SPA shell.
- `/_control` and `/_control/locks/sites/sre.json` are blocked, with no object bytes exposed. Confirm the R2 `r2.dev` domain is disabled.
- Inspect origin and edge response headers for `index.html`, a mutable index, an artifact, and a hashed asset. Confirm browser and edge behavior respect the published origin `Cache-Control` bounds. Check `CF-Cache-Status` on a cold request and a warm request.
- If the operator enables Cloudflare Access, verify its cold/warm request behavior in that deployment; this is an operator-owned edge policy, not an Artifact Pages product check.
- Publish a change, confirm new bytes at origin, request the site through the custom domain, and confirm purge/revalidation reaches the updated content within the expected bound.
- Exercise real R2 conditional creation and a simultaneous `If-Match` race. Exactly one competing lock update must win, the other must map to a precondition failure, and the final object must match the winner.
- Verify complete R2 list pagination and delete behavior, including a partial-delete retry, before relying on unregister for cleanup.

## Limitations

R2 temporary credentials must be minted and renewed outside this CLI. Viewer access is configured and verified independently by the operator at the edge; Artifact Pages has no user identity or per-site permission model. Cache purge cannot clear a viewer's browser cache; origin/browser TTLs therefore stay part of the contract. The modules and local profile have not been applied to or smoke-tested against a live account. [T15](../backlog/verification/T15-provider-delivery.md) owns live delivery/cache evidence, and [T16](../backlog/verification/T16-external-adoption.md) owns the external clean-room flow.

## References

[R2 temporary credential scopes and supported operation permissions](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/), [Cloudflare Transform Rules with Terraform](https://developers.cloudflare.com/terraform/additional-configurations/transform-rules/), [Cache Rules with Terraform](https://developers.cloudflare.com/cache/how-to/cache-rules/terraform-example/), [R2 custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/), and [Cloudflare Ruleset phases](https://developers.cloudflare.com/ruleset-engine/reference/phases-list/).
