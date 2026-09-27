# IMP-36 — Local edge-to-object-storage conformance environments

- Status: Open
- Phase: Phase 1 — Local product (provider-contract test foundation)
- Depends on: [IMP-21](IMP-21-registered-discovery.md), [IMP-22](IMP-22-site-locks.md), [IMP-25](IMP-25-production-reconciler.md)
- Enables: stronger local/E2E coverage for [IMP-28](IMP-28-local-operator-flow.md), [IMP-29](IMP-29-aws-production-adapter.md), and [IMP-32](IMP-32-cloudflare-production-adapter.md)

## Background

The current browser stack uses nginx for edge behavior, but mounts `fixtures/storage` (or `.local/storage`) into nginx and serves content directly from that filesystem. This proves the HTTP routes and publishing logic separately, but does not prove that publish writes through an object-storage API and that the edge then reads those objects from an origin.

Build a repeatable local topology that exercises the product's actual boundary:

~~~text
artifact-pages publish / fixture seeding
                 ↓ PUT / object API
        object-storage origin
                 ↑ origin reads
Browser → local edge / CDN equivalent
~~~

The goal is to test Git Artifact Pages' storage and HTTP contracts across adapters. It is not to recreate cloud control planes, CDN internals, or every provider behavior.

## Scope

- Add local Compose profiles for the three intended deployment shapes: AWS (CloudFront + S3), Cloudflare (Cloudflare edge + R2), and GCP (Cloud CDN + Cloud Storage).
- Use nginx or an equivalent local reverse proxy as the edge, and a local object-storage API/emulator as its origin. Keep the SPA application plane separate from the changing `/_indexes/*` and `/_artifacts/*` objects.
- Seed committed fixtures and generated/build output by PUT or the same publish path used by the application. Do not bind-mount the dynamic object tree into nginx.
- Preserve the existing browser-facing route, SPA fallback, real artifact-resource 404, CSP, cache-header, and MIME contracts.
- Run the same origin/storage contract tests and browser E2E cases against all three local profiles, with a provider adapter translating only at the infrastructure boundary.
- Determine whether `/_indexes/` autoindex discovery can work through a static object-storage/CDN origin. If it cannot be made portable, publish and consume a static site catalog (or another documented static discovery projection) and update the fixture and registered modes to use the portable contract.
- Record emulator choices, startup/seed/publish commands, readiness checks, limitations, and how to run each profile in the developer guide.

## Out of scope

- Exact emulation of CloudFront, Cloudflare edge services, or Cloud CDN behavior.
- Provisioning or changing real AWS, Cloudflare, or GCP accounts/resources.
- Claiming a production GCP deployment adapter is supported. GCP is included here as a local contract profile only.
- Replacing provider-specific production adapters or weakening their real-provider smoke tests.

## Acceptance criteria

- [ ] Each profile starts from a clean local state using documented commands and has a health/readiness check for both origin and edge.
- [ ] Fixture seeding and a real `artifact-pages site publish` write dynamic objects through the configured object API. The nginx edge has no read-only bind mount of the dynamic storage tree.
- [ ] Browser requests for `/_indexes/*` and `/_artifacts/*` pass through the edge to the origin; index/catalog changes made via the object API become visible without rebuilding the SPA image.
- [ ] The same HTTP contract suite passes for all three profiles: SPA route fallback, index and artifact responses, relative HTML/Markdown resources, correct MIME/cache/CSP headers, and a real 404 for a missing artifact resource rather than the SPA shell.
- [ ] The same storage contract suite passes for the supported operations exercised by the app: object PUT/GET/HEAD, complete prefix listing, conditional writes/lock CAS, batched deletion, and error mapping. Any emulator limitation is documented and does not silently count as proof of a provider-specific production behavior.
- [ ] The site chooser works without nginx autoindex or object-store `ListObjects` at browser request time. If that requires a static catalog, it is published as an object and covered by tests for empty, multiple-site, and changed registries.
- [ ] Existing fixture browsing, local registered-site publish, and preview-local workflows remain runnable; local generated state stays under ignored `.local/`.
- [ ] Documentation states what this setup proves and what still requires AWS/Cloudflare real-service smoke tests. `docs/specification.md` and `docs/roadmap.md` reflect any changed discovery or local-serving contract.

## Implementation note

Prefer a parameterized test suite and small per-profile Compose/config files over three copied applications. Select emulators based on the API operations above; a passing emulator test is contract evidence, not proof that the corresponding public cloud service is identical.
