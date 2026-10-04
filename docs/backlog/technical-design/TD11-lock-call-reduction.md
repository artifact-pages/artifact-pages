# TD11 — Lock lifecycle 呼出し削減

- Status: Open
- Phase: Provider-backed publication and registry cleanup
- Related verification: [T5](../verification/T5-concurrency-recovery.md), [T21](../verification/T21-command-cost-audit.md), [T14](../verification/T14-production-reconciliation.md)
- Product contract: [Specification](../../specification.md)

## Decision to make

lock record の cold acquire と warm acquire/release で発生する GET / conditional write を、安全性を落とさず減らせるかを測定・比較する。cold absent-record acquisition と既存 held record の release/recovery は別々の判断として扱う。

## Evidence

T21 の local lock fake で `SiteLockManager.Acquire` + release を計測したところ、cold は GET 3 / conditional PUT 3、warm は GET 2 / conditional PUT 2 だった。inspect/recover の別 call profile や provider latency は測っていない。

T21 と現 specification は cooperative site/registry locks、absent key の conditional create、later acquire/release/recovery の ETag compare-and-swap を契約としている。以下はまだ static hypothesis で、request saving の測定/実装結果ではない。

## 比較する候補

- absent lock を free record として作ってから取得する cold path を、held record の If-None-Match create にまとめられるか。
- release 前に再取得している記録を、取得時に保持した record と ETag を使う conditional update に置き換えられるか。
- contention polling の backoff は latency、load、wait contract を分けて比較する。単純に poll を減らすことで timeout/公平性を変えない。
- 十分な節約がなければ現在の protocol を維持する。

## 守る契約と範囲

owner identity、per-site と registry scope の分離、競合時の conditional failure、stale-lock inspect/recover の ETag fencing、lost-response の曖昧さ、lock-loss coordination を守る。安全停止後の release は許すが、所有者と ETag が一致する記録のみを解放し、失われた lock や別 owner の lock を解放しない。違う site/registry の隣接 scope に触れない。No-op publication で lock を省く候補は specification の registry revalidation/serialization 契約に反するため検討対象外。自動 lease expiry や time-only stale takeover も対象外。

## Done / 次の handoff

cold/warm、contention、two-owner CAS race、stale recovery と persisted-but-error response を含む fake で read/write calls、競合結果、wait time を比較する。adapter call counts と actual provider/wire count を混同せず、request reduction と correctness trade-off を併記して採用または現状維持を決める。採用時のみ独立 implementation/verification handoff を作る。
