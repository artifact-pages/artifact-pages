# Git Artifact Pages — Specification

Status: **Phase 1 local product; implementation-aligned, evolving**

This document records the current local product contract and identifies decisions intentionally deferred until measurements or a concrete deployment use case justify them.

## 1. Product definition

Git Artifact Pages is a Git-backed platform for publishing static artifacts as searchable, browsable websites.

A typical source artifact is generated or maintained in a Git repository, for example:

- HTML reports
- architecture explanations
- design documents
- generated visualizations
- incident reports
- review artifacts
- documentation bundles

The product preserves Git as the source of truth while presenting artifacts through a normal web experience.

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

### 2.2 Content plane

The content plane changes as artifacts are published.

~~~text
/_indexes/*
/_artifacts/*
/_previews/*
~~~

It is independently deployable from the application plane.
`/_previews/*` is the local-development projection. Provider-backed preview publication and lifecycle behavior remain a later phase.

The reserved `/_control/*` keyspace stores private coordination state such as retained publish locks and retry records. It is not part of the application or content serving planes. Every local or provider delivery configuration must deny public reads from this prefix.

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

The `artifactIndexUrl` pointer keeps the browser from hard-coding the artifact-index location. The current implementation still publishes one complete artifact index per site; sharding or an inverted index is not part of the contract until benchmarks demonstrate a need.

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
is no H1. Markdown headings are indexed for Contents, and generated heading IDs match the reader.
HTML retains its `<title>`-based display title and existing precomputed heading behavior.

### Publishable source directory

The builder's `sourcePath` is the exact static content tree intended to be served beneath `/_artifacts/<site>/`. It may contain directly authored static files or output from another site generator, but HTML and Markdown must already be ready to publish: this builder does not expand templates, run site generators, bundle CSS or JavaScript, rewrite resource URLs, or copy files.

The builder recursively indexes every `.html`, `.htm`, and `.md` file under that tree, including root-level and nested `index.html` files. Every page uses its full source-relative filename and extension in its route; index files do not alias their parent directories. No directory-name or dotfile heuristic excludes pages; for example, HTML or Markdown under `_includes/` is indexed if that directory is inside `sourcePath`. Select a publishable root that contains the pages to expose and excludes source-only templates or partials.

Local resources referenced by those pages must also be present under `sourcePath`, with their relative directory structure intact. External resources may be referenced over HTTPS under the artifact resource policy described below. The index builder leaves the tree unchanged and emits metadata only. The later publish operation treats the publishable files in `sourcePath` as the desired artifact state: it uploads new and changed files and removes stale objects under that site's artifact prefix, excluding Git metadata such as `.git` and without touching another site, the registry object, or the application plane. It also publishes the generated per-site metadata and index.

Provider-backed publish accepts only regular files and directories beneath `sourcePath`. It fails on symbolic links or other special filesystem entries; it neither follows a link outside the selected tree nor publishes the link target or link text as an artifact. This keeps the published projection within the declared source boundary and gives object storage consistent file semantics.

For a provider-backed publish, build the desired projection locally, acquire the site's lock, and revalidate the deployed registry before writing. Upload new and changed artifact files first; after those uploads succeed, replace `index.json` and then `meta.json`; delete stale artifact objects last. This ordering reduces broken references but does not make a multi-object site update atomic. A reader may temporarily observe old metadata with new artifact bytes, a new index while stale objects are still being removed, or cached older content. V1 accepts this eventual-consistency window and does not use versioned release directories or an atomic site pointer.

Publish is idempotent desired-state synchronization, not a transaction with rollback. If an operation fails partway through, it reports failure and releases its lock when it can stop safely; a process crash leaves the lock held for explicit recovery. Retrying the same desired source reuploads or verifies needed objects, republishes index and metadata, removes remaining stale objects, and converges the site. A successful origin sync does not guarantee every CDN edge has refreshed; mutable paths therefore use bounded cache freshness and revalidation rather than immutable long-lived caching or a mandatory CDN purge after every publish.

`sourcePath` must be inside the current Git working tree. Tracked source files provide commit-based `updatedAt` and `lastCommitter` metadata. Files without Git history, including ignored or generated output, remain indexable; for them `updatedAt` falls back to filesystem modification times and `lastCommitter` is omitted. Prefer tracked, publishable documents when Git-derived details are required.

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

/:site uses discovery metadata for the site picker and loads the active site's artifact index from its `artifactIndexUrl`; it initially presents recent artifacts, expected to start with roughly the latest 10 entries.

### Search

Normal page search is client-side and scoped to the active site's artifact index. It must not read other sites' artifact indexes. The `@` prefix searches lightweight site metadata and switches site; `>` searches commands; `#` searches headings in the open artifact. Cross-site artifact search is not implemented. If it becomes a product need, evaluate its cost and UX separately rather than widening ordinary search silently.

Initial searchable fields:

- title
- path
- filename where available

Search should feel immediate after the index is loaded.

### Left sidebar

The left sidebar derives a tree/navigation model from the site index. It may support filtering without additional network calls. Artifact rows may offer Pin/Unpin, Copy link, Open source, View history, and Open raw artifact actions. Pin stores only a site-scoped artifact reference in the current browser's local storage; it does not change the index, artifact bytes, source tree, or Browse hierarchy. The Pinned section is a shortcut list between Recently updated and Browse. Copy link copies the application's artifact route, while raw/source/history actions open their corresponding projections in a new tab. No sidebar action mutates Git content.

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

The operator/admin repository owns the human-maintained registry as YAML, reviewed and versioned in Git. The YAML is the sole editable source of truth. The admin deployment validates it, generates a public, machine-readable JSON projection, and deploys that object at `/_indexes/sites.json` in the backing storage (for example, S3); the generated JSON is never edited independently. The browser and satellite publisher fetch the deployed projection, avoiding separate hand-maintained registries or YAML parsing in the browser. A satellite publisher does not read the YAML from the admin repository or require a checkout of that repository.

The V1 registry file is `sites.yaml` at the root of the operator/admin repository. A change to this file is reconciled by the admin deployment path; the application and satellite repositories do not maintain copies of the registry.

In the initial one-repository-per-site model, each YAML site entry maps a logical site ID to one source repository and an exact `sourcePath`:

~~~yaml
schemaVersion: 1
sites:
  sre:
    name: "SRE & Platform"
    repository: company/sre-monorepo
    sourcePath: docs/artifacts
~~~

The site ID is the stable machine key; `name` is the human-readable display name and may contain spaces or punctuation. `name` is canonical in the registry. Per-site `meta.json` and `index.json` carry it as `site.title` for the browser, generated from the registry rather than edited separately.

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

The browser reads the registry through the site's distribution endpoint. A satellite publisher reads the deployed object through its provider adapter using its own read-only permission for that object; for AWS this is `s3:GetObject` on `/_indexes/sites.json`, not public access to the S3 bucket. The supported `artifact-pages` publish command rejects an unregistered or mismatched source before writing. This is a product/workflow-level eligibility check, not a dynamically managed cloud IAM boundary; registering or unregistering a site does not update provider permissions.

Unregistering a site removes its registration and the administrator deletes that site's stored projection, including `/_indexes/<site>/` and `/_artifacts/<site>/`. The registry does not create a separate paused/disabled state.

When `registry publish` has site data to remove, it writes a private `/_control/registry-cleanup.json` retry record before publishing the new registry. It retains that record until the origin prefixes are deleted and cache revalidation succeeds. A retry reads the record and repeats any incomplete cleanup even when the registry projection already matches the desired YAML. If a later desired registry re-adds a recorded site, registry publish leaves that site's content intact and clears its obsolete cleanup entry after reconciling the registry.

### Concurrent publish and unregister

Checking the registry and then publishing without coordination has a time-of-check/time-of-use race: an unregister can remove the registration and delete the site's objects after a publisher's check but before that publisher writes. The provider publishing contract therefore uses one cooperative, per-site storage lock shared by satellite publish and `registry unregister` operations.

The lock is a reserved control object outside the site's index and artifact prefixes, for example `/_control/locks/<site>.json`. It is not part of the registry, browser index, or published site data, and deleting a site's projection must not delete it. The hosting adapter must not expose control objects through the public site distribution. Keep one small lock record per site with `free` or `held` state and an opaque operation/run identifier while held; retain the free record after `registry unregister` rather than relying on conditional object deletion. For first use, create it atomically only if absent. For later acquisitions, releases, and recovery, compare-and-swap the record with a conditional `PutObject` using the current ETag (`If-Match`). This lets a recovery operation detect that the lock changed after inspection rather than clearing a newer owner's lock.

The critical sequences are:

~~~text
satellite publish:
  build locally
  acquire site lock
  fetch the current deployed registry directly from storage and validate the exact source
  synchronize that site's index and artifact prefixes
  release site lock

registry unregister:
  serialize with other admin registry deployments
  publish the registry without that site
  acquire the same site lock
  delete that site's index and artifact prefixes
  release site lock
  invalidate/revalidate affected CDN paths
~~~

The publisher must perform its authoritative registry check **after acquiring the lock**, against the current deployed object rather than a CDN-cached response. Unpublishing through `registry unregister` first removes the entry from the deployed registry, closing the gate to new valid publishes; it then acquires the site lock and waits for any publisher that already passed its check to finish before deleting the projection. A publisher that acquires the lock after registry removal sees the missing entry and exits without writing. Unpublishing is idempotent for its explicit target site ID: if cleanup fails after registry removal, retry still acquires that site's lock, deletes its prefixes if needed, and repeats the complete cache invalidation request, including `/_indexes/sites.json`, even though the registry entry is already absent. The command reports success after registry publication, origin deletion, and the provider's cache invalidation/revalidation request have succeeded. This is eventual consistency, not global revocation: an edge may serve a stale response while invalidation propagates, and bytes or rendered pages already delivered to a browser cannot be recalled. If the cache request itself fails, the site remains unpublished and its origin data remains deleted, but the command reports failure so cleanup can be retried; the admin registry deployment path stays serialized through this step to prevent re-registration from racing the pending cache update. Unrelated sites use different locks and may publish concurrently. Registry JSON updates are whole-object writes, so all admin registry deployments must also be serialized through the single admin deployment path; per-site locks alone do not prevent two admin updates from overwriting each other.

Locks do not expire automatically in v1. This fails closed if a process dies: publishing or unregister cleanup for that site remains blocked until an operator confirms no operation is active and uses a compare-and-swap transition to mark the stale lock free. The Artifact Pages command must provide lock inspection and guarded stale-lock recovery; operators should not need raw provider CLIs. If the ETag changed since inspection, recovery must stop and inspect again. A time-based lease without fencing is not sufficient, because a paused publisher could resume after its lease expires and write anyway. Commands wait/retry for a bounded period when another operation holds the lock, then fail without taking it over; the precise timeout and retry schedule are adapter details. This is coordination among supported Artifact Pages commands, not an IAM security boundary; callers with direct write credentials can bypass it.

The YAML source accepts only the schema shown above: `schemaVersion` must be the integer `1`, `sites` must be a mapping (an empty mapping is valid), and each site entry must contain exactly `name`, `repository`, and `sourcePath`. Reject duplicate YAML keys, unknown fields, missing fields, and values of the wrong type rather than silently ignoring or overwriting them. The deployed JSON projection uses the separate array shape shown above. Its path and role as the shared runtime representation are fixed for this model. The initial model has one source per site and no mount-path merging; if multi-repository sites are introduced later, the registry must prevent overlapping mount paths.

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
- sidebar filter → artifact selection
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

The owner selected the long-lived `artifact-pages.dev` domain and reported its purchase on September 28, 2026. The selected policy uses Cloudflare Registrar with authoritative Cloudflare DNS. Production at the apex uses Cloudflare Cache/CDN and R2 custom-domain delivery, not Pages or Workers Static Assets. `aws.artifact-pages.dev` is the independent AWS verification endpoint: a DNS-only Cloudflare CNAME points directly to CloudFront with a private S3 origin; its ACM viewer certificate is issued in `us-east-1`, with DNS-validation records in Cloudflare. No Route 53 hosted zone is used. The existing AWS module's caller-managed DNS/certificate interface needs the new composed path in [IMP-39](backlog/implementation/IMP-39-aws-cloudflare-dns-acm.md).

This is deployment policy, not a hostname requirement for adopters or a change to Site, Artifact, registry schemas, logical routes, or CLI operation meaning. DNS/certificate orchestration belongs in infrastructure modules/adapters. A future `gcp.artifact-pages.dev` hostname may be added, but does not authorize or imply a production GCP adapter. The [domain and delivery policy](architecture/deployment-domain-policy.html) records module ownership, prerequisites, costs, and the remaining handoff. Acquisition is owner-confirmed; authoritative DNS, TLS, apply, and actual provider behavior remain unverified. Purchase alone does not close T15/T16 delivery proof.

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

These are initial product defaults: browsers must revalidate mutable objects on use, while shared CDN caches may retain site metadata/indexes for up to 60 seconds and stable artifact URLs for up to 300 seconds. Normal publish does not invalidate the CDN; a changed artifact may therefore remain stale at an edge for up to five minutes. The provider adapter must honor these upper bounds or use stricter freshness. Vite/Rollup application assets with the default eight-character `-[hash]` filename suffix may be cached for one year because a content change produces a different URL; fixed-name and unrecognized application files must revalidate.

For AWS, the publisher's registry read is directly from the S3 object and therefore does not depend on CloudFront cache freshness; browser visibility still requires timely CDN revalidation or invalidation. During unpublish, the affected cache set includes `/_indexes/sites.json`, `/<site>`, `/<site>/*`, `/_indexes/<site>/*`, `/_artifacts/<site>/*`, and `/_previews/<site>/*`; the adapter requests provider invalidation or equivalent revalidation/expiry and reports failure if that request fails. A successful request does not promise instantaneous global cache convergence or revoke content already delivered to clients. If an operator configures an external access gate at the serving edge, it must cover the desired routes and run before protected bytes are returned from an origin or shared cache. That gate and its verification are deployment concerns; Artifact Pages does not implement identity-aware cache partitioning. Provider implementation details do not change the path sets or freshness contract.

Artifact paths may later become commit-addressed/immutable, which would allow aggressive CDN caching. That is an optimization, not an MVP requirement.

## 17. Publishing and AWS credentials

The user-facing publishing interface is the `artifact-pages` command. Its provider adapter performs the provider API operations; users do not need to invoke raw provider CLIs such as `aws s3` for the product workflow.

### Object-prefix reconciliation

Site publish and unregister must enumerate object prefixes completely before treating the result as the site's current stored state. Adapters follow every listing continuation token/page; they must not assume that one response contains every object. Before deleting stale keys, the command must have successfully completed listings for both `/_artifacts/<site>/` and `/_indexes/<site>/`. A failed or incomplete listing aborts reconciliation rather than risking deletion based on a partial view.

Delete operations use batches within the provider's documented limits and inspect per-object failures as well as request-level errors. A partial delete is a failed operation; retrying the same desired publish or unregister repeats the listing and converges idempotently. Site operations may read or delete only their exact artifact and index prefixes. They must never include `/_indexes/sites.json`, `/_indexes/index.html`, the application plane, or `/_control/locks/<site>.json` in site-content cleanup. Provider pagination and batch sizes stay inside the adapter, not in the product data model.

The intended GitHub-to-AWS path uses GitHub Actions OIDC rather than long-lived AWS access keys. The admin and satellite workflows use separate roles:

- The admin role deploys the application and registry projection, coordinates through the per-site lock during unregistration, and removes a site's stored prefixes.
- A satellite role can read `/_indexes/sites.json`, read and conditionally update its site's reserved lock record, and list and synchronize site content beneath `/_indexes/<site>/` and `/_artifacts/<site>/`, but cannot modify the registry object or application plane. Synchronization may require listing output prefixes and deleting stale objects in addition to uploading files.

The Artifact Pages command builds locally, acquires the site's lock, retrieves and validates the currently deployed registry, and only then makes content-plane storage changes. Registration changes do not dynamically change IAM policy; registry enforcement and the lock protocol are command-level workflow coordination, not a per-site IAM security boundary. Thus the satellite role's writable scope includes its allowed content namespaces and reserved lock object, excluding the registry object and application plane. In these examples, leading-slash paths are logical URL paths; the corresponding S3 object keys omit the leading slash. For AWS, the conceptual permissions include `s3:GetObject` on `/_indexes/sites.json`, `s3:ListBucket` constrained to the content prefixes, conditional `s3:PutObject` plus `s3:GetObject` on the lock record, and `s3:PutObject`/`s3:DeleteObject` on content objects. Exact bucket-policy conditions and API operations belong to the AWS adapter design.

The exact IAM model belongs to the AWS/publisher phase.

## 18. Viewer access and identity

Artifact Pages is a static publishing and reading product. It has no viewer accounts, login/session model, roles, or per-site access policy. It does not decide which people may view a site.

The operator chooses and configures any viewer-access control at the hosting edge or surrounding network—for example, VPN or IP restrictions, Basic Authentication, an identity provider with CloudFront signed cookies, Cloudflare Access, or an equivalent provider-specific mechanism. The control may protect a hostname, selected paths, or a broader network boundary; that scope belongs to the operator's infrastructure, not to `sites.yaml`, the public site catalog, the CLI, or the browser application. Reference infrastructure may accept customer-managed edge configuration as an input, but does not define an Artifact Pages identity or authorization policy.

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
The [preview decision register](architecture/preview-decisions.md) records product choices; the [backlog](backlog/README.md) tracks remaining technical design, implementation slices, and verification separately.

Phase 1 includes a focused local developer mode: `cmd/preview-local` builds changed documents from Git into ignored `.local/previews`, and nginx serves them through the same `/_previews/*` object layout and logical browser routes used by the preview reader. This development output is separate from the configured target used by registered-site `artifact-pages site publish` (for example, `.local/storage`). The preview domain depends on a small `PreviewStore` interface for origin reads, immutable object creation, mutable catalog replacement, and a per-site lock; `publisher.ObjectPreviewStore` bridges that contract to the shared deployment backend. At the `PreviewStore` boundary, canonical file keys encode each source path segment once; adapters validate and decode those segments once when mapping to local files or provider object keys. Stored names and manifest paths preserve the original source-relative UTF-8 text, while reader and Action URLs encode each segment once. Local registered-site publish now reconciles missing preview references after committing the production projection. This does not reconcile the separate `.local/previews` directory unless it is the selected deployment target, and it does not establish AWS/Cloudflare origin, cache, provider IAM, retention, or CI-wrapper behavior; those remain separate implementation and verification work. Viewer access remains an operator-managed edge/network concern as described in §18.

Pre-publish is a separate operation from production publish and dry-run. It creates a temporary, site-scoped review projection only for a registered site's source. A pull-request comment may carry a direct URL, but the browser must also be able to discover available previews from within that site. Previews are not inserted into the production artifact index, Browse tree, Recently updated section, or normal page-search results. The site home has a quiet link to the dedicated Previews list, not an inline list of preview entries. Inside a site, the command palette has a separate Previews tab. Opening a preview surface loads only that site's lightweight preview catalog, not catalogs for every site at startup.

Preview catalogs, logical routes, raw documents, and bundled resources are static objects served through the configured distribution. They receive no per-site authorization from Artifact Pages; they are reachable to the same extent as other objects covered by the operator's edge/network policy. This applies to pre-merge content as well: a hidden palette entry or an unguessable SHA is not an access control. Operators who do not want preview content available to everyone admitted by the distribution must configure their own edge boundary to cover preview routes and raw preview objects. Preview-only accounts or private-site permissions are not product features.

GitHub pull-request-associated pre-publish initially accepts only a head branch in the site's registered source repository. A pull request targeting that repository but originating from a fork does not inherit its trust: its head content is excluded from pre-publish even if the target site is registered. The Action must verify the head repository identity before any provider-backed publication; the provider's CI identity policy must also constrain which workflows may obtain the publisher role. Do not use a privileged `pull_request_target` workflow to check out and execute untrusted fork content. Supporting fork previews later requires an explicit approval and isolation model, because preview HTML is executable content served in the application's trust boundary. This restriction is separate from the registry's source-path eligibility check.

#### Preview rendering trust model

Preview HTML is trusted published executable content, under the same trust model as production HTML. Pre-publish approves execution of the selected content before merge; it is not a safe viewer for arbitrary untrusted changes. The operator trusts the people and CI allowed to publish. Being in a registered repository does not by itself establish that its contents are safe, and the existing registered-source/no-fork checks do not replace that publication responsibility.

Serve the raw preview document and its bundled resources from the application's origin, and load that document URL in an ordinary iframe without a sandbox. The iframe separates rendering and CSS, not hostile-script execution: preview JavaScript can access the parent application DOM, same-origin content, and origin-scoped browser storage. No separate preview hostname or deployment-config origin field is required. Logical routes, raw keys, head-snapshot bytes, and revision identity stay unchanged. Frame navigation handling still validates the sending frame/origin and allowed manifest/index destinations for routing correctness, not as a hostile-preview isolation boundary.

Use the production HTML resource-policy principles with the preview revision's raw namespace: bundled local resources and external HTTPS resources may load subject to ordinary browser TLS, CORS, and mixed-content rules; insecure external HTTP remains blocked. Do not add blanket `Access-Control-Allow-Origin: null` or wildcard CORS to solve module loading, or retain an opaque-origin `srcDoc` rendering fallback. Third-party cross-origin script reads receive no additional CORS grant. Public static objects are not made private by these rules; viewer access remains the operator's edge/network responsibility.

Preview Markdown retains the native reader's sanitized, non-executable trust model and strict, non-interactive Mermaid rendering. Publishing Markdown does not approve arbitrary script execution. Private control-object denial and real raw-resource 404s remain unchanged for both formats.

The owner accepted this contract on 2026-09-28 in [TD3](backlog/technical-design/TD3-preview-origin-delivery.md). The existing isolated-loopback/opaque-frame reader is a prior implementation model; its replacement and regressions remain [ISSUE-026](backlog/issues/ISSUE-026-preview-provider-module-loading.md), with local proof in T4/T6 and live provider proof in T15. This decision is not a claim that those changes or tests are complete.

PR provenance is an explicit pre-publish input: the caller may provide a PR number or URL, which is checked against the site's registered source repository. Neither the CLI nor its Action wrapper infers a PR association from a branch, commit, or CI event when the input is absent. Without an explicit PR reference, pre-publish creates a manual preview and the reader shows no PR link.

Each preview revision is identified within its site by the resolved source head SHA. The preview renders a snapshot of that head's source tree, not a temporary merge with the default branch and not a guarantee of the eventual post-merge result. The default branch's resolved HEAD at pre-publish time is recorded as comparison provenance and helps select the documents to preview, but is not part of the public revision identity. Its advance alone does not change an existing preview URL. The planned logical document route is `/:site/_previews/<head SHA>/<artifact path>`; `_previews` is reserved within the site namespace.

Select changed documents under the registered source path by comparing the merge-base of the current default-branch HEAD and the source head against the source head. This isolates the source's changes without treating commits added only to the default branch as preview changes. Only added or modified HTML/Markdown documents present in the head tree are previewable; a rename previews the destination path as an addition. A deleted source path has no preview and is not shown as a preview item. The selected documents and all previewed bytes come from the head tree. Do not use a direct default-branch-HEAD-to-head tree comparison for selection. A deletion-only document change produces an explicit `no-preview` result rather than a fabricated page or preview URL. A change containing only non-document files remains ineligible for pre-publish and is an error. If a PR group previously had a preview, `no-preview` removes that group's discovery entry without deleting the older bytes.

Keep navigation links distinct from rendering dependencies. For statically resolvable links in previewed HTML or Markdown, a link to another changed document opens that document in the same preview revision; a link to an unchanged document opens its production logical route. HTML links must transition the parent application rather than nesting an application route inside the artifact iframe. Copy the local CSS, JavaScript, images, fonts, and other resources needed to render a changed document from the head tree into the preview bundle, preserving relative relationships where possible. This does not require recursively copying every document reachable by navigation links. External HTTPS links remain external.

Automatically collect statically resolvable local rendering resources. Pre-publish also accepts explicit source-relative paths or patterns for additional non-document resources whose names are constructed dynamically; reject missing paths, paths outside the registered source tree, and attempts to include unchanged HTML/Markdown as a shortcut around the changed-document rule. Such an include makes relative dynamic resource URLs work when their resolved preview locations match the copied layout. It cannot generically redirect JavaScript-built root-relative URLs or rewrite arbitrary runtime navigation, so those behaviors are outside the automatic preview guarantee.

#### CLI and Action interface

Provider-backed pre-publish is exposed as a separate command from local development preview and production site publish:

~~~sh
artifact-pages preview publish --site ID --source DIR --base-url ORIGIN \
  [--head REF] [--default-ref REF] [--pull-request REF] [--include PATH] \
  [--config LOCATOR] [--dry-run] [--format text|json]
~~~

`--site`, `--source`, and `--base-url` are required. `--source` is relative to the current Git checkout and must exactly match the registered source path. `--head` selects the preview tree and defaults to `HEAD`; `--default-ref` selects the current default-branch reference used for merge-base comparison and defaults to `origin/HEAD`. Only committed Git trees at those refs are read. `--base-url` is an HTTP(S) origin without a path, query, or fragment; it is used to construct the returned group and document URLs. `--config` uses the deployment-config locator described in §22 and defaults through T10's locator precedence.

`--pull-request REF` accepts either a positive PR number or a canonical `https://github.com/OWNER/REPO/pull/NUMBER` URL. The repository is identified from the checkout's Git origin. The CLI reads the PR through GitHub's REST API and verifies its base repository, same-repository head, and head SHA against the selected source head and the registered source repository. A read token, when needed for a private repository, is taken from `GITHUB_TOKEN` or `GH_TOKEN`. Omitting this flag always creates a manual group, even in a PR-triggered workflow.

`--include PATH` is repeatable and accepts an exact source-relative path or a Go `path.Match` pattern evaluated over slash-separated source paths. Wildcards do not cross `/`. Each match must be a non-document resource beneath the registered source path. Missing matches, out-of-tree paths, and unchanged HTML/Markdown matches are errors. Automatic resource discovery remains enabled independently of these additional includes.

`--dry-run` reads the Git source, deployment config, deployed registry, and the preview objects/catalog needed to make a plan, but it acquires no publication lock and performs no provider writes, deletes, or cache changes. It reports `planned` when the plan would change state and `no-op` when the current projection already matches. A deletion-only document change returns `no-preview`; a change containing only non-document files is an error.

JSON output has `operation`, `outcome`, `site`, `groupId`, `headSha`, optional `pullRequestUrl`, `groupListUrl`, `documents`, `objects`, `catalogChanges`, optional `configCommitSha`, and optional `error`. Each document contains its source-relative `path`, `title`, and fixed revision URL. PR document URLs include the group's query context; manual URLs do not. `objects` sort by path with the manifest last. `catalogChanges` sort by group ID, head SHA, action, then reason. A publication failure after source selection retains the known group and document URLs in the typed failure result; earlier failures without a resolved preview identity return empty arrays. Outcomes are `planned`, `published`, `no-op`, `no-preview`, or `failed`. Successful outcomes exit zero; invalid command/config input exits two, while GitHub lookup, provider, and publication failures exit one and return the typed failure envelope when JSON was requested.

The optional thin preview Action maps its `site`, `source`, `head`, `default-ref`, `pull-request`, `base-url`, `config`, and `dry-run` inputs to this same command; its `include` input is a newline-separated list expanded to repeated `--include` flags. It exposes `outcome`, `group-list-url`, and `documents` (the CLI document array serialized as JSON), and may expose the full CLI JSON result as `result`. It does not infer PR provenance, select event timing, or post comments. The separate production admin/site Actions use the T11 contract.

While a completed revision remains at the provider, its URL must not change content: retrying the same head verifies the existing projection and does not rewrite its objects merely to extend provider retention. A changed projection or document set for the same head is an error, including if an unusual default-branch history change produces a different merge-base. Direct preview URLs resolve through their own completed revision manifest, not the mutable discovery catalog.

The preview catalog is a mutable static object containing discoverable preview metadata and links. When the caller explicitly supplies a PR reference, it shows only the latest completed pre-publish in that PR's group. Older revisions are removed from the catalog but their direct URLs remain usable while their provider objects remain available. The core preview-group identity is not tied to a particular CI provider. Pre-publish without a PR reference is manual and uses its head SHA as its discovery group. PR and head-derived groups occupy distinct namespaces so they cannot collide. Group identity determines which revision appears in discovery; it is not the revision's URL identity. The v1 catalog and manifest fields, keys, and digest are settled in the [T1 record contract](backlog/technical-design/T1-preview-record-contract.md).

The site's `/:site/_previews` view lists available groups. An optional URL-encoded `group` query parameter filters that view to one group and always resolves through the current catalog, so it is a mutable latest-preview link suitable for a pull-request comment. It is not a fixed revision URL: if the group has no current preview or its revision is no longer available from the provider, the view shows an empty state rather than an obsolete revision. The Action exposes this group-list URL and the individual revision-specific document URLs as outputs; when a PR reference was explicitly supplied, each document URL carries that PR group's view context so a reviewer can return from the artifact to the PR. Caller-owned workflows decide whether and how to post the URLs to a PR. A separate per-revision summary page is not required.

The selected reader treatment is a quiet preview provenance label in the application header, not inside the artifact. It distinguishes the short head SHA from production without changing the document H1 or adding a reader strip. Every PR-associated preview document opened with its PR-group context shows a subtle PR-number link back to the validated source PR. The reader checks the site catalog to confirm that the named group is explicitly PR-associated and currently points to the URL's head SHA; it never infers a PR from the SHA alone. Preview-to-preview document navigation within the same revision preserves this view context; navigation to a production document does not. A manual preview, a bare revision URL without group context, or a missing, mismatched, or unreadable group still renders the document when its own completion manifest is available, but shows no PR link. Group context affects only reader chrome, not revision identity or artifact bytes. Direct revision URLs remain usable as previews after their groups leave discovery, while provider objects remain available, even though their PR link may then disappear. The document H1 remains untouched and no reader strip is added. T1 records the v1 route-key and query encoding.

Preview discovery follows provider availability, not Git or PR state. A preview remains discoverable while its completion manifest exists, including after its PR is merged or closed without merging. The ordinary `artifact-pages site publish` operation reads the site-scoped catalog and, through the configured storage adapter, prunes references whose completion manifests are confirmed missing at provider origin. Pre-publish does the same before its own catalog upsert. Neither operation compares production commits with PRs or polls PR state for cleanup. GitHub Actions is an optional wrapper for checkout, credentials, invocation, and presentation of the result; it does not implement a separate cleanup algorithm.

For production publish, read the current catalog at provider origin under the site lock and check its referenced manifests, but write a reduced catalog only after the production projection has been committed at origin. Write only when confirmed missing references were removed; a failed production publish must not hide its previews. Catalog cleanup removes references, not completed preview bytes or fixed direct URLs; those remain usable while the provider retains them. Between catalog writes, the reader checks manifest availability and hides missing candidates. A provider read error is not a confirmed absence and must not trigger pruning. An absent logical preview document shows a neutral "Preview unavailable" state with a way back to its site; missing raw preview resources return a real not-found response rather than the SPA document.

Pre-publish shares the cooperative per-site storage lock with production publish and `registry unregister`. After acquiring the lock, it revalidates the deployed registry directly from storage. It uploads the new preview bundle and its completion manifest before reading and updating the catalog from storage. Updating the catalog is an idempotent upsert by preview identity, not a blind append. If the catalog update fails, the incomplete publication reports failure and can be retried; unlisted uploaded objects remain subject to preview retention. A different CI run for the same site cannot overwrite that catalog update while the lock is held. Unregister waits for an already-running pre-publish, then removes that site's preview projection along with its production projection.

Pre-publish does not immediately delete an older completed revision when a newer one replaces it in the catalog. Early deletion would break previously shared direct URLs and could leave a cached catalog pointing at missing content. Preview lifetime is delegated entirely to the provider's administrator-defined lifecycle policy: the application does not compute, store, display, or enforce its own expiry timestamp. Catalog entries are discovery candidates, not proof that their manifests still exist. The local Previews list checks fixture or local manifests when opened; registered-site production publish also removes confirmed-missing references from the `_previews` prefix in its configured target after a successful production projection. That core reconciliation is exercised with the local backend. Real provider-origin behavior, provider-backed availability checks, lifecycle and shared-cache behavior remain separate verification work. Any viewer access gate is independently configured and verified by the operator at the edge.

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

Satellite publish and `registry unregister` for one site serialize through a shared per-site storage lock; registry publication updates are serialized through one registry deployment path.

Fixture and registered modes read `/_indexes/sites.json` and lightweight per-site metadata; both modes load only the active site's artifact index. The browser does not use nginx autoindex or object-storage ListObjects APIs.

Artifacts live under /_artifacts.

Indexes live under /_indexes.

Logical user routes do not expose the storage projection as the main UX.

Prefer publish-time computation over request-time services.
~~~

## 22. Deployment configuration and command interface

Deployment targets are described by a strict version-1 YAML file, separate from the admin-owned `sites.yaml` registry. The file selects exactly one provider and its settings. The local target stores `root`; AWS stores `region`, `bucket`, and optional `distributionId`; Cloudflare stores R2 `accountId` and `bucket`, `zoneId`, `publicBaseURL`, and environment-variable names for its R2 access key, secret key, and cache-purge API token. Cloudflare may optionally name `sessionTokenEnv` for an externally issued short-lived R2 credential; the CLI passes that session token to the S3 client but does not mint or renew temporary credentials. Cloudflare may also configure a separate registry-reader identity with `registryReaderAccessKeyIdEnv`, `registryReaderSecretAccessKeyEnv`, and optional `registryReaderSessionTokenEnv`. When configured, only `GetObject("_indexes/sites.json")` uses that identity; all object writes and other object operations use the primary R2 identity. If reader credential environment names are configured but their key or secret values are missing, the CLI fails before making provider requests instead of falling back to the primary identity. A satellite deployment should scope its reader credential to read the exact registry object, and scope its primary credential to that site's index, artifact, and preview prefixes plus its site lock; the primary credential must not include the registry object. An admin deployment that publishes the registry can omit the reader identity and use its primary credential. The R2 and cache API credential values may be absent from invocations that do not use them: `site publish` needs R2 access, while operations that invalidate public cache also need the zone API token. AWS and Cloudflare targets also set one positive `previewRetentionDays` value for provider-managed `_previews/` lifecycle rules. Local development may omit that policy. Configuration contains no credential values. AWS credentials use the standard AWS credential chain. For local conformance only, Cloudflare may also set loopback-only `r2Endpoint` and `apiBaseURL` overrides; these are rejected for non-loopback hosts. The `gcp-local` provider accepts only an HTTP loopback endpoint and bucket for fake-gcs-server and is an emulator test profile, not a production GCP adapter.

A config locator is a local path or `github://OWNER/REPO/FILE?ref=REF`. When a GitHub file is omitted, resolve `.artifact-pages.yaml`, then `artifact-pages.yaml`, and fall back only on a confirmed 404. When `ref` is omitted, resolve the repository's default branch to a commit SHA, then fetch the selected file at that SHA for the whole invocation. A caller may pin a commit directly. Every invocation re-fetches remote configuration; a remote URL is deployment input, not a trust boundary. Private config reads may use `GITHUB_TOKEN` or `GH_TOKEN`; redirects to another host, oversized responses, and credentials in diagnostics are rejected.

For a remote config, command output reports the resolved config commit: text output prints `Deployment config commit: SHA`, and JSON result and failure envelopes include `configCommitSha`. Local config results omit this field.

Config locator precedence is `--config`, `ARTIFACT_PAGES_CONFIG`, repository-local `.artifact-pages.yaml`, then the user's saved locator. `artifact-pages config set-default LOCATOR` updates only that locator in the user's config directory. A satellite repository resolves its deployment target without cloning the admin repository; publishing eligibility still comes from the deployed `/_indexes/sites.json` registry.

For local development, a repository may commit a non-secret target file and admin-owned registry:

~~~yaml
# .artifact-pages.yaml
schemaVersion: 1
provider: local
local:
  root: .local/storage
~~~

~~~yaml
# sites.yaml
schemaVersion: 1
sites:
  sre:
    name: SRE & Platform
    repository: acme/platform
    sourcePath: docs/artifacts
~~~

`registry publish` validates the Git-owned YAML, builds its JSON projection, and deploys that registry in one operation. The operator can review the plan and publish one explicit site with:

~~~text
artifact-pages registry publish --manifest sites.yaml --config .artifact-pages.yaml --dry-run
artifact-pages registry publish --manifest sites.yaml --config .artifact-pages.yaml
artifact-pages site publish --config .artifact-pages.yaml --site sre --source docs/artifacts --dry-run
~~~

In a separate admin/satellite layout, the satellite can select a pinned remote target config while still using the deployed registry for eligibility:

~~~text
artifact-pages site publish --config 'github://acme/platform-admin/.artifact-pages.yaml?ref=0123456789abcdef0123456789abcdef01234567' --site sre --source docs/artifacts --dry-run
~~~

The operation-oriented command surface is provider-neutral:

~~~text
artifact-pages registry publish [--manifest sites.yaml] [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages registry unregister --site ID [--manifest sites.yaml] [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages site publish --site ID [--source DIR] [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages app deploy (--version VERSION | --archive FILE) [--repository OWNER/REPO] [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages lock inspect (--site ID | --scope registry) [--format text|json]
artifact-pages lock recover (--site ID | --scope registry) --observed-etag ETAG [--format text|json]
~~~

`registry publish` validates the selected YAML manifest, creates the registry projection, and reconciles it to the configured target as one operation. It serializes whole-registry updates, reports `registryUpdated` as a boolean on planned, published, and no-op outcomes, and includes an empty `changes` array when the registry is already current. `registry unregister --site ID` expects the checked-out manifest to already omit that site; it publishes that desired registry and cleans the selected site's exact prefixes, including when retrying after a previous registry withdrawal. Every site operation selects one explicit site ID. `--config LOCATOR` is an optional deployment-target selector and follows the locator precedence above. `site publish` builds the index and static source projection as one operation; `index build` remains a local utility and is not required for publishing.

`--dry-run` is the common read-only planning option for registry publish/unregister, site publish, and app deploy. It may read the config and deployed objects needed to calculate the plan, but does not write or delete objects, recover locks, or request cache changes. `app deploy` accepts exactly one of `--version` or `--archive`. `--version` selects and verifies a published release; it downloads the bundle in a temporary location that is removed after the command. `--archive` accepts a caller-provided packaged archive with its adjacent manifest and checksum. For site publish, JSON `changes` is the full per-path production change list, sorted by path and action; JSON `previewChanges` is the full per-group preview disposition list, sorted by group ID and head SHA. Each `previewChanges` entry contains `groupId`, `headSha`, `action` (`remove` or `keep`), and `reason` (`manifest-missing`, `manifest-present`, or `manifest-unavailable`). Remove a catalog reference only when its completion manifest is confirmed missing; keep live and unavailable groups. A provider read error is not evidence that a manifest is missing. Text output summarizes production create, update, removal, preview prune, and retain counts. The same plan and classifications apply to real publish; a preview-only catalog prune is a published change, and the operation is a no-op only when neither production objects nor preview references need changes. JSON results use stable operation/outcome/change/result fields, with `site` and `previewChanges` for site publish and `registryUpdated` for registry operations. Plans, success, and no-op outcomes exit 0; invalid command, config, or manifest exits 2; provider and reconciliation failures exit 1. Optional GitHub Actions invoke the same CLI operations and relay their results without implementing separate publish or cleanup logic.

The application orchestration consumes provider-neutral storage and cache interfaces. AWS/S3/CloudFront and Cloudflare/R2/cache APIs stay in adapter and deployment packages; they do not define the site registry, content keys, browser routes, or publication order.

`registry unregister --site ID` expects the checked-out admin manifest to already omit that site, keeping YAML as the sole editable source of truth. It withdraws the current deployed registration, then cleans the selected site's exact content and preview prefixes while holding the site lock. It remains safe to retry after registry withdrawal. Lock commands support `--scope registry` for the whole-registry serialization lock and `--site ID` for a per-site lock.
