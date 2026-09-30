# Documentation backlog

[Backlog overview and shared status legend](../README.md). This track covers the public, reader-facing documentation sites published from `docs/public/sites/`. Internal design notes, UI concepts, and backlog records stay in their existing tracks and are not published as these sites.

Each ticket is one page (or one structural change). Pages are written and reviewed **one at a time**: the owner reviews each draft before the next page starts.

## Site lineup

Sites are divided by the reader's purpose, not by language. Translations live inside one site (see [`docs/public/sites/AGENTS.md`](../../public/sites/AGENTS.md)).

| Site ID | Display name | Reader's purpose | Status |
| --- | --- | --- | --- |
| `guide` | Guide | Adopt, publish, and read with Git Artifact Pages. | Registered locally; source `docs/public/sites/guide/` (DOC-01). |
| `architecture` | Architecture | Understand how it works and why. | Planned; registered only when its first page exists (DOC-08). |
| `reference` | Reference | Look up commands, config keys, and index formats. | Not planned yet. Start inside `guide`; split out when lookup becomes the main use. |

Contributor-facing material stays in the GitHub repository and is not a site.

Registry metadata (planned):

- `guide` (registered) — name `Guide`; description `Adopt, publish, and read with Git Artifact Pages. 導入・公開・閲覧のガイド。`
- `architecture` — name `Architecture`; description `How Git Artifact Pages works and why. 仕組みと設計の考え方。`

Names are English and descriptions carry both languages because registry `name` and `description` are single strings today.

## Page conventions

- Every page exists as `ja/<file>.html` and `en/<file>.html` with the same filename; each links to its translation through the in-page language switch.
- No numeric filename prefixes. Reading order is expressed by in-page previous/next navigation.
- Shared CSS and JavaScript come from one source and are copied into each site's `assets/` (per-site CSP prevents cross-site assets; DOC-01 sets up the copy and a consistency check).
- Facts come from the linked primary sources (specification, technical design, CLI help). A page must not introduce behavior that the specification does not state.
- Illustrative teams and repositories use the `acme/…` examples (`sre`, `checkout`, `billing`) and say they are illustrative.

## Workflow and definition of Done

1. Mark the ticket `In progress` and update this index.
2. Draft both languages, publish locally (`site publish --dry-run`, then `site publish`), and check light, dark, and ~400px width.
3. Hand the draft to the owner for review. Revise until approved.
4. Mark `Done` only after the owner approves the page and the acceptance criteria are checked.

## Index

| Order | Ticket | Site | Page | Status |
| ---: | --- | --- | --- | --- |
| 1 | [DOC-01](DOC-01-guide-site-structure.md) | guide | Move to the `guide` site structure | Done |
| 2 | [DOC-02](DOC-02-guide-overview.md) | guide | `what-is-git-artifact-pages.html` — overview | In progress |
| 3 | [DOC-03](DOC-03-guide-getting-started.md) | guide | `getting-started.html` | Open |
| 4 | [DOC-04](DOC-04-guide-publishing.md) | guide | `publishing.html` | Open |
| 5 | [DOC-05](DOC-05-guide-reading.md) | guide | `reading.html` | Open |
| 6 | [DOC-06](DOC-06-guide-configuration.md) | guide | `configuration.html` | Open |
| 7 | [DOC-07](DOC-07-guide-access-and-trust.md) | guide | `access-and-trust.html` | Open |
| 8 | [DOC-08](DOC-08-architecture-overview.md) | architecture | `overview.html` and site registration | Open |
| 9 | [DOC-09](DOC-09-architecture-storage-layout.md) | architecture | `storage-layout.html` | Open |
| 10 | [DOC-10](DOC-10-architecture-publishing-model.md) | architecture | `publishing-model.html` | Open |
| 11 | [DOC-11](DOC-11-architecture-previews.md) | architecture | `previews.html` | Open |
| 12 | [DOC-12](DOC-12-architecture-trust-model.md) | architecture | `trust-model.html` | Open |

## Product observations from this work

These surfaced while planning the sites. They are not yet product issues; file them in [issues](../issues/README.md) if the owner confirms them.

- Registry site `name` and `description` cannot be localized, so a bilingual site shows one language in the picker and palette.
- One site with `ja/` and `en/` mixes both languages in Browse, Recently updated, and page search. Language filtering is explicitly undecided in `docs/public/sites/AGENTS.md`.
- Per-site CSP means sites cannot share CSS or JavaScript; every site needs its own copy.
