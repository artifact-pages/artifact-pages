# Local edge and object-storage profiles

These Compose profiles exercise the browser-facing edge and storage adapters through local object APIs. They keep generated data and deployment config under ignored `.local/edge-profiles/`.

## Requirements

- Docker with Compose v2
- Node.js and the repository's installed npm dependencies
- Go, for `artifact-pages site publish` and the provider contract suite

## Run a profile

From the repository root, start one profile:

```sh
node scripts/run-edge-profile.mjs aws
node scripts/run-edge-profile.mjs cloudflare
node scripts/run-edge-profile.mjs gcp
```

Each command resets the profile's object projection to committed fixtures, builds the SPA, starts the origin and nginx edge, and waits for origin and edge readiness. It runs `artifact-pages site publish` against the configured adapter, then registers a temporary site by reconciling the complete manifest through the same object API, including cleanup of content for any omitted sites. The runner verifies that the edge can read both the changed site index and changed catalog without rebuilding the SPA, runs the object-storage conformance test against the live emulator, restores the committed fixture projection, and runs `e2e/local-serving.spec.ts` against nginx with one worker for repeatability. A successful command leaves the profile running at `http://127.0.0.1:8081`.

To stop a profile:

```sh
node scripts/run-edge-profile.mjs down aws
node scripts/run-edge-profile.mjs down cloudflare
node scripts/run-edge-profile.mjs down gcp
```

The generated origin data and `deployment.yaml` remain under `.local/edge-profiles/<profile>/` for inspection. Set `EDGE_PROFILE_STATE_ROOT` to use another repository-relative or absolute state directory; it defaults to `.local/edge-profiles`. Starting AWS or Cloudflare clears and recreates its MinIO state; GCP keeps fake-gcs-server's bucket metadata across restarts and replaces its objects through the API seeder. Set `EDGE_PORT`, `MINIO_PORT`, `GCS_PORT`, or `CF_API_PORT` to change the default loopback ports (`8081`, `19000`, `14443`, and `18787`).

## Profiles and evidence

| Profile | Local origin and edge | Contract demonstrated |
| --- | --- | --- |
| `aws` | MinIO S3 API and nginx | AWS adapter's local S3-compatible object operations and edge reads |
| `cloudflare` | MinIO S3 API, a local Cloudflare purge API mock, and nginx | R2-shaped S3 object operations and purge URL/prefix translation to the mock |
| `gcp` | `fsouza/fake-gcs-server:1.56.1` JSON API and nginx | Emulator-only GCS adapter operations; there is no production GCP adapter |

All three profiles run the same storage contract against their actual origin: object PUT/GET/metadata HEAD, conditional create and compare-and-swap, complete paginated prefix listing, batched deletion of more than 1,000 objects, empty deletion, missing-object and precondition error mapping, and local invalidation behavior. The browser suite checks SPA fallback, the static site catalog, artifact navigation, relative resources, MIME and cache headers, trusted same-origin preview HTML with HTTPS allowed and external HTTP blocked, no-CORS opaque-origin reads, and real missing-resource 404s through nginx. Same-origin preview scripts are trusted and can access the parent app; these local profiles do not make public objects private or prove live provider behavior.

The nginx edge mounts the built SPA and its profile config. It does not mount the changing object tree; fixture and publish writes go through the storage API, and browser reads are proxied to that origin. The Compose file and profile configs are separate from the default local fixture stack.

## Limits

These runs verify the repository's adapter and HTTP contracts against local emulators. MinIO does not establish compatibility with AWS S3 or Cloudflare R2, and the local purge mock does not establish Cloudflare API or edge-cache behavior. `fake-gcs-server` is used only to test the local GCS JSON API adapter; it does not imply production GCP support. Real-provider smoke tests are still needed for production claims, and no profile models a public CDN's propagation or cache behavior.
