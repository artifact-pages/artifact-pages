# CLI output

All operational commands use the same low-chroma text report: operation and result first, then relevant target or source context, grouped details, and an explicit completion summary. Errors use the same structure on stderr with recovery guidance. The command meanings, JSON fields, and exit codes do not change.

| Command | Details shown |
| --- | --- |
| `registry sync` | Registration changes, registry projection, cleanup scopes and objects, cache revalidation, and whether the registry changes |
| `site sync` | Artifact and index changes, nonempty preview reconciliation counts, synced and removed file counts, cache paths and request ID |
| `app deploy` | Version, application file changes, cache revalidation request, and source-dirty warning |
| `app remove` | Removed application files and cache revalidation request |
| `preview publish` | Head SHA, optional explicit PR link, preview-list link, document URLs, object and catalog changes |
| `preview remove` | Selected group, exact revision/object cleanup, and preview cache revalidation |
| `index build` | Artifact/file counts, elapsed time, output paths and byte sizes; no artifacts are copied or published |
| `config set-default` | Selected locator and local saved-locator path; no deployment changes |
| `lock inspect` / `recover` | Scope, state, exact ETag, optional owner and acquisition time; inspection never performs recovery |

Dry-runs say `DRY RUN` and `No writes`. Real no-op operations say `UP TO DATE`. Preview publication with no added or changed documents says `NO PREVIEW`, not `PUBLISHED`. A recovery report reflects the fresh inspection after the guarded recovery and makes no claim that a concurrent publisher cannot acquire the lock again.

Color appears only on terminal output and follows `NO_COLOR`; redirected output remains plain text. Paths and dynamic text cannot inject terminal control sequences. Color emphasizes status and action markers, not whole paths or backgrounds. Each detailed list is capped at 12 entries, including preview document URLs; deployment and preview `--format json` retain the complete result. Index/config output contains only its small fixed summary and has no JSON option.

Registry paths containing `#sites/<id>` identify logical registration changes, not separately stored objects. Cleanup scope entries such as `/<site>/*` are shown separately from concrete object keys. Cache revalidation is a requested action; displaying its request ID does not claim CDN propagation has completed.

~~~text
registry sync  DRY RUN

  Target    Cloudflare R2 bucket artifact-pages (account ...)

  + 1 create   ~ 1 update   - 0 remove   ↻ 1 invalidate

  Site registrations · 1
  + create     _indexes/sites.json#sites/guide

  Registry projection · 1
  ~ update     _indexes/sites.json

  Cache revalidation · 1
  ↻ invalidate /_indexes/sites.json

  Registry projection: will update.

  Dry run complete. No writes.
~~~

These reports describe the completed result or calculated plan. They are not live progress bars; no simulated phases or percentages are displayed. Operational failures never print the planned change list as if it had completed. JSON failure envelopes remain machine-readable on stdout, with diagnostic error text on stderr.
