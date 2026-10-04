# T21 — コマンドとワークフローのコスト監査

- Status: Done
- Scope: 10 個の production CLI operation、help/alias/bare dispatch、developer 用 `preview-local`
- Source baseline: `2f9e41cf68161c1e3aa6642f3e018da036418213` (`main`)
- Probe harness commit: `cad12d4a926cfc07e15df1f4345b4f8b33e32cac` (test/script only; no production code changed)
- Related: [ISSUE-062](../issues/ISSUE-062-config-set-default-help-saved.md), [T18](T18-publish-scale-baseline.md), [T19](T19-publish-state-layout-cost.md), [T20](T20-publish-state-and-candidate.md), [T22 — cache purge retry verification](T22-cache-purge-retry.md)

## 確認したこと

目的は、各 operation が守る契約を保ったまま、どの作業を減らせるかを測定可能な候補に分けること。今回は production implementation、provider mutation、AWS/R2 の実測、release 操作は行わない。測定は同じ source revision のローカル fixture、provider fake、`httptest` に限定する。

基準コードは上記 SHA。監査用 [publisher probes](../../../cli/internal/publisher/t21_audit_probe_test.go)、[index probe](../../../cli/internal/indexer/t21_audit_probe_test.go)、[config probe](../../../cli/internal/config/t21_audit_probe_test.go) は `t21audit` build tag の下に置き、普通の `go test ./...` からは実行されない。index probe は固定時刻と固定文書 10 件を使い、0 / 10 / 100 MiB の resource を `.local/` に生成して終了時に削除する。registry/app probe は既存 fake を使い、[preview probe script](../../../scripts/command-cost-audit-preview.sh) は `.local/` に一時 Git repository を作る。実行ログと生成物は ignored `.local/` に置く。

## CLI surface と守る仕事

| Operation | 守る仕事・現在の境界 | 監査の扱い |
| --- | --- | --- |
| `index build` | source tree を走査し、HTML/Markdown、Git 更新情報、resource metadata から index/search を作る。公開はしない。 | resource byte サイズによる PrepareBuild の時間・live heap と出力同一性を測定。 |
| `app deploy` | release archive を検証し、全 object を照合して必要なものを順序どおり配置、変更 URL を invalidate する。全件 HEAD は drift repair を担保。 | 2-object fake で dry-run、changed、purge failure 後 retry を測定。 |
| `registry register` | 完全な registry を読み直して照合し、削除対象を inventory して catalog/cache を更新。 | same-input、dry-run、add-only purge failure retry を測定。 registry freshness/lock は省かない。 |
| `registry unregister` | lock 下で登録解除し、artifact/index/preview と private control を列挙・削除して cache を invalidate する。 | fake の logical LIST/DELETE/GET/conditional-PUT を測定。未知の stale object cleanup に使う public prefix LIST は維持候補。 |
| `site publish` | config・registry・lock を確認し、Git と immutable source snapshot から index/search を作り、projection・retry・preview/cache を収束させる。 | R2/AWS adapter fake の whole-operation no-op と 1-resource update を確認。 |
| `preview publish` | merge-base から変更 document/resource dependency を選び、lock 下で immutable revision を byte-verify し、manifest を files の後、catalog を最後に書く。完成 revision は上書き/削除しない。 | memory store の fresh-plan read reuse と、temporary Git fixture の subprocess/selected-byte 数を測定。 |
| `config set-default` | 選んだ locator を local config に atomic・restricted-permission で保存する。 | filesystem-only。ネットワークなし。`--help` は locator 扱いになる既知挙動を [ISSUE-062](../issues/ISSUE-062-config-set-default-help-saved.md) として参照。 |
| `lock inspect` / `lock recover` | inspect は選択 scope の現在値を読む。recover は observed ETag に条件付きで置換し、競合を守る。 | cold/warm acquire-release の request pattern を測定。inspect/recover 自体は source review のみ。 |
| `version` | build/module/VCS version を表示する。 | provider/config/Git read を行わない。 `--version` alias も同じ。 |

root の bare/help (`help`, `-h`, `--help`) は usage を表示し、各 namespace の bare/help も usage を返す。引数のない `app deploy` と `registry register` は operation に進み config を解決する。引数のない `registry unregister` は `--site` 不足で config 解決前に失敗する。`index build`、`site publish`、`preview publish` も必須引数がなければ失敗する。`--dry-run` は app、registry、site、preview の apply 前計画にあり、`--reconcile` は site publish のみ（dry-run と併用可）。lock recover は明示的な変更操作で dry-run はない。開発用 `preview-local` は local Git/filesystem のみを扱い、provider/config/dry-run/reconcile 面は持たない。

## 測定結果

### Publisher・registry・lock の logical fake calls

| Scenario | Observed calls / outcome |
| --- | --- |
| Lock cold acquire + release | GET 3, conditional PUT 3 |
| Lock warm acquire + release | GET 2, conditional PUT 2 |
| Registry same-input dry-run | GET 2, conditional PUT 0, LIST 0, invalidation 0 |
| Registry same-input apply, cold lock | GET 5, conditional PUT 3, LIST 0, invalidation 0 |
| Registry same-input apply, warm lock | GET 4, conditional PUT 2, LIST 0, invalidation 0 |
| Registry unregister of one populated site | GET 9, conditional PUT 8, 4 logical LIST prefixes (`_artifacts/<site>/`, `_indexes/<site>/`, `_previews/<site>/`, exact publish-state key), 2 bulk DELETE calls, 5 keys removed, 1 invalidation |
| App changed 2-file archive dry-run | HEAD 2, PUT 0, invalidation 0, 2 files planned |
| App changed 2-file archive; injected invalidation failure, then identical retry | First: HEAD 2, PUT 2, invalidation fails. Retry: HEAD 2, PUT 0, no second invalidation. |
| Registry add-only change; injected invalidation failure, then identical retry | First: GET 5, conditional PUT 4, invalidation fails. Retry: GET 4, conditional PUT 2, no second invalidation; no cleanup journal is present. |

この表は T21 の pre-fix source baseline における観測値を保持している。最後の2行は registry/app の invalidation failure が retry に残らない不具合の再現であり、修正後の結果は [T22](T22-cache-purge-retry.md) に別記する。tagged probe の pre-fix 観測を望ましい挙動として固定しない。

### ISSUE-066 修正後の同じ fake probe

同じ tagged publisher probe を修正後の source commit `0707f2915dc86f25583819b28e1f29fa6fca6d7c` で再実行した。registry は最初の purge failure 後に retry で invalidation を再送し、app は pending `/index.html` を再送した。表の `conditionalPUT` / S3 `PUT` は lock・retry-control と projection/object write を含む fake SDK 呼出しであり、個別 billing request 数ではない。app の再実行で application-object PUT が0件だったことは T22 の専用回帰テストで確認する。

| Scenario | First attempt | Retry | Result |
| --- | --- | --- | --- |
| Registry add-only registration; purge fails | GET 5, conditional PUT 5, invalidation attempt 1, error | GET 4, conditional PUT 2, invalidation attempt 1, journal absent | `registered`; pending path is purged and intent clears |
| App deploy of the same two-file bundle; purge fails | HEAD 2, aggregate S3 PUT 6, invalidation attempt 1, error | HEAD 2, aggregate S3 PUT 2, total invalidations 2 | `deployed`; no application-object rewrite on retry |

### Site publish and preview fake calls

現在の [`site_publish_cost_test.go`](../../../cli/internal/publisher/site_publish_cost_test.go) fake は control と projection の呼出しを分けて数える。clean-state no-op は R2-style GET-only adapter で GET 6、PUT 2、state body 716 byte、AWS-style HEAD+GET adapter で GET 5、HEAD 1、PUT 2、state body 0 byte。どちらも control は計8回で、projection inventory/mutation と cache invalidation はない。測定した1-resource updateでは R2-style が GET 8、PUT 5、DELETE 1、invalidation 1。AWS-style は state HEAD が1回増え、projection write は同じだった。update の GET 合計は index/meta の `generatedAt` 保持のための読取が実行ごとの生成 byte によって0–2回変わり得るため、この1回の値を不変条件として扱わない。いずれも provider adapter fake の呼出しで、R2/AWS の実 wire trace ではない。

[`TestPublishAppliesFreshLockedPlanWithoutDuplicateTargetReads`](../../../cli/internal/preview/store_test.go) starts with 1 lock call, 4 target `ReadObject` calls (catalog, manifest, and two files), and 4 writes (two files, completion manifest, catalog). Same-head retry adds 1 lock, 4 target reads, and 0 writes. The local `preview-local` probe produced:

| Scenario | Git subprocesses | `cat-file` subprocesses | Selected files | Selected output bytes |
| --- | ---: | ---: | ---: | ---: |
| 100-document no-op | 5 | 0 | 0 | 0 |
| 100 documents, one changed document | 7 | 1 | 1 | 45 |
| 1 document + shared CSS + SVG dependency | 12 | 6 | 3 | 188 |
| 100 documents sharing changed CSS + SVG | 210 | 204 | 102 | 8,108 |
| 100 documents with one changed unique CSS | 208 | 202 | 2 | 106 |

これは local Git process 数と選択された byte 数であり、object-store 呼出し数ではない。test-local Git fixture は dependency の分布を明示するが、一般的な repository の代表値や latency SLA ではない。

### Standalone index resource-size slope

固定 Markdown 10件と無関係な binary resource 1件で、local 3回の中央値は次のとおり。

| Resource size | `PrepareBuild` time | Live heap delta after `PrepareBuild` | `BuildPrepared` time | Output bytes / SHA-256 |
| ---: | ---: | ---: | ---: | --- |
| 0 B | 41.1 ms | 58,312 B | 2.24 ms | 9,359 / `c4ba119b5dd915869f905f3d894f91ae1d44805f2820b2d9fa2a1949fe62dd35` |
| 10 MiB | 47.2 ms | 10,513,720 B | 1.71 ms | same |
| 100 MiB | 90.5 ms | 104,885,448 B | 1.75 ms | same |

synthetic asset は固定文書から参照されない。`PrepareBuild` は11ファイルを走査し、prepared snapshot 用に resource bytes を取り込み、resource size に応じて input root が変わる。一方 `BuildPrepared` の出力 path/byte digest と size は同じだった。heap 値は snapshot を保持したまま強制 GC 後に測った live `HeapAlloc` 差分で、peak heap や RSS ではない。standalone index 専用の軽量 capture を別途検証する価値があるが、publisher の snapshot 完全性と input fingerprint は保つ。時間は1つの local test process で順に3回測った中央値で、CPU/filesystem の揺れがあり、disk throughput の測定ではない。

### Remote config resolver

A local `httptest` server returned fixed repository/commit/content responses. Resolving the default branch made 3 HTTP requests, named branch 2, and pinned SHA 1. The request paths were respectively repository metadata + commit + content; commit + content; content. This confirms pinned immutable refs already avoid the extra branch-resolution reads in one invocation. The resolver re-fetches on each invocation by contract; no cross-run cache was tested or recommended.

## 料金と計測範囲

公式料金ページを 2026-10-05 に確認した。Cloudflare R2 Standard は Class A が $4.50/100万、Class B が $0.36/100万、Delete と egress は無料。free allowance は月 100万 A、1,000万 B、10 GB-month で、月単位・単位切り上げ・日次 peak storage 平均がある。[Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)。AWS S3 は region、storage class、request class、転送経路で料金が異なるため、この監査では金額を出さない。[Amazon S3 pricing](https://aws.amazon.com/s3/pricing/)。CloudFront は path 単位で月 1,000 invalidation paths が account 全 distribution 共通で無料であり、wildcard も1 pathとして数える。[CloudFront invalidation pricing](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PayingForInvalidation.html)。

ここでの API 数は fake/storage interface calls またはローカル subprocess 数であり、wire request 数ではない。特に LIST pagination、SDK retry、bulk delete batching、CloudFront invalidation billing path、free allowance のアカウント共有分は測定していない。provider の実際の request logs、請求、region、CDN hit/miss は参照していないため、金額換算・cloud latency 推定をしていない。

## 優先候補と判断

1. **正しさの修復: ISSUE-066。** T21 の baseline では `registry register` add-only と `app deploy` が origin write 後の invalidation failure を次回へ durable に持ち越さなかった。修正と acceptance の検証は [T22](T22-cache-purge-retry.md) に記録した。
2. **index-only snapshot の分離を検討。** 100 MiB asset で prepared snapshot が約100 MiBの live heap を保持した一方、index output は完全一致した。document text、Git/history と resource timestamp/symlink validation を守る lightweight capture が可能か別設計・比較で証明する。Publisher は captured resource bytes と fingerprint に依存するため同じ省略を流用しない。
3. **app archive digest 再利用を検討。** bundle validation 時に digest/size を計算して immutable in-memory file record に結び付け、publish 側の同じ bytes 再 hash を省ける可能性がある。毎 run の HEAD drift check、upload order、purge retry は別の保証なので残す。
4. **preview Git subprocess の集約を測る。** 100 docs の shared/unique resource fixture では変更範囲により 6–204 `cat-file` process が観測された。Batch Git reads / same-commit result reuse を experiment する候補だが、merge-base、selected dependency closure、delete behavior を保持する。
5. **lock cold/warm write を最小限に検討。** cold/warm 差は lock lifecycle の初期化による。If-None-Match held-create や release ETag CAS の変更は owner identity、stale recovery、lost response の同時性テストを前提にした仮説であり、この監査では採用しない。
6. **registry cleanup と config read は現状維持を基本とする。** Unregister の prefix inventory は manifest 外 drift を消すために必要。Remote config の SHA pin は既に少ない request path であり、cross-invocation cache は freshness 契約を変える。
7. **help/version/set-default は軽量。** Help/version は provider reads を行わず、`set-default` は atomic local save を行う。現時点の測定で変更候補にしない。

## Technical-design follow-up

監査は完了しており、以下は比較判断を後続で独立して閉じる backlog 項目である。ここで実装や採用を決めたものではない。

| 項目 | 次の判断 |
| --- | --- |
| [TD8 — index-only input capture](../technical-design/TD8-index-only-input-capture.md) | standalone index build の不要な resource-byte capture を省けるか。 |
| [TD9 — app archive digest reuse](../technical-design/TD9-app-archive-digest-reuse.md) | archive validation の digest/size を同じ immutable bytes の diff/upload で再利用できるか。 |
| [TD10 — preview Git read batching](../technical-design/TD10-preview-git-read-batching.md) | 完了: build 内の同一 blob 再利用を採用。batch 読取は未比較のため対象外。 |
| [TD11 — lock call reduction](../technical-design/TD11-lock-call-reduction.md) | cold/warm lock request を CAS/owner 契約を保って減らせるか。 |

Cache purge failure の correctness gap は新しい設計項目に分割せず、完了記録 [T22](T22-cache-purge-retry.md) に移した。

## 再実行

Repository root から以下を実行する。出力はテスト log に入り、テストの一時 source/output は `.local/` に作って cleanup する。

```sh
(cd cli && go test -tags t21audit ./internal/publisher -run '^TestT21' -count=1 -v)
(cd cli && go test -tags t21audit ./internal/indexer -run '^TestT21ProbeIndexBuildResourceSizeSlope$' -count=3 -v)
(cd cli && go test -tags t21audit ./internal/config -run '^TestT21RemoteConfigCallProfile$' -count=1 -v)
sh scripts/command-cost-audit-preview.sh
```

Preview の scale probe は repository root から再実行できる（一時 Git repository は ignored `.local/` に作成）。preview fake-store 数は `(cd cli && go test ./internal/preview -run '^TestPublishAppliesFreshLockedPlanWithoutDuplicateTargetReads$' -count=1)` で再現できる。

生の実行出力は ignored `.local/t21-audit/` と `.local/site-preview-audit/` にあり、commit 対象ではない。上記コマンドで再生成できる。

## 検証

- [x] `go test ./...` from `cli/` passed across all Go packages.
- [x] `go test -race ./internal/publisher ./internal/preview` passed.
- [x] All three tagged T21 Go probes passed; the index slope ran three sequential repetitions.
- [x] `sh -n scripts/command-cost-audit-preview.sh`, the script itself, and its preview fake-store test passed.
- [x] `git diff --check` and `git diff --cached --check` passed before final review.

## 限界

CLI の静的挙動・code path は source review である。実行したのは明記した fake、`httptest`、local index resource slope、local Git subprocess のみ。全 command の latency benchmark ではなく、lock inspect/recover、app の大きい archive、実 GitHub latency、S3/R2 wire/page/retry 数、provider billing、cache hit/miss、production target は測定していない。過去の T18–T20 publisher scale/provider/candidate 結果は別記録であり、T21 の測定に含めない。
