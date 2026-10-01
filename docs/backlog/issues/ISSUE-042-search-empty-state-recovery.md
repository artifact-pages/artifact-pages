# 検索ゼロ件の案内が現在のモードと検索目的に合わない

- Status: Open
- Priority: P2
- Area: Sidebar filter / Command palette empty states

## Problem

ゼロ件の案内が現在の状況を考慮していない。すでにコマンドモードでもコマンドモードへの切替を提案し、1サイトしかないサイドバーでも別サイトの検索を主な回復方法として示す。検索語の変更や絞り込み解除など、今の目的を続ける方法が弱い。

## Evidence and reproduction

2026-10-01、Codex アプリ内ブラウザ、Guide 1サイトで確認。

1. `http://127.0.0.1:4179/guide` のサイドバーに `zzz` を入力する。
2. 「Nothing in Guide matches. Press ⌘ K, then @, to find another site.」と表示される。Clear filter 自体は存在し動作する。
3. 文書上でパレットに `>コピー` を入力するとゼロ件になり、「Nothing matches. Try > for commands, @ for sites, or # for headings.」と表示される。

日本語タイトル・見出しの検索は動作した。日本語コマンド別名の追加はこの issue の必須解決策としない。

## Expected outcome

ゼロ件になった理由と、現在の検索を続けるための次の操作が分かる。

## Acceptance criteria

- [ ] コマンド・サイト・見出しモードで、すでに選択中のモードへの切替を主な回復案として表示しない。
- [ ] サイドバーのゼロ件で、検索語の変更や解除など、その場で有効な回復操作を案内する。
- [ ] 1サイト環境でも案内が行き止まりを作らず、検索語を変更・解除すると通常の候補へ復帰する。
