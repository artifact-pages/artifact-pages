# Git Artifact Pages

**Git Artifact Pages turns Git-managed static artifacts into searchable, browsable websites.**

Teams keep HTML reports, design documents, diagrams, generated explanations, and other static artifacts in Git. Git Artifact Pages publishes them into a stable web namespace and provides a lightweight SPA for discovery, search, navigation, and viewing.

The intended production shape is deliberately static:

~~~text
Git repositories
      ↓
publish pipeline
      ↓
S3
├── _indexes/
├── _artifacts/
├── index.html
└── assets/
      ↓
CloudFront
      ↓
Browser
~~~

There is no application server in the request path. Git is the source of truth; object storage is a serving projection.

## Status

Phase 1 local product. The SPA discovers sites from lightweight metadata, loads only the active site's artifact index, and provides a site picker, recent-artifact home, searchable navigation tree, and command palette. HTML artifacts run in an iframe; Markdown artifacts use a sanitized native reader.

AWS infrastructure and reusable distribution packages come later.

## Local development

Install dependencies and start the Vite development server:

~~~sh
npm install
npm run dev
~~~

Run the isolated UI design workspace with:

~~~sh
npm run storybook
~~~

Storybook uses the same React components and CSS as the application, with the committed site indexes and artifact fixtures. Site Home uses full-path labels, while the artifact sidebar uses subtle branch guides. The **Product / Workspace** stories cover site home, artifact viewing, light and dark themes, and the collapsed Reader rail. **Navigation** stories cover the site picker and command-palette search modes.

Create a production build with:

~~~sh
npm run build
npm run preview
~~~

Package the built application plane for a separate installation repository with:

~~~sh
npm run package:web -- --version local-test-1
~~~

This creates a version-labelled `artifact-pages-web-*.tar.gz` archive, a SHA-256 checksum, and a release manifest under `.local/releases/`. The archive contains only the deployable SPA files (`index.html` and `assets/`) at its root; site indexes and artifact files remain a separate content plane. The version is an explicit label for local integration testing; a public release/versioning policy has not been set yet.

`artifact-pages-example` can install this archive and serve the extracted app bundle through the existing local nginx/E2E setup by setting `WEB_ROOT` to its installation directory.

Build both the application and the Storybook catalog with:

~~~sh
npm run build
npm run build-storybook
~~~

To serve the production build with the local nginx contract:

~~~sh
npm run serve:local
~~~

This serves the SPA on `http://localhost:4173/`, site discovery metadata and artifact indexes below `/_indexes/`, and fixture artifacts below `/_artifacts/`. Any other route falls back to the SPA shell.

On first use, install the Playwright Chromium browser, then run the end-to-end checks against the production build served by nginx:

~~~sh
npx playwright install chromium
npm run test:e2e
~~~

The command builds the SPA first, starts an isolated Compose nginx service on port `4174`, and removes that test service when finished. The regular local service on `4173` is left untouched. Docker Compose and the Playwright Chromium browser are required. Tests cover site discovery, lazy per-site index loading, current-site search scope, deep-link/reload behavior, relative artifact assets, and the collapsed navigation rail.

## Local index builder prototype

The Go builder creates one site's discovery metadata and artifact index from a publishable static content directory inside a Git working tree. Point `--source` at the exact tree that should be served under `/_artifacts/<site>/`, containing ready-to-serve HTML, Markdown, and their local resources—not an unrendered template/source tree. It does not render templates, bundle assets, rewrite URLs, copy artifact files, or publish to a hosting provider.

Every `.html`, `.htm`, and `.md` file below the selected directory is an explicit artifact. Artifact routes retain their exact source-relative filename and extension, including root or nested `index.html` and `README.md`; none implicitly aliases a directory or site home. HTML artifacts render in an unsandboxed iframe as trusted published executable content. Markdown renders in the application DOM after sanitization and does not execute embedded scripts or unsanitized raw HTML. Mermaid is rendered in strict mode. Markdown may use same-site relative resources, HTTPS external links/images, and safe base64 raster data images; external HTTP resources and cross-site artifact paths are rejected. There are no path-name exclusions: if `_includes` or another partial/template directory is inside the selected tree, its HTML and Markdown files are indexed too. Choose a publishable root that excludes source-only files.

The source directory must be inside the current Git working tree. Tracked files provide Git-based update metadata. Untracked files, including Git-ignored generated output, can still be indexed, but `updatedAt` then falls back to filesystem modification times and `lastCommitter` is omitted.

Requires Go 1.26 or newer.

~~~sh
go run ./cmd/artifact-pages index build \
  --site sre \
  --site-title SRE \
  --source fixtures/storage/_artifacts/sre \
  --out .local/storage
~~~

This writes `.local/storage/_indexes/sre.json` (lightweight site discovery metadata) and `.local/storage/_indexes/sre/index.json` (the artifact index). The source tree is left untouched, and every indexed page points to its original file under the source-relative artifact path. A later static publish step should copy the selected content tree unchanged so relative CSS, JavaScript, images, and other resources retain their paths. The initial builder expects one repository source per site.

Run the Go tests and the benchmarks with generated fixtures in temporary Git repositories. The file-count benchmark uses 1,000, 5,000, and 10,000 source files, corresponding to 100, 500, and 1,000 HTML pages. A second benchmark measures 500 and 1,000 HTML pages with 51 commits in the history:

~~~sh
go test ./...
go test ./internal/indexer -run '^$' -bench=BenchmarkBuildIndexFiles -benchtime=5x -benchmem
go test ./internal/indexer -run '^$' -bench=BenchmarkBuildIndexGitHistoryPages -benchtime=3x -benchmem
~~~

The browser palette benchmark creates ignored synthetic data under `.local/palette-load-fixtures/`. It measures single-site index sizes and multi-site discovery separately; the latter downloads every lightweight summary but only the active site's artifact index. It reports payload and loopback-transfer timing, JSON body-read and parse time, browser heap, query time, and input-to-paint latency. These timings compare browser/projection costs locally; they are not a forecast of CDN or public-network latency. For example:

~~~sh
npm run benchmark:palette -- --sites 20 --artifacts-per-site 1000 --iterations 20 --seed local-scale
~~~

It also checks that `@` site lookup does not fetch another site's artifact index. Sharding and inverted indexes remain deferred until these measurements show a single-index limit.

## Core ideas

- Git-managed artifacts remain versioned with the work that produced them.
- A site is a logical namespace such as sre or frontend.
- The initial index builder maps one repository source directory to one site; merging multiple repositories into a site is deferred.
- /_artifacts/* contains published static files.
- /_indexes/<site>.json contains lightweight site discovery metadata.
- /_indexes/<site>/index.json contains the searchable/browsable artifact projection for that site.
- Normal artifact search is scoped to the current site; `@` searches site metadata. Cross-site artifact search is not implemented.
- The SPA is stable infrastructure; artifact content and site indexes change independently.
- Search, recent items, tree navigation, and table-of-contents metadata are precomputed at publish time where practical.

See [the thesis](docs/thesis.md), [specification](docs/specification.md), and [roadmap](docs/roadmap.md).
