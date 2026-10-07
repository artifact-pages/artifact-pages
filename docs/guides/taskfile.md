# Development tasks

Install Task v3 (the tasks are verified with v3.51.1). The root Taskfile includes CLI and Web task definitions from their packages. All commands and relative SOURCE, CONFIG, ARCHIVE, and STORAGE paths are rooted at the product repository, including when using `task -t cli/Taskfile.yml` or running from a package directory.

~~~sh
task --list
task cli:build
task cli:test
task web:build
task web:serve
~~~

Local serving defaults to port 4179 and `.local/public-site/storage`, matching the local deployment config. `task web:serve PORT=4180 STORAGE=./.local/other/storage` changes only serving; keep the selected CLI config's `local.root` aligned with STORAGE. It does not register sites, publish documents, or deploy a bundle to storage.

## Publish and deploy

Publishing requires both SITE and SOURCE. Every mutation task builds the CLI before invoking it. CONFIG is optional for ordinary tasks; without it the CLI uses its own config resolution rules. DRY_RUN accepts only `true` or `false` and defaults to `false`.

~~~sh
task cli:site:sync SITE=guide SOURCE=docs/public/sites/guide DRY_RUN=true
task cli:site:sync SITE=guide SOURCE=docs/public/sites/guide
task cli:registry:sync DRY_RUN=true
task cli:app:deploy ARCHIVE=.local/releases/artifact-pages-web-v1.2.3.tar.gz DRY_RUN=true
task cli:app:deploy VERSION=1.2.3 DRY_RUN=true
~~~

Registry sync reconciles the complete desired `sites` mapping and removes sites omitted from it. Site sync only changes its selected site. App deployment requires exactly one of ARCHIVE or VERSION. Site sync never implicitly reconciles the registry, deploys the app, or runs Terraform.

## Cloudflare overlay

~~~sh
task cli:registry:sync:cloudflare DRY_RUN=true
task cli:site:sync:cloudflare SITE=guide SOURCE=docs/public/sites/guide DRY_RUN=true
task cli:app:deploy:cloudflare VERSION=1.2.3 DRY_RUN=true
~~~

Cloudflare tasks select exactly `--config artifact-pages.yaml --config artifact-pages.cloudflare.yaml`, in that order. The base site's mapping is inherited when the overlay omits `sites`. The ignored overlay and credentials must already exist locally. CONFIG does not change this fixed Cloudflare stack. Drop DRY_RUN only when ready to write. Task's own `--dry` only prints commands and is not a substitute for the CLI's `DRY_RUN=true`, which reads the target and computes actual changes.

Provider-module repositories have separate `tf:*` tasks. Run those within the module repository and explicitly select a consumer deployment directory with TF_DIR for initialization, validation, planning, applying, and outputs. No task in this product repository operates a sibling Terraform repository.

## Other CLI subcommands

Task names mirror the CLI hierarchy: `site:sync`, `registry:sync`, `app:deploy`, `app:remove`, `preview:publish`, and `preview:remove`.

~~~sh
# Remove retired from the desired config's sites mapping, then review the full cleanup plan.
task cli:registry:sync DRY_RUN=true
task cli:registry:sync:cloudflare DRY_RUN=true

task cli:app:remove DRY_RUN=true
task cli:preview:remove SITE=guide GROUP=pr:42 DRY_RUN=true
task cli:preview:remove:cloudflare SITE=guide GROUP=pr:42 DRY_RUN=true

task cli:preview:publish SITE=guide SOURCE=docs/public/sites/guide BASE_URL=http://localhost:4179 DRY_RUN=true
task cli:preview:publish:cloudflare SITE=guide SOURCE=docs/public/sites/guide BASE_URL=https://artifact-pages.dev PULL_REQUEST=42 DRY_RUN=true

# Local index output, not a publish operation.
task cli:index:build SITE=guide SOURCE=docs/public/sites/guide OUT=.local/index-only
task cli:config:set-default LOCATOR=artifact-pages.yaml

task cli:lock:inspect SITE=guide
task cli:lock:inspect:cloudflare SCOPE=registry
# Only after confirming the owner is stale; preserve the observed ETag exactly.
task cli:lock:recover:cloudflare SCOPE=registry OBSERVED_ETAG='"observed-etag"'
~~~

Preview publishing requires BASE_URL and supports optional HEAD, DEFAULT_REF, PULL_REQUEST, and one INCLUDE resource path/pattern. Omitted Git refs use the CLI defaults. Use the CLI directly for repeated `--include` flags or additional output options. Index building requires OUT, and optionally accepts TITLE, REF, REPOSITORY, and REPOSITORY_URL. Config selection requires LOCATOR and changes only the user's saved locator.

Lock operations require SITE, or SCOPE=registry without SITE. Recover additionally requires OBSERVED_ETAG; it is never run automatically after inspect. The CLI has no dry-run for lock recovery, index building, or config selection, so these tasks reject DRY_RUN=true instead of silently writing. Use Task's `--dry` to inspect their command expansion without executing them. Every target-dependent operation has a `:cloudflare` counterpart with the same fixed config stack; index building and config selection do not use a deployment target.
