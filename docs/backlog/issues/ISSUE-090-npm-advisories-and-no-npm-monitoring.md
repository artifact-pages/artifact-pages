# npm has known advisories and nothing monitors them continuously

- Status: Done
- Assignee: Codex
- Priority: P2
- Area: dependencies / CI
- Implementer: Codex
- Source: public-launch review 2026-10-13, finding R9 and the npm half of R1

## Problem

`npm audit` on `04783fb3` reports one high and two low entries, and nothing re-checks npm advisories after merge. `.github/workflows/vulncheck.yml` runs `govulncheck` only (weekly, Go modules). `.github/dependabot.yml` disables routine Go and npm version updates (`open-pull-requests-limit: 0`) and relies on Dependabot security updates, which are disabled on the repository, so the intended monitoring is not in effect for npm.

## Evidence and reproduction

1. `npm audit` including dev dependencies: high 1, low 2, total 3. With production dependencies only (`npm audit --omit=dev`): low 2, no high or critical.
2. Dev dependency: `vite -> postcss -> source-map-js@1.2.1`, [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) (high; event-loop denial of service from an indexed source map with an abnormal offset). Fixed in `source-map-js` 1.2.2. This is a build-time dependency and is not treated as a runtime vulnerability of the published SPA.
3. Production dependency: `mermaid@11.17.2 -> katex@0.16.47`, [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7) (low; can bypass katex trust restrictions when a prototype pollution already exists). Fixed in `katex` 0.18.2. The extra precondition and any exploitation were not examined. The two "low" audit entries are this single advisory counted once for katex and once for the affected mermaid.
4. `npm audit fix --force` proposes moving Mermaid to an older major; it must not be applied mechanically.
5. Enabling Dependabot alerts and security updates is a repository setting tracked outside this repository (workspace ops item OPS-005). This issue covers the lockfile, the audit triage and the scheduled npm check.

## Expected outcome

Known npm advisories are fixed or explicitly triaged with reachability, and new npm advisories are found by a scheduled check with a stated response rule.

## Acceptance criteria

- [x] The lockfile resolves `source-map-js` at 1.2.2 or later.
- [x] The katex advisory is fixed by a compatible update or a verified `overrides` entry. If neither is possible, a written triage records reachability (whether Mermaid's `securityLevel`, input paths and the sanitization in the reader allow the precondition) and a revisit trigger.
- [x] `npm audit fix --force` is not used.
- [x] After the dependency change, Mermaid diagrams render, the sanitization tests pass, and the entry and lazy chunk sizes are rechecked against the build output of `04783fb3` (entry JS 745.83 kB minified).
- [x] A scheduled workflow (for example an extension of `vulncheck.yml`) runs an npm advisory check on `main`, and the repository records the response rule (severity thresholds and time limits for fix or triage).

## Verification

- Lockfile: `postcss@8.5.30`, `source-map-js@1.2.2` (with `nanoid@3.3.20`, required by postcss), and `katex@0.18.10` through the root `overrides` entry; Mermaid stays on 11.17.2. Mermaid 11 calls `katex.renderToString` with `throwOnError`, `displayMode` and `output`, which are unchanged in 0.18.
- `npm audit` before: 1 high and 2 low (production only: 2 low). After: 0 vulnerabilities.
- `npm run build` passed. Bundle sizes are minified / gzip, in kB:

  | Chunk | `origin/main` baseline | Updated | Change |
  | --- | ---: | ---: | ---: |
  | `index` | 745.83 / 227.14 | 745.83 / 227.14 | 0 / 0 |
  | `mermaid.core` | 94.28 / 32.53 | 94.28 / 32.53 | 0 / 0 |
  | `katex` | 258.68 / 77.43 | 258.89 / 77.66 | +0.21 / +0.23 |

- `npm run test:third-party-notices`: 3 passed. `npm run test:web-packaging`: 2 passed. `npm run test:web-unit`: 188 passed.
- No committed `THIRD_PARTY_NOTICES.txt` exists. The release packaging flow generates notices from the installed production dependency graph; the notice and packaging tests pass with the new KaTeX lockfile.
- Added a `$$x^2$$` label to the Mermaid catalog flowchart and an e2e assertion that a `.katex` element renders inside that diagram. Browser verification (this assertion, the Mermaid catalog and the Markdown sanitization e2e cases) ran in the pull request CI job "Unit, type and browser tests" ([#132](https://github.com/artifact-pages/artifact-pages/pull/132)).
