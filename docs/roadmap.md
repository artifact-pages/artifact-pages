# Roadmap

The roadmap is intentionally staged. Each phase should prove a stable contract before the next infrastructure layer is added.

## Phase 1 — Local product

Build the product locally without AWS.

Target stack:

- Vite
- React + TypeScript
- nginx
- Docker Compose
- fixture indexes and artifacts
- Vitest
- Storybook interaction tests
- Playwright E2E

Target user experience:

- / shows available sites.
- /:site shows the site home and recent artifacts.
- /:site/* deep-links to an artifact.
- Left sidebar shows a searchable/filterable artifact tree.
- Main pane renders HTML in an iframe and Markdown in the native reader.
- Indexed document routes retain their source-relative filename and extension.
- E2E covers artifact routes and relative resources with spaces, Unicode, and reserved URL characters, including direct load and reload round-trips.
- An optional right panel switches between indexed contents and artifact details (last committer, update date, and source).
- Direct navigation and reload restore the same state.
- Fixture and registered-site discovery use the static `/_indexes/sites.json` catalog plus lightweight per-site metadata; only the active site's artifact index is loaded. Discovery does not depend on nginx autoindex or object-store listing.
- Local conformance profiles send fixture seeding and `artifact-pages site publish` through object APIs, then serve `/_indexes/*` and `/_artifacts/*` through nginx to the emulator origin. MinIO covers the shared S3 API shape used by AWS and Cloudflare adapter tests; fake-gcs-server covers `gcp-local` JSON API behavior only. These profiles do not claim real-provider equivalence, and GCP remains local-only.
- A focused `preview-local` developer command projects changed Git documents under ignored `.local/previews`; nginx and the SPA use the same static preview record and logical-route contract.
- Preview projection writes go through a small provider-neutral store interface. The local directory is the Phase 1 adapter; AWS and Cloudflare storage, locking, serving policy, and retention stay in their provider phase.
- Normal page search stays within the active site; `@` searches site metadata.

The single-site and multi-site palette benchmark is recorded in [palette-search-benchmark.md](./research/palette-search-benchmark.md). It includes 20 sites × 1,000 artifacts, character-by-character input, browser heap, load/parse/search timings, and an eager-chunk comparison. Eager chunks did not improve ready-to-use time or memory, so keep product-level sharding and inverted indexes deferred until a different loading model demonstrates a user-visible benefit. Local transfer timings compare projection/browser costs but are not a forecast of CDN or public-network latency.

VRT is optional at this stage and should focus on the application shell rather than arbitrary artifact contents.

## Phase 2 — Local production projection builder

Build the per-site index from one Git repository source directory:

~~~text
source repository + sourcePath
        ↓
_indexes/<site>/meta.json        lightweight discovery metadata
_indexes/<site>/index.json       artifact records
~~~

The standalone `artifact-pages` CLI consumes one publishable static content directory inside a Git working tree; it is not a `git` subcommand. HTML and Markdown must already be ready to publish; the index builder does not run templates or another site's build, bundle CSS/JavaScript, rewrite URLs, or copy files. It recursively indexes every `.html`, `.htm`, and `.md` file, including root and nested `index.html`; every indexed document uses its exact source-relative filename, extension included, as its logical route. Markdown metadata uses its first H1 for the display title and extracts heading IDs for Contents. The product reader supports GFM and Mermaid code fences. There are no implicit path exclusions, so the selected directory must not include source-only HTML or Markdown partials unless they are intended to be published as artifacts.

The builder extracts display metadata and computes update times from Git history and working-tree changes. It records the Git committer name for the latest relevant change, without resolving a GitHub account or publishing the committer email. Untracked files, including ignored generated output, remain indexable, but their update time falls back to filesystem modification times and they have no `lastCommitter`. The command does not copy artifact bytes or publish to a hosting provider; a later publish step should copy the selected static tree unchanged so its relative resources continue to work.

The full source tree is scanned on each build. Temporary file-count fixtures cover 1,000, 5,000, and 10,000 source files (100, 500, and 1,000 HTML pages); Git-history fixtures cover 500 and 1,000 HTML pages with 51 commits. Browser palette fixtures are generated under ignored `.local/` storage and cover single-site sizes plus multiple sites, including 20 × 1,000. They measure summary/index downloads, JSON parsing, browser memory, search, and input-to-paint. Use the measurements to decide whether incremental building or index partitioning is warranted; do not implement either preemptively.

Use one repository source per site for this milestone. Registry enforcement, mount ownership, multi-repository merging, and provider publishing are deferred until the static index contract is validated.

The public contract should remain simple even if internal merge/staging mechanics evolve.

The Phase 1 preview developer helper remains a separate focused command; it does not promote preview publishing into the general-purpose `artifact-pages` CLI contract.

## Phase 3 — Provider-backed deployments

Provide the AWS reference deployment and a Cloudflare adapter against the same provider-neutral publisher/storage contract. Choose Cloudflare's concrete storage and lock services in the linked design work before implementing its adapter.

The AWS reference deployment includes:

- private S3 origin
- CloudFront
- Origin Access Control
- SPA fallback/rewrite
- cache policies appropriate to application, indexes, and artifacts
- optional customer-managed edge access controls (outside the Artifact Pages identity and site model)
- GitHub Actions OIDC for publishing

Prefer Terraform for the reference infrastructure.

The Cloudflare adapter must preserve the same catalog, manifest, object-key, immutability, publication-order, and per-site lock semantics. Provider-specific credentials, storage APIs, locking, cache, and lifecycle configuration stay within each adapter/deployment boundary. Viewer access remains an operator-managed edge/network policy and is not represented in the site's product or registry model.

The publishing adapter must coordinate satellite publish and `registry unregister` with the shared per-site storage-lock contract in the specification. Registry publications that update the whole sites registry must be serialized. Implement and verify this only when the repository reaches the provider-publishing phase; it is not part of the current local-product implementation.

Provider-publishing release gate: add deterministic concurrency and recovery tests proving both orderings (publish owns the lock first; unregister withdraws the registry first), and verify that the final state is always unregistered with no site objects. Also cover concurrent publishers for different sites, interrupted/partial unregister followed by an idempotent retry, stale-lock recovery losing its ETag compare-and-swap race, and CDN invalidation failure followed by a successful retry. For publish, interrupt after artifact upload, after index/meta replacement, and during stale-object deletion; retrying the same desired source must converge to an index whose artifact references exist, with no stale objects left under the site prefix. Tests should use provider fakes for repeatability, with a small real-provider smoke test validating each adapter's conditional object-write behavior.

Exercise complete-prefix reconciliation with multiple listing pages and enough stale objects to exceed one provider delete batch. Inject a listing failure before deletion and per-object delete failures; the command must report failure, never infer a complete view from a partial listing, and converge on retry without touching neighboring site or control-plane keys.

Registry tests validate the strict YAML mapping, the empty-registry case, rejection of duplicate/unknown/mistyped fields, and deterministic JSON projection as an ID-sorted array (including an empty array when no sites are registered).

The provider smoke test also verifies that uploaded bytes are unchanged and browser-facing `Content-Type` metadata is correct for HTML, Markdown, CSS, JavaScript, JSON, an image, a font, and WASM. Verify that unknown extensions use the documented binary fallback and that uploads do not force attachment disposition or claim an encoding that was not applied. Exercise a page with relative CSS, script, and image references against the deployed origin so incorrect metadata or routing is observable as a browser failure.

Verify effective browser/CDN cache headers against the cache model: mutable URLs revalidate in browsers, metadata/index responses have at most 60 seconds of shared-cache freshness, artifact responses at most 300 seconds, and content-hashed application assets use the immutable one-year policy. Any customer-configured edge access gate is outside the product contract; its operator must verify that it covers the intended routes before protected bytes are served.

Publisher tests also cover symlinked files/directories and unsupported filesystem entries. Publishing must fail clearly without dereferencing a symlink target or exposing data outside the selected source tree.

## Phase 4 — Reusable distribution

Package the system so another organization can adopt it without copying implementation code.

Expected distribution surfaces:

- CLI / core package
- bundled SPA
- Terraform reference modules for the supported providers (initially AWS and Cloudflare)
- optional thin composite GitHub Actions that invoke the CLI
- caller-owned workflow examples showing how to invoke those Actions

Reusable workflows are not part of the distribution contract: adopters own event triggers, approvals, and credential policy. Do not lock further package boundaries until Phases 1–3 make the contracts clear.

The `gcp-local` profile is an emulator-only contract test. A production GCP adapter or Terraform module is not currently in scope and requires a separate decision based on an adoption need.

## Before an OSS release

- [x] Include the selected MIT license and generated third-party notices in web releases; attach dependency notices to any future standalone CLI binary release.
- [x] Define web-bundle-only SemVer releases, immutable source refs for Actions/CLI and Terraform, and the schema compatibility boundary in [TD2](backlog/technical-design/TD2-component-release-policy.md).
- [ ] Document security assumptions for arbitrary HTML/JavaScript artifacts.
- [ ] Document upgrade and rollback behavior for each released component.
