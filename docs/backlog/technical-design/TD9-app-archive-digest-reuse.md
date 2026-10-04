# TD9 — App deploy archive digest reuse

- Status: Open
- Phase: CLI app deployment
- Related verification: [T21](../verification/T21-command-cost-audit.md), [ISSUE-066](../issues/ISSUE-066-registry-app-deploy-lose-failed-purge.md)
- Product contract: [Specification](../../specification.md)

## Decision to make

`app deploy` が archive 検証中に得た per-file digest/size を immutable bundle record に保持し、changed object upload 時の同じ byte slice の再 hash を省くべきかを比較する。origin の全 object を毎回調べる現在の drift-repair 保証を弱めずに得られる効果が対象。

## Evidence

T21 の2-file fake bundle は changed dry-run で HEAD 2 / PUT 0、apply で HEAD 2 / PUT 2 を観測した。大きな archive の CPU/heap 時間や hash 処理時間は測っていない。Source review では `loadAppBundle` が archive/checksum を検証して bytes を `bundleFile` に保持し、`appObjectMatchesBundle` が per-file SHA-256 を計算する。差分で upload する file は `DeployApp` が PUT metadata 用に同じ bytes を再度 SHA-256 する。archive-level digest と per-file digest は別の値・用途である。

したがって hash reuse は測定前の候補にすぎず、T21 は savings を示していない。object HEAD が存在し、size、SHA metadata、Content-Type、Cache-Control、Content-Encoding/Disposition と release provenance を照合する現在の境界は維持する。

## 比較する候補

- bundle validation 時に per-file digest/size/HTTP policy を計算し、検証済みの captured bytes と同じ immutable entry に保持して diff と PUT が共有する。
- 現行どおり diff と changed PUT で digest を別々に計算する。
- 明確な benefit がなければ manifest/cache/root など persistent state を加えず現状維持する。

## 守る契約と範囲

archive、adjacent manifest、checksum の整合性検証、path/type/size/duplicate 検査、完全な HTTP policy、release provenance、全 object の毎回 HEAD による drift repair、`index.html` を最後に書く順序を守る。No-op 時の remote HEAD 省略、historical hashed asset の削除、cache retry の代替実装は対象外。Purge failure の retry は既存 [ISSUE-066](../issues/ISSUE-066-registry-app-deploy-lose-failed-purge.md) が扱う。

## Done / 次の handoff

小・中・大 archive と sparse/dense changed files で hash bytes/回数、CPU、live/peak memory、全 operation を比較し、same captured bytes・metadata・origin key/HTTP policy を検証する。ISSUE-066 の失敗・retry 条件を悪化させないことも確認し、採用または現状維持を決める。採用時のみ独立 implementation/verification handoff を作る。
