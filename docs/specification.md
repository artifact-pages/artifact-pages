# Git Artifact Pages — Specification

Status: **Phase 1 local product; implementation-aligned, evolving**

This document records the current local product contract and identifies decisions intentionally deferred until measurements or a concrete deployment use case justify them.

## 1. Product definition

Git Artifact Pages is a Git-backed platform in which each registered site publishes its static artifacts independently, from its own repository, into one shared static projection that a single browser application presents as one reading space.

A typical source artifact is generated or maintained in a Git repository, for example:

- HTML reports
- architecture explanations
- design documents
- generated visualizations
- incident reports
- review artifacts
- documentation bundles

The product preserves Git as the source of truth. Publishing is per site: no central build regenerates every site, and one site's publish does not wait for another's. All sites share the projection layout and the reader application, so readers get the same discovery, navigation, search, and reading experience on every site.

## 2. System model

~~~text
Git repositories
      ↓
publisher
      ↓
static projection
      ↓
object storage
      ↓
CDN / HTTP server
      ↓
browser SPA
~~~

There is no required application server in the browser request path.

### 2.1 Application plane

The application plane changes relatively infrequently.

~~~text
/index.html
/assets/*
~~~

It contains the SPA shell and its versioned JS/CSS assets.

The initial SPA implementation is Vite + React + TypeScript.

`app deploy` serializes application writers with the private `/_control/locks/application.json` lock. Before the first application-object write, it conditionally stores a retry record at `/_control/app-cache/retry.json`. The current record is a `schemaVersion: 1` JSON object with the sorted path array `paths: ["/index.html"]`, capped at 16 KiB, served as `application/json` with `Cache-Control: no-store`; creation uses `If-None-Match` and replacement uses the read ETag with `If-Match`. It is private control data and is never served as application content. The command keeps it after an object-write or cache-invalidation failure, rechecks the complete bundle on retry, and clears it after the invalidation request succeeds. A reported clear failure is returned as an error; the command preserves or restores the retry record while still holding the application lock so the next run can safely repeat the invalidation. Older, malformed, or out-of-scope records fail closed and are never reset automatically.

### 2.2 Content plane

The content plane changes as artifacts are published.

~~~text
/_indexes/*
/_artifacts/*
/_previews/*
~~~

It is independently deployable from the application plane.
`/_previews/*` is the local-development projection. Provider-backed preview publication and lifecycle behavior remain a later phase.

The reserved `/_control/*` keyspace stores private coordination state such as retained publish locks, cache retry records, and per-site publish state. It is not part of the application or content serving planes. Delivery configurations must not return these object bytes to viewers. When unmatched paths fall back to the app shell, `/_control/*` may receive that shell response, but must never route to the control objects in storage.

## 3. Site

A **site** is the first logical segment of a user-facing route.

Examples:

~~~text
/sre
/frontend
/platform
~~~

Therefore /sre/incidents/123.html means:

- site: sre
- logical artifact route: incidents/123.html

A site is a logical destination, not a repository identity. The initial builder maps one repository source directory to one site. Combining sources from multiple repositories is deferred until a concrete use case requires it.

In the registered deployment model, a [SiteRegistry](architecture/domain-model.html) owns the registered Sites. Registration adds a Site; unregistering removes it from discovery and initiates removal of its published projection. This is not a per-viewer access-control decision. Publishing updates the current Artifacts of an existing registered Site. Registration is an operation, not a separate `SiteRegistration` entity. Fixture and registered modes both discover sites from the static `/_indexes/sites.json` projection; fixture data commits the catalog while the local registered-site workflow publishes it from the admin registry.

## 4. User-facing routing

The browser contract is intentionally small:

~~~text
/            site selection
/:site       site home
/:site/*     artifact view
~~~

Storage implementation paths are internal details and should not become the primary URLs users share.

Example:

~~~text
user URL:
/sre/incidents/123.html

internal artifact URL:
/_artifacts/sre/incidents/123.html
~~~

The SPA resolves the logical route and loads the corresponding artifact. Indexed document routes
retain their full source-relative path, filename, and extension; `/:site` remains the separate site-home route.

A path that names the same route in a non-canonical form is corrected in place: the app replaces the address-bar URL (no history entry, query and fragment kept) when duplicate slashes collapse (`/guide//en//reading.html` becomes `/guide/en/reading.html`) or a trailing slash follows the site ID alone (`/guide/` becomes `/guide`). A folder-like path such as `/guide/en/` is left as written and is not turned into a listing.

## 5. Storage projection

The initial projection shape is:

~~~text
/
├── index.html
├── assets/
├── _indexes/
│   ├── sites.json
│   ├── sre/
│   │   ├── meta.json
│   │   └── index.json
│   ├── frontend/
│   │   ├── meta.json
│   │   └── index.json
│   └── platform/
│       ├── meta.json
│       └── index.json
└── _artifacts/
    ├── sre/
    ├── frontend/
    └── platform/
~~~

### 5.1 Site discovery

Unknown or invalid site routes and unmatched artifact routes use a common reader-facing `Page not found` message rather than exposing site-ID parsing or storage-index details. An unknown route offers a return to All sites; an unmatched artifact retains its known site's navigation and offers Back to site. Registered-but-unpublished sites and loading/network failures remain distinct states. This is an SPA presentation contract, not an HTTP-status or private-storage access-control mechanism; an edge-served SPA shell may still have HTTP status 200.

Fixture and registered modes read the static `/_indexes/sites.json` catalog and fetch each listed site's small `<site>/meta.json` discovery metadata. This metadata contains the site's display name, artifact count, generated time, and an `artifactIndexUrl` pointer. It does not contain artifact records. The catalog is a committed projection in fixture mode and is built from the admin-owned YAML registry for registered deployments. This contract does not depend on nginx autoindex or an object-storage list API at browser request time.

A failure to fetch or validate one site's metadata does not invalidate the site catalog. A metadata 404 leaves that registered site visible as not yet published; another metadata error leaves it visible with a details-unavailable state. Neither state displays an artifact count. Site selection and site search continue to include registered entries. If the full index is also missing for a site whose metadata is missing or unavailable, the route explains that the site is registered but not yet available. A site absent from a successfully loaded registry uses the not-found state. Registry fetch or validation failures remain catalog errors, and full-index failures remain scoped to the active site.

The browser loads a site's full artifact index only when that site becomes active. It does not fetch all artifact indexes during startup. An empty catalog is represented by `{"schemaVersion":1,"sites":[]}`; catalog entries are sorted by site ID and identify the logical site name and source mapping.

For the registered deployment model, the admin repository's YAML registry is projected to `/_indexes/sites.json`. This static JSON replaces storage directory listing as the site-discovery and publisher-eligibility source. The browser uses its site IDs and names for discovery, then fetches per-site `meta.json`; the publisher uses the source mapping to check whether its repository and source path are registered.

The sites registry changes when sites are registered or unregistered, not on each artifact publication. The per-site metadata and full artifact index remain at `/_indexes/<site>/meta.json` and `/_indexes/<site>/index.json`.

### 5.2 Site metadata and artifact index

Each site has two static JSON documents with distinct responsibilities, colocated in its directory:

~~~text
/_indexes/<site>/meta.json        lightweight discovery metadata
/_indexes/<site>/index.json       artifact records for that site
~~~

Example discovery metadata:

~~~json
{
  "schemaVersion": 1,
  "site": { "id": "sre", "title": "SRE & Platform" },
  "generatedAt": "2026-09-22T00:00:00Z",
  "artifactCount": 1,
  "artifactIndexUrl": "/_indexes/sre/index.json"
}
~~~

The `artifactIndexUrl` pointer keeps the browser from hard-coding the artifact-index location. The navigation/palette implementation still publishes one complete artifact index per site. Submit-to-search full-text data is a separate projection advertised by `fullTextUrl`; see [the full-text core contract](architecture/fulltext-search.md). It does not change the navigation index loading model.

A registered site may have no HTML or Markdown documents. Its index uses `"artifacts": []`, and its discovery metadata reports `"artifactCount": 0`. This is a published empty site, distinct from an unpublished site: `/:site` remains the site home and shows an empty state, while an explicit document route such as `/:site/index.html` is not inferred. Static resources still follow normal publish rules, and stale document objects are removed during reconciliation without unregistering the site.

Example artifact index:

~~~json
{
  "schemaVersion": 1,
  "site": {
    "id": "sre",
    "title": "SRE & Platform"
  },
  "generatedAt": "2026-09-22T00:00:00Z",
  "artifacts": [
    {
      "id": "incidents/123.html",
      "title": "Incident 123 Review",
      "path": "incidents/123.html",
      "format": "html",
      "artifactUrl": "/_artifacts/sre/incidents/123.html",
      "updatedAt": "2026-09-22T00:00:00Z",
      "lastCommitter": {
        "name": "Octocat"
      },
      "source": {
        "repository": "example/sre",
        "repositoryUrl": "https://github.com/example/sre",
        "ref": "main",
        "filePath": "artifacts/incidents/123.html"
      },
      "toc": [
        { "level": 1, "text": "Summary", "id": "summary" },
        { "level": 2, "text": "Root cause", "id": "root-cause" }
      ]
    }
  ]
}
~~~

Before the first release, schema version 1 uses the `format` field (`html` or `markdown`) and the
exact source-relative document path as each artifact's stable identity. No compatibility layer for
earlier pre-release shapes is required.

The builder indexes `.html`, `.htm`, and `.md` documents as individual artifacts. `id` and `path`
are the exact source-relative path, including filename and extension; `artifactUrl` points to the
unchanged file under the artifact tree. `index.html`, `README.md`, and other documents are opened
explicitly and do not act as implicit directory landing pages. Thus `foo.html` and `foo.md` are
distinct pages and routes. Static resources such as CSS, JavaScript, images, and fonts are available
to pages but are not independently indexed.

Artifact `id` and `path` values use slash-separated, source-relative UTF-8 names and are not URL-encoded in JSON. When producing `artifactUrl` or a logical `/:site/...` route, percent-encode each path segment independently and retain `/` only as the segment separator. This keeps spaces, `#`, `?`, `%`, and non-ASCII characters from changing URL structure; use URL-path encoding, not form encoding (`+` is a literal plus, not a space), and decode each segment at most once. Do not slugify or otherwise rewrite valid names. Reject filenames that are not valid UTF-8 rather than serializing a lossy replacement into the index. Storage keys preserve the source-relative directory structure and names.

For Markdown, the first H1 supplies the display title, with a readable filename fallback when there
is no H1. HTML uses its `<title>` when present and falls back to the readable filename when absent.
Filename-derived titles remove the extension, turn hyphens and underscores into spaces, and uppercase
the first Unicode character of each word without changing the remaining characters. Explicit titles
retain their original text. Markdown headings are indexed for Contents, and generated heading IDs
match the reader. HTML retains its existing precomputed heading behavior.

### 5.3 Reader compatibility and the republish state

Each published format carries an integer `schemaVersion`: the registry (`/_indexes/sites.json`), `meta.json`, `index.json`, preview catalogs and revision manifests, full-text search data, and the CLI's control records (site locks, registry cleanup, site cache retry records, and per-site publish state). A format's version changes only for a breaking change to that format; additive changes keep it. The full-text manifest still names its field `version`; it is renamed `schemaVersion` in that format's next breaking change. [TD2](backlog/technical-design/TD2-component-release-policy.md) defines which product release steps may change versions and what operators must do.

All readers, in the web app and the CLI, follow the same rules:

- **Unknown fields are ignored.** No reader validates exact key sets or fails on an unexpected field. Required fields are still validated.
- **A missing optional field means the feature is unavailable.** For example, a site without `fullTextUrl` (published by an earlier version, or whose publish did not complete) has no page text search.
- **An unknown `schemaVersion` is a confirmed but unreadable format.** The reader checks `schemaVersion` before anything else, so data in a newer shape is never misread or reported as malformed. A missing or non-integer `schemaVersion` remains invalid data.

Web behavior for an unknown `schemaVersion`:

| Format | Reader-facing result |
| --- | --- |
| `sites.json` | The site picker shows the product-level state "This library needs to be updated": the list of sites uses a format this version cannot read and the administrator should register the sites again and republish each one. |
| `meta.json` | The site stays listed on the picker with the label "Registered · needs to be republished". |
| `index.json` (or a site opened with an unreadable `meta.json` and no readable index) | The site route, including deep links to artifacts, shows "This site needs to be republished" with a short explanation for readers and a "← All sites" action. |
| Preview catalog / manifest | The preview list shows "Previews need to be republished" (catalog) or "Some previews need to be republished and are not listed" (manifest); a preview document shows "This preview needs to be republished"; site home reports that previews need republishing. The published site itself is unaffected. |
| Full-text manifest | Page text search reports "Page text search needs to be republished"; the rest of the site works. |

This state is distinct from the network and invalid-data errors ("Unable to load this site", "Unable to load sites", "Search data could not be read"), which describe a failed or malformed response rather than a confirmed format mismatch, and from "Page not found". It is not retryable: only a publish with a matching CLI resolves it.

CLI behavior: every command that reads published data or a control record checks `schemaVersion` first and fails, without writing, with a message naming the record, the version found and the version this CLI reads. For data written by a newer major version it says to upgrade the CLI to that release and follow the release notes' upgrade procedure (`registry register`, `app deploy`, then republish every site); for older data it says to republish with this CLI or use the matching older release.

### Per-site publish state and reconciliation

The publisher keeps a private, site-scoped state record at `/_control/publish-state/<site>.json.gz`. Schema 1 uses deterministic gzip and stores the site ID, a committed input root, a committed origin-transaction generation, and a key-sorted inventory of committed objects. Each inventory row records the object key, SHA-256, byte size, `Content-Type`, `Content-Encoding`, `Content-Disposition`, and `Cache-Control`; owned keys are limited to that site's `_artifacts/` prefix and generated `_indexes/<site>/` objects. Schema 1 has no inline pending field. The current prerelease reader accepts this shape only; older private-control shapes fail closed even if they carry the same integer schema version. An unsupported or unreadable record is never treated as a missing state.

The stored state object uses `Content-Type: application/octet-stream`, no `Content-Encoding`, and `Cache-Control: no-store`. Its HTTP metadata carries `artifact-pages-publish-state-schema`, `artifact-pages-publish-input-root`, `artifact-pages-publish-generation`, `artifact-pages-publish-pending=false`, `artifact-pages-sha256` (SHA-256 of the compressed bytes), and `artifact-pages-site`. Every read verifies a non-empty ETag, required metadata, body size and digest, gzip bounds, and schema/body/header agreement. The compressed object is limited to 16 MiB and its uncompressed JSON to 64 MiB. An adapter that uses HEAD followed by GET must confirm the GET ETag matches the preceding HEAD; Cloudflare's R2 adapter instead reads the complete state and HTTP metadata in one GET and does not issue a state HEAD. An oversized state, missing required metadata, malformed record, or unsupported schema fails closed before origin writes and is never treated as absence.

The publisher uses the existing private cache-retry key, `/_control/site-cache/<site>.json`, as the durable transaction journal. Schema 1 records the selected site and the sorted union of pending invalidation paths. When an origin transaction is in progress, it also stores a cryptographically random transaction ID, its committed base generation, and the sorted union of projection keys that may have been written or deleted. The generation in the state record identifies the last committed origin transaction; an input-root-only state update retains that generation. The journal is site-scoped and rejects malformed IDs, duplicate or out-of-scope keys, unsupported schemas, and oversized records. The current prerelease reader accepts this shape only; older private-control shapes fail closed.

The committed input root is a domain-separated fingerprint of the publish inputs and projection policy. It includes the selected site and source identity, source paths and exact file bytes, resolved Git-derived metadata, full-text mode, index/build behavior, and HTTP representation/cache policy. The input-policy version is part of that fingerprint and must be advanced when output-affecting semantics change. The state record's own `schemaVersion` changes when its on-storage contract changes incompatibly.

Every normal publish validates the effective registry and acquires the site lock. It reads the cache/transaction journal before classifying the state. For the default HEAD-first readers, a supported state with a matching reusable input root and no pending origin transaction can skip `Build`, the state-body GET, and per-object origin reconciliation. The R2 adapter uses a single validated GET for the state on every publish; it can still skip `Build` and all per-object reads on a match. JSON reports `buildSkipped: true`; if no preview, cache-retry, or other publication duty remains, the operation reports `no-op` with no changed objects. The normal path does not list or HEAD each artifact, index, or search object and therefore does not detect out-of-band deletion, byte replacement, or HTTP metadata drift. A normal no-op is evidence that the last committed state matches current inputs, not a general origin-integrity audit.

Use `artifact-pages site publish --reconcile` when an operator needs an explicit origin check or repair. This mode lists the complete selected-site artifact and index prefixes and HEAD-checks stored objects against the committed inventory, comparing stored SHA metadata and HTTP representation metadata. It can repair missing objects, stale keys, and metadata drift, but does not GET all object bodies; it cannot detect byte corruption when an out-of-band writer leaves the stored SHA metadata unchanged. Provider listings must be complete, and any listing or HEAD failure stops before stale deletion.

When the state key is confirmed absent, the publisher bootstraps by completely listing both site prefixes and HEAD-checking listed objects. It does not infer an empty origin from a failed or partial listing. The absent state has a stable synthetic base generation so an interrupted first publish can be retried. An existing but unreadable or unsupported state fails closed; it is not silently replaced by inventory.

For a changed projection, the publisher first conditionally writes the journal with a new transaction ID and the monotone union of touched keys. It then writes desired source objects, immutable search blobs, generated index/manifest/meta objects in dependency order, and stale deletes. Every touched key that remains desired is written even if it equals the prior committed row; every touched key now absent is deleted. Only after all origin operations succeed does a conditional state update install the new inventory and set `generation` to the transaction ID. A root update that changes only input metadata retains the existing generation. If an API reports an error after a conditional write may have persisted, the next invocation classifies the stored transaction by comparing its ID and base generation with the state generation: a matching ID means origin commit completed and only cache/preview work remains; a matching base means replay every touched key; any other generation fails closed. The journal remains until the preview catalog and cache invalidation succeed, then it is deleted. These records use the observed ETags for compare-and-swap. Unregister deletes this site's state and retry records as part of exact-site cleanup, while retaining its lock.

This private state is a CLI control format and does not change browser-facing registry, index, metadata, preview, or full-text schemas. A reset after an unsupported private state requires backing up both exact per-site control keys, confirming no publish or cache retry is in progress, and deleting only those keys; the publisher never performs this reset automatically.

Prepared inputs can be marked non-reusable when existing metadata semantics depend on invocation time. In particular, a tracked dependency deletion can make an affected document's `updatedAt` fall back to the captured build time. The publisher then builds again on a repeated invocation rather than freezing or changing that timestamp contract; this volatile deleted-dependency case is outside the fast-path guarantee.

### Publishable source directory

The builder's `sourcePath` is the exact static content tree intended to be served beneath `/_artifacts/<site>/`. It may contain directly authored static files or output from another site generator, but HTML and Markdown must already be ready to publish: this builder does not expand templates, run site generators, bundle CSS or JavaScript, rewrite resource URLs, or copy files.

The builder recursively indexes every `.html`, `.htm`, and `.md` file under that tree, including root-level and nested `index.html` files. Every page uses its full source-relative filename and extension in its route; index files do not alias their parent directories. No directory-name or dotfile heuristic excludes pages; for example, HTML or Markdown under `_includes/` is indexed if that directory is inside `sourcePath`. Select a publishable root that contains the pages to expose and excludes source-only templates or partials.

Local resources referenced by those pages must also be present under `sourcePath`, with their relative directory structure intact. External resources may be referenced over HTTPS under the artifact resource policy described below. The index builder leaves the tree unchanged and emits metadata only. The later publish operation treats the publishable files in `sourcePath` as the desired artifact state: it uploads new and changed files and removes stale objects under that site's artifact prefix, excluding Git metadata such as `.git` and without touching another site, the registry object, or the application plane. It also publishes the generated per-site metadata and index.

Site publish accepts only regular files and directories beneath `sourcePath` for every delivery target, including local storage. It fails on symbolic links or other special filesystem entries; it neither follows a link outside the selected tree nor publishes the link target or link text as an artifact. This keeps the published projection within the declared source boundary and gives object storage consistent file semantics.

For every target, acquire the site's lock (dry-run takes none), revalidate the deployed registry, then build the desired projection locally with the registered name and description and compare it with the origin before writing. A local-storage target additionally checks, before locking, that its storage root does not overlap the source. Upload new and changed artifact files first; after those uploads succeed, replace `index.json` and then `meta.json`; delete stale artifact objects last. This ordering reduces broken references but does not make a multi-object site update atomic. A reader may temporarily observe old metadata with new artifact bytes, a new index while stale objects are still being removed, or cached older content. V1 accepts this eventual-consistency window and does not use versioned release directories or an atomic site pointer.

Publish is idempotent desired-state synchronization, not a transaction with rollback. If an operation fails partway through, it reports failure and releases its lock when it can stop safely; a process crash leaves the lock held for explicit recovery. Retrying the same desired source reuploads or verifies needed objects, republishes index and metadata, removes remaining stale objects, and converges the site. After origin synchronization and preview-catalog reconciliation, site publish requests cache invalidation for changed artifact/resource URLs (including removed objects), changed index/metadata URLs, and the preview catalog when pruned. A successful request does not guarantee every CDN edge has refreshed or update an already-open reader's in-memory state.

Under the same site lock, save the sorted, deduplicated invalidation paths in private `/_control/site-cache/<site>.json` before any projection mutation. Merge outstanding paths from that record into the current plan, including URLs no longer present at the origin. Keep the record on upload, deletion, reconciliation, cache-request, or retry-record cleanup failure; clear it only after synchronization and cache invalidation succeed. A retry with no origin differences still performs pending invalidation and reports `published`, not `no-op`. Dry-run reports `invalidationPaths` without writing the record or requesting cache changes. A real no-op with no pending invalidation performs neither. Unregister removes this site's retry record alongside its projection, while retaining its lock. Scoped publisher credentials must allow read/write/delete on the exact retry-record key as well as the provider's cache-request API.

Invalidation covers both reader-encoded URLs and relative-resource spellings of safe ASCII characters. Adapters may compact requests within the affected site's boundary: AWS uses `/_artifacts/<site>/*` when artifact invalidations exceed 1,000 paths, exceed CloudFront's path-length limit, or contain unsupported tilde/literal-wildcard filenames. Cloudflare replaces more than 100 unique exact paths beneath one site's artifact or index prefix with a URL-prefix invalidation for that same trailing-slash prefix. Prefix compaction can refresh unchanged cached objects inside the affected site prefix; it never broadens to another site, the application plane, `/_indexes/sites.json`, or control data. Preview catalog and other unrelated paths remain exact. The optional adapter planning interface makes the actual provider request path set visible in dry-run and `invalidationPaths`; the private retry record retains the original exact requested URLs. Cloudflare supports prefix purge on all plans and allows up to 100 prefixes per request; rate limits still apply. These paths request cache refresh, not removal of origin data. See [CloudFront's path restrictions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/invalidation-specifying-objects.html) and [Cloudflare's prefix purge limits](https://developers.cloudflare.com/cache/how-to/purge-cache/purge_by_prefix/).

`sourcePath` must be inside the current Git working tree. Documents with Git history provide commit-based `updatedAt` and `lastCommitter` metadata; a shared-resource commit contributes Git metadata only to documents that themselves have Git history. Files without Git history, including ignored or generated output, remain indexable; for them `updatedAt` falls back to filesystem modification times and `lastCommitter` is omitted. Prefer tracked, publishable documents when Git-derived details are required.

**Shallow checkouts.** A checkout with truncated history (`git rev-parse --is-shallow-repository`) produces the same Git metadata as a full clone. The CLI never reports a shallow boundary commit, which Git treats as having added every file, as a document's last commit. A complete checkout reads history directly, unchanged. In a shallow checkout, `site publish` (including `--dry-run`) first reads the committed publish state and the deployed `index.json` it vouches for (read-only; the index bytes must match the digest recorded in the state). A document keeps its deployed `updatedAt` and `lastCommitter` when it was deployed with a committer, its attribution scope has the same paths and SHA-256 values as the committed state under the same document layout, and no source path removed since the deployment rolls up into it. The attribution scope is the document file plus the non-document files that roll up into it, as above. A visible non-boundary commit newer than the deployed value that touches the scope replaces the deployed value. Every other document is computed with `git log` and accepted only when its newest touching commit is strictly newer than every shallow boundary commit touching it. Otherwise the CLI deepens the checkout from `origin` (cumulative `git fetch --deepen` steps of 8, 32, 128, 512 and 2048 commits, then `--unshallow`) and recomputes. With no trustworthy deployed state (first publish, no state root, or an index whose digest differs from the state's), the CLI unshallows first and then proceeds as for a complete checkout. A published result therefore does not depend on the clone depth, except that history that leaves no byte difference is invisible to carry-forward: a commit between two publishes that touches a document's scope without changing its bytes (a revert to the deployed bytes, a touch, or a history rewrite preserving content) is seen only when it lies within the fetched history. Use a full clone (`fetch-depth: 0`) when such commits must be reflected. The product owner accepted this limitation on 2026-10-05 as a constraint (the carried-forward `updatedAt` and `lastCommitter` are kept), with no change to the publish-state schema.

Deepening only fetches Git objects into the local checkout; it writes nothing to the provider and is therefore also performed in dry-run, so the plan equals the real run. Fetches go to `origin`. When `origin` is an HTTPS URL on `github.com` or on the host of `GITHUB_SERVER_URL`, no `http.extraheader` is already configured for it, and `ARTIFACT_PAGES_FETCH_TOKEN`, `GITHUB_TOKEN` or `GH_TOKEN` is set (in that order of preference), the CLI supplies that token as an `http.extraheader` through `GIT_CONFIG_*` environment variables of the fetch subprocess only. The token is not written to Git configuration, files, or output, and fetches never prompt for credentials. A failed fetch fails the command with guidance to use `fetch-depth: 0` or provide a token that can read the repository; the CLI never falls back to shallow-boundary metadata.

The index should eventually contain enough information to support:

- recent artifacts
- title search
- filename/path search
- tree navigation
- source/path grouping where useful
- table of contents
- deep links

The browser should not need S3 ListObjects or equivalent runtime storage listing APIs.

## 6. Artifacts

Artifact bytes are served beneath:

~~~text
/_artifacts/<site>/...
~~~

The platform does not define "static artifact" by file extension. HTML may depend on:

- CSS
- JavaScript
- images
- SVG
- fonts
- JSON
- WASM
- other static relative resources

The publisher therefore works on declared source paths / mounts, not on a hard-coded extension allowlist.

Relative resources should work naturally because artifact directory structure is preserved in the storage projection. Resolve ordinary HTML references from the artifact document URL, CSS `url()` references from the stylesheet URL, and module imports from the importing module URL.

Artifact-owned resources should normally use relative URLs that stay within their artifact directory. A root-relative URL such as `/assets/report.css` starts at the origin root and does not retain the `/_artifacts/<site>/...` namespace; enough `../` segments can also leave the artifact tree. Sites may contain identical relative paths and filenames; while references stay within their artifact directories, their full URLs remain distinct because each site's tree has its own prefix. Missing artifact resources should return a real 404, not the SPA fallback document.

### HTTP representation metadata

Publishing preserves each source file's bytes and relative path, and sets the stored object's `Content-Type` from a deterministic, case-insensitive extension map. Do not depend on the publishing host's operating-system MIME database for formats the product supports. The required mappings are listed below. The generated `meta.json`, `index.json`, and `sites.json` are `application/json; charset=utf-8`. Unrecognized extensions use `application/octet-stream`; they are still copied and addressable, but the builder does not inspect their contents to guess a type.

The initial required mappings are:

| Extensions | `Content-Type` |
| --- | --- |
| `.html`, `.htm` | `text/html; charset=utf-8` |
| `.md`, `.markdown` | `text/markdown; charset=utf-8` |
| `.css` | `text/css; charset=utf-8` |
| `.js`, `.mjs`, `.cjs` | `text/javascript; charset=utf-8` |
| `.json`, `.map` | `application/json; charset=utf-8` |
| `.webmanifest` | `application/manifest+json; charset=utf-8` |
| `.svg` | `image/svg+xml; charset=utf-8` |
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.avif` | `image/avif` |
| `.ico` | `image/vnd.microsoft.icon` |
| `.woff` | `font/woff` |
| `.woff2` | `font/woff2` |
| `.ttf` | `font/ttf` |
| `.otf` | `font/otf` |
| `.pdf` | `application/pdf` |
| `.wasm` | `application/wasm` |
| unrecognized extension | `application/octet-stream` |

Do not set `Content-Disposition: attachment` by default; HTML and other browser-native artifacts must remain directly viewable. Do not set `Content-Encoding` unless the stored bytes have actually been encoded that way. Provider/CDN-side transparent compression is allowed, but must preserve normal browser decoding and must not change the source objects or their URLs. Cache policy is defined separately in the caching section; `Content-Type` selection must not alter it.

## 7. Artifact viewer

HTML artifacts are displayed in an iframe. Markdown artifacts are rendered by the native reader inside the application workspace.

The iframe behavior for HTML artifacts:

- preserve normal relative URL behavior
- isolate artifact CSS from the application shell
- avoid injecting arbitrary HTML into the SPA DOM
- allow normal browser HTML and JavaScript behavior for published artifacts
- keep the SPA focused on navigation and discovery

The iframe intentionally has no `sandbox` attribute. Publishing HTML is the trust boundary: HTML is treated as approved executable content and can use normal browser capabilities. It can access the same-origin application and other same-origin content; the iframe is for rendering and CSS isolation, not hostile-content isolation.

The hosting layer sends an enforced Content Security Policy that allows resources from the current logical site's `/_artifacts/<site>/` path and from HTTPS origins. This lets ordinary browser-rendered HTML load remote CSS, JavaScript, images, fonts, media, and fetch/XHR resources when the browser's normal TLS, CORS, and mixed-content rules permit them. Insecure external HTTP resources remain blocked. Inline scripts, styles, and eval remain allowed because published artifacts are trusted.

The `https:` source is intentionally broad: it matches resources from any HTTPS origin, including other logical-site paths on the application's own HTTPS origin. Therefore the path source is not a cross-site isolation boundary when the application is served over HTTPS. Do not use `'self'` as a replacement; all logical sites share one origin. This behavior is acceptable only under the current trust model, where publishing an artifact means approving its active content and network requests. Browsers may disclose ordinary request metadata to remote resource hosts.

The policy does not confine redirects to an artifact path: an allowed HTTPS resource may redirect to another HTTPS URL. Any future hosting adapter must preserve the HTTPS-resource behavior and the same trusted-publisher assumption. If mutually untrusted publishers or private artifacts need isolation, use a per-site HTTPS-origin allowlist or a separate origin before supporting that use case.

Delivery must not alter the bytes of an artifact or preview object: the response body equals the published object. Edge features that rewrite or inject into response bodies, such as email obfuscation, Rocket Loader, Automatic HTTPS Rewrites, Fonts, analytics injection, and Polish, are disabled for the Artifact Pages hostname by the provider module, scoped to that hostname rather than the zone.

Artifacts are served from the same origin as the SPA under `/_artifacts/*`. The policy does not isolate artifacts: an artifact script can access the parent application and other same-origin resources, and the broad HTTPS source permits same-origin HTTPS requests outside its site prefix. This product trusts published HTML rather than isolating hostile publishers. If private or authenticated content, or mutually untrusted HTML publishers, become part of the product, artifact hosting must move to a separate origin and the security model must be revisited before that use case is supported.

### Markdown reader trust boundary

Markdown is rendered in the SPA DOM and is not treated as executable HTML. Raw HTML passes through the sanitizer before it reaches React-rendered content; script-bearing or otherwise disallowed elements and attributes are removed. Mermaid code fences are rendered locally with Mermaid's `securityLevel: "strict"` and without diagram interactions. A render failure leaves the source visible as code.

Relative resources resolve from the Markdown artifact URL and are allowed only inside that site's artifact namespace. Links to same-site `.html`, `.htm`, or `.md` artifacts become application routes; other external links open in a new tab with `noopener`/`noreferrer`. External HTTPS URLs are allowed for links and images. External HTTP resources are blocked; `data:` is allowed only for base64 PNG, JPEG, GIF, WebP, or AVIF images. `mailto:` links are allowed. This is a different trust model from HTML: publishing Markdown does not grant arbitrary script execution.

The right-hand table of contents should use precomputed index metadata rather than requiring the parent application to inspect the iframe DOM.

## 8. Browser UX

Target layout:

~~~text
┌──────────────────────────────────────────────────────────┐
│ Git Artifact Pages                         Search        │
├─────────────────┬─────────────────────────┬──────────────┤
│                 │                         │              │
│ Artifact tree   │ Artifact viewer         │ Contents     │
│ filters/search  │ iframe                  │ H1 / H2 / H3 │
│                 │                         │              │
└─────────────────┴─────────────────────────┴──────────────┘
~~~

### Root route

/ presents site selection using discovered lightweight metadata.

### Site home

/:site uses discovery metadata for the site picker and loads the active site's artifact index from its `artifactIndexUrl`; it initially presents recent artifacts, expected to start with roughly the latest 10 entries. It has no inline filter: a "Jump to a page… ⌘ K" button opens the command palette, and a quiet link leads to the site's Previews list.

The site picker marks sites that publish page text search. Below nine sites it lists them without a separate search trigger; ⌘ K still opens site search.

### Search

Finding a page by name and searching page text are separate surfaces.

Normal page search (the ⌘ K palette) is client-side and scoped to the active site's artifact index. It must not read other sites' artifact indexes. It has no scope tabs. A blank query lists the reader's Pinned pages, then Recently read pages, then commands; with neither, it lists ranked pages. Pins and reads also boost ranking. The `@` prefix searches lightweight site metadata (name, ID and description) and switches site; a site whose name or ID matches is listed before one that matches only in its description. `>` searches commands; `#` searches headings in the open artifact. Matching folds compatibility forms (NFKC, then lowercase) in both the query and the text, so full-width input such as `ＲＥＡＤ` matches `read`, and the full-width prefixes `＠`, `＞` and `＃` select the same modes as `@`, `>` and `#`. Palette options are listbox options, not links. After a choice that navigates, keyboard focus lands on the page (the artifact frame, or the main region); Esc or closing without a choice returns focus to the element that had it before the palette opened (the main region when nothing had focus). On the site picker, with no registered page text search, an empty result says pages are searched after a site is chosen. Cross-site artifact search is not implemented. If it becomes a product need, evaluate its cost and UX separately rather than widening ordinary search silently.

Initial searchable fields:

- title
- path
- filename where available

Search should feel immediate after the index is loaded.

Page text search data is always built and published by `site publish` and `index build`, with no option to omit it, and is advertised by `meta.json.fullTextUrl`. A site whose metadata lacks `fullTextUrl` (for example one published by an earlier version) has no page text search until it is republished. Previews are excluded. It searches the active site's normalized static title/body text with whitespace-separated AND substring terms, returning full artifact IDs/logical routes, total count and a path-ordered result page. Ranking and snippets are not provided. The versioned format, caching, update/retry and extraction semantics are defined in [the full-text core contract](architecture/fulltext-search.md).

On a site that advertises it, the sidebar's search field takes a committed query: typing does not search, Enter searches (an IME conversion Enter does not), and Esc or × clears (clearing a draft that was never searched leaves the URL and history unchanged). × and a failure's Try again leave keyboard focus in the field. Enter on the query that is already committed adds no history entry; after a failure it retries. Committing a new query keeps the URL fragment. Search data is fetched only for a committed nonblank query; showing or typing in the field downloads nothing. The committed query is kept in the URL as `?q=` and persists while moving within the site, so reload and back/forward restore it. Only the latest submission may update the results. Results replace the sidebar's Pinned and Browse sections, grouped by folder in path order, 20 per page with a control to show more (keyboard focus on that control moves to the first new result, expanding its folder if the reader collapsed it, unless the reader moved focus while the page loaded, including to the page itself by clicking its text), and show the open page's position as "n / total". Editing the query after a search dims the previous results until Enter. Loading, zero results (explaining that every word must match), network failures (including a search decoder that fails to load) versus invalid-data failures with a retry, and a query the search cannot run (for example one longer than 4,096 characters) are distinguished; only loading, result and error changes (including a failure to load more results) are announced to assistive technology. If the site's search data changes between pages of results, the list is fetched again from the start instead of mixing generations. ⌘ ⇧ F (Ctrl ⇧ F) focuses the field. With the sidebar collapsed, a chip in the workspace header shows the query and reopens it. The committed terms are highlighted in the open HTML or Markdown page without changing the artifact DOM (the highlight style is an adopted style sheet; only browsers without constructable style sheets get a style element), and each newly committed query (including one present when the page loads) scrolls its first match into view unless the URL, or the HTML artifact frame's own location after an in-artifact link, has a fragment, or the reader has already started scrolling the page since it loaded or the query was committed (a fragment change does not reset this, and removing the fragment from an HTML page does not reload the frame or scroll to the first match; a match found late, for example in a diagram, then only gets highlighted); re-applying the same query while the page renders does not scroll again. Matching follows the core's normalization (NFKC, then lowercase over the whole text) within single text nodes.

When the query is not blank, the palette also offers "Search page text for …" after the page matches (selected by default when no page name matches), and ⌘ ↵ hands the query to the sidebar at any time; after a hand-off focus is in the sidebar's search field, so ↓ enters the results. On a site without page text search the sidebar shows a "Jump to a page… ⌘ K" button instead of the field, the palette offers no hand-off, and ⌘ ⇧ F shows a short notice.

### Links, tab titles and shortcuts

Every row that navigates is a real link (`<a href>` to its logical route): site picker cards, Recently updated and Browse rows on the site home, sidebar Browse and Pinned items, page text search results, and breadcrumb menu entries. Only a plain primary click is handled in the app; ⌘/Ctrl/Shift/Alt-click, middle-click and "copy link address" keep the browser's behavior. A link's `href` already carries the committed `?q=` wherever following it in the app would (within the same site, never to previews). Counts read "1 artifact" and "N artifacts".

The tab title reads from the most specific page to its container, joined by " · ": an artifact is "<artifact title> · <site title>", a site home is "<site title>", the site picker is "Git Artifact Pages", the Previews list is "Previews · <site title>", a preview document is "<document title> · Previews · <site title>", and a not-found page inside a site is "Page not found · <site title>". Pages outside any site (loading, error and not-found states) end with "· Git Artifact Pages". The site title is the registered name; the site ID stands in until the registry has loaded.

⌘ B (Ctrl B) toggles the sidebar, ⌘ K opens the palette and ⌘ ⇧ F focuses page text search from anywhere in the app, including while keyboard focus is inside an HTML artifact's frame. "Copy link" (the header button and the palette command) copies the document's link without the reader's `?q=` search and with its fragment; the committed search is personal context, not part of the document.

Below 620 px wide the workspace header puts the breadcrumb path on its own row above the actions, so the current document's title keeps the full width (an ellipsis at its end at most) while the folder menus stay available. The site picker keeps its "Page text search" badge at every width (smaller on narrow screens).

### Left sidebar

The left sidebar derives a tree/navigation model from the site index. Its top holds the page text search field, or a "Jump to a page… ⌘ K" button on sites without page text search; the sidebar does not filter by name, which the palette does. Artifact rows may offer Pin/Unpin, Copy link, Open source, View history, and Open raw artifact actions. Pin stores only a site-scoped artifact reference in the current browser's local storage; it does not change the index, artifact bytes, source tree, or Browse hierarchy. The Pinned section is a shortcut list above Browse. Recently updated pages are listed on the site home rather than in the sidebar. Copy link copies the application's artifact route (without `?q=`), while raw/source/history actions open their corresponding projections in a new tab. No sidebar action mutates Git content.

### Main pane

HTML artifacts are loaded from `/_artifacts/*` into the iframe. Markdown artifacts are rendered in
the application's native reader within the same workspace.

The Markdown reader supports CommonMark and GitHub Flavored Markdown, including tables, task lists,
strikethrough, autolinks, and footnotes. Mermaid code fences are rendered client-side in strict
security mode, with diagram interactions disabled. Embedded raw HTML is sanitized before entering
the application DOM. Relative assets resolve from the Markdown file's location. Links to other
indexed Markdown or HTML documents navigate to their extension-preserving application routes.

### Right sidebar

The optional right panel has two views, toggled from the workspace header:

- **Contents** displays table-of-contents metadata and navigates to heading anchors in the artifact.
- **Details** displays the last Git committer, last-updated date, and source repository link/ref.

Both views use the same overlay panel so opening metadata does not narrow or reflow the artifact. `updatedAt` describes the artifact's last relevant source update, not the index generation time. `lastCommitter.name` is the committer name recorded in Git for that latest relevant source change; it is not a claim about the artifact's original author or a resolved GitHub account. Commit email addresses are not included in the public index. `source.repositoryUrl` is the canonical clickable repository URL, while `repository` remains its display name. `source.filePath` is the exact source file path relative to the Git repository root; unlike the artifact route path, it includes the configured `sourcePath` prefix. It lets the reader open the correct source file or file-specific Git history without guessing that the published source root is the repository root.

## 9. Initial builder source model

The initial index build consumes one source per site:

~~~text
(repository, ref, sourcePath)
~~~

Artifact paths and IDs are relative to `sourcePath`; repository identity is recorded as metadata, not exposed in the site's public route. For example:

~~~yaml
site: sre
repository: company/sre-monorepo
ref: main
sourcePath: docs/artifacts
~~~

An artifact-only repository can use its root as the source:

~~~yaml
site: sre
repository: company/sre-artifacts
ref: main
sourcePath: .
~~~

There is no mount-path merge in the initial builder. A later publisher may add explicit mounting if a validated use case needs it.

## 10. Multiple repositories in one site (deferred)

This is a possible future capability, not an MVP requirement. The initial builder does not merge multiple repositories or require a registry to allocate mount paths.

Example:

~~~text
site: sre

/incidents     ← company/sre
/architecture  ← company/platform
/runbooks      ← company/operations
~~~

If multi-repository publishing is introduced, the registry must guarantee that mount paths within a site do not overlap.

Invalid examples:

~~~text
/reports
/reports
~~~

and:

~~~text
/reports
/reports/security
~~~

Parent/child overlap is rejected because a publisher using delete/sync semantics could affect another publisher's namespace.

The browser-facing projection has lightweight `/_indexes/sre/meta.json` discovery metadata and a full `/_indexes/sre/index.json` artifact index for the site.

How multiple publisher contributions might be staged and merged into that single index is a future implementation concern. Source-specific manifests are one possible internal mechanism, but are not required by the browser-facing contract or the initial builder.

## 11. Registry

The operator/admin repository owns one human-maintained YAML configuration, reviewed and versioned in Git. It selects the deployment target and may also contain the complete site registry as an optional top-level `sites` mapping. The admin runs an explicit registry operation to validate that mapping, generate a public, machine-readable JSON projection, and deploy it at `/_indexes/sites.json`; the generated JSON is never edited independently. The browser and satellite publisher use the deployed projection, avoiding YAML parsing in the browser. A satellite publisher does not use the config's `sites` mapping for eligibility or require a checkout of the admin repository.

There is no separate V1 `sites.yaml` file or `--manifest` input. The unified config is usually `artifact-pages.yaml` in the admin repository, though callers may select another filename. A change to its `sites` mapping is reconciled only by `registry register` or `registry unregister`; site publishing, preview publishing, and app deployment do not reconcile the registry. Application and satellite repositories do not maintain copies of the admin registry.

In the initial one-repository-per-site model, each YAML site entry maps a logical site ID to one source repository and an exact `sourcePath`:

~~~yaml
schemaVersion: 1
provider: local
local:
  root: .local/storage
sites:
  sre:
    name: "SRE & Platform"
    repository: company/sre-monorepo
    sourcePath: docs/artifacts
~~~

The site ID is the stable machine key; `name` is the human-readable display name and may contain spaces or punctuation. `name` is canonical in the registry. Per-site `meta.json` and `index.json` carry it as `site.title` for the browser, generated from the registry rather than edited separately. An entry may also carry an optional one-line `description`; a blank value is omitted. It is copied into `sites.json` and into `site.description` in `meta.json` and `index.json`, and the site picker shows it.

For GitHub, source identity is the human-readable `owner/repo` locator together with `sourcePath`; a numeric repository ID is not required. If a repository is renamed or transferred, its locator in the registry must be updated.

The registry's `repository` value is exactly `owner/repo`—not a clone URL, URL with a host, or a value ending in `.git`. Before publishing, the satellite command retrieves the deployed `/_indexes/sites.json`, identifies the checked-out GitHub repository, normalizes it to `owner/repo`, and compares it with the registered value and `sourcePath`. Registry retrieval and checkout identity detection are separate steps; a Git remote is used only to identify the satellite source, not to locate the registry.

The registry deliberately has no branch/ref field. A site's identity is independent of the publishing branch; the satellite workflow owns the policy for which ref may publish.

Site IDs are machine identifiers used in URL routes and storage paths, not display labels. V1 IDs use lowercase ASCII letters and digits separated by single hyphens (`[a-z0-9]+(?:-[a-z0-9]+)*`). Spaces and other punctuation are invalid even if quoted in YAML. Human-readable names, including names with spaces, belong in the registry's `name` field.

Generated registry example:

The human-maintained YAML uses a mapping keyed by site ID (`sites: {}` is the valid empty form). The deployed JSON projection intentionally uses an array of site records (`"sites": []` when empty), sorted by `id` ascending so equivalent registry content always produces deterministic JSON independent of YAML entry order.

~~~json
{
  "schemaVersion": 1,
  "sites": [
    {
      "id": "sre",
      "name": "SRE & Platform",
      "repository": "company/sre-monorepo",
      "sourcePath": "docs/artifacts"
    }
  ]
}
~~~

The browser reads the registry through the site's distribution endpoint. A satellite publisher reads the deployed object through its provider adapter using its own read-only permission for that object; for AWS this is `s3:GetObject` on `/_indexes/sites.json`, not public access to the S3 bucket. The supported `artifact-pages site publish` command rejects an unregistered or mismatched source before writing. This is a product/workflow-level eligibility check, not a dynamically managed cloud IAM boundary; registering or unregistering a site does not update provider permissions.

Unregistering a site removes its registration and the administrator deletes that site's stored projection, including `/_indexes/<site>/` and `/_artifacts/<site>/`. The registry does not create a separate paused/disabled state.

Before changing `/_indexes/sites.json` or deleting removed-site objects, `registry register` and `registry unregister` write a private `/_control/registry-cleanup.json` intent using a conditional write. The current record has `schemaVersion`, sorted `sites` still requiring origin cleanup, and sorted `paths` still requiring CDN invalidation. These fields have separate meanings: if a later desired registry re-adds a site, cleanup for that site stops and its ID leaves `sites`, but its old URL patterns stay in `paths` until purge succeeds. New registry and cleanup work unions its paths with any pending paths. After all origin cleanup and the complete path invalidation succeed, the CLI deletes the record. A retry after an add-only or metadata-only registry purge failure therefore repeats the purge even though no content deletion is pending. A malformed, incomplete, or older private record without the complete invalidation paths for each pending site fails closed; an operator must explicitly recover that exact private record after backing it up and confirming no operation is active. The CLI never silently discards or reconstructs it.

### Concurrent publish and unregister

Checking the registry and then publishing without coordination has a time-of-check/time-of-use race: an unregister can remove the registration and delete the site's objects after a publisher's check but before that publisher writes. The provider publishing contract therefore uses one cooperative, per-site storage lock shared by satellite publish and `registry unregister` operations.

The per-site lock is a reserved control object outside the site's index and artifact prefixes, at `/_control/locks/sites/<site>.json`. The registry-wide lock is `/_control/locks/registry.json`; the application deployment lock is `/_control/locks/application.json`. None is part of the registry, browser index, or published site data, and deleting a site's projection must not delete a lock. Hosting adapters must not expose control objects through the public site distribution. Keep one small lock record per scope with `free` or `held` state and an opaque operation/run identifier while held; retain free records rather than relying on conditional object deletion. For first use, create a record atomically only if absent. For later acquisitions, releases, and recovery, compare-and-swap the record with a conditional `PutObject` using the current ETag (`If-Match`). This lets a recovery operation detect that the lock changed after inspection rather than clearing a newer owner's lock.

The critical sequences are:

~~~text
satellite publish:
  acquire site lock
  fetch the current deployed registry directly from storage and validate the exact source
  build locally with the registered name and description
  synchronize that site's index and artifact prefixes
  release site lock

registry register:
  serialize with other admin registry operations
  persist pending catalog/site invalidation paths
  reconcile the deployed registry to the complete manifest registration set
  clean content prefixes for sites omitted from the manifest
  invalidate all pending paths, then clear the intent

registry unregister:
  serialize with other admin registry deployments
  reconcile the registry without that site
  acquire the same site lock
  delete that site's index and artifact prefixes
  invalidate/revalidate affected CDN paths
  clear the retry intent
  release site lock

app deploy:
  validate the complete local bundle
  acquire the application lock before reading app-object metadata
  HEAD and compare every bundle object, including for no-op drift repair
  persist /index.html invalidation intent before changed app-object writes
  upload changed assets and index.html last
  invalidate /index.html, then clear the intent
  release the application lock
~~~

The publisher must perform its authoritative registry check **after acquiring the lock**, against the current deployed object rather than a CDN-cached response. `registry unregister` first removes the entry from the deployed registry, closing the gate to new valid site publishes; it then acquires the site lock and waits for any publisher that already passed its check to finish before deleting the projection. A publisher that acquires the lock after registry removal sees the missing entry and exits without writing. Unregister is idempotent for its explicit target site ID: if cleanup fails after registration removal, retry still acquires that site's lock, deletes its prefixes if needed, and repeats the complete cache invalidation request, including `/_indexes/sites.json`, even though the registry entry is already absent. The command reports success after the registry update, origin deletion, and the provider's cache invalidation/revalidation request have succeeded. This is eventual consistency, not global revocation: an edge may serve a stale response while invalidation propagates, and bytes or rendered pages already delivered to a browser cannot be recalled. If the cache request itself fails, the site remains unregistered and its origin data remains deleted, but the command reports failure so cleanup can be retried; the admin registry path stays serialized through this step to prevent re-registration from racing the pending cache update. Unrelated sites use different locks and may publish concurrently. Registry JSON updates are whole-object writes, so all admin registry operations must also be serialized through the single admin path; per-site locks alone do not prevent two admin updates from overwriting each other.

Locks do not expire automatically in v1. This fails closed if a process dies: publishing or unregister cleanup for that site remains blocked until an operator confirms no operation is active and uses a compare-and-swap transition to mark the stale lock free. The Artifact Pages command must provide lock inspection and guarded stale-lock recovery; operators should not need raw provider CLIs. If the ETag changed since inspection, recovery must stop and inspect again. A time-based lease without fencing is not sufficient, because a paused publisher could resume after its lease expires and write anyway. Commands wait/retry for a bounded period when another operation holds the lock, then fail without taking it over; the precise timeout and retry schedule are adapter details. This is coordination among supported Artifact Pages commands, not an IAM security boundary; callers with direct write credentials can bypass it.

The YAML source accepts only the schema shown above: `schemaVersion` must be the integer `1`, `sites` must be a mapping (an empty mapping is valid), and each site entry must contain exactly `name`, `repository`, and `sourcePath`, plus an optional `description` string. Reject duplicate YAML keys, unknown fields, missing fields, and values of the wrong type rather than silently ignoring or overwriting them. The deployed JSON projection uses the separate array shape shown above. Its path and role as the shared runtime representation are fixed for this model. The initial model has one source per site and no mount-path merging; if multi-repository sites are introduced later, the registry must prevent overlapping mount paths.

Registry validation must reject invalid or reserved site IDs, blank names, and unsafe source paths. Site IDs use lowercase ASCII letters and digits separated by single hyphens (`[a-z0-9]+(?:-[a-z0-9]+)*`). Reserve `assets`, which conflicts with the SPA's `/assets/*` application plane; `_indexes` and `_artifacts` are already excluded by the site-ID syntax. Names must be non-empty after trimming; duplicate display names are allowed because the site ID remains the unique key. A GitHub repository locator must be exactly two non-empty `owner/repo` components, not a URL, clone URL, or value ending in `.git`. Repository identity is compared case-insensitively, matching satellite checkout eligibility checks; source paths are compared exactly. Source paths are canonical repository-relative POSIX paths: `.` represents the repository root; absolute paths, `..` segments, backslashes, and leading/trailing whitespace are rejected. A `(repository, sourcePath)` pair may be registered only once under those comparison rules, while different paths in the same repository may belong to different sites. The publisher also verifies that `sourcePath` exists as a directory inside its checkout. If mount-path merging is introduced, it must also reject:

- duplicate mount paths
- ancestor/descendant mount overlap
- ..
- reserved platform namespaces

## 12. Publish-time metadata

Where practical, metadata is produced at publish time instead of browser request time.

Candidate metadata:

- title
- logical path
- filename
- updated time
- last committer recorded by Git
- commit SHA
- source repository
- source repository URL
- source ref
- headings / TOC
- optional tags
- optional description

HTML display-title extraction uses the HTML title element. Markdown display titles use the first H1.

Sidecar metadata may be added later if HTML alone is insufficient.

The initial local builder records the Git committer name for the latest relevant artifact change. It does not infer a GitHub account or expose the committer email; commit activity also supplies `updatedAt`.

## 13. Local reference implementation

Local development should reproduce the production routing contract without AWS.

Target:

~~~text
artifact-pages site publish / fixture seeder
                 ↓ JSON API writes
        local object-storage emulator
                 ↑ origin reads
Browser → nginx edge (Docker Compose)
              ├── /_indexes/*, /_artifacts/* → object API origin
              └── app routes and /assets/* → SPA application plane
~~~

Committed fixture data lives separately from generated local state.

Recommended convention:

~~~text
fixtures/storage/   committed representative projection
.local/             generated/untracked projection
~~~

The local product should be usable before any AWS code exists.

The ordinary filesystem-backed Compose workflow remains useful for fast UI iteration. Separate conformance profiles exercise the publisher's configured object API and have nginx proxy dynamic content requests to that origin; nginx does not mount the dynamic object tree. MinIO supplies the local S3 API shape used for AWS and Cloudflare adapter tests, and fake-gcs-server supplies the emulator-only `gcp-local` JSON API profile. These profiles prove local adapter and HTTP contracts, not equivalence with CloudFront, Cloudflare, Cloud CDN, or live provider services. GCP remains local-only until a separate production-adapter decision and verification exist. Run commands, readiness behavior, and emulator limits are in the [local edge and object-storage guide](guides/local-edge-object-storage.md).

## 14. Testing direction

Target testing layers:

- Vitest for domain/unit behavior
- Storybook for isolated UI states
- Storybook interaction tests for component behavior
- Playwright for full navigation and routing behavior

Important E2E flows include:

- root → choose site
- site home → recent artifact
- palette name search → artifact selection
- committed page text search → result selection, highlight, and `?q=` restoration
- deep-link directly to an artifact
- reload preserves route
- iframe loads nested relative artifact assets, modules, and data from the artifact's site namespace
- Markdown routes retain `.md`, render H1 / GFM / Mermaid, and navigate through Contents links
- relative Markdown images resolve within the same site's artifact tree
- CSP permits external HTTPS resources and blocks external HTTP resource fetches
- missing artifact resources return 404 rather than the SPA shell
- artifact styles remain inside the iframe document
- published scripts retain normal same-origin browser capabilities
- TOC navigation reaches an artifact heading

VRT can be introduced later for the stable application shell. Arbitrary artifact contents should not become the primary VRT responsibility.

## 15. AWS reference architecture

AWS is a reference production adapter, after the local contract is stable. The project's selected public deployment uses Cloudflare; AWS delivery is verified independently against the same static contract.

Expected static architecture:

~~~text
Git
 ↓
GitHub Actions / publisher
 ↓
private S3
 ↓ OAC
CloudFront
 ↓
Browser
~~~

Expected CloudFront routing has three conceptual behaviors:

~~~text
/_indexes/*    → static index content
/_artifacts/*  → static artifact content
Default (*)    → SPA shell
~~~

The first two patterns do not overlap, so their relative order is not semantically important. The default behavior is the fallback.

SPA routes such as `/sre/incidents/123.html` must resolve to the application shell rather than being looked up as literal S3 object keys. The AWS adapter will therefore need an SPA fallback/rewrite mechanism.

The S3 bucket remains private and CloudFront reads it through Origin Access Control.

### 15.1 Project deployment domains

The owner selected the long-lived `artifact-pages.dev` domain and reported its purchase on September 28, 2026. The selected policy uses Cloudflare Registrar with authoritative Cloudflare DNS. Production at the apex uses Cloudflare Cache/CDN and R2 custom-domain delivery, not Pages or Workers Static Assets. `aws.artifact-pages.stream` is the independent AWS verification endpoint: a DNS-only Cloudflare CNAME points directly to CloudFront with a private S3 origin; its ACM viewer certificate is issued in `us-east-1`, with DNS-validation records in Cloudflare. No Route 53 hosted zone is used. The existing AWS module's caller-managed DNS/certificate interface needs the new composed path in [IMP-39](backlog/implementation/IMP-39-aws-cloudflare-dns-acm.md).

This is deployment policy, not a hostname requirement for adopters or a change to Site, Artifact, registry schemas, logical routes, or CLI operation meaning. DNS/certificate orchestration belongs in infrastructure modules/adapters. A future `gcp.artifact-pages.stream` hostname may be added, but does not authorize or imply a production GCP adapter. The [domain and delivery policy](architecture/deployment-domain-policy.html) records module ownership, prerequisites, costs, and the remaining handoff. Acquisition is owner-confirmed; authoritative DNS, TLS, apply, and actual provider behavior remain unverified. Purchase alone does not close T15/T16 delivery proof.

## 16. Cache model

The application and content planes have different lifecycles.

Expected direction:

~~~text
/index.html                          no-cache, max-age=0, must-revalidate
/preview-bridge.js                  no-cache, max-age=0, must-revalidate
/LICENSE                            no-cache, max-age=0, must-revalidate
/THIRD_PARTY_NOTICES.txt            no-cache, max-age=0, must-revalidate
/assets/<fixed-or-unrecognized-name>.* no-cache, max-age=0, must-revalidate
/assets/<name>-<8-character-hash>.*  public, max-age=31536000, immutable
/_indexes/sites.json                 public, max-age=0, s-maxage=60, must-revalidate
/_indexes/<site>/meta.json           public, max-age=0, s-maxage=60, must-revalidate
/_indexes/<site>/index.json          public, max-age=0, s-maxage=60, must-revalidate
/_artifacts/<site>/*                 public, max-age=0, s-maxage=300, must-revalidate
~~~

These are initial product defaults: browsers must revalidate mutable objects on use, while shared CDN caches may retain site metadata/indexes for up to 60 seconds and stable artifact URLs for up to 300 seconds. Site publish requests invalidation of its changed URLs after origin synchronization, with a durable retry record for failures. Bounded freshness remains the fallback while invalidation propagates or when an adapter has no CDN. The provider adapter must honor these upper bounds or use stricter freshness. Vite/Rollup application assets with the default eight-character `-[hash]` filename suffix may be cached for one year because a content change produces a different URL; fixed-name and unrecognized application files must revalidate.

For AWS, the publisher's registry read is directly from the S3 object and therefore does not depend on CloudFront cache freshness; browser visibility still requires timely CDN revalidation or invalidation. During unregister cleanup, the affected cache set includes `/_indexes/sites.json`, `/<site>`, `/<site>/*`, `/_indexes/<site>/*`, `/_artifacts/<site>/*`, and `/_previews/<site>/*`; the adapter requests provider invalidation or equivalent revalidation/expiry and reports failure if that request fails. A successful request does not promise instantaneous global cache convergence or revoke content already delivered to clients. If an operator configures an external access gate at the serving edge, it must cover the desired routes and run before protected bytes are returned from an origin or shared cache. That gate and its verification are deployment concerns; Artifact Pages does not implement identity-aware cache partitioning. Provider implementation details do not change the path sets or freshness contract.

Artifact paths may later become commit-addressed/immutable, which would allow aggressive CDN caching. That is an optimization, not an MVP requirement.

## 17. Publishing and AWS credentials

The user-facing publishing interface is the `artifact-pages` command. Its provider adapter performs the provider API operations; users do not need to invoke raw provider CLIs such as `aws s3` for the product workflow.

### Object-prefix reconciliation

Site publish and unregister must enumerate object prefixes completely before treating the result as the site's current stored state. Adapters follow every listing continuation token/page; they must not assume that one response contains every object. Before deleting stale keys, the command must have successfully completed listings for both `/_artifacts/<site>/` and `/_indexes/<site>/`. A failed or incomplete listing aborts reconciliation rather than risking deletion based on a partial view.

Delete operations use batches within the provider's documented limits and inspect per-object failures as well as request-level errors. A partial delete is a failed operation; retrying the same desired publish or unregister repeats the listing and converges idempotently. Site operations may read or delete only their exact artifact and index prefixes. They must never include `/_indexes/sites.json`, `/_indexes/index.html`, the application plane, or `/_control/locks/sites/<site>.json` in site-content cleanup. Provider pagination and batch sizes stay inside the adapter, not in the product data model.

The intended GitHub-to-AWS path uses GitHub Actions OIDC rather than long-lived AWS access keys. The admin and satellite workflows use separate roles:

- The admin role deploys the application and registry projection, coordinates through the per-site lock during unregistration, and removes a site's stored prefixes.
- A satellite role can read `/_indexes/sites.json`, read and conditionally update its site's reserved lock record, and list and synchronize site content beneath `/_indexes/<site>/` and `/_artifacts/<site>/`, but cannot modify the registry object or application plane. Synchronization may require listing output prefixes and deleting stale objects in addition to uploading files.

The Artifact Pages command validates the deployed registry and acquires the site's lock before it makes content-plane changes. Registration and lock checks are workflow coordination, not a per-site IAM security boundary. Leading-slash paths in this section are logical URLs; their S3 object keys omit the slash.

The reference AWS satellite policy grants `s3:GetObject` on `/_indexes/sites.json`, the selected site's index/artifact/preview objects, and its exact lock, cache-retry, and publish-state objects. `s3:ListBucket` is constrained to the selected site's `_indexes/<site>/`, `_artifacts/<site>/`, and `_previews/<site>/` prefixes plus its exact private control keys. It grants `s3:PutObject` to those selected-site prefixes and exact lock/cache/state objects, and `s3:DeleteObject` to `_artifacts/<site>/*`, `_indexes/<site>/*`, and the exact site cache-retry and publish-state keys. The index deletion scope is required to remove stale `index.json`, `meta.json`, and generated full-text search objects during reconciliation; it never includes `/_indexes/sites.json`. The state key is exactly `_control/publish-state/<site>.json.gz`; read and write support state HEAD/GET and conditional updates, while deletion is needed when unregistering that site.

The admin cleanup role lists `_control/publish-state/*` and has `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on that control prefix so registry reconciliation can clean state for unregistered sites. The CLI also needs `cloudfront:CreateInvalidation` on the configured distribution when a publish or cleanup requests invalidation. See the [AWS module policy](../terraform/modules/aws/README.md) for the reference deployment's IAM scope. Keep these exact object/prefix restrictions when composing roles; do not grant a satellite access to another site's state or the whole registry.

## 18. Viewer access and identity

Artifact Pages is a static publishing and reading product. It has no viewer accounts, login/session model, roles, or per-site access policy. It does not decide which people may view a site.

The operator chooses and configures any viewer-access control at the hosting edge or surrounding network—for example, VPN or IP restrictions, Basic Authentication, an identity provider with CloudFront signed cookies, Cloudflare Access, or an equivalent provider-specific mechanism. The control may protect a hostname, selected paths, or a broader network boundary; that scope belongs to the operator's infrastructure, not to the config's `sites` mapping, the public site catalog, the CLI, or the browser application. Reference infrastructure may accept customer-managed edge configuration as an input, but does not define an Artifact Pages identity or authorization policy.

Once a request is allowed through that boundary, the product serves the same static application and content. The site registry and catalog describe registered sites and publication eligibility; they are not viewer permissions. Hiding a site from navigation or removing it from the catalog is not access control. If access must be restricted, the operator's edge configuration must cover the logical routes and the corresponding raw index, artifact, and preview paths before protected bytes can be returned from an origin or shared cache.

## 19. Distribution model

The eventual OSS distribution is expected to be a set of versioned components rather than one copied template.

Possible surfaces:

~~~text
core / CLI
bundled SPA
Terraform AWS module
GitHub Action
reusable workflow examples
~~~

The core product contract should not require AWS. AWS is a reference infrastructure adapter.

Do not freeze package/repository boundaries before the local and AWS implementations validate the contracts.

### Post-MVP pre-publish preview contract

The [preview publishing contract](architecture/preview-publishing-contract.html) gives the proposed static object layout, completion order, adapter boundary, and validation matrix for this product contract. It is design documentation, not Phase 1 implementation.
The [preview decision register](architecture/preview-decisions.md) records product choices; the backlog tracks remaining [technical design](backlog/technical-design/), [implementation slices](backlog/implementation/README.md), and [verification](backlog/verification/) separately.

Phase 1 includes a focused local developer mode: `cli/cmd/preview-local` builds changed documents from Git into ignored `.local/previews`, and nginx serves them through the same `/_previews/*` object layout and logical browser routes used by the preview reader. This development output is separate from the configured target used by registered-site `artifact-pages site publish` (for example, `.local/storage`). The preview domain depends on a small `PreviewStore` interface for origin reads, immutable object creation, mutable catalog replacement, and a per-site lock; `publisher.ObjectPreviewStore` bridges that contract to the shared deployment backend. At the `PreviewStore` boundary, canonical file keys encode each source path segment once; adapters validate and decode those segments once when mapping to local files or provider object keys. Stored names and manifest paths preserve the original source-relative UTF-8 text, while reader and Action URLs encode each segment once. Local registered-site publish now reconciles missing preview references after committing the production projection. This does not reconcile the separate `.local/previews` directory unless it is the selected deployment target, and it does not establish AWS/Cloudflare origin, cache, provider IAM, retention, or CI-wrapper behavior; those remain separate implementation and verification work. Viewer access remains an operator-managed edge/network concern as described in §18.

Pre-publish is a separate operation from production publish and dry-run. It creates a temporary, site-scoped review projection only for a registered site's source. A pull-request comment may carry a direct URL, but the browser must also be able to discover available previews from within that site. Previews are not inserted into the production artifact index, Browse tree, Recently updated section, page text search, or normal page-search results. The site home has a quiet link to the dedicated Previews list, not an inline list of preview entries. Inside a site, the command palette offers an "Open previews" command that opens the same list. Opening a preview surface loads only that site's lightweight preview catalog, not catalogs for every site at startup.

Preview catalogs, logical routes, raw documents, and bundled resources are static objects served through the configured distribution. They receive no per-site authorization from Artifact Pages; they are reachable to the same extent as other objects covered by the operator's edge/network policy. This applies to pre-merge content as well: a hidden palette entry or an unguessable SHA is not an access control. Operators who do not want preview content available to everyone admitted by the distribution must configure their own edge boundary to cover preview routes and raw preview objects. Preview-only accounts or private-site permissions are not product features.

GitHub pull-request-associated pre-publish initially accepts only a head branch in the site's registered source repository. A pull request targeting that repository but originating from a fork does not inherit its trust: its head content is excluded from pre-publish even if the target site is registered. The Action must verify the head repository identity before any provider-backed publication; the provider's CI identity policy must also constrain which workflows may obtain the publisher role. Do not use a privileged `pull_request_target` workflow to check out and execute untrusted fork content. Supporting fork previews later requires an explicit approval and isolation model, because preview HTML is executable content served in the application's trust boundary. This restriction is separate from the registry's source-path eligibility check.

#### Preview rendering trust model

Preview HTML is trusted published executable content, under the same trust model as production HTML. Pre-publish approves execution of the selected content before merge; it is not a safe viewer for arbitrary untrusted changes. The operator trusts the people and CI allowed to publish. Being in a registered repository does not by itself establish that its contents are safe, and the existing registered-source/no-fork checks do not replace that publication responsibility.

Serve the raw preview document and its bundled resources from the application's origin, and load that document URL in an ordinary iframe without a sandbox. The iframe separates rendering and CSS, not hostile-script execution: preview JavaScript can access the parent application DOM, same-origin content, and origin-scoped browser storage. No separate preview hostname or deployment-config origin field is required. Logical routes, raw keys, head-snapshot bytes, and revision identity stay unchanged. Frame navigation handling still validates the sending frame/origin and allowed manifest/index destinations for routing correctness, not as a hostile-preview isolation boundary.

Use the production HTML resource-policy principles with the preview revision's raw namespace: bundled local resources and external HTTPS resources may load subject to ordinary browser TLS, CORS, and mixed-content rules; insecure external HTTP remains blocked. Do not add blanket `Access-Control-Allow-Origin: null` or wildcard CORS to solve module loading, or retain an opaque-origin `srcDoc` rendering fallback. Third-party cross-origin script reads receive no additional CORS grant. Public static objects are not made private by these rules; viewer access remains the operator's edge/network responsibility.

Preview Markdown retains the native reader's sanitized, non-executable trust model and strict, non-interactive Mermaid rendering. Publishing Markdown does not approve arbitrary script execution. Private control-object denial and real raw-resource 404s remain unchanged for both formats.

The owner accepted this contract on 2026-09-28 in [TD3](backlog/technical-design/TD3-preview-origin-delivery.md). The existing isolated-loopback/opaque-frame reader is a prior implementation model; its replacement and regressions are complete with local proof recorded in T4/T6. Live provider proof remains in T15.

PR provenance is an explicit pre-publish input: the caller may provide a PR number or URL, which is checked against the site's registered source repository. The CLI never infers a PR association: it attaches one only from `--pull-request`. The Action wrapper defaults its `pull-request` input from the event payload only on a `pull_request` event (see below); it never infers a PR from a branch, a commit, `pull_request_target`, or any other event. Without a PR reference, pre-publish creates a manual preview and the reader shows no PR link.

Each preview revision is identified within its site by the resolved source head SHA. The preview renders a snapshot of that head's source tree, not a temporary merge with the default branch and not a guarantee of the eventual post-merge result. The default branch's resolved HEAD at pre-publish time is recorded as comparison provenance and helps select the documents to preview, but is not part of the public revision identity. Its advance alone does not change an existing preview URL. The planned logical document route is `/:site/_previews/<head SHA>/<artifact path>`; `_previews` is reserved within the site namespace.

Select changed documents under the registered source path by comparing the merge-base of the current default-branch HEAD and the source head against the source head. This isolates the source's changes without treating commits added only to the default branch as preview changes. The preview set is the union of two kinds of document, both taken from the head tree under the registered source path. (1) Changed documents: added or modified HTML/Markdown documents; a rename previews the destination path as an addition. (2) Dependency documents: unchanged HTML/Markdown documents whose statically resolvable local rendering-resource closure contains at least one changed non-document file. A changed non-document file is an added, modified, or renamed-destination non-document path under the source, selected with the same merge-base comparison. The closure is computed with the same forward resource collection that builds the bundle (HTML and Markdown references, transitively through CSS `@import`/`url()` and JavaScript imports); the reverse scan runs only when a non-document file changed. Explicit `include` patterns are not part of the closure used for selection, and references that JavaScript constructs at runtime are not detected; both are documented limitations. There is no cap on the number of dependency documents. A deleted source path has no preview and is not shown as a preview item; a document in the head tree that still references a path deleted by the change fails with the missing-resource error rather than being skipped. Each previewed document records a `reason`, `changed` or `dependency`; a dependency document also records the sorted `changedResources` that selected it. Documents are ordered by path regardless of reason. The selected documents and all previewed bytes come from the head tree. Do not use a direct default-branch-HEAD-to-head tree comparison for selection. In a shallow checkout, the CLI first fetches a missing `origin/<branch>` default ref or a missing head SHA at depth 1, then deepens (cumulative `--deepen` steps of 8, 32, 128, 512 and 2048 commits, then `--unshallow`) until the merge-base is exact: a merge-base exists and every shallow boundary reachable from either ref is an ancestor of it (or equal to it), so no more recent common ancestor can be hidden. Selection is therefore identical to a full clone's and never compares against production state. The same credential and failure rules apply as for production publish above. When no document changed and no document depends on a changed resource (a deletion-only document change, a resource change nothing uses, or no change under the source path), the result is an explicit `no-preview` outcome (exit 0) rather than a fabricated page or preview URL, and it is not an error. If a PR group previously had a preview, `no-preview` removes that group's discovery entry without deleting the older bytes.

Keep navigation links distinct from rendering dependencies. For statically resolvable links in previewed HTML or Markdown, a link to another changed document opens that document in the same preview revision; a link to an unchanged document opens its production logical route. HTML links must transition the parent application rather than nesting an application route inside the artifact iframe. Copy the local CSS, JavaScript, images, fonts, and other resources needed to render a previewed document (changed or dependency) from the head tree into the preview bundle, preserving relative relationships where possible. This does not require recursively copying every document reachable by navigation links. External HTTPS links remain external.

Automatically collect statically resolvable local rendering resources. Pre-publish also accepts explicit source-relative paths or patterns for additional non-document resources whose names are constructed dynamically; reject missing paths, paths outside the registered source tree, and attempts to include unchanged HTML/Markdown as a shortcut around the document-selection rule; unchanged documents enter a preview only as dependency documents. Such an include makes relative dynamic resource URLs work when their resolved preview locations match the copied layout. It cannot generically redirect JavaScript-built root-relative URLs or rewrite arbitrary runtime navigation, so those behaviors are outside the automatic preview guarantee.

#### CLI and Action interface

Provider-backed pre-publish is exposed as a separate command from local development preview and production site publish:

~~~sh
artifact-pages preview publish --site ID [--source DIR] [--base-url ORIGIN] \
  [--head REF] [--default-ref REF] [--pull-request REF] [--include PATH] \
  [--config LOCATOR] [--dry-run] [--format text|json]
~~~

`--site` is required. `--source` is relative to the current Git checkout and must exactly match the registered source path; when omitted it defaults to that registered source path, read from the deployed registry (the same default `site publish` applies), and the exact-match check runs against the deployed registry before any write either way. `--head` selects the preview tree and defaults to `HEAD`; `--default-ref` selects the current default-branch reference used for merge-base comparison and defaults to `origin/HEAD`. Only committed Git trees at those refs are read. `--base-url` is an HTTP(S) origin without a path, query, or fragment; it is used to construct the returned group and document URLs. An explicit `--base-url` always wins. When omitted, the origin comes from the selected deployment config: the provider-neutral top-level `publicBaseURL` (§22) or, for Cloudflare, `cloudflare.publicBaseURL`. If neither is available the command exits two with a message naming both ways to supply it. `--config` uses the deployment-config locator described in §22 and defaults through T10's locator precedence.

`--pull-request REF` accepts either a positive PR number or a canonical `https://github.com/OWNER/REPO/pull/NUMBER` URL. The repository is identified from the checkout's Git origin. The CLI reads the PR through GitHub's REST API and verifies its base repository, same-repository head, and head SHA against the selected source head and the registered source repository. A read token, when needed for a private repository, is taken from `GITHUB_TOKEN` or `GH_TOKEN`. Omitting this flag always creates a manual group, even in a PR-triggered workflow.

`--include PATH` is repeatable and accepts an exact source-relative path or a Go `path.Match` pattern evaluated over slash-separated source paths. Wildcards do not cross `/`. Each match must be a non-document resource beneath the registered source path. Missing matches, out-of-tree paths, and unchanged HTML/Markdown matches are errors. Automatic resource discovery remains enabled independently of these additional includes.

`--dry-run` reads the Git source, deployment config, deployed registry, and the preview objects/catalog needed to make a plan, but it acquires no publication lock and performs no provider writes, deletes, or cache changes. It reports `planned` when the plan would change state and `no-op` when the current projection already matches. A deletion-only document change, or a change whose changed non-document files are used by no document, returns `no-preview`; a change containing only non-document files previews the documents that depend on them.

JSON output has `operation`, `outcome`, `site`, `groupId`, `headSha`, optional `pullRequestUrl`, `groupListUrl`, `documents`, `objects`, `catalogChanges`, optional `configCommitSha`, and optional `error`. Each document contains its source-relative `path`, `title`, fixed revision URL, `reason` (`changed` or `dependency`), and, for dependency documents, the sorted `changedResources`. The preview manifest and catalog record the same `reason` and `changedResources` per document; records written before these fields existed read as `changed`. PR document URLs include the group's query context; manual URLs do not. `objects` sort by path with the manifest last. `catalogChanges` sort by group ID, head SHA, action, then reason. A publication failure after source selection retains the known group and document URLs in the typed failure result; earlier failures without a resolved preview identity return empty arrays. Outcomes are `planned`, `published`, `no-op`, `no-preview`, or `failed`. Successful outcomes exit zero; invalid command/config input exits two, while GitHub lookup, provider, and publication failures exit one and return the typed failure envelope when JSON was requested.

The optional thin preview Action maps its `site`, `source`, `head`, `default-ref`, `pull-request`, `base-url`, `config`, and `dry-run` inputs to this same command; `source` and `base-url` are optional and default as described above; its `include` input is a newline-separated list expanded to repeated `--include` flags. It exposes `operation`, `outcome`, `site`, `group-list-url`, `documents` (the CLI document array serialized as JSON), `result` (the full CLI JSON result), `exit-code`, `error`, and `comment-url`. Action output names are hyphen-case across all Actions (`result`, `changes`, `preview-changes`, `registry-updated`, `exit-code`).

After its optional checkout (see "Shared Action behavior") and before any Go setup, CLI call, or provider access, the preview Action verifies that a `pull_request` event originates from the workflow repository, rejects `pull_request_target`, and, when `pull-request` is given, verifies that PR's base repository, same-repository head, and head SHA through the GitHub API. Callers should additionally guard the job with a same-repository `if:`, rely on GitHub withholding secrets and OIDC tokens from fork pull-request runs, and restrict the provider role's trust policy to the intended repository, workflow, and ref. Provider credentials are configured by a caller step before the Action; no separate preflight Action exists.

The Action's `head` and `default-ref` inputs default to empty. An explicit input always wins. When empty on a `pull_request` event, the Action reads the event payload and uses `pull_request.head.sha` as the head and `origin/<pull_request.base.ref>` as the default ref; on any other event it passes `HEAD` and `origin/HEAD`, matching the CLI defaults. The Action's `pull-request` input follows its own rule. An explicit value always wins (a number or canonical URL, exactly as the CLI accepts it); the value `none` (case-insensitive) forces a manual preview. When the input is empty on a `pull_request` event, the Action uses `pull_request.number` from the event payload, and a payload without a positive integer number is an error. On any other event, including `pull_request_target` (which is rejected), an empty input means a manual preview. The defaulted number is passed to the CLI as `--pull-request` and goes through exactly the same trust verification as an explicit one (base repository, same-repository head, head SHA against GitHub's PR metadata); the CLI itself stays explicit-only. The same resolution feeds the Action's trust verification and the CLI invocation. A shallow checkout does not contain the head commit or `origin/<base>` necessarily, so before any Go setup, build, or provider access the Action requires only that each ref either resolves locally or is one the CLI can fetch (a full-SHA head, an `origin/<branch>` default ref); any other unresolvable ref fails with a message that points to a full-SHA head, an `origin/<branch>` default ref or `fetch-depth: 0`, and returns the same typed failure outputs as a failed trust verification. Whether the fetchable ref exists, and the merge base itself, are resolved by the CLI, which fetches and deepens (and reports `no merge base`). The trust verification compares a full-SHA `head` input with GitHub's pull-request head SHA directly, without local objects, so it still runs first against a depth-1 base-ref checkout. Apart from its own optional `actions/checkout` step the Action never fetches. It does not select event timing.

The Action's optional `comment` input (default `false`) lets it post the review links itself. It acts only when a pull request was resolved (an explicit `pull-request` input, or the defaulted `pull_request` event number) and the Action's trust verification passed, so `comment: true` works on `pull_request` events without a `pull-request` input; with no resolved pull request (another event, or `pull-request: none`), it emits a warning and writes nothing. It maintains at most one comment per site per PR, identified by a hidden `<!-- artifact-pages-preview:site=SITE -->` marker: it creates the comment when absent and updates it in place otherwise. For `published` and `no-op` it lists the site, the group-list URL, each previewed document's title, path, and fixed revision URL, and the head short SHA. Changed pages and pages affected by a resource change are listed in separate tables (the latter with the triggering changed resource), sharing one 50-row cap with changed pages first and an "and N more" line for the rest. A dry-run (`planned`) writes nothing. For `no-preview` or a failed run it only updates an existing comment, saying that no pages changed or that the latest preview failed with a link to the workflow run; it never creates a comment for those outcomes. The comment step runs even after a CLI failure, and the Action still fails because of the CLI. The comment uses the GitHub REST issue-comments API with `github-token` or the workflow token and needs `pull-requests: write`. A missing permission or any other comment API error is reported as a warning and never fails the publish. `comment-url` holds the URL of the comment written, or an empty string. The separate production admin/site Actions use the T11 contract.

While a completed revision remains at the provider, its URL must not change content: retrying the same head verifies the existing projection and does not rewrite its objects merely to extend provider retention. A changed projection or document set for the same head is an error, including if an unusual default-branch history change produces a different merge-base. Direct preview URLs resolve through their own completed revision manifest, not the mutable discovery catalog.

The preview catalog is a mutable static object containing discoverable preview metadata and links. When the caller explicitly supplies a PR reference, it shows only the latest completed pre-publish in that PR's group. Older revisions are removed from the catalog but their direct URLs remain usable while their provider objects remain available. The core preview-group identity is not tied to a particular CI provider. Pre-publish without a PR reference is manual and uses its head SHA as its discovery group. PR and head-derived groups occupy distinct namespaces so they cannot collide. Group identity determines which revision appears in discovery; it is not the revision's URL identity. The v1 catalog and manifest fields, keys, and digest are settled in the [T1 record contract](backlog/technical-design/T1-preview-record-contract.md).

The site's `/:site/_previews` view lists available groups. Within a group, changed documents are listed first and dependency documents appear in a separate "Affected by resource change" section that names the changed resources. An optional URL-encoded `group` query parameter filters that view to one group and always resolves through the current catalog, so it is a mutable latest-preview link suitable for a pull-request comment. It is not a fixed revision URL: if the group has no current preview or its revision is no longer available from the provider, the view shows an empty state rather than an obsolete revision. The Action exposes this group-list URL and the individual revision-specific document URLs as outputs; when a PR reference was explicitly supplied, each document URL carries that PR group's view context so a reviewer can return from the artifact to the PR. The preview Action can post these URLs to the PR itself when the caller opts in with `comment: true`; otherwise caller-owned workflows decide whether and how to post them. A separate per-revision summary page is not required.

The selected reader treatment is a quiet preview provenance label in the application header, not inside the artifact. It distinguishes the short head SHA from production without changing the document H1 or adding a reader strip. Every PR-associated preview document opened with its PR-group context shows a subtle PR-number link back to the validated source PR. The reader checks the site catalog to confirm that the named group is explicitly PR-associated and currently points to the URL's head SHA; it never infers a PR from the SHA alone. Preview-to-preview document navigation within the same revision preserves this view context; navigation to a production document does not. A manual preview, a bare revision URL without group context, or a missing, mismatched, or unreadable group still renders the document when its own completion manifest is available, but shows no PR link. Group context affects only reader chrome, not revision identity or artifact bytes. Direct revision URLs remain usable as previews after their groups leave discovery, while provider objects remain available, even though their PR link may then disappear. The document H1 remains untouched and no reader strip is added. T1 records the v1 route-key and query encoding.

Preview discovery follows provider availability, not Git or PR state. A preview remains discoverable while its completion manifest exists, including after its PR is merged or closed without merging. The ordinary `artifact-pages site publish` operation reads the site-scoped catalog and, through the configured storage adapter, prunes references whose completion manifests are confirmed missing at provider origin. Pre-publish does the same before its own catalog upsert. Neither operation compares production commits with PRs or polls PR state for cleanup. GitHub Actions is an optional wrapper for checkout, credentials, invocation, and presentation of the result; it does not implement a separate cleanup algorithm.

For production publish, read the current catalog at provider origin under the site lock and check its referenced manifests, but write a reduced catalog only after the production projection has been committed at origin. Write only when confirmed missing references were removed; a failed production publish must not hide its previews. Catalog cleanup removes references, not completed preview bytes or fixed direct URLs; those remain usable while the provider retains them. Between catalog writes, the reader checks manifest availability and hides missing candidates. A provider read error is not a confirmed absence and must not trigger pruning. An absent logical preview document shows a neutral "Preview unavailable" state with a way back to its site; missing raw preview resources return a real not-found response rather than the SPA document.

Pre-publish shares the cooperative per-site storage lock with production publish and `registry unregister`. After acquiring the lock, it revalidates the deployed registry directly from storage. It uploads the new preview bundle and its completion manifest before reading and updating the catalog from storage. Updating the catalog is an idempotent upsert by preview identity, not a blind append. If the catalog update fails, the incomplete publication reports failure and can be retried; unlisted uploaded objects remain subject to preview retention. A different CI run for the same site cannot overwrite that catalog update while the lock is held. Unregister waits for an already-running pre-publish, then removes that site's preview projection along with its production projection.

Pre-publish does not immediately delete an older completed revision when a newer one replaces it in the catalog. Early deletion would break previously shared direct URLs and could leave a cached catalog pointing at missing content. Preview lifetime is delegated entirely to the provider's administrator-defined lifecycle policy: the application does not compute, store, display, or enforce its own expiry timestamp. Catalog entries are discovery candidates, not proof that their manifests still exist. The local Previews list checks fixture or local manifests when opened; registered-site production publish also removes confirmed-missing references from the `_previews` prefix in its configured target after a successful production projection. That core reconciliation is exercised with the local backend. Real provider-origin behavior, provider-backed availability checks, lifecycle and shared-cache behavior remain separate verification work. Any viewer access gate is independently configured and verified by the operator at the edge.

#### Shared Action behavior

These behaviors are properties of the composite Action wrappers (root `action.yml`, `actions/site-publish`, `actions/admin`, `actions/preview-publish`). They live in the wrapper, never in the CLI, so the CLI contract above is unchanged. The decisions and rejected alternatives are recorded in [TD12](backlog/technical-design/TD12-action-consumer-contract.md).

**Publish condition.** The site-publish (and root) and admin Actions accept an optional `publish-on` input: a newline-separated list of `event` or `event:ref` entries such as `push:refs/heads/main` and `workflow_dispatch`. An entry matches when its event equals `GITHUB_EVENT_NAME` and, if it names a ref, that ref equals the full `GITHUB_REF` (`*` matches any run of characters, so `push:refs/tags/v*` covers tags). A run that matches no entry is passed to the CLI as `--dry-run` and logs a notice saying why. An explicit `dry-run: true` always wins. An empty `publish-on` means no condition, which is the previous behavior. A malformed entry fails the run (exit two, typed failure outputs) instead of silently becoming a dry-run. The preview Action has no `publish-on`: a preview is not a production write, and callers choose when it runs with workflow `on:` and job `if:`.

**Job Summary.** Every Action accepts `summary` (default `true`). After writing its step outputs, the Action appends one Markdown block to `GITHUB_STEP_SUMMARY`; it does so also when the operation failed, and `summary: false` writes nothing. A problem writing the summary is a warning, never a failure, and the summary never changes outputs or the exit code. The block is rendered only from the typed CLI result, so it does not depend on the caller. The format is a stable contract: the heading is `### Artifact Pages: <operation> (<outcome>)`, followed by a bullet list whose lines appear in this order when they apply:

- `` - **Site:** `ID` ``, whenever the result names a site.
- `- **Mode:** dry-run`, with the reason in parentheses when `publish-on` caused it, when the CLI ran with `--dry-run`.
- Site publish: `- **Changes:** N` with a per-action breakdown such as `(create 2, update 1)`, then `- **Pruned previews:** N`, the number of preview-catalog `remove` changes.
- Registry register: `- **Registered:** ...` (sites created or updated in the registry), `- **Removed:** ...` (sites removed), each a comma-separated list of IDs or `none`, then `- **Registry updated:** true|false`. Registry unregister: `` - **Removed:** `ID` ``, then `- **Registry updated:**`.
- App deploy: `- **Object changes:** N`, then `- **Version:**` when known.
- Preview publish: `- **Preview list:** URL` (the group-list URL), `- **Documents:** N`, then a table with the columns Document (linked title), Path and Reason, capped at 50 rows with an `... and N more` line.
- On failure, a blockquote `> **Error (exit CODE):** text` with the error collapsed to one line.
- Except for preview and unregister, a collapsed `<details>` list of the individual changes (`action path`), capped at 100 lines.

Within one release line the heading, the bold labels and their order do not change; additional lines may be appended after existing ones. The preview Action also writes its summary when its trust or Git-ref preflight fails.

**Checkout.** Every Action accepts `checkout` (`auto`, `true` or `false`; default `auto`) and `fetch-depth` (default `1`, a shallow checkout). With `auto` the Action runs `actions/checkout` itself, pinned to a full commit SHA with a version comment, only when `GITHUB_WORKSPACE` is not itself the root of a Git work tree; when the workspace already is a checkout it does nothing, so a caller's own checkout step is never repeated or overridden. `true` always checks out and `false` never does. Any other value, or a `fetch-depth` that is not a non-negative integer, fails the step. The checkout uses the workflow token (`github.token`), never the private-config `github-token` input, and always sets `persist-credentials: false`. The root, site-publish and admin Actions check out the event's default ref. The preview Action, on a `pull_request` event, checks out the base ref (`github.event.pull_request.base.ref`) and never the pull-request head, matching the recommended workflow; the head commit is read from the fetched history by SHA. With the default `fetch-depth: 1` the checkout is shallow and the CLI deepens it from `origin` on demand (see Shallow checkouts), so per-document `updatedAt` and last-committer metadata and the preview merge base equal those of a full clone, subject to the byte-identical-commit limit described there. `fetch-depth: 0` fetches full history and avoids that limit. The CLI step receives the workflow token as `ARTIFACT_PAGES_FETCH_TOKEN` (never the private-config `github-token` input, which may be scoped to a different repository and could not read this one); the CLI prefers it over `GITHUB_TOKEN`/`GH_TOKEN` for the fetch subprocess only. `permissions: contents: read` is sufficient. The checkout is the first step of every Action. In the preview Action it runs before the trust preflight because the preflight reads Git refs; it uses only the workflow token and the repository's own base ref, and it touches no provider and no CLI, so the guarantee that trust verification precedes any provider access is unchanged (provider credentials are still configured by caller steps before the Action, and the preview job must still be gated as same-repository).

**Prebuilt CLI.** Each Action builds the CLI from its own pinned source unless it can install the matching released binary. It installs the binary only when all of these hold: the Action ref (`github.action_ref`) is a release tag `vMAJOR.MINOR.PATCH`, that version equals the `Product` constant in the source tree the Action runs from, and the runner is Linux or macOS on amd64 or arm64. It then downloads `artifact-pages_vX.Y.Z_<os>_<arch>` and `artifact-pages_vX.Y.Z_checksums.txt` from that tag's GitHub Release in the Action's own repository, verifies the binary's SHA-256 against the checksums file, and skips Go setup, the Go cache and the build. A SHA or branch ref, a local `uses: ./` reference, a ref that differs from the source version, an unsupported platform, or a missing or unreachable release asset or checksum entry falls back to the source build; the step logs which path it took. A checksum mismatch is never papered over with a fallback: the step fails. Downloads are unauthenticated from `github.com`; only when that is rate limited (HTTP 403 or 429) does the Action retry through the GitHub API with the workflow token (never the private-config `github-token` input), and the token is never printed. The checksums file comes from the same release as the binary, so it detects corruption and a partial upload, not a compromised release; adopters who want to rule out the release asset path pin a full SHA, which always builds from source. The preview Action downloads only after its trust preflight. The release workflow builds the binaries with `CGO_ENABLED=0 -trimpath`, verifies the checksums, and attaches the binaries, the checksums file and `artifact-pages_vX.Y.Z_THIRD_PARTY_NOTICES.txt` (the licenses of the linked Go modules) to the release; its post-publication verification re-checks them. Windows runners build from source.

## 20. Non-goals for the MVP

- server-side rendering
- viewer accounts, login/session handling, roles, and per-site authorization; configure access at the customer-managed edge/network boundary instead
- database
- request-time search API
- browser-side S3 ListObjects
- per-viewer GitHub OAuth authorization
- PR/branch preview environments
- arbitrary dynamic backend execution
- a generalized documentation CMS
- automatic interpretation of every possible HTML/browser feature

## 21. Architectural invariants

Treat changes to these as architecture decisions:

~~~text
Git is the source of truth.

The served system is a static projection.

The SPA application plane and artifact content plane are independently deployable.

A site is a logical namespace, not a repository identity.

The initial builder maps one repository source to each site; multi-repository merging is deferred. If it is introduced later, mount paths within a site must not overlap.

Satellite publish and `registry unregister` for one site serialize through a shared per-site storage lock; complete-set registry registration/reconciliation operations are serialized through one registry deployment path.

Fixture and registered modes read `/_indexes/sites.json` and lightweight per-site metadata; both modes load only the active site's artifact index. The browser does not use nginx autoindex or object-storage ListObjects APIs.

Artifacts live under /_artifacts.

Indexes live under /_indexes.

Logical user routes do not expose the storage projection as the main UX.

Prefer publish-time computation over request-time services.
~~~

## 22. Deployment configuration and command interface

The CLI resolves one effective version-1 YAML config, supplied either as one complete file or as explicitly ordered local layers. Each layer requires integer `schemaVersion: 1`. A layer that defines a provider must also define exactly its matching provider settings block; a base layer may omit both to contribute only shared fields such as `sites`. Provider targets are replaced as a whole by later target layers, never deep-merged. Unknown fields, duplicate mapping keys, multiple YAML documents, and mistyped values are errors. The local target stores `root`. AWS stores `region`, optional `bucket`, optional 12-digit string `accountId`, and optional `distributionId`; `accountId` is required only when `bucket` is omitted, in which case the effective bucket is `artifact-pages-<accountId>-<region>`. An explicit bucket always takes precedence, and AWS identity is never discovered from credentials. Every provider may also set an optional top-level `publicBaseURL`, the public application origin (an HTTPS origin, or an HTTP loopback origin for local development, without credentials, path, query, or fragment). It is provider-neutral, is not discovered from provider identity, and is used only to default `preview publish --base-url`. It belongs to the target unit: a config layer that sets `provider` replaces it (an omitted value clears it), and a later layer without `provider` may set it alone. Cloudflare keeps its required `cloudflare.publicBaseURL`, which counts as the declared origin; a top-level `publicBaseURL` that is also set must equal it. Cloudflare requires R2 `accountId`, `zoneId`, and `publicBaseURL`; its bucket defaults to `artifact-pages`. The primary credential environment-name fields default to `CF_R2_ACCESS_KEY_ID`, `CF_R2_SECRET_ACCESS_KEY`, and `CF_API_TOKEN` and may be overridden with valid environment-variable names. The CLI requires the primary R2 access key and secret for provider-backed publication, deployment, registry, and lock commands; it does not require those values for `index build` or `config set-default`. Cloudflare may optionally name `sessionTokenEnv` for an externally issued short-lived R2 credential; the CLI passes that session token to the S3 client but does not mint or renew temporary credentials. The zone API token value is required only for a non-empty cache invalidation request. Dry-runs and fully converged no-op operations do not require it; registry, application, and site mutation workflows check that it is configured before changing projection objects.

Cloudflare may configure a separate registry-reader identity with `registryReaderAccessKeyIdEnv`, `registryReaderSecretAccessKeyEnv`, and optional `registryReaderSessionTokenEnv`. This identity is used only by `site publish` and `preview publish`, and only when those fields are explicitly configured. When used, `GetObject("_indexes/sites.json")` uses that identity; all object writes and other object operations use the primary R2 identity. If delegated registry-reader fields are configured but their key or secret values are missing, those two publish commands fail before provider requests instead of falling back to the primary identity. Commands that do not read the registry through the delegated identity ignore those environment values. With no reader fields configured, site and preview publishers read the registry using the primary identity. A delegated publisher should scope its reader credential to read the exact registry object and scope its primary credential to that site's index, artifact, and preview prefixes plus its site lock; the primary credential must not include the registry object. Admin registry operations use the primary R2 identity and do not need a reader identity. Preview retention is configured by provider infrastructure and is not a CLI YAML field. Configuration contains environment-variable names only, never credential values. AWS credentials use the standard AWS credential chain. For local conformance only, Cloudflare may also set loopback-only `r2Endpoint` and `apiBaseURL` overrides; these are rejected for non-loopback hosts. The `gcp-local` provider accepts only an HTTP loopback endpoint and bucket for fake-gcs-server and is an emulator test profile, not a production GCP adapter.

The optional top-level `sites` field is a mapping keyed by site ID. If present, it follows the registry rules in §11. Across ordered local layers, an omitted `sites` field inherits the previous mapping; an explicitly supplied mapping replaces the complete mapping and is never merged site-by-site. In particular, `sites: {}` explicitly selects an empty desired registry. `registry register` and `registry unregister` require `sites` to be present in the effective config; absence is never treated as an empty registry. Registering the empty mapping removes all currently registered sites and reconciles their content cleanup. Registry operations use this complete effective mapping; there is no separate site-manifest file.

A config locator is a local path or `github://OWNER/REPO/FILE?ref=REF`. Repeating `--config` composes local files in command-line order. When a later layer omits `sites`, the earlier `sites` mapping carries forward; if it includes `sites`, that complete mapping replaces the earlier one. A later provider layer replaces the prior provider and target as a unit. Remote GitHub config is supported as one complete locator, but cannot be composed with other layers; this keeps remote provenance and pinned-commit reporting unambiguous. Local paths and explicit remote `FILE` paths may select arbitrary config filenames. The repository component preserves its spelling and follows GitHub’s repository-name rules: 1–100 ASCII letters, digits, periods, hyphens, or underscores ([GitHub Docs](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository)); Artifact Pages also rejects `.` and `..` path components and names ending in `.git` to keep the canonical `owner/repo` locator unambiguous. Empty path segments, traversal, encoded path separators, malformed query escapes, duplicate or empty `ref` values, and query keys other than `ref` are rejected before network access. When a GitHub file is omitted, resolve only `artifact-pages.yaml`; there is no implicit fallback to `.artifact-pages.yaml`. When `ref` is omitted, resolve the repository's default branch to a commit SHA, then fetch the selected config at that SHA for the whole invocation. A caller may pin a commit directly. Every invocation re-fetches remote configuration; a remote URL is deployment input, not a trust boundary. Private config reads may use `GITHUB_TOKEN` or `GH_TOKEN`; redirects to another host, oversized responses, and credentials in diagnostics are rejected.

Commands that use a deployment target report the effective target bucket in normal and dry-run text output and in the top-level JSON `target` object; AWS target details include region and optional account ID, and Cloudflare target details include account ID. For a remote config, output also reports the resolved config commit: successful text reports show a labeled `Config` SHA, failure reports retain a labeled deployment config commit, and JSON result and failure envelopes include `configCommitSha`. Local config results omit the commit field.

Operational text reports share the low-chroma, terminal-aware [CLI output contract](guides/cli-output.md). They show the operation and outcome first, with grouped bounded change details, target context, and explicit dry-run/no-op completion. Registry changes distinguish logical registrations, concrete projection objects, cleanup scopes, and cache requests. Preview links, lock state/ETag, local index outputs, and saved config locators retain their operation-specific meaning. Piped output and `NO_COLOR` contain no color escapes; machine-readable JSON and exit codes are unchanged. These reports do not simulate live progress or claim that a cache request has propagated.

Config locator precedence is explicit `--config` layer(s), `ARTIFACT_PAGES_CONFIG`, `artifact-pages.yaml` in the current working directory, then the user's saved locator. The environment, implicit working-directory default, and saved locator each select one file; only repeated explicit `--config` flags create a local stack. `artifact-pages.yaml` remains the implicit local default; explicit `--config` and saved locators support arbitrary filenames. `artifact-pages config set-default LOCATOR` updates only that locator in the user's config directory. A satellite repository resolves its deployment target without cloning the admin repository; publishing eligibility still comes from the deployed `/_indexes/sites.json` registry, regardless of whether the selected config contains `sites`. A command invoked without `--config` resolves its config through this order and runs; if nothing resolves, it fails with a non-zero exit and a message naming the sources. Only an explicit `-h` or `--help` prints help and exits 0, so a bare `registry register` never silently does nothing.

For local development, one repository may commit a config containing both a non-secret target and the admin-owned registry:

~~~yaml
# artifact-pages.yaml
schemaVersion: 1
provider: local
local:
  root: .local/storage
sites:
  sre:
    name: SRE & Platform
    repository: acme/platform
    sourcePath: docs/artifacts
~~~

`registry register` validates the selected config's complete `sites` mapping, builds its JSON projection, and reconciles the deployed registry to that desired registration set in one operation. It also cleans content prefixes for sites omitted from the mapping. The operator can review this plan and apply the desired set with:

~~~text
artifact-pages registry register --config artifact-pages.yaml --dry-run
artifact-pages registry register --config artifact-pages.yaml
artifact-pages registry unregister --site sre --config artifact-pages.yaml --dry-run
artifact-pages site publish --config artifact-pages.yaml --site sre --source docs/artifacts --dry-run
~~~

When the same site registry must be reused with different deployment targets, keep it in a shared base layer and pass the target layer explicitly. Each layer has `schemaVersion: 1`; a target layer contains its complete `provider` and matching provider block, and replaces the earlier target as a unit. Only `sites` carries forward: if a later layer omits it, the previous mapping is inherited; if it specifies `sites`, that entire mapping replaces the previous one, including when it is `{}`. For example, `artifact-pages.yaml` can contain the non-secret `sites` mapping, while an ignored local overlay contains `provider: local` and `local.root`:

~~~text
artifact-pages registry register --config artifact-pages.yaml --config .local/artifact-pages.local.yaml --dry-run
artifact-pages site publish --config artifact-pages.yaml --config .local/artifact-pages.local.yaml --site en --dry-run
~~~

Do not rely on automatic overlay filename discovery. Layer order is part of the command input and therefore remains visible and predictable.

In a separate admin/satellite layout, the satellite can select a pinned remote target config while still using the deployed registry for eligibility:

~~~text
artifact-pages site publish --config 'github://acme/platform-admin/artifact-pages.yaml?ref=0123456789abcdef0123456789abcdef01234567' --site sre --source docs/artifacts --dry-run
~~~

The operation-oriented command surface is provider-neutral. Registry operations read `sites` from the selected config and have no `--manifest` option:

~~~text
artifact-pages registry register [--config LOCATOR ...] [--dry-run] [--format text|json]
artifact-pages registry unregister --site ID [--config LOCATOR ...] [--dry-run] [--format text|json]
artifact-pages site publish --site ID [--source DIR] [--config LOCATOR ...] [--dry-run] [--reconcile] [--format text|json]
artifact-pages app deploy [--archive FILE] [--repository OWNER/REPO] [--config LOCATOR ...] [--dry-run] [--format text|json]
artifact-pages version [--format text|json]
artifact-pages lock inspect (--site ID | --scope registry|application) [--config LOCATOR ...] [--format text|json]
artifact-pages lock recover (--site ID | --scope registry|application) --observed-etag ETAG [--config LOCATOR ...] [--format text|json]
~~~

`registry register` and `registry unregister` require `sites` to be present in the selected config, create its registry projection, and reconcile the configured target to that complete desired registration set. A missing `sites` field is an input error; `sites: {}` explicitly requests an empty registry. Register removes registrations omitted from the mapping and cleans those sites' content prefixes. Unregister requires the selected site to already be omitted from the mapping, then ensures cleanup of that site's exact prefixes, including when retrying after a previous registry withdrawal. These operations serialize whole-registry updates, report `registryUpdated` as a boolean on planned, registered, unregistered, and no-op outcomes, and include an empty `changes` array when the registry is already current. A changed successful registration has outcome `registered`; a current registry has outcome `no-op`. Site, preview, and app operations do not reconcile `sites`; site and preview publishing continue to validate eligibility against the deployed `/_indexes/sites.json`. Every site operation selects one explicit site ID. `--config LOCATOR` is an optional deployment-config selector and follows the locator precedence above. `site publish` builds the index and static source projection as one operation; `index build` remains a local utility and is not required for publishing.

`--dry-run` is the common read-only planning option for registry register/unregister, site publish, and app deploy. It may read the config and deployed objects needed to calculate the plan, but does not write or delete objects, acquire or recover locks, or request cache changes. If an application cache retry is pending, app dry-run includes its invalidation path without acquiring the application lock. `site publish --reconcile` bypasses the matching-state fast path and checks the complete selected-site artifact and index origin inventory, using HEAD metadata to compare recorded SHA and HTTP representation values; it does not download object bodies. JSON `buildSkipped: true` means the publisher reused a matching, reusable prepared input and omitted `Build`; registry, lock, preview cleanup, and pending cache-retry duties still apply. `app deploy` deploys the web bundle of the CLI's own product version: the CLI source holds that version as a constant (`cli/internal/version`), and without `--archive` it downloads the assets of release `v<version>` from `--repository` (default `tasuku43/git-artifact-pages`) in a temporary location that is removed after the command, verifies archive, manifest and checksum, and requires the manifest version to equal the pinned version before writing. When the release cannot be fetched the command fails before any write with a message naming the version, repository and the `--archive` alternative. There is no `--version` option and no Action `version` input; pinning a CLI or Action ref therefore pins a tested CLI/web pair, and a new release or CLI upgrade never deploys the app by itself. Between releases the constant still names the last release. `--archive` accepts a caller-provided packaged archive (for local and pre-release bundles) with its adjacent manifest and checksum. A real deployment holds the `application` lock from before its first app-object HEAD through cache invalidation and retry-record clearing. Failed invalidation or an ambiguous operation retains private `/_control/app-cache/retry.json` with the pending `/index.html` path; the next invocation replays it even when bundle objects are unchanged and reports `deployed` with zero uploaded files. Only a clean unchanged bundle with no pending path reports `no-op`; it performs no application-object PUTs or cache invalidation while still acquiring and releasing the application lock. Use `artifact-pages lock inspect --scope application` and guarded `lock recover --scope application --observed-etag ETAG` to inspect or recover a confirmed stale application lock. The current app retry record has `schemaVersion: 1` plus a sorted `paths` array and allows only `/index.html`; it is capped at 16 KiB, stored as `application/json` with `Cache-Control: no-store`, and conditionally created or replaced using `If-None-Match` or its observed ETag with `If-Match`. Malformed, older, or out-of-scope private records fail closed. An operator may reset the exact record only after preserving a backup and confirming no operation is active; the CLI never silently discards it. `artifact-pages version` prints the product version, the main module version and checksum (`Main.Version`, `Main.Sum`; the checksum is present only for a build from a downloaded module, such as `go install …@vX.Y.Z`), the Go version that built the binary, and the VCS revision and modified flag from the Go build info; `--format json` returns `{operation, version, revision, modified, moduleVersion, moduleSum, goVersion}` (`revision`, `moduleVersion` and `moduleSum` are omitted when unavailable). For site publish, JSON `changes` is the full per-path production change list, sorted by path and action; JSON `previewChanges` is the full per-group preview disposition list, sorted by group ID and head SHA. Each `previewChanges` entry contains `groupId`, `headSha`, `action` (`remove` or `keep`), and `reason` (`manifest-missing`, `manifest-present`, or `manifest-unavailable`). Remove a catalog reference only when its completion manifest is confirmed missing; keep live and unavailable groups. A provider read error is not evidence that a manifest is missing. Text output summarizes production create, update, removal, preview prune, and retain counts. The same plan and classifications apply to real site publish; a preview-only catalog prune is a published change, and the operation is a no-op only when neither production objects nor preview references need changes and no cache retry is pending. JSON results use stable operation/outcome/change/result fields, with `site`, `previewChanges`, and optional `buildSkipped` for site publish and `registryUpdated` for registry operations. Plans, success, and no-op outcomes exit 0; invalid command or config input exits 2; provider and reconciliation failures exit 1. Optional GitHub Actions invoke the same CLI operations and relay their results without implementing separate site publication or registry reconciliation logic. They are versioned with the product tag and build the CLI from the tagged source. The repository-root Action is `site-publish`, listed on GitHub Marketplace as "Artifact Pages" from the first full (non-pre-release) release. The `admin`, `preview-preflight`, `preview-publish` and `site-publish` Actions remain usable as `tasuku43/git-artifact-pages/actions/<name>@<ref>`. Documentation references an exact release tag, such as `@v0.1.0`, or its full commit SHA. No moving major tag is published during `0.x`.

The application orchestration consumes provider-neutral storage and cache interfaces. AWS/S3/CloudFront and Cloudflare/R2/cache APIs stay in adapter and deployment packages; they do not define the site registry, content keys, browser routes, or publication order.

`registry unregister --site ID` expects the selected config's `sites` mapping to already omit that site, keeping the unified config as the sole editable source of truth. It withdraws the current deployed registration, then cleans the selected site's exact content and preview prefixes while holding the site lock. It remains safe to retry after registration removal. Lock commands support `--scope registry` for the whole-registry serialization lock, `--scope application` for the app deployment lock, and `--site ID` for a per-site lock.
