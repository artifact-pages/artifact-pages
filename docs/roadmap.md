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
- Site discovery uses lightweight metadata; only the active site's artifact index is loaded.
- Normal page search stays within the active site; `@` searches site metadata.

The single-site and multi-site palette benchmark is recorded in [palette-search-benchmark.md](./research/palette-search-benchmark.md). It includes 20 sites × 1,000 artifacts, character-by-character input, browser heap, load/parse/search timings, and an eager-chunk comparison. Eager chunks did not improve ready-to-use time or memory, so keep product-level sharding and inverted indexes deferred until a different loading model demonstrates a user-visible benefit. Local transfer timings compare projection/browser costs but are not a forecast of CDN or public-network latency.

VRT is optional at this stage and should focus on the application shell rather than arbitrary artifact contents.

## Phase 2 — Local projection builder

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

## Phase 3 — AWS reference deployment

Provide a reference AWS deployment:

- private S3 origin
- CloudFront
- Origin Access Control
- SPA fallback/rewrite
- cache policies appropriate to application, indexes, and artifacts
- optional access controls
- GitHub Actions OIDC for publishing

Prefer Terraform for the reference infrastructure.

The publishing adapter must coordinate satellite publish and admin unregister with the shared per-site storage-lock contract in the specification. Admin deployments that update the whole sites registry must be serialized. Implement and verify this only when the repository reaches the provider-publishing phase; it is not part of the current local-product implementation.

Provider-publishing release gate: add deterministic concurrency and recovery tests proving both orderings (publish owns the lock first; unregister withdraws the registry first), and verify that the final state is always unregistered with no site objects. Also cover concurrent publishers for different sites, interrupted/partial unregister followed by an idempotent retry, stale-lock recovery losing its ETag compare-and-swap race, and CDN invalidation failure followed by a successful retry. For publish, interrupt after artifact upload, after index/meta replacement, and during stale-object deletion; retrying the same desired source must converge to an index whose artifact references exist, with no stale objects left under the site prefix. Tests should use provider fakes for repeatability, with a small real-provider smoke test validating each adapter's conditional object-write behavior.

Exercise complete-prefix reconciliation with multiple listing pages and enough stale objects to exceed one provider delete batch. Inject a listing failure before deletion and per-object delete failures; the command must report failure, never infer a complete view from a partial listing, and converge on retry without touching neighboring site or control-plane keys.

Registry tests validate the strict YAML mapping, the empty-registry case, rejection of duplicate/unknown/mistyped fields, and deterministic JSON projection as an ID-sorted array (including an empty array when no sites are registered).

The provider smoke test also verifies that uploaded bytes are unchanged and browser-facing `Content-Type` metadata is correct for HTML, Markdown, CSS, JavaScript, JSON, an image, a font, and WASM. Verify that unknown extensions use the documented binary fallback and that uploads do not force attachment disposition or claim an encoding that was not applied. Exercise a page with relative CSS, script, and image references against the deployed origin so incorrect metadata or routing is observable as a browser failure.

Verify effective browser/CDN cache headers against the cache model: mutable URLs revalidate in browsers, metadata/index responses have at most 60 seconds of shared-cache freshness, artifact responses at most 300 seconds, and content-hashed application assets use the immutable one-year policy. When access control is enabled, confirm authorization runs before shared-cache delivery.

Publisher tests also cover symlinked files/directories and unsupported filesystem entries. Publishing must fail clearly without dereferencing a symlink target or exposing data outside the selected source tree.

## Phase 4 — Reusable distribution

Package the system so another organization can adopt it without copying implementation code.

Expected distribution surfaces:

- CLI / core package
- bundled SPA
- Terraform AWS module
- GitHub Action
- reusable workflow examples

Do not lock these package boundaries until Phases 1–3 make the contracts clear.

## Before an OSS release

- choose an OSS license
- define compatibility/versioning policy for index and registry schemas
- document security assumptions for arbitrary HTML/JavaScript artifacts
- document upgrade and rollback behavior
