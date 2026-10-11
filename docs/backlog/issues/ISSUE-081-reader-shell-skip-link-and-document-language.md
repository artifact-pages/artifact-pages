# The reader shell has no skip link and keeps lang="en" on Japanese documents

- Status: Done
- Assignee: Claude
- Priority: P3
- Area: Reader shell accessibility (`web/index.html`, `web/src/components/ArtifactWorkspace.tsx`)

## Problem

Two small shell-level accessibility defects, kept in one item because both are one-line-scale changes to the shell document and layout. They are independent; split them if one grows.

1. A keyboard or screen-reader user must tab through the rail, sidebar and toolbar to reach the document. Artifact pages have their own "Skip to content" inside the iframe, but the shell has none.
2. The shell document is `<html lang="en">`. The content frame of a Japanese page is `lang="ja"`, but the shell title and chrome stay English; bilingual sites are an actual audience of the product.

## Evidence and reproduction

From the 2026-10-11 dogfooding of `https://artifact-pages.dev`, DOM inspection, confirmed in code.

1. Inspect the shell DOM on any document page. Landmarks exist (aside "Guide navigation", nav "Artifacts", nav "Artifact path", main) and controls have accessible names. No skip link: a search of `web/src` finds no skip-link markup. The main region is `<main ... tabIndex={-1}>` (`ArtifactWorkspace.tsx:773`), so it can already take focus.
2. `web/index.html:2` is `<html lang="en">`. Nothing in `web/src` changes `document.documentElement.lang`. The shell has no `h1` (the document's `h1` is inside the iframe).
3. Tab-key focus testing in the automation was unreliable, so keyboard-only conclusions rest on source and DOM inspection, not on a manual keyboard pass.

Hypothesis: the artifact's language can be read from the frame's `<html lang>` because artifacts are served same-origin (the reader already reaches `contentWindow`, `ArtifactWorkspace.tsx:792`); the index does not carry a language. Whether the shell chrome text should be localized is a separate product question and not part of this item.

## Expected outcome

Keyboard users can skip straight to the document, and assistive technology announces Japanese documents in Japanese.

## Acceptance criteria

- [x] A "Skip to content" link is the first focusable element in the shell, visible on focus, and moves focus to the main region (or the artifact frame).
- [x] When a document with a declared language is open, the language is exposed to assistive technology: either the shell sets `lang` for the document region or the frame element carries the artifact's declared language. The approach is recorded in the issue; chrome text stays English unless localization is separately decided.
- [x] A Playwright case checks the skip link's focus order and target; the language behavior is checked on a Japanese fixture.

## Resolution

- Skip link: `ArtifactWorkspace` renders "Skip to content" as the first element of the shell. It is visually hidden until focused. Activation does not navigate (the URL fragment belongs to the open document); it moves focus to the artifact frame for HTML and to `<main id="main-content">` otherwise.
- Language source (recorded in the specification, "Main pane"): for HTML artifacts the reader reads `<html lang>` of the artifact through the same-origin frame (`onLoad`) and sets `lang` on the iframe element when it is a valid BCP 47-shaped tag. The index carries no language, so nothing is guessed for HTML. Markdown has no declaration; the Markdown reader sets `lang="ja"` on the document region only when the prose (code ignored) has kana and at least a third of its letters are Japanese (Han alone is ambiguous with Chinese); other Markdown stays undeclared. The shell chrome stays English and `<html lang="en">` is unchanged (localizing the chrome is still a separate decision).
- Tests: `web/src/domain/document-language.test.mjs` (`npm run test:reader-shell`) and the Playwright cases in "reader shell polish" (skip link focus order and target for HTML and Markdown; HTML `lang="ja"` and Markdown Japanese fixtures routed over the committed pages).
- Scope: the skip link exists in the document workspace (`ArtifactWorkspace`: site home, artifact and not-found views). The site picker, status pages and the preview list and preview document pages do not have one; the preview document page is a possible follow-up.
