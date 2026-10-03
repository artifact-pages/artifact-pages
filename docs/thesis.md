# Thesis

Independent publishing, shared experience.

Teams produce static artifacts in many Git repositories: HTML reports, design documents, diagrams, generated explanations, Markdown notes. Readers want to find, open, and read them in one place. The usual ways of getting there each give something up:

- A central documentation build gathers every repository and regenerates the whole website. Readers get one site, but every team now depends on a shared pipeline and its timing.
- Each repository hosts its own static site. Teams publish freely, but readers face scattered websites with different navigation and no shared way to find anything.
- A dedicated documentation service holds the content. Reading is unified, but the artifacts leave Git and acquire a second lifecycle outside review and history.

Git Artifact Pages keeps the publishing independence of the second option and the single reading place of the first, without moving the source of truth out of Git.

## The central model

~~~text
Git-managed artifacts
(repository, sourcePath; made, reviewed, versioned there)
        ↓
independent publish
(one site per run, from that site's own repository, CI, and timing)
        ↓
shared static projection
├── _indexes
└── _artifacts
        ↓
object storage + CDN
(no particular cloud, no application server in the request path)
        ↓
one reader app
(site discovery, tree, palette, page text search, pins and recents, reader, contents, links to previews and Git)
~~~

The four parts depend on each other:

1. **Git is the source of truth.** Artifacts are made in the repository that produces them, reviewed there, and published with their history intact. Artifact Pages does not edit or manage them.
2. **Publishing is independent.** No central build gathers every site. A site is registered once, and from then on its repository publishes only that site's scope, whenever it changes, without waiting for any other site's build or deploy.
3. **The platform is shared and static.** Every site's output lands in one common static projection with a fixed layout. It is designed so that any object store and CDN can serve it; there is no always-on backend. Because the layout is shared, independently published sites form one Artifact Pages space rather than separate websites.
4. **The frontend is rich and unified.** One browser application reads that projection and gives every site the same way to discover, navigate, search, and read.

Individual features such as page text search or CDN delivery are components that make this model work.

The SPA is not the system of record. Object storage is not the system of record. The CDN is not the system of record.

**Git is authoritative. Everything served to the browser is reproducible projection data.**

## Design principles

### Static by default

If a feature can be computed at publish time and served as a static file, prefer that over a request-time backend.

### Build-time over request-time

Search metadata, recent items, file trees, and table-of-contents information should be precomputed when practical.

### Publish per site, not per platform

A publish run writes one site's scope and nothing else. No step should require rebuilding or redeploying other sites, and the shared parts (the reader app and the site registry) change through their own explicit operations.

### Stable application, changing content

The browser application changes infrequently. /_indexes/* and /_artifacts/* change as teams publish.

### Shared layout, shared experience

Every site uses the same projection layout and the same reader. Upgrading the reader app changes the reading experience of every site without republishing them, and a site publishes without coordinating with the app's release.

### Site namespace over repository identity

A site is a logical destination such as sre or frontend. Repository boundaries do not have to appear in the public URL.

### Explicit ownership

If multiple repositories are supported later, each publisher must own a non-overlapping mount path. Namespace collision is a configuration error. Multi-repository contribution is not required for the initial builder; it consumes one repository source per site.

### Infrastructure is an adapter

Cloudflare and AWS are delivery adapters, not the definition of the product. The core contract is the static projection and the browser that consumes it. The project's selected public deployment uses Cloudflare, while AWS is verified independently; the [domain and delivery policy](architecture/deployment-domain-policy.html) is an operator choice, not part of the Site or Artifact model.
