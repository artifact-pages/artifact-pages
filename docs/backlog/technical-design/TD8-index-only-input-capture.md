# TD8 — Standalone index build の軽量 input capture

- Status: Done
- Phase: Local index builder
- Related verification: [T21](../verification/T21-command-cost-audit.md)
- Product contract: [Specification](../../specification.md)

## Decision to make

Standalone `index build` には index/search に使わない resource body を読まない専用 capture path を採用する。公開 `PrepareBuild` と publisher の immutable snapshot は完全な resource bytes、digest、input root を引き続き保持する。軽量 path は standalone `Build` 内だけで使い、exported API や publisher に流用しない。

## Evidence

T21 の固定10 Markdown文書＋無関係な resource probe（source baseline `2f9e41cf`、probe commit は T21 参照）では、0 / 10 / 100 MiB resource に対し `PrepareBuild` 後の sampled `HeapAlloc` delta が 58,312 / 10,513,720 / 104,885,448 byte だった。これは forced-GC retained heap や peak heap/RSS の値ではない。11ファイルを走査し、100 MiBの場合も `BuildPrepared` 出力は9,359 byte、SHA-256 `c4ba119b5dd915869f905f3d894f91ae1d44805f2820b2d9fa2a1949fe62dd35` で同一だった。この別 fixture/source baseline の結果は歴史的比較であり、今回の paired probe と混ぜない。

T21 の probe は別の fixture/source baseline (`2f9e41cf`) を使った過去の測定であり、以下の paired result とは混ぜない。TD8 paired probe は source baseline `449dfdd2`、実装 commit `48b004be` の同一 Git fixture 上で full `PrepareBuild` + `BuildPrepared` と standalone `Build` を比較する。固定 Markdown 10件と resource 6件（参照あり/なしの CSS・SVG・binary、0 / 10 / 100 MiB payload）を使い、各モードの10 output objects / 9,648 bytes、path・body・HTTP metadata fingerprint SHA-256 `c2389d88cb6638fbb7bcebae7ae79c0e0f544f72f661f2193f8f7ee5d77ba4e5` が全サイズで一致した。

reader hook は full capture が各サイズで6 resource reads、225 / 10,485,985 / 104,857,825 resource bytes、10 document reads / 601 bytes を確認した。Index-only capture と standalone `Build` は resource body read 0 bytes / 0 calls、各6 resource Open→Stat→Close readability checks、同じ10 document reads / 601 bytes だった。Resource directory は列挙・stat されるため、候補は file-count に対する filesystem metadata work をなくさない。

各サイズ3回の中央値（ms）は次の通り。`Full total` は full capture + `BuildPrepared`、`Standalone total` は `Build` 全体である。

| Payload | Full capture | Index-only capture | Full `BuildPrepared` | Full total | Standalone total |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 MiB | 37.617 | 35.358 | 2.642 | 40.399 | 39.212 |
| 10 MiB | 58.194 | 49.681 | 2.141 | 60.504 | 51.782 |
| 100 MiB | 218.780 | 169.464 | 2.120 | 220.889 | 179.060 |

Forced-GC 後に full prepared snapshot を保持した際の Go heap 増分は 65,632 / 10,508,344 / 104,893,896 bytes。そこへ index-only prepared capture を追加して保持した増分は 11,480 / 51,488 / 51,712 bytes だった。これは full snapshot を保持中の incremental live-heap sample であり、standalone-only の独立 heap 測定でも peak heap/RSS でもない。最も強い証拠は resource body reads と retained resource payload bytes がゼロになること、そして出力一致である。0 MiB の時間差はほぼなく、時間はこの小さな local fixture での3回の中央値であり目標値ではない。

再現 command は `cd cli && go test -tags td8audit ./internal/indexer -run '^TestTD8ProbeIndexBuildMixedResourceSizeSweep$' -count=3 -v`。生ログは ignored な `.local/td8-audit/paired-probe-3runs.log` に保存した。fixture はテスト内で固定生成するため、ログは tracked contract ではなく再生成可能な測定結果である。

同じ fixture の出力と resource 更新時刻を比較したテストは committed/staged/unstaged/untracked/deleted dependency state を通し、unreadable resource、regular/broken/non-file symlink、document symlink、unsupported FIFO の失敗境界も確認する。Full capture の publisher snapshot bytes / input root は既存の `TestBuildPreparedUsesExactCapturedSourceBytes` を含むテストで維持する。Index-only mode は resource stat/history/timestamp 入力を保持し、document bytes のみを parser/search builder へ渡す。

## 比較する候補

- document bytes と全 file の path/type/stat/history を保持し、resource content は読まずに index を生成する専用 capture API。
- 現在の共通 snapshot を保持する。実装分岐と異なる TOCTOU 対策を避けられる利点も含めて比較する。
- 必要なら document/resource metadata を一度列挙し、Git update metadata をまとめて解決する。ただし差が測れない一般的な abstraction は追加しない。

## 守る契約と範囲

HTML/Markdown の path、本文、Git history、last committer、working-tree/deletion に由来する updatedAt、resource 依存時刻、symlink/unsupported entry の拒否、生成 index/search の byte と HTTP policy を一致させる。`site publish` は upload と input fingerprint に使う完全な captured bytes を維持する。fulltext の仕様変更、parser/format の変更、publisher への軽量 snapshot 流用は範囲外。

## Done / 次の handoff

TD8 の decision は上記の index-only capture を standalone `Build` に限って採用すること。Publisher full snapshot と public `PrepareBuild` は変更しない。検証は `cd cli && go test ./...`、`cd cli && go test -race ./internal/indexer`、paired tagged probe、ならびに独立 Luna max review PASS。Peak RSS と実 provider operation は未計測であり、この local-only optimization では対象外。
