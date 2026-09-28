# Thesis

Git Artifact Pages exists because static artifacts often want two properties at the same time:

1. **Git-native lifecycle** — artifacts should be reviewed, linked, versioned, and recoverable alongside engineering work.
2. **Web-native consumption** — a reviewer should open a normal URL and immediately browse, search, and read the rendered artifact.

Existing choices tend to optimize for only one side. Git hosts preserve history well but treat HTML primarily as source. Static hosting makes HTML easy to consume but usually turns deployment into a separate lifecycle.

Git Artifact Pages treats Git as the source of truth and a static website as a **projection** of that source.

## The central model

~~~text
Git source
(repository, ref, sourcePath)
        ↓
publish
        ↓
site namespace / mountPath
        ↓
static projection
├── _indexes
└── _artifacts
        ↓
object storage + CDN
        ↓
browser SPA
~~~

The SPA is not the system of record. S3 is not the system of record. The CDN is not the system of record.

**Git is authoritative. Everything served to the browser is reproducible projection data.**

## Design principles

### Static by default

If a feature can be computed at publish time and served as a static file, prefer that over a request-time backend.

### Build-time over request-time

Search metadata, recent items, file trees, and table-of-contents information should be precomputed when practical.

### Stable application, changing content

The browser application changes infrequently. /_indexes/* and /_artifacts/* change as teams publish.

### Site namespace over repository identity

A site is a logical destination such as sre or frontend. Repository boundaries do not have to appear in the public URL.

### Explicit ownership

If multiple repositories are supported later, each publisher must own a non-overlapping mount path. Namespace collision is a configuration error. Multi-repository contribution is not required for the initial builder; it consumes one repository source per site.

### Infrastructure is an adapter

Cloudflare and AWS are delivery adapters, not the definition of the product. The core contract is the static projection and the browser that consumes it. The project's selected public deployment uses Cloudflare, while AWS is verified independently; the [domain and delivery policy](architecture/deployment-domain-policy.html) is an operator choice, not part of the Site or Artifact model.
