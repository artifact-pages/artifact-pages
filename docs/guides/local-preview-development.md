# Local preview development mode

The repository can build a preview projection from Git and serve it from a local directory. It uses the same site catalog, immutable revision manifest, logical browser routes, and raw bundle paths as the static preview contract. This is the Phase 1 development path; it does not publish to AWS or Cloudflare.

## Build a local preview

From the source repository, run:

```sh
go run ./cmd/preview-local \
  --site sre \
  --source-path path/to/site-content \
  --default-ref origin/main \
  --head-ref HEAD
```

The command compares the selected head with the merge-base of the default branch and reads documents and resources from the Git object tree. It writes under `.local/previews/`, which is ignored by Git. Add `--resource path/from/source/root` once per extra resource that should be copied.

To attach the preview to a same-repository pull request, provide all three provenance values:

```sh
go run ./cmd/preview-local \
  --site sre \
  --source-path path/to/site-content \
  --default-ref origin/main \
  --head-ref HEAD \
  --repository owner/repository \
  --pull-request-url https://github.com/owner/repository/pull/42 \
  --pull-request-head-repository owner/repository \
  --pull-request-head-sha <full-head-sha>
```

The PR head repository and full head SHA must match the registered repository and selected `--head-ref`. Fork-origin or mismatched heads are rejected. Without an explicit PR URL, the command creates a manual head-SHA group and the reader does not show a PR link. If the changed-document diff contains only document deletions, the command removes that PR group from the local catalog. It leaves immutable revision files in place so already shared revision URLs keep their existing storage lifecycle.

## Serve the local output

Start the browser app and nginx with:

```sh
PREVIEW_ROOT=./.local/previews npm run serve:local
```

The local preview route is `/:site/_previews/<full-head-SHA>/<document-path>`. The site home has a **View previews** link. You can also pass `PREVIEW_ROOT=./fixtures/storage/_previews` to serve the committed browser fixtures used by the end-to-end suite.

Docker Compose binds nginx to loopback only. The app reads catalogs and manifests from its own origin; nginx serves HTML previews from the separate `preview.localhost` origin on the same port. The sandboxed frame can load relative scripts, styles, fonts, and images from that origin without an `Origin: null` CORS exception. Navigation messages are accepted only for documents listed in the revision manifest or production index. Markdown uses the app's sanitized reader. These local headers and routing checks demonstrate the browser contract; they do not establish CloudFront caching, access control, cross-process publication locking, or provider retention behavior.

## Provider boundary

`cmd/preview-local` calls `preview.WriteLocal`, which uses `preview.DirectoryStore` directly for `.local/previews`. Separately, registered-site `site publish` uses `publisher.ObjectPreviewStore` to adapt its configured deployment backend to the shared `PreviewStore` contract. AWS and Cloudflare adapters are selected outside the preview domain; their provider-origin, locking, cache, and lifecycle behavior remains a separate verification gate. Record schemas, object keys, publication order, and browser routes stay shared. Normal production publishing commonly targets `.local/storage` and reconciles that target's `_previews` prefix.

The directory-backed lock coordinates concurrent calls inside one process. It is not a cross-process lock. Keep dynamically constructed root-relative URLs and runtime-built navigation outside the preview guarantee; explicit `--resource` paths support extra non-document files when the document uses a relative URL that resolves to the copied layout. The local reader expects the app at `localhost` or `127.0.0.1`; `preview.localhost` is reserved for the isolated HTML frame origin.
