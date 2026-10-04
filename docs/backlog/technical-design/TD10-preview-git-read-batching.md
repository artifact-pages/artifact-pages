# TD10 — Preview の Git 読取と dependency scan 集約

- Status: Open
- Phase: Local preview and provider-backed preview publication
- Related verification: [T21](../verification/T21-command-cost-audit.md), [T6](../verification/T6-resources-navigation.md), [T7](../verification/T7-discovery-performance.md)
- Product contract: [Specification](../../specification.md)

## Decision to make

同じ head/tree を一回の preview build 中に複数回調べる Git subprocess/blob 読取を、batch や同じ build 内の結果再利用で集約するかを比較する。cross-run cache を導入する場合は、その freshness key と invalidation policy も判断する。

## Evidence

T21 の一時 Git fixture は100 documents の no-op で5 subprocess / 0 `cat-file` / 0 selected bytes、1 document change で7 / 1 / 1 file・45 byte、100 documents が共有する CSS+SVG change で210 / 204 / 102 files・8,108 byte、unique CSS change で208 / 202 / 2 files・106 byteだった。1 document と shared CSS+SVG の小さい fixture は12 / 6 / 3 files・188 byte。これらは local wrapper が数えた Git process と作った preview bundle の bytes であり、一般 repository の分布、provider calls、latency を表さない。

Fresh locked plan を apply で再利用する fake-store test は、初回2-file revision の target read 4 / write 4、同一 head retry の target read 4 / write 0 を確認する。これは provider-free memory fake であり、immutable bytes の再検証を省ける証拠ではない。

## 比較する候補

- `git cat-file --batch` 等で blob 読取 process をまとめる。
- 1 build 内で同じ commit/tree/blob・依存 scan 結果を共有する。
- cross-run cache は、head/tree SHA、sourcePath、merge-base、parser/selection policy を含む key と stale/error behavior を説明できる場合のみ比較する。
- 変更が有意でなければ現行の個別 read を維持する。

## 守る契約と範囲

head/default-ref/merge-base と affected-document selection、resource dependency closure、rename/delete、unsupported path/symlink の扱い、source bytes、full-byte immutable revision verification、files → completion manifest → catalog の write 順、同一 revision を上書きしない規則を守る。Completed revision の overwrite/delete、head/tree/source/selection policy の違いを無視した結果再利用、site publish の projection state 共通化は対象外。同一 blob SHA による共有は、同じ bytes と利用条件を証明できる場合に限り比較する。Mutable preview catalog と immutable revision の異なる比較規則を混同しない。

## Done / 次の handoff

no-op、document-only、共有/unique resource、resource deletion/rename と大きめ fixture を baseline/candidate で比較する。Git processes/blob reads/selected bytes/build wall と preview store operations を別々に数え、affected set と generated bundle bytes の一致、partial retry の immutable behavior を検証する。採用または現状維持の contract を記録し、採用時のみ implementation/verification handoff を作る。
