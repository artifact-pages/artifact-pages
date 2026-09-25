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
~~~

It is independently deployable from the application plane.

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

The local reference implementation discovers site IDs from the site-directory links in the listing at `/_indexes/` and fetches each site's small `<site>/meta.json` discovery metadata. This metadata contains the site's display name, artifact count, generated time, and an `artifactIndexUrl` pointer. It does not contain artifact records.

The browser loads a site's full artifact index only when that site becomes active. It does not fetch all artifact indexes during startup. No separate `sites.json` registry is required for the local product; the listing remains the discovery entry point.

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

For Markdown, the first H1 supplies the display title, with a readable filename fallback when there
is no H1. Markdown headings are indexed for Contents, and generated heading IDs match the reader.
HTML retains its `<title>`-based display title and existing precomputed heading behavior.

### Publishable source directory

The builder's `sourcePath` is the exact static content tree intended to be served beneath `/_artifacts/<site>/`. It may contain directly authored static files or output from another site generator, but HTML and Markdown must already be ready to publish: this builder does not expand templates, run site generators, bundle CSS or JavaScript, rewrite resource URLs, or copy files.

The builder recursively indexes every `.html`, `.htm`, and `.md` file under that tree, including root-level and nested `index.html` files. Every page uses its full source-relative filename and extension in its route; index files do not alias their parent directories. No directory-name or dotfile heuristic excludes pages; for example, HTML or Markdown under `_includes/` is indexed if that directory is inside `sourcePath`. Select a publishable root that contains the pages to expose and excludes source-only templates or partials.

Local resources referenced by those pages must also be present under `sourcePath`, with their relative directory structure intact. External resources may be referenced over HTTPS under the artifact resource policy described below. The index builder leaves the tree unchanged and emits metadata only. The later publish operation treats the publishable files in `sourcePath` as the desired artifact state: it uploads new and changed files and removes stale objects under that site's artifact prefix, excluding Git metadata such as `.git` and without touching another site, the registry object, or the application plane. It also publishes the generated per-site metadata and index.

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

### Concurrent publish and unregister

Checking the registry and then publishing without coordination has a time-of-check/time-of-use race: an unregister can remove the registration and delete the site's objects after a publisher's check but before that publisher writes. The provider publishing contract therefore uses one cooperative, per-site storage lock shared by satellite publish and admin unregister operations.

The lock is a reserved control object outside the site's index and artifact prefixes, for example `/_control/locks/<site>.json`. It is not part of the registry, browser index, or published site data, and deleting a site's projection must not delete it. The hosting adapter must not expose control objects through the public site distribution. Keep one small lock record per site with `free` or `held` state and an opaque operation/run identifier while held; retain the free record after unregister rather than relying on conditional object deletion. For first use, create it atomically only if absent. For later acquisitions, releases, and recovery, compare-and-swap the record with a conditional `PutObject` using the current ETag (`If-Match`). This lets a recovery operation detect that the lock changed after inspection rather than clearing a newer owner's lock.

The critical sequences are:

~~~text
satellite publish:
  build locally
  acquire site lock
  fetch the current deployed registry directly from storage and validate the exact source
  synchronize that site's index and artifact prefixes
  release site lock

admin unregister:
  serialize with other admin registry deployments
  publish the registry without that site
  acquire the same site lock
  delete that site's index and artifact prefixes
  release site lock
  invalidate/revalidate affected CDN paths
~~~

The publisher must perform its authoritative registry check **after acquiring the lock**, against the current deployed object rather than a CDN-cached response. Unregister first removes the entry from the deployed registry, closing the gate to new valid publishes; it then acquires the site lock and waits for any publisher that already passed its check to finish before deleting the projection. A publisher that acquires the lock after registry removal sees the missing entry and exits without writing. Unregister is idempotent for its explicit target site ID: if cleanup fails after registry removal, retry still acquires that site's lock, deletes its prefixes if needed, and repeats cache invalidation even though the registry entry is already absent. An unregister command reports success only after registry publication, origin deletion, and CDN invalidation/revalidation have completed. If the final cache step fails, the site remains unregistered and its origin data remains deleted, but the command reports failure so cleanup can be retried; the admin registry deployment path stays serialized through this step to prevent re-registration from racing the pending cache update. Unrelated sites use different locks and may publish concurrently. Registry JSON updates are whole-object writes, so all admin registry deployments must also be serialized through the single admin deployment path; per-site locks alone do not prevent two admin updates from overwriting each other.

Locks do not expire automatically in v1. This fails closed if a process dies: publishing or unregister cleanup for that site remains blocked until an operator confirms no operation is active and uses a compare-and-swap transition to mark the stale lock free. The Artifact Pages command must provide lock inspection and guarded stale-lock recovery; operators should not need raw provider CLIs. If the ETag changed since inspection, recovery must stop and inspect again. A time-based lease without fencing is not sufficient, because a paused publisher could resume after its lease expires and write anyway. Commands wait/retry for a bounded period when another operation holds the lock, then fail without taking it over; the precise timeout and retry schedule are adapter details. This is coordination among supported Artifact Pages commands, not an IAM security boundary; callers with direct write credentials can bypass it.

The exact YAML file location and full validation rules remain open. The JSON projection path and its role as the shared runtime representation are fixed for this model. The initial model has one source per site and no mount-path merging; if multi-repository sites are introduced later, the registry must prevent overlapping mount paths.

Registry validation must reject invalid or reserved site IDs, blank names, and unsafe source paths. Source paths are canonical repository-relative POSIX paths: `.` represents the repository root; absolute paths, `..` segments, and backslashes are rejected. The exact `(repository, sourcePath)` pair may be registered only once, while different paths in the same repository may belong to different sites. The publisher also verifies that `sourcePath` exists as a directory inside its checkout. If mount-path merging is introduced, it must also reject:

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
Browser
   ↓
nginx (Docker Compose)
   ├── /_indexes/*   → fixture/generated static files
   ├── /_artifacts/* → fixture/generated static files
   └── everything else → Vite SPA index.html
~~~

Committed fixture data lives separately from generated local state.

Recommended convention:

~~~text
fixtures/storage/   committed representative projection
.local/             generated/untracked projection
~~~

The local product should be usable before any AWS code exists.

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

AWS is the first intended production adapter, after the local contract is stable.

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

## 16. Cache model

The application and content planes have different lifecycles.

Expected direction:

~~~text
/index.html             short/revalidated
/assets/<hashed>*       long/immutable

/_indexes/sites.json    registration/discovery state; revalidate or expire promptly on changes
/_indexes/<site>/*      short/revalidated
/_artifacts/*           mutable stable paths; finite freshness lifetime and revalidation
~~~

The provider adapter must ensure registration changes become visible through the CDN before browser clients rely on the new registry state. For AWS, the publisher's registry read is directly from the S3 object and therefore does not depend on CloudFront cache freshness; browser visibility still requires timely CDN revalidation or invalidation. Normal publish relies on the finite freshness lifetime and revalidation of mutable artifact/index paths; it does not require CDN invalidation for every publish. On unregister, the affected cache set includes `/_indexes/sites.json`, `/_indexes/<site>/*`, and `/_artifacts/<site>/*`; the adapter may use provider invalidation or an equivalent revalidation/expiry mechanism, but must not report unregister success while stale cached site content may still be served. The mechanism is provider-specific and does not change IAM permissions.

Artifact paths may later become commit-addressed/immutable, which would allow aggressive CDN caching. That is an optimization, not an MVP requirement.

## 17. Publishing and AWS credentials

The user-facing publishing interface is the `artifact-pages` command. Its provider adapter performs the provider API operations; users do not need to invoke raw provider CLIs such as `aws s3` for the product workflow.

The intended GitHub-to-AWS path uses GitHub Actions OIDC rather than long-lived AWS access keys. The admin and satellite workflows use separate roles:

- The admin role deploys the application and registry projection, coordinates through the per-site lock during unregistration, and removes a site's stored prefixes.
- A satellite role can read `/_indexes/sites.json`, read and conditionally update its site's reserved lock record, and list and synchronize site content beneath `/_indexes/<site>/` and `/_artifacts/<site>/`, but cannot modify the registry object or application plane. Synchronization may require listing output prefixes and deleting stale objects in addition to uploading files.

The Artifact Pages command builds locally, acquires the site's lock, retrieves and validates the currently deployed registry, and only then makes content-plane storage changes. Registration changes do not dynamically change IAM policy; registry enforcement and the lock protocol are command-level workflow coordination, not a per-site IAM security boundary. Thus the satellite role's writable scope includes its allowed content namespaces and reserved lock object, excluding the registry object and application plane. In these examples, leading-slash paths are logical URL paths; the corresponding S3 object keys omit the leading slash. For AWS, the conceptual permissions include `s3:GetObject` on `/_indexes/sites.json`, `s3:ListBucket` constrained to the content prefixes, conditional `s3:PutObject` plus `s3:GetObject` on the lock record, and `s3:PutObject`/`s3:DeleteObject` on content objects. Exact bucket-policy conditions and API operations belong to the AWS adapter design.

The exact IAM model belongs to the AWS/publisher phase.

## 18. Access control

Repository read permission and website viewer permission are separate concerns.

The first AWS reference implementation may support simple deployment-level controls such as:

- network/IP restrictions
- Basic Authentication
- an existing organizational identity layer

Mirroring GitHub repository ACLs for each viewer is not an initial goal.

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

## 20. Non-goals for the MVP

- server-side rendering
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

Satellite publish and admin unregister for one site serialize through a shared per-site storage lock; admin registry projection updates are serialized through one admin deployment path.

The browser discovers sites through the local `/_indexes/` listing and lightweight per-site metadata, then loads only the active site's artifact index. It does not use browser-side object-storage ListObjects APIs.

Artifacts live under /_artifacts.

Indexes live under /_indexes.

Logical user routes do not expose the storage projection as the main UX.

Prefer publish-time computation over request-time services.
~~~
