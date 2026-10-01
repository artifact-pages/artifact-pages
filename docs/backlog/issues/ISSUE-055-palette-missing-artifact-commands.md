# 上部の文書操作の一部がパレットのコマンドにない

- Status: Done
- Priority: P3
- Area: Command palette commands

## Problem

文書の上部には Pin と Details の操作があるが、パレットで `>` と入力したコマンド一覧には、ピン留めと Details を開く操作がない（Toggle contents、リンクのコピー、元ファイルを開く、などはある）。キーボード中心の利用者は、ピン留めや詳細の表示だけ、マウスで上部のボタンを押す必要がある。

## Evidence and reproduction

2026-10-01、Claude in Chrome で操作。ビューポート約1568×568（ウィンドウ最大化のため幅の変更は不可）、Guide 1サイト・HTML 4文書、ダークテーマ（System）。コードとドキュメントを読まずに操作した初心者レビュー。

1. `http://127.0.0.1:4179/guide/en/reading.html` を開き、⌘K でパレットを開いて `>` と入力する。
2. 表示されるコマンド：Toggle sidebar、Toggle contents、Go to site home、Use light theme、Use dark theme、Use system theme、Copy artifact link、Open raw artifact。
3. ピン留め（Pin／Unpin）と Details の表示は一覧にない。

## Expected outcome

文書に対して上部のボタンでできる主な操作を、パレットのコマンドからも実行できる。

## Acceptance criteria

- [x] 文書を開いているとき、パレットのコマンドからピン留めとピン留めの解除ができる。
- [x] パレットのコマンドから Details を開閉できる。
- [x] 文書を開いていない画面では、これらのコマンドが実行できない状態で表示されない。

## Related issues and scope

- ISSUE-048 はパレットの候補の見せ方を扱う。本件はコマンドの種類の不足だけを扱い、候補の並べ方は変えない。

## Verification (2026-10-01)

- Implemented by a Sonnet subagent and reviewed by a separate Sonnet subagent (no blockers; the sidebar Pinned assertion was added).
- The palette's `>` commands now include "Pin artifact" / "Unpin artifact" (the title follows the current pin state, like the header button) and "Toggle details" (mirroring "Toggle contents"). The pin command uses the same `toggleArtifactPin` as the header and sidebar, so state, storage, and the toast are shared. Both commands use `available: Boolean(currentArtifact)`, so they are hidden where no artifact is open. Candidate grouping and ranking are unchanged (ISSUE-048).
- New e2e test "palette commands pin and unpin the current artifact and toggle Details only while an artifact is open" covers pin and unpin (toast, header state, storage, sidebar Pinned section), opening and closing Details, and absence on the site home. `npx tsc -p web/tsconfig.json --noEmit` and `npm run build` passed; `node scripts/run-e2e.mjs` passed 90/90.
- Follow-up noted by the review, not part of this issue: opening Contents or Details from the palette leaves focus where the palette restores it (outside the panel), as "Toggle contents" already did. Moving focus into the panel after a palette-driven open would help keyboard users.
