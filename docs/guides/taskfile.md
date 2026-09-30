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
task cli:publish SITE=guide SOURCE=docs/public/sites/guide DRY_RUN=true
task cli:publish SITE=guide SOURCE=docs/public/sites/guide
task cli:registry DRY_RUN=true
task cli:deploy ARCHIVE=.local/releases/artifact-pages-web-v1.2.3.tar.gz DRY_RUN=true
task cli:deploy VERSION=1.2.3 DRY_RUN=true
~~~

App deployment requires exactly one of ARCHIVE or VERSION. Registry reconciliation is the existing `registry register` operation; it may remove registrations omitted from the desired mapping. Publishing never implicitly reconciles the registry, deploys the app, or runs Terraform.

## Cloudflare overlay

~~~sh
task cli:registry:cloudflare DRY_RUN=true
task cli:publish:cloudflare SITE=guide SOURCE=docs/public/sites/guide DRY_RUN=true
task cli:deploy:cloudflare VERSION=1.2.3 DRY_RUN=true
~~~

Cloudflare tasks select exactly `--config artifact-pages.yaml --config artifact-pages.cloudflare.yaml`, in that order. The base site's mapping is inherited when the overlay omits `sites`. The ignored overlay and credentials must already exist locally. CONFIG does not change this fixed Cloudflare stack. Drop DRY_RUN only when ready to write. Task's own `--dry` only prints commands and is not a substitute for the CLI's `DRY_RUN=true`, which reads the target and computes actual changes.

Provider-module repositories have separate `tf:*` tasks. Run those within the module repository and explicitly select a consumer deployment directory with TF_DIR for initialization, validation, planning, applying, and outputs. No task in this product repository operates a sibling Terraform repository.
