# サイトホームに使えない文書操作が並ぶ

- Status: Done
- Priority: P3
- Area: Site home toolbar

## Problem

文書を開いていないサイトホームでも Contents・Details・Copy・raw のアイコンが並ぶ。無効な操作の理由が初見で分かりにくく、文書を探す画面に不要な判断を増やす。

## Evidence and reproduction

2026-10-01、Codex アプリ内ブラウザで確認。

1. `http://127.0.0.1:4179/guide` を開く。
2. Contents・Details・Copy は無効表示。raw アイコンも薄く、リンク先は `/guide#`。
3. raw をクリックしても有用な画面変化は見られなかった。

表示状態とクリック結果の観測であり、内部の無効化方式は未調査。

## Expected outcome

ホームで利用できる操作が明確で、文書専用操作が読み込み中や権限不足に見えない。

## Acceptance criteria

- [x] ホームの文書専用操作は表示されないか、現在使えない理由が明確になる。
- [x] 文書を開いていない状態で raw 操作が意味のない移動先を提供しない。
- [x] 文書を開いた後は Contents・Details・Copy・raw の有効な操作を利用できる。

## Verification

Artifact-only toolbar actions now render only for an open artifact. Build and focused home/document toolbar, narrow all-sites, pin, and existing artifact-action regressions passed. Independent review by review_issue_043 found no blocking findings and passed four focused cases. The full 75-case run passed 74 cases; its stale ISSUE-042 mobile expectation was separately repaired and independently verified (3/3). Manual in-app browser follow-up was unavailable because the in-app browser surface was not available; narrow and toolbar verification used repository Playwright tests.
