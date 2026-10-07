# Repository layout

This document describes the ownership boundaries in this checkout and the local commands that cross them. It does not change the product's browser URLs or the static application/content planes.

## Ownership and entry points

| Path | Owns | Main entry points |
| --- | --- | --- |
| `web/` | Vite, React, TypeScript, Storybook, Playwright browser product | `npm run dev`, `npm run build`, `npm run storybook`, `npm run build-storybook`, `npm run test:e2e` |
| `cli/cmd/` and `cli/internal/` | Go commands and their implementation packages | `go run ./cli/cmd/artifact-pages`, `go run ./cli/cmd/preview-local`, `go test ./...` |
| `terraform/deployments/` | Local caller roots for AWS and Cloudflare reference deployments | `terraform -chdir=terraform/deployments/aws ...`, `terraform -chdir=terraform/deployments/cloudflare ...` |
| `terraform/modules/` | Reusable Terraform modules maintained in this repository | AWS module; Cloudflare delivery and retention modules |
| `actions/` | Thin, path-stable composite Actions that build the Go command from this repository | `uses: <repo>/actions/<name>@<ref>` |
| `scripts/` | Repository task runner and cross-component verification | `npm run test:provider-delivery`, `npm run test:actions-parity`, `node scripts/run-edge-profile.mjs <aws|cloudflare|gcp>`, and the named local integration scripts |
| `fixtures/`, `docker/`, `docker-compose*.yml` | Committed storage projections and nginx/object-storage local serving profiles | `npm run serve:local`, `npm run test:e2e`, `node scripts/run-edge-profile.mjs <profile>` |
| `docs/`, `artifact-pages.yaml`, `AGENTS.md`, `LICENSE` | Product contracts, operating guidance, root configuration and licensing | Documentation entry points in `README.md` and `docs/README.md` |

The root `package.json` and `package-lock.json` intentionally remain repository-level manifests. npm installs dependencies into root `node_modules/`; root scripts coordinate the web app, Go commands, Actions, Compose profiles and Terraform checks. The Go `go.mod` and `go.sum` also remain at the repository root so `go test ./...` and the Actions' `go-version-file` continue to use one module without changing its module path.

## Browser and serving contract

The web source and browser tooling live in `web/`. Vite writes `web/dist/`; Storybook writes `web/storybook-static/`. The local nginx Compose profiles mount `web/dist/` as their document root. The web release packager archives the contents of `web/dist/` at the archive root, retaining `/index.html`, `/assets/*`, `/preview-bridge.js`, `/LICENSE`, and `/THIRD_PARTY_NOTICES.txt`.

Fixtures remain at `fixtures/storage/`, outside the SPA source and output. nginx continues to serve `/_indexes/*`, `/_artifacts/*`, `/_previews/*`, and the reserved `/_control/*` boundary separately from the application shell. Logical browser routes remain `/`, `/:site`, and `/:site/*`.

## Terraform ownership

`terraform/deployments/aws` and `terraform/deployments/cloudflare` are caller roots. `terraform/deployments/cloudflare` consumes `terraform/modules/cloudflare` in this repository; `terraform/deployments/aws` still consumes the sibling `terraform-aws-artifact-pages` checkout until IMP-63 covers AWS. These directories are not copies of those modules.

`terraform/modules/aws` is the AWS provider module maintained in this repository. `terraform/modules/cloudflare` is the Cloudflare module in Registry layout (root entry module, `modules/delivery`, `modules/retention`, `examples/`, `tests/`, `scripts/`) and the source of truth for the `terraform-cloudflare-artifact-pages` package (TD15); `examples/cloudflare/terraform` is a local caller of its submodules.

The deployment roots and in-repository modules are separate source/release boundaries. In particular, `terraform/deployments/aws` consumes the sibling `terraform-aws-artifact-pages` checkout; it does not source `terraform/modules/aws`. Likewise, the Cloudflare deployment roots and the local example consume the in-repository Cloudflare module. These components remain separately releasable from the web application as described by TD2; this layout does not publish or pin a Registry release.

Tracked `.terraform.lock.hcl` files stay with their Terraform roots, modules, or examples. This move records Darwin arm64 provider checksums alongside the existing hashes without changing locked provider versions.

Local Terraform state stays under ignored `.local/terraform/{aws,cloudflare}/`. Real `.terraform/` plugin caches, local variable files, and state are machine-local and are not part of the repository layout or moves.

## Baseline move and dependency map

Before changing paths, the tracked layout had web source/config at the root (`src/`, `public/`, `index.html`, `vite.config.ts`, `tsconfig.json`, `playwright.config.ts`, `.storybook/`, and `e2e/`); Go sources at `cmd/` and `internal/`; Terraform caller roots at `terraform/{aws,cloudflare}`; and the local AWS/Cloudflare Terraform sources under `infra/`.

| Before | After | Dependencies that must follow the move |
| --- | --- | --- |
| Root web source, configs, Storybook, E2E | `web/` | Root npm scripts specify config paths; Vite and Storybook resolve fixtures outside `web/`; stories resolve JSON fixtures; TypeScript and Playwright resolve web-local paths; nginx receives `web/dist/`. |
| `cmd/`, `internal/` | `cli/cmd/`, `cli/internal/` | Keep root Go module and module path; update internal import paths, root `go run`/`go build`, scripts, guides, and Actions build targets. |
| `terraform/{aws,cloudflare}` | `terraform/deployments/{aws,cloudflare}` | Update sibling-module relative sources, `.local` backend state paths, README commands, and local variable-file paths without moving ignored state or plugin data. |
| `infra/aws` | `terraform/modules/aws` | Keep the in-repository AWS module and route-contract tests together; update root npm provider-test paths. |
| `infra/cloudflare/{delivery,retention}` | `terraform/modules/cloudflare/modules/{delivery,retention}` | Update the Cloudflare example caller, provider-test paths, module examples, and documentation links. |
| Repository-wide runner files and manifests | Remain at root | Continue resolving root `node_modules/`, `.local/`, `go.mod`, fixtures, Actions, Compose, and docs from the repository root. |

The existing ignored `dist/`, `storybook-static/`, `node_modules/`, `.local/`, `test-results/`, and Terraform `.terraform/`/state/variable outputs were present during the inventory. They are generated or machine-local data and were excluded from tracked moves.
