# The reader column's Contents list reads flat and its Details spend space on little information

- Status: Done
- Assignee: Claude
- Priority: P3
- Area: Reader right column (ISSUE-108), Contents and Details panels

## Problem

In the persistent right column (1200 px and wider) the Contents list separates h2 and h3 only by indentation and colour, so a long list reads as one flat run and the reader cannot see chapter boundaries or how far they have read. Details puts the last committer in a bordered card with a one-letter circle, a "Last committed by" label and label/value rows; the block is tall for little information, and Source links to the repository root rather than to the page's source file even though the index has `source.filePath`. At 248 px Japanese headings wrap early.

## Evidence and reproduction

1. Open a Markdown guide page with h2 and h3 headings at 1280 px or wider (owner screenshot, 2026-10-19).
2. Observed: Contents is a flat list with an `--active` pill on the current entry; Details shows a card "G GitHub", then "Updated" and "Source artifact-pages/docs [main]" rows; Source opens the repository root.

The owner compared options on https://claude.ai/artifact/DRDiuAyPC4s6qXNbVsuUxA and selected Contents **R1 (rail and dots with progress)** and Details **1 (byline)**, in the app's own monochrome tokens (not a borrowed accent colour). The width follows the page's recommendation, `clamp(256px, 21vw, 312px)`.

Out of scope: the committer shown is the Git committer (`lastCommitter.name`), which is "GitHub" for web-merged commits; author and avatar data need an index change and are a separate backend item. "Open raw artifact" is unchanged here. Preview Details (ISSUE-109) keep their own content.

## Expected outcome

Contents shows chapters as dots on a vertical rail with the read part marked; Details is a compact byline and a direct link to the page's source file on the Git host.

## Acceptance criteria

- [x] Contents (column and the narrow-screen Contents panel): entries sit on a thin vertical rail (`--line`). Level-2 entries have a hollow dot on the rail and semibold text; level-3 entries have no dot, regular weight and tertiary colour, and start at the same text inset as level-2 entries, as in the selected mock: the levels differ by dot, weight and colour, not by indentation, and the rail stays in one place. The rail starts at the first entry's dot and ends at the last entry.
- [x] Progress: rail segments and level-2 dots before the current entry use `--text-tertiary` (filled dots); the current entry's text sits in the existing `--active` 6 px-radius pill, semibold, `--text`; a current level-2 entry's dot is filled `--text` with a 3 px `--active` halo; a current level-3 entry shows a small filled `--text` dot with the same halo on the rail, and its parent level-2 dot is filled `--text`. With no current entry nothing is marked. Hover uses `--hover` on the pill area. No hue other than the existing tokens is introduced; light and dark both work.
- [x] Existing Contents behaviour is unchanged: buttons, `aria-current="location"`, keyboard focus ring, the list's own scroll keeping the current entry visible, `focusReaderColumnPart`, empty-state message.
- [x] Details (column and Details panel, published documents): no card and no "Last committed by" label. Row 1: a 24 px circular initial avatar (current neutral style), the committer name (12.5 px semibold, ellipsis) and below it "Updated <Mon D, YYYY>" in tertiary text. Without a committer, only the "Updated" line shows, without an avatar.
- [x] Below a `--line-soft` divider: a file icon, the source file path (`source.filePath`, monospace, wraps anywhere) and an external-link icon, the whole being one link to `artifactSourceLinks(artifact).sourceUrl` (new tab, `rel="noreferrer"`); under it, indented to the text, the repository display name and the ref chip. Without `filePath`, the link text is the repository name (still to `sourceUrl`); without a safe URL, the path or repository name is plain text. Without `source`, the block is omitted.
- [x] Column width is `clamp(256px, 21vw, 312px)`, defined once as a custom property and used everywhere the old 248 px was hard-coded (column, HTML frame width, match navigation offset and max width).
- [x] Left sidebar expanded width equals the right column width, `clamp(256px, 21vw, 312px)`; collapsed rail and narrow drawer unchanged.
- [x] `docs/specification.md` "Right sidebar" Details sentence describes the byline and source-file link; unit/e2e tests and Storybook stories that cover the column, Details and Contents are updated; verify and e2e pass.

Production check (2026-10-20, Claude): web 0.4.1 on https://artifact-pages.dev (admin #24, App deploy run 39345078565). On guide `en/getting-started.html` the right column shows the byline with the source-file link to `sites/guide/en/getting-started.html` (artifact-pages/docs, main chip) and the rail-and-dots Contents; dark theme, 1280 px wide.
