# Publish/state 最適化の具体例

これは一つの publisher 調査で使った考え方の例であり、他の command/workflow に同じ state format、read policy、release policy を課すものではない。実際の契約と権限は対象 repository と依頼に従う。

この調査では、まず build を省ける unchanged-input 経路と、変更済み input から出力 object を差分化する経路を分けた。準備済みの immutable input に基づく fingerprint と object summaries を検討し、digest/size/HTTP metadata、全体 index/search 出力、snapshot の一貫性を検証した。flat state、階層 summary、fixed shards は仮説として測定し、bytes 減少だけから料金効果を推定しなかった。

publisher は mutable origin に書くため、pending journal、conditional state write、committed root の順、再試行時の touched-key union、cache retry を correctness と一緒に検証した。preview は immutable revision なので fresh plan を一度作って未作成ファイルのみ適用する考え方を使ったが、preview の full-byte 検証や同一 revision の不変契約を mutable publisher の diff predicate に置き換えなかった。

この例の schema 版、provider read policy、旧 prerelease control の扱いは当時の明示的な repository/user 判断である。互換性方針、provider の capability、料金、月次 workload は別の環境では再確認する。

## Repository evidence

- [Publisher specification](../../../../docs/specification.md)
- [TD6: fused publish-state design](../../../../docs/backlog/technical-design/TD6-fused-publish-state.md)
- [T18: scale baseline](../../../../docs/backlog/verification/T18-publish-scale-baseline.md)
- [T19: state layout and cost comparison](../../../../docs/backlog/verification/T19-publish-state-layout-cost.md)
- [T20: recovery and candidate verification](../../../../docs/backlog/verification/T20-publish-state-and-candidate.md)
- [Delegation guidance](../../../../docs/backlog/delegation.md)
