# Public documentation sites

These instructions apply to public documentation under this directory.

## Site and language boundaries

- A site is a registration and publishing unit for a coherent documentation collection. Language alone is not a reason to create a separate site.
- Keep translations of the same documentation in one site, with language directories inside that site's source directory.
- Use this target layout; the site ID below is illustrative, not a selected registry ID:

  ```text
  docs/public/sites/<site-id>/
    ja/
      introduction.html
      getting-started.html
    en/
      introduction.html
      getting-started.html
    assets/
  ```

- Register the site's source directory, not each language directory. Keep these agent instruction files outside the registered artifact source directory.

## Site lineup

- Divide sites by the reader's purpose. The planned lineup, registry metadata, and one-page-per-ticket work queue live in [`docs/backlog/documentation/`](../../backlog/documentation/README.md).
- `guide` (`docs/public/sites/guide/`) is for adopting, publishing, and reading. `architecture` is for how the system works; create and register it only with its first page.
- Internal design notes, UI concepts, and backlog records are not public sites.

## Shared assets

- The source of the shared `site.css` and `site.js` is `docs/public/shared/assets/`. Per-site CSP prevents one site from loading another site's assets, so each site keeps a committed copy in its own `assets/`.
- Edit only the shared source, then run `npm run docs:sync-assets`. `npm run docs:check-assets` fails when a site copy is missing or differs.
- Pages reference the copy relative to their language directory, for example `../assets/site.css`.

## Translated pages

- Use a separate HTML artifact for each language. Keep corresponding translations at matching relative paths and filenames beneath their language directories.
- Provide a compact language switch within the page that links directly to the corresponding translated HTML artifact. Use relative links so they work both in the reader and when the artifact is opened directly.
- Offer only translations that exist. Do not silently send the reader to an unrelated page or a language homepage when a translation is missing.
- Preserve file extensions in artifact URLs. Treat `index.html`, when present, as an explicitly opened artifact rather than an implicit directory entry.
- Set the HTML `lang` attribute to the page's language and give each page a clear, localized H1. The artifact title and search identity should describe the content.
- The default approach is navigation between translated HTML files, rather than embedding all translations in one HTML file and switching them with JavaScript or query parameters.

## Scope of this decision

- Write agent instructions in English; write page content in the language of its directory.
- Language switching belongs to the documentation pages. Language filtering or prioritization in the application's Browse and command palette is not decided by this policy.
- Keep public reader-facing documentation here. Keep internal backlog, design notes, and verification records in their existing documentation tracks.
