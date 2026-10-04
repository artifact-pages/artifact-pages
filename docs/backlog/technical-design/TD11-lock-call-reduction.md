# TD11 — Lock lifecycle 呼出し削減

- Status: Done
- Phase: Provider-backed publication and registry cleanup
- Related verification: [T5](../verification/T5-concurrency-recovery.md), [T21](../verification/T21-command-cost-audit.md), [T14](../verification/T14-production-reconciliation.md)
- Product contract: [Specification](../../specification.md)

## 決定

absent lock は free record を作ってから再読する代わりに、held record を `If-None-Match` で直接作成する。release は取得時に保持した record と ETag を `If-Match` に渡し、現在値の再読を省く。既存 key の acquire、inspect/recover、polling は変えない。lock JSON/schema と scope も変えない。

## Baseline

T21 の local lock fake で `SiteLockManager.Acquire` + release を計測したところ、cold は GET 3 / conditional PUT 3、warm は GET 2 / conditional PUT 2 だった。これは lock backend の論理呼び出し数で、HTTP wire request や provider latency ではない。

T21 と現 specification は cooperative site/registry/application locks、absent key の conditional create、later acquire/release/recovery の ETag compare-and-swap を契約としている。inspect/recover の別 call profile や provider latency は測っていない。

## 比較結果

実装 commit `aea8ead6c069b425d16f92f103fbbae76a38b996` は両変更を採用する。新しい計測テストは `Acquire` と release を別々に数え、cold/warm のどちらも Acquire GET 1 / PUT 1、release GET 0 / PUT 1、合計 GET 1 / PUT 2 を観測する。

| 対象 | T21 baseline (GET / conditional PUT) | candidate の実測 (GET / conditional PUT) | 効果 |
| --- | ---: | ---: | --- |
| absent cold acquire（直接 held create） | GET 2 / PUT 2* | GET 1 / PUT 1 | cold の GET 1 / PUT 1 を削減 |
| warm free acquire（直接 held create の影響なし） | GET 1 / PUT 1* | GET 1 / PUT 1 | 変化なし |
| release（取得時 ETag で CAS） | GET 1 / PUT 1* | GET 0 / PUT 1 | cold/warm とも GET 1 を削減 |
| cold Acquire + release | GET 3 / PUT 3 | GET 1 / PUT 2 | GET 2 / PUT 1 を削減 |
| warm Acquire + release | GET 2 / PUT 2 | GET 1 / PUT 2 | GET 1 を削減 |

`*` T21 は lifecycle total を測定した。旧 Acquire/release の内訳は、旧実装が absent initialization に GET+conditional PUT、次に free-record read+held CAS を行い、release 前にも GET+conditional PUT していたことから分解した値。candidate の per-step counters は独立テストで実測した。cold/warm lifecycle totals も同テストが確認する。

## 守る契約と範囲

既存 lock の owner identity、per-site・registry・application scope、競合時の conditional failure、stale-lock inspect/recover の ETag fencing、lock-loss coordination を保つ。Held create が persist した後エラーを返した場合、Acquire は失敗し caller は何も実行しない。lock を自動回収せず、operator が inspect した最新 ETag で recover する。release の ambiguous error も成功と推測せず返す。古い ETag による release/retry は precondition failure となり、新 owner を上書きしない。Site/registry/application/neighbor の scope separation と blank-ETag fail-closed をテストした。

No-op publication で lock を省く候補、自動 lease expiry、time-only stale takeover、polling/backoff の変更は採用しない。fake/backend counter の節約は logical-call evidence であり、AWS/R2 live wire request、provider billing、latency は未測定。

## 検証

~~~sh
cd cli
go test -count=1 ./internal/publisher -run '^TestTD11' -v
go test -count=1 ./internal/publisher -run '^TestDeployAppStopsBeforeReadsWhenLockAcquireResponseHasNoETag$' -v
go test -race ./internal/publisher -run '^TestTD11|^TestSiteLockConcurrentFirstCreationAndSameSiteExclusion$|^TestSiteLocksAllowIndependentSitesConcurrently$|^TestApplicationLockHasFixedIdentityAndGuardedRecovery$|^TestSiteLockRecoveryRejectsChangedETagAndRecoveryRace$|^TestLockAcquireRejectsExistingRecordWithoutETag$' -count=1
go test -count=1 ./internal/publisher
go test ./... -count=1
go test -race ./internal/publisher -count=1
~~~

全 Go suite と publisher race suite は production diff 完了後に PASS。test-only step-counter assertions の追加後、TD11 focused test と publisher package を再実行して PASS、independent Luna max review も同じ focused test を再実行して PASS。`git diff --check` は clean。
