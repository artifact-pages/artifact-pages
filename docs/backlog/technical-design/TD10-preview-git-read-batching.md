# TD10 — Preview の Git 読取と dependency scan 集約

- Status: Done
- Phase: Local preview and provider-backed preview publication
- Related verification: [T21](../verification/T21-command-cost-audit.md), [T6](../verification/T6-resources-navigation.md), [T7](../verification/T7-discovery-performance.md)
- Product contract: [Specification](../../specification.md)

## 決定

`BuildFromGit` の一回の実行内だけ、Git blob SHA ごとに依存走査で得た成功済み bytes を再利用する。対象文書が変更 resource に依存すると判明した場合に限って走査中の bytes を保持し、それ以外の候補文書は保持しない。各 tree entry の type/mode を cache lookup 前に検証する。結果の別 path は同じ bytes を共有しても変更可能 slice を alias しない。失敗 read は cache しない。cross-run cache と `git cat-file --batch` は導入しない。

## 測定

source diff base は `fbc8a4d5`。実装 probe commit `837eb611` 上で同じ一時 Git fixture に対して `buildFromGit(..., false)` の cache 無効 baseline mode と `buildFromGit(..., true)` の candidate mode を比較した。各 fixture の base/head commit SHA は再現ログに記録される。数は shim が数えたローカル Git subprocess と `cat-file` stdout bytes で、provider request、billing、fixture 外 repository の分布を表さない。

| ケース | Git subprocess old→candidate | `cat-file` old→candidate | `cat-file` bytes old→candidate | 結果 |
| --- | ---: | ---: | ---: | --- |
| no-op | 5→5 | 0→0 | 0→0 | no-preview |
| document 変更 | 7→7 | 1→1 | 78→78 | 1 document / 1 file |
| 100 documents が CSS→SVG を共有 | 210→108 | 204→102 | 25,416→12,708 | 100 documents / 102 files |
| 100 unique 64 KiB CSS、1つを変更 | 208→206 | 202→200 | 6,631,963→6,566,300 | 1 document / 2 files |
| 未参照 resource 削除 | 106→106 | 100→100 | 7,500→7,500 | no-preview |
| 参照中 resource 削除 / 参照を直さない rename | 7→7 | 1→1 | 123→123 | 同じ missing-resource error |
| rename 後に参照も更新 | 107→107 | 101→101 | 7,566→7,566 | 1 document / 2 files |

共有 resource の例では走査と bundle 組み立てで再読していた blob 102件を一回ずつにし、12,708 bytes の重複読取を避けた。unique-resource の例では選択された 65,663 bytes だけを再利用し、キャッシュ最大量はその選択出力量と同じだった。キャッシュは組み立て後に空になる。未参照 resource の削除ではキャッシュ保持量、回避 bytes ともに 0。unique-resource の計測で cache/scratch/result の同時追跡 byte 上限は 131,326 bytes で、全候補文書の body は保持されない。

各 row で baseline と candidate の `BuildResult`、document reason と `ChangedResources`、manifest、全 file path/body、preview HTTP metadata fingerprint が一致した。回帰テストは同一 blob SHA の regular file と symlink で mode 検証が cache を迂回しないこと、別 result path の slice 非共有、失敗した read の非保持も確認する。別の memory-store test は first publish の target read/write 4/4 と同じ head retry の 4/0 を引き続き確認する。これは Git read reuse とは別の store boundary である。

実装・再現コマンド:

~~~sh
cd cli
go test ./internal/preview -tags td10audit -run 'TestTD10' -count=1 -v
go test -count=1 ./internal/preview
go test -count=1 ./internal/preview -run '^TestPublishAppliesFreshLockedPlanWithoutDuplicateTargetReads$'
go test ./... -count=1
go test -race ./internal/preview -count=1
~~~

結果ログ: [ignored local probe output](../../../.local/td10-audit/blob-reuse-probe.log). Source/test commit: `837eb611823e580f433cecf87a2dcae88cdd6af7`. Independent Luna max source/probe review: PASS.

## 境界と限界

No-op と document-only case では read count は減らない。unique resource の1文書更新では 2 subprocess / 65,663 bytes の差だった。timing は単発の local samples で採否根拠にせず、post-GC `HeapAlloc` は返却 `BuildResult` を生存させた時の値で peak/RSS ではない。cache/scratch counters は明示的に追跡した payload bytes で heap profiler ではない。`cat-file --batch` の候補は比較していない。provider-backed preview operations と billing は測っていない。

Merge-base と changed-path selection、resource dependency closure、rename/delete の既存 outcome、HEAD/tree metadata、source bytes、immutable preview revision の full-byte verification、files → completion manifest → catalog write order、completed revision の不変性を保つ。異なる build/run 間での cache、preview publication store の read/write 削減、site publish との共有 state/cache は対象外。
