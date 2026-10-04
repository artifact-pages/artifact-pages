# TD8 — Standalone index build の軽量 input capture

- Status: Open
- Phase: Local index builder
- Related verification: [T21](../verification/T21-command-cost-audit.md)
- Product contract: [Specification](../../specification.md)

## Decision to make

Standalone `index build` が index/search に使わない resource bytes を読み込み・保持せずに済む専用 capture path を設けるか、既存の完全 snapshot を維持するかを比較する。これは publisher の prepared snapshot を弱める判断ではない。

## Evidence

T21 の固定10 Markdown文書＋無関係な resource probe（source baseline `2f9e41cf`、probe commit は T21 参照）では、0 / 10 / 100 MiB resource に対し `PrepareBuild` 後の live heap 増分中央値が 58,312 / 10,513,720 / 104,885,448 byte だった。11ファイルを走査し、100 MiBの場合も `BuildPrepared` 出力は9,359 byte、SHA-256 `c4ba119b5dd915869f905f3d894f91ae1d44805f2820b2d9fa2a1949fe62dd35` で同一だった。これは一つの synthetic local fixture であり、時間・heap の目標値ではない。

現在の実装が resource bytes を含む immutable snapshot を作ることは source review、size と出力の比較は実測である。resource 内容に依存しない index-only build が一般入力で安全、とはまだ証明していない。

## 比較する候補

- document bytes と全 file の path/type/stat/history を保持し、resource content は読まずに index を生成する専用 capture API。
- 現在の共通 snapshot を保持する。実装分岐と異なる TOCTOU 対策を避けられる利点も含めて比較する。
- 必要なら document/resource metadata を一度列挙し、Git update metadata をまとめて解決する。ただし差が測れない一般的な abstraction は追加しない。

## 守る契約と範囲

HTML/Markdown の path、本文、Git history、last committer、working-tree/deletion に由来する updatedAt、resource 依存時刻、symlink/unsupported entry の拒否、生成 index/search の byte と HTTP policy を一致させる。`site publish` は upload と input fingerprint に使う完全な captured bytes を維持する。fulltext の仕様変更、parser/format の変更、publisher への軽量 snapshot 流用は範囲外。

## Done / 次の handoff

代表 resource size/type と文書/resource 混在を baseline と候補で比較し、同一出力・metadata・失敗境界を確かめる。省略できる読み取り/bytes、CPU、peak/live memory、全 build 時間を示し、採用または現状維持を理由付きで決める。採用時のみ独立した implementation と verification handoff を作る。
