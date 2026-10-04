---
name: command-cost-optimization
description: Analyze and reduce structural cost or resource use across commands and workflows by proving which work is necessary, moving or reusing work safely, and measuring whole-operation tradeoffs. Use for optimization work, not ordinary bug fixes.
---

# コマンドとワークフローの構造的なコスト最適化

コマンド単体または複数段階のワークフローについて、必要な成果と正しさを保ちながら、繰り返しの仕事、不要な取得・照合、I/O、CPU、転送、待ち時間を減らす依頼で使う。対象はローカル実行、クラウド操作、複数コマンドをまたぐ処理のいずれでもよい。通常の不具合修正には適用しない。

## 判断の順序

1. **なぜこの仕事が必要か、何を保証するかを明らかにする。** 受け入れ条件、元の振る舞い、必要な安全性を確認し、重複作業や過剰な検証と区別する。最適化の都合だけで元の契約を変えない。契約変更が必要なら判断点として示す。
2. **各実行で本当に必要な仕事を棚卸しする。** 入力と依存関係、読み書きする状態、外部副作用、権限境界、失敗時の回復、呼び出し側が既に持つ情報を追う。単一コマンドだけでなく、複数コマンド間の重複も必要に応じて調べる。
3. **仕事の置き場所や回数を変える候補を出す。** 不要な処理の省略、生成・準備段階への前倒し、計算や読取の集約、結果の再利用、処理範囲の局所化、バッチ化、並列化を検討する。並列化は待ち時間を短くしても総CPU、I/O、リクエスト、課金を増やすことがある。
4. **根拠を同じ入力・同じ保証で比較する。** 最小限の代表ケースから測定を始め、必要な範囲へ広げる。候補のデータ構造や仕組みは測定対象の仮説であり、最初に決め打ちしない。

## 入力・前計算・再利用

入力、依存、永続状態、読取・書込、副作用、実行権限を図や短い表で把握する。必要ならコマンド間の依存グラフも作り、どの段階が重複しているかを示す。

処理前に入力 fingerprint、digest、index、summary、manifest を作る候補を評価する。再利用する要約には、出力を変えうる意味のある入力、形式・アルゴリズムの版、必要なメタデータを含める。オブジェクト出力を扱う場合は用途に応じて key/path、digest、size、完全な HTTP 表現 metadata をまとめる。これらは候補であり、すべてのコマンドに同じ manifest を導入する要件ではない。

前計算がどの仕事を省略できる証明なのかを明確にする。freshness、無効化条件、形式変更、外部依存、時刻依存、入力の同時変更を扱い、計算時のスナップショットと利用時のデータが同一であることを確かめる。生成時刻は意味のある契約値か確認し、安定化または前回値の保持ができるならそれを検討する。毎回現在時刻を fingerprint に足して no-op を無効にしない。

「入力が不変なので後続処理を省ける」経路と、「入力が変わった後で個々の出力を差分比較する」経路を分けて測る。前者は build やコマンド段階を省けても、後者の比較が増分的だとは限らない。ハッシュや summary のためのローカル O(bytes) 作業も記録する。

## 比較と検証

コールド初回 bootstrap と定常 no-op を分け、必要な場合は規模、変更量、配置の組み合わせを再現可能な入力で比べる。例として変更ゼロ、単一・疎・密・全件、追加、削除、rename、metadata-only、revert、集中・散在・深い階層を含める。コマンドの性質に合わない軸は省き、その理由を記録する。長期状態を持つ処理では連続実行、月次相当の履歴、削除・rename、inactive な保持データ、cleanup/GC も比較する。

継続的な比較に使う代表 fixture は、生成手順・seed・期待値とともに Git 管理する。実行ごとの出力や一時変異は ignored な場所に分け、baseline と candidate のコード・入力 version を固定し、同じ開始状態から比較する。

データ構造を検討する場合、flat 圧縮 state、ディレクトリ集約、Merkle tree、固定 shard/chunk などを仮説として扱う。小さい metadata や事前計算が、読み書きリクエスト、write amplification、保存量、期限切れデータ、cleanup をどう変えるか測る。転送量の減少は、料金やユーザー目的に結び付かない限りコスト削減と同じではない。

目的に応じて料金と資源消費を分けて記録する。CPU、メモリ、ローカル I/O、ネットワーク転送、API request、保存量、待ち時間は別の指標として扱う。課金が関係する場合は現在の provider 公式料金・API仕様を参照し、日付、region/転送経路、storage class、request class、丸め、共有 free allowance を記録する。CDN/cache の hit・miss と origin への実際の経路も確認する。限界コストとアカウント全体の請求への寄与を混同しない。

各段階と全体の operation 数・処理時間を報告する。共通の準備や認証、lock、catalog/cache 作業と最適化で変わる部分を分けつつ、必ず全工程合計も示す。論理的な呼出し数と実際の wire request 数、list pagination、payload/state の raw・compressed bytes を区別する。CLI 出力だけから正確な provider request 数を推定しない。

入力、成果物、metadata、隣接対象への影響が期待値どおりか確認する。必要な範囲で dry-run、途中失敗、再試行、入力変更後や revert 後の再試行、cache/cleanup retry を含める。結果が想定どおりでも、fake、emulator、live provider、料金モデルのどの証拠かを明示する。

## アーキテクチャと権限境界

共有の正しさ、差分ルール、状態遷移、回復処理は共通 core に置けるか検討し、adapter には provider 固有の小さな capability や read policy を寄せる。provider 名だけで全体方式を自動選択する仕組みや、比較のためだけの汎用 framework を作らない。

観測専用処理、mutable な更新処理、immutable revision の作成処理は契約が異なる場合がある。計画を一度作り変更分だけ適用する考え方は共有できても、同じ diff predicate や削除・上書き方針を無理に共有しない。

conditional write、CAS/ETag/generation、journal、root/manifest の commit 順、曖昧な永続化エラー時の retry、monotone な touched-set、reconcile は、stateful な副作用がある場合に適用する条件付きの検討事項である。副作用のないすべてのコマンドに一律に要求しない。既存の recovery/compatibility policy を確認し、黙って破壊的な reset や契約変更を加えない。

調査や実装を委譲するなら、設計・レビューと実装の責任を分け、ファイルや subsystem の担当、守る不変条件、受け入れ条件、必要な測定結果を明記する。今回のモデル選択や委譲方法を将来のタスクに固定しない。

この skill 自体は外部操作の許可を増やさない。cloud mutation、データ reset、push、tag、release は現在の依頼とセッションの明示的な権限に従う。artifact を作る場合は clean な特定 commit から生成し、source SHA、dirty 状態、artifact checksum を記録する。local preflight と remote gate 成功を区別する。

## 具体例

publish/state 最適化での適用例と、この repository の記録が必要な場合は [publish example](references/publish-example.md) を参照する。そこにある provider、schema、pricing、互換性判断を他のプロジェクトの既定値にしない。
