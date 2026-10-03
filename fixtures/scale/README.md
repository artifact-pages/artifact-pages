# Publisher scale fixtures

This committed corpus gives publisher verification repeatable source trees from 10 through 10,000 files. The page/resource split is explicit in `config.json`; a page is an HTML or Markdown file, and every other generated source file is counted as a static resource.

| Site ID | Source files | HTML pages | Markdown pages | Pages | Static resources |
| --- | ---: | ---: | ---: | ---: | ---: |
| `verify-scale-10` | 10 | 1 | 1 | 2 | 8 |
| `verify-scale-100` | 100 | 7 | 3 | 10 | 90 |
| `verify-scale-1000` | 1,000 | 70 | 30 | 100 | 900 |
| `verify-scale-5000` | 5,000 | 350 | 150 | 500 | 4,500 |
| `verify-scale-10000` | 10,000 | 700 | 300 | 1,000 | 9,000 |

The `smoke` profile selects the 10-file site. The `full` profile selects all five sites. Pages and resources have deterministic content with modest size variation; generated files contain no timestamps or large binary payloads. Every site includes nested paths and examples with Unicode, spaces, `+`, `%`, `?`, and `#` in filenames.

Run these commands from the repository root to regenerate or verify the committed files:

```sh
(cd fixtures && go run ./cmd/scale-fixtures -profile smoke)
(cd fixtures && go run ./cmd/scale-fixtures -profile full)
(cd fixtures && go run ./cmd/scale-fixtures -profile full -check)
```

The generator only writes under `fixtures/scale/sites/<site-id>/source/`. The fixture module and its generator stay under `fixtures/`; `fixtures/storage` and `fixtures/actions-smoke` remain separate.

To exercise the publisher against its isolated local projection, register the fixture sites once, then publish the smoke site with full-text enabled or disabled. Omitting `--fulltext` disables and removes that site's full-text projection on the next publish.

```sh
go run ./cli/cmd/artifact-pages registry register --config fixtures/scale/publisher.yaml
go run ./cli/cmd/artifact-pages site publish --site verify-scale-10 --config fixtures/scale/publisher.yaml --fulltext
go run ./cli/cmd/artifact-pages site publish --site verify-scale-10 --config fixtures/scale/publisher.yaml
```

`publisher.yaml` points at `.local/scale-fixtures/storage`, separate from the local product projection. Use any of the five site IDs to select a larger dataset. These fixtures define test inputs; performance measurements and thresholds are tracked separately.

The tracked root `artifact-pages.yaml` is the complete local verification config at `.local/verify/storage`; its `sites` mapping contains the existing `smoke` registration plus all five scale sites. `fixtures/scale/publisher.yaml` provides the same complete mapping at a separate ignored root for isolated scale work.

For the Cloudflare verification target, layer the configs in this order so the target inherits the complete root `sites` mapping:

```sh
go run ./cli/cmd/artifact-pages registry register --config artifact-pages.yaml --config artifact-pages.cloudflare.yaml --dry-run
go run ./cli/cmd/artifact-pages site publish --site verify-scale-10 --config artifact-pages.yaml --config artifact-pages.cloudflare.yaml --fulltext --dry-run
```

`artifact-pages.cloudflare.yaml` is a target-only overlay for bucket `artifact-pages-verify` at `https://artifact-pages.stream`; it reads credentials through `CF_VERIFY_R2_ACCESS_KEY_ID`, `CF_VERIFY_R2_SECRET_ACCESS_KEY`, and `CF_VERIFY_API_TOKEN`. `artifact-pages.verify.yaml` is the complete single-file compatibility config with its own full `sites` mapping. Select it alone with one `--config` argument; do not combine it with the layered pair. Neither config points at the production `artifact-pages` bucket or `artifact-pages.dev` hostname.
