# TD7 — Per-site page text search opt-out

- Status: Deferred
- Phase: Page text search
- Decision: Not decided. On 2026-10-04 the owner made page text search data always built and published by `site publish` and `index build`, and removed the `--fulltext` flag and the Action `fulltext` input. This item records the alternative that was set aside.
- Revisit when: A concrete site needs to omit page text search data, for example because its search objects are too large or too costly to store and serve.
- Related design: [T2](T2-cli-action-interface.md), [T11](T11-command-surface.md)
- Related implementation: [IMP-41](../implementation/IMP-41-fulltext-search-core.md)

## Problem

Every published site now carries full-text data. A site with very large or sensitive text may want to omit it. A per-publish flag was rejected because each publish could contradict the previous one and silently withdraw search data, which is the failure mode the removed `--fulltext` flag had.

## Candidate direction

- Decide it once, by the administrator, as a setting on the site's registry or deployment-config entry, not per publish and not per Action input.
- A site that opts out publishes no `search/` objects and no `meta.json.fullTextUrl`. The reader already treats such a site as having no page text search.
- Changing the setting takes effect on the site's next publish, which removes or writes the search objects accordingly.

## Not decided

- The exact setting name and its place in the unified deployment config and registry projection.
- Whether the setting must be visible to readers, for example to explain why a site has no page text search.
- Cost thresholds that would justify opting out. See [the cost research](../../research/fulltext-search-cost.md).
