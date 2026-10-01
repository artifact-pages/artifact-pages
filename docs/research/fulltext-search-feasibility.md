# Build 時に作る全文検索の実現可能性

調査日: 2026-10-01。製品への組み込み前の実験であり、既存 schema・検索 UI・publish 契約は変更していない。

続編: [検索確定後に取得する、容量を優先した全文検索](fulltext-search-cost.md)。本文の複製を省く辞書・圧縮 posting・singleton inline・更新に安定した分割を実測している。

## 結論

**本文検索はバックエンドなしで実現できる。** Git の publishable source から build 時に本文を抽出し、サイト単位の静的検索データを生成してブラウザで検索する構成は thesis に合う。

ただし「本文を通常の `index.json` に足す」だけではサイトを開くたびに読み込みが増える。検索専用の projection として分離し、検索を使うときに取得する方向がよい。最初は小規模な本文走査と既存の検索ライブラリを比較し、大規模向けには本文全体を読み込まずに検索できる方式を評価する。

今回の素朴な文字 2-gram 転置索引は日本語の部分一致を扱えるが、容量と一般的な英語クエリの候補削減に弱点があった。これをそのまま製品の方式として採用する根拠はない。

## 現在の実装と差分

- `cli/internal/indexer/build.go`: `Build` 内で各文書の `readArtifactMetadata` を呼ぶ。HTML は `golang.org/x/net/html` で解析し、Markdown は Goldmark + GFM で HTML に変換して解析する。ここで本文とセクションを抽出でき、検索のための追加ファイル読み込みを避けられる。
- 同ファイルの `SiteIndex` / `ArtifactIndexEntry`: title・path・toc などを持つが本文は持たない。
- `web/src/components/CommandPalette.tsx`: `prepareFuzzyScoreText(artifact.title/path)` に対して検索する。本文の曖昧一致は現在の機能に含まれない。
- `paletteScoringProfile`: build 時に作る CSR はタイトル・フォルダの文脈ランキング用。本文検索用の索引でも、意味を表す embedding でもない。
- `cli/internal/publisher/site_publish.go`: 生成物の取り込みは `index.json` と `meta.json` の列挙。検索ファイルを build するだけでは配信されないため、実装時は publish・削除・キャッシュ更新まで契約を拡張する必要がある。

既存の [palette benchmark](palette-search-benchmark.md) はタイトル・パス検索の結果であり、本文検索の負荷を示すものではない。また、全件を先読みする chunk 分割で効果がなかったことは、クエリに必要な索引だけを取得する方式を否定する結果ではない。

## 再現できる実験

リポジトリ root で実行:

```sh
node scripts/benchmark-fulltext.mjs
```

必要条件は既存の Go dependencies、npm dependencies、Playwright Chromium。新しい製品依存は追加していない。

- `scripts/fulltext-corpus/main.go`: research 用 extractor。既存と同じ HTML parser / Markdown renderer を使用するが、製品 builder の関数自体は呼んでいない。
- `scripts/benchmark-fulltext.mjs`: build 時の正規化・文字 2-gram → 文書 ordinal の転置索引生成、本文走査との一致検証、Node / Chromium の時間計測。
- `.local/fulltext-experiment/corpus.json`: 抽出した実文書。
- `.local/fulltext-experiment/results.json`: 生の計測結果。

検索の意味は NFKC・小文字化・空白圧縮後の部分一致。空白で分けた複数語は AND。空クエリは結果なし。語幹処理・同義語・BM25・曖昧一致・意味検索は実装していない。2-gram の intersection は候補を作るだけで、最終的に本文の `includes` を確認する。位置を保持しない索引での誤一致をこの確認で防ぐ。1文字の検索は本文走査に戻る。

検証は script 内の assertion に含む:

- タイトルに頼らず、本文だけにある日本語の識別語で検索できる。
- `再<span>試行</span>` は `再試行` として抽出できる。
- `ＡＰＩ` と `api` の正規化、HTML entity、補助平面文字を扱う。
- head・script・style・template・noscript、および hidden / aria-hidden / data-search-ignore の要素を対象から除く。
- Markdown の本文・コード・GFM table を抽出する。
- `ab zz bc zz cd` が `abcd` の誤一致にならない。
- 実文書と各合成サイズで、10クエリの本文走査と転置索引検索が Node / Chromium とも完全に一致する。

## 測定結果

Node v22.14.0、headless Chromium 153.0.8010.12。実文書は `fixtures/storage/_artifacts` と `docs/public/sites/guide` の20文書。正規化後の本文は合計45.5 KB。

合成 corpus はこの20文書を繰り返し、個別の識別子と一部に検索語を足したもの。1文書の本文は平均約2.3 KB。語彙・長さ・圧縮率が偏るため、実運用の分布やサイズ上限を予測するデータではない。

| 文書数 | 本文 JSON gzip | 本文 + 2-gram JSON gzip | 索引 build | Chromium JSON parse | Chromium 保持 heap 増分 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 実20 | 17.9 KB | 29.1 KB | 3.4 ms | 0.4 ms | 0.28 MB |
| 合成1,000 | 0.85 MB | 1.00 MB | 112 ms | 4.4 ms | 5.32 MB |
| 合成5,000 | 4.25 MB | 5.49 MB | 602 ms | 19.1 ms | 25.62 MB |
| 合成10,000 | 8.50 MB | 13.58 MB | 1,135 ms | 37.9 ms | 51.00 MB |

KB / MB は十進。gzip は Node によるサイズ見積もりで、実際の HTTP 転送測定ではない。build は抽出後の本文正規化・索引生成だけを測る。Git scan / 履歴取得・serialization・gzip は含まない。20実文書の抽出は Go 起動等を含めて約61 ms（Go の build cache が温まった状態）であり、製品 builder の追加時間には換算できない。

browser parse は1回の測定。保持 heap は全文データ・索引と検索処理の状態を読み込んだ後に forced GC を行い、空の実験ページとの差を測定したもの。SPA 全体の heap、本文だけの heap、parse 中のピークは測っていない。ネットワーク・検索 UI・input-to-paint は含まない。

10,000文書の Chromium 検索時間（ウォームアップ5回 + 30回、p50）:

| クエリ | 本文走査 | 2-gram + 本文確認 | 候補数 / 一致数 |
| --- | ---: | ---: | ---: |
| `cache` | 4.9 ms | 4.9 ms | 7,503 / 1,000 |
| `API cache` | 8.1 ms | 5.0 ms | 4,500 / 500 |
| `再試行` | 1.0 ms | <0.1 ms | 100 / 100 |
| `本` | 1.3 ms | 1.3 ms | 10,000 / 2,500 |

Chromium のタイマー分解能のため、0 ms と報告された中央値はここでは <0.1 ms と表記する。

希少な語には効果がある一方、`cache` のように各 bigram が多数の文書に散在する語では候補がほとんど残る。本文と索引を全件持つ方式は読み込みとメモリの負荷も残す。計算を build に移すだけでは、この負荷は解消しない。

## 製品に組み込むときの projection 案

例示であり、採用済み schema ではない:

```text
/_indexes/<site>/index.json            既存のナビゲーションと文書情報
/_indexes/<site>/search/manifest.json  検索 schema・generation・tokenizer・ファイル参照
/_indexes/<site>/search/<hash>.*       索引と結果表示用の本文断片
```

1. build 時に文書を抽出し、既存の artifact ID/path と対応づける。ordinal を使う場合は同じ generation の文書表を同梱し、別世代の通常 index の配列位置と混ぜない。
2. `index.json` に任意の検索 manifest pointer を持たせる。サイトの discovery metadata は軽いまま保つ。pointer がない旧 index でも現在の検索を維持する。
3. 検索を開いたときに active site の検索データを取得する。大きな site ではクエリに必要な postings と上位結果の snippet だけを読む。処理が main thread を塞ぐ場合は Worker に移す。
4. 結果 URL は `/:site/<encoded-path>`。storage path を表示用 URL にしない。タイトル・パスの既存 fuzzy ranking を維持し、本文一致をどう合流させるかを別途評価する。
5. search の全生成物を先に公開してから pointer を更新する。hash 付き参照と generation により本文表・postings の取り違えを防ぐ。古い参照を読むクライアントのための保持期間、古いファイル削除、unregister、キャッシュ更新を合わせて決める。サイト全体の原子的更新を保証する案ではない。

本文抽出には browser の実行結果を使わず、source bytes を使う。JavaScript が fetch / canvas / DOM に生成する内容、画像・PDF の文字は今回の対象外。CSS による非表示はこの実験では判定できない。nav 等の共通文言を除く selector、検索対象範囲を指定する opt-in、alt text、コードの重み付けも製品化前に決める。表示する snippet は文字列として扱い、artifact の HTML を SPA DOM に挿入しない。

見出し単位の結果を出すなら、build 時に既存の toc ID と本文のセクションを対応づける。ID のない HTML 見出しには存在しない anchor を生成せず、文書 URL へ戻す。本文位置を保存すると exact phrase・highlight を扱いやすいが、索引容量が増える。

## 既存エンジンの候補

| 方式 | この製品との適合 | 次に確認する点 |
| --- | --- | --- |
| 本文 JSON + substring 走査 | 最小の PoC。Go の既存解析を使え、日本語を辞書なしで扱える | 短い実 corpus では十分でも、長文・大規模・一般語で再測定が必要 |
| MiniSearch | serialize/loadJSON・field boost・prefix/fuzzy があり、単一の検索 JSON を試しやすい | 全体をメモリに載せる前提。日本語 tokenizer と build/query の一致、Go binary への統合方法 |
| Pagefind | 静的索引の chunk を必要に応じて取得する設計。独自検索 UI から API を使える | Go 配布との依存境界、Markdown の入力、多言語横断、exact filename routes、配信する生成物 |
| 独自の packed 転置索引 | Go builder と static projection の制御を揃えられる | tokenizer・圧縮・ランキング・snippet の保守を自前で引き受けるため、既存エンジン比較が先 |

[MiniSearch の API](https://lucaong.github.io/minisearch/classes/MiniSearch.MiniSearch.html) は index の JSON 保存/復元と field boost 等を提供する。[公式 repository](https://github.com/lucaong/minisearch) ではメモリに収まる検索データを対象とし、tokenizer をカスタマイズできる。今回 MiniSearch を install / 実測したわけではない。

[Pagefind](https://pagefind.app/) は build 後の静的検索 bundle と分割索引を提供する。[Node API](https://pagefind.app/docs/node-api/) の custom record は本文と明示的な論理 URL を渡せるので、元ファイルを変更せず Markdown やこの製品の route に対応させる候補になる。[多言語仕様](https://pagefind.app/docs/multilingual/) では言語別 index の自動選択があるため、英語 shell から日本語 artifact も探すケースを確認する必要がある。日本語の segmentation は extended release が対象。今回 Pagefind の統合・性能・検索品質は未検証。

## Elasticsearch・ベクトル検索との関係

Elasticsearch の全文検索は、語を解析して転置索引を引き、BM25 で関連度を計算する。意味を embedding に変換して探す vector/semantic search もあり、組み合わせる hybrid search もある。[Elastic の方式比較](https://www.elastic.co/docs/solutions/search/search-approaches)、[全文検索の仕組み](https://www.elastic.co/docs/solutions/search/full-text/how-full-text-works)

この製品で検討しているのは、このうち検索用の索引を事前に作り、必要な文書を取り出す機能。分散サーバー・リアルタイム更新・クラスタ運用を再現する必要はない。今回の実験は BM25 ではなく、文字の部分一致を候補削減する方式である。

ベクトル検索も文書側の仕事は build に移せるが、**ユーザーの検索文を同じ embedding model で変換する処理は検索時に残る**。静的サイトだけで完結させるならブラウザでモデルを実行する必要があり、モデル取得サイズ・初期化・端末性能・言語・モデル version を新たに扱う。外部 inference API を使うなら request-time の依存と認証・費用が増える。いずれも今回の実験では検証していない。

容量の算術例: 10,000件 × 384次元 × Float32 4 byte = 15.36 MB、768次元なら30.72 MB。これは無圧縮の vector 配列だけで、モデル、文書表、snippet、近傍索引を含まない。見出し/段落ごとに分割すると vector 件数も増える。量子化で減らせる可能性はあるが品質評価が必要。

例えば「タイムアウト」という実際の語・エラーコード・API名を探す検索は lexical search が検証しやすい。「応答が遅い原因」という問いから別の言い回しの文書を探す目的なら semantic search を別の評価対象にする。全文検索の実現性を確かめる段階で embedding を必須にする理由はない。

## 次の評価と採用条件

次は同じ corpus で **本文走査 / MiniSearch / Pagefind** を比較する。日本語・英語・コードを含む実文書、長文、共通ナビゲーションを持つ文書を増やし、正解文書を指定したクエリ集合で top-k の品質を比較する。

比較するのは追加 build 時間、配信総容量、検索開始までの取得量、初回/逐次入力/IME確定/クエリ変更の時間、input-to-paint、保持/ピーク heap、snippet の正しさ、更新・削除後の古い結果の扱い。小さい site は全件方式、大きい site は必要な索引だけを読む方式を候補とするが、文書数だけの固定閾値は今回の測定から決めない。

採用条件は、検索を使わないサイト表示を重くしないこと、本文だけの語から正しい文書へ到達できること、日本語を落とさないこと、通常の論理 URL を返すこと、publish と世代整合性が成立すること。ベクトル検索は「言い換えによる発見」が必要かを別途確かめてから検討する。
