# Documentation backlog

Statuses follow the [shared backlog legend](../../../AGENTS.md#backlog-and-issue-tracking). This track covers the public, reader-facing documentation sites published from `docs/public/sites/`. Internal design notes, UI concepts, and backlog records stay in their existing tracks and are not published as these sites.

Each ticket is one page (or one structural change). Until 2026-10-01 pages were written and reviewed one at a time. Since 2026-10-02 the owner drafts every page that can be written in one batch, has it reviewed independently by agents first, and then reviews the set together.

## Site lineup

Sites are divided by the reader's purpose, not by language. Translations live inside one site (see [`docs/public/sites/AGENTS.md`](../../public/sites/AGENTS.md)).

| Site ID | Display name | Reader's purpose | Status |
| --- | --- | --- | --- |
| `guide` | Guide | Adopt, publish, and read with Git Artifact Pages. | Registered locally; source `docs/public/sites/guide/` (DOC-01). |
| `architecture` | Architecture | Understand how it works and why. | Registered locally; source `docs/public/sites/architecture/` (DOC-08). |
| `reference` | Reference | Look up commands, config keys, and index formats. | Not planned yet. Start inside `guide`; split out when lookup becomes the main use. |

Contributor-facing material stays in the GitHub repository and is not a site.

Registry metadata:

- `guide` (registered) — name `Guide`; description `Adopt, publish, and read with Git Artifact Pages. 導入・公開・閲覧のガイド。`
- `architecture` (registered) — name `Architecture`; description `How Git Artifact Pages works and why. 仕組みと設計の考え方。`

Names are English and descriptions carry both languages because registry `name` and `description` are single strings today.

## Page conventions

- Every page exists as `ja/<file>.html` and `en/<file>.html` with the same filename; each links to its translation through the in-page language switch.
- No numeric filename prefixes. Reading order is expressed by in-page previous/next navigation.
- Shared CSS and JavaScript come from one source and are copied into each site's `assets/` (each site never loads another site's assets; per-site CSP blocks cross-site asset paths only over plain HTTP, such as local nginx, because over HTTPS its `https:` source matches every same-origin path, so the copies are what keep each site self-contained; DOC-01 sets up the copy and a consistency check).
- Facts come from the linked primary sources (specification, technical design, CLI help). A page must not introduce behavior that the specification does not state.
- Illustrative teams and repositories use the `acme/…` examples (`sre`, `checkout`, `billing`) and say they are illustrative.

## Workflow and definition of Done

1. Mark the ticket `In progress` and update this index.
2. Draft both languages, publish locally (`site publish --dry-run`, then `site publish`), and check light, dark, and ~400px width.
3. Have the draft reviewed independently, then hand it to the owner (singly or as part of a batch). Revise until approved.
4. Mark `Done` only after the owner approves the page and the acceptance criteria are checked.

## Index

Batch of 2026-10-02: DOC-02 (reading-features revision), DOC-04–07 and DOC-08–13 are drafted and awaiting review. DOC-04 and DOC-06 cover only what does not depend on the release-shape decision in [DOC-03](DOC-03-guide-getting-started.md#blocker-2026-10-01); each records its release-dependent parts. Second review round of 2026-10-03 applied to DOC-02 and DOC-04–13 (each ticket records it). Per the owner, pages assume releases are published, use `x.y.z`, and link to GitHub Releases once; release details are expected to change. DOC-03 stays blocked on the undecided CLI installation and Action reference details.


| Order | Ticket | Site | Page | Status |
| ---: | --- | --- | --- | --- |
| 1 | [DOC-01](DOC-01-guide-site-structure.md) | guide | Move to the `guide` site structure | Done |
| 2 | [DOC-02](DOC-02-guide-overview.md) | guide | `what-is-git-artifact-pages.html` — overview | In progress |
| 3 | [DOC-03](DOC-03-guide-getting-started.md) | guide | `getting-started.html` | Blocked |
| 4 | [DOC-04](DOC-04-guide-publishing.md) | guide | `publishing.html` | In progress |
| 5 | [DOC-05](DOC-05-guide-reading.md) | guide | `reading.html` | In progress |
| 6 | [DOC-06](DOC-06-guide-configuration.md) | guide | `configuration.html` | In progress |
| 7 | [DOC-07](DOC-07-guide-access-and-trust.md) | guide | `access-and-trust.html` | In progress |
| 8 | [DOC-08](DOC-08-architecture-overview.md) | architecture | `overview.html` and site registration | In progress |
| 9 | [DOC-09](DOC-09-architecture-storage-layout.md) | architecture | `storage-layout.html` | In progress |
| 10 | [DOC-10](DOC-10-architecture-publishing-model.md) | architecture | `publishing-model.html` | In progress |
| 11 | [DOC-11](DOC-11-architecture-previews.md) | architecture | `previews.html` | In progress |
| 12 | [DOC-12](DOC-12-architecture-trust-model.md) | architecture | `trust-model.html` | In progress |
| 13 | [DOC-13](DOC-13-architecture-search.md) | architecture | `search.html` — name search and page text search | In progress |

## Product observations from this work

These surfaced while planning the sites. They are not yet product issues; file them in [issues](../issues/README.md) if the owner confirms them.

- Registry site `name` and `description` cannot be localized, so a bilingual site shows one language in the picker and palette.
- One site with `ja/` and `en/` mixes both languages in Browse, Recently updated, and page search. Language filtering is explicitly undecided in `docs/public/sites/AGENTS.md`.
- Each site keeps its own copy of the shared CSS and JavaScript. Per-site CSP blocks cross-site asset paths only over plain HTTP; over HTTPS the copies are a convention, not something CSP enforces.
- From the 2026-10-01 beginner review of the reader (documentation-side, not product issues): the guide pages use smooth scrolling, so a Contents jump to a distant heading takes about one to two seconds and looks unresponsive at first; and the overview page's autoplay palette sample looks identical to the real palette, so a first-time reader may not tell them apart despite the "sample" note.
