# 検索確定後に取得する、容量を優先した全文検索

調査日: 2026-10-01。[最初の実現可能性調査](fulltext-search-feasibility.md) に続く容量・転送量の実験。検索文字列を確定するまで、検索データと検索用 decoder を取得しない UX を前提にする。製品の index schema / UI / publisher は変更していない。

## 現時点の判断

有望なのは **共通文字列辞書 + 圧縮した文書集合 + singleton の辞書内埋め込み + 文字列ごとの固定分割先**。

本文を検索用に複製せず、検索に必要な「文字列がどの文書にあるか」だけを保存する。今回定義した空白区切りの AND 部分一致なら、本文を追加取得して正誤を確認する必要がない。入力中の取得を止めた UX と組み合わせると、初回検索に必要な leaf だけを取得できる。

語の組み合わせを変えた合成1万文書では、最初の本文 + 2-gram JSON の gzip 15.39 MBに対し、実際に配信可能な root と leaf 一式は gzip 約1.19 MB（約92%減）。初回検索は decoder も含めて41–267 KBだった。ただし、共通語彙を使った合成データであり、実運用の削減率を保証するものではない。

**単一の方式を全 site に固定する判断はまだ早い。** 小さい site、反復の多い site、日本語の長い連続文では、本文を圧縮して検索時に走査する方式も比較対象に残る。実測では Brotli や高度な整数符号化が常に最小になったわけではない。

## 保存する情報を減らせる理由

検索条件を明確に限定している:

- 本文とクエリを NFKC・小文字化・空白圧縮で正規化する。
- クエリを空白で分け、各検索語の部分一致を AND で求める。
- 順位付け・引用符による phrase query・同義語・語幹処理・意味検索は今回の比較対象外。

空白を含まない検索語は、正規化後の本文中の1つの空白区切り文字列の中に必ず収まる。そのため:

```text
本文を空白区切り文字列の集合にする
  → 同じ文字列は辞書に1回だけ保存
  → 辞書中で検索語を含む文字列を探す
  → その文字列の文書集合を union
  → 複数の検索語の文書集合を intersect
```

この条件では本文走査と同じ結果を出せる。日本語を形態素に分けなくても部分一致が成立し、記号入りの `foo.bar` やコードの識別子も対象になる。出現順序と回数を保存しないことで減らせる情報量を利用している。

日本語の空白なしの長文は長い辞書エントリになる。部分一致の正確性を維持する一方、語彙共有による容量削減が弱くなる。この制約を隠して英語だけの成果を一般化しない。

## 実装した工夫

1. **辞書を共有**: Unicode 文字列を辞書に1回だけ置く。ソート後に前のエントリとの共通 UTF-8 prefix と suffix だけを書き、整数は varint にする。suffix が UTF-8 の途中から始まっても byte 列を復元してから decode する。
2. **文書番号を差分符号化**: ソートした文書 ordinal の差分を保存する。JSON の十進文字列、括弧、区切りを除く。
3. **集合ごとの表現選択**: 差分列、bitmap、連続範囲、補集合、全件を表す値の中から raw byte 数で小さいものを選ぶ。さらに Elias–Fano を候補に加えた比較も実装した。
4. **同じ文書集合を共有**: 異なる語が全く同じ文書集合に出る場合、posting を1つにする。反復の多い corpus で効く。
5. **singleton を辞書に埋め込む**: 1文書にしか出ない文字列はその文書番号を辞書側に保存し、別の posting を取得しない。今回の固有識別子検索ではこれだけで結果が確定する。
6. **分割先を文字列から固定**: token の hash で leaf を決める。全体の語彙や posting ID の追加で無関係の leaf を組み直すことを防ぐ。leaf 内では文字列と posting の対応を持ち、別世代の global ID と混ぜない。
7. **root を1ファイルにする**: file 参照・generation と辞書を1つの gzip payload にまとめる。manifest と辞書を別々に取得する1リクエストと、manifest の圧縮漏れを除く。
8. **leaf を内容 hash 付き URL にする**: 変わらない leaf を再利用する。root のみが mutable。root は検索確定後に取得し、その root が参照する leaf を読む。

これらは既存の圧縮・索引技術を組み合わせた研究 prototype であり、新しい検索アルゴリズムを発明したという主張ではない。

## 容量の比較

単位は十進 KB / MB。gzip は level 9、Brotli は quality 5。保存容量と転送量を一致させられるよう、HTTP 動的圧縮に依存しない `.gz` の実ファイルも生成している。本文の既存 artifact と通常の navigation index は別途存在する。

| corpus | 文書数 | 本文 + 2-gram JSON gzip | 本文だけの JSON gzip / Brotli | root + leaf 一式 gzip（1 leaf 設定） |
| --- | ---: | ---: | ---: | ---: |
| 実 publishable 文書 | 20 | 29.1 KB | 17.9 / 16.6 KB | 17.5 KB |
| repository 内の説明文書 | 122 | 235.0 KB | 197.0 / 183.6 KB | 108.5 KB |
| 実本文を繰り返す合成 | 10,000 | 14.23 MB | 8.50 MB / 70.7 KB | 58.2 KB |
| 語の組み合わせを変える合成 | 10,000 | 15.39 MB | 5.16 / 4.65 MB | 1.19 MB |
| 空白なしの日本語文の合成 | 10,000 | 2.38 MB | 306.6 / 354.3 KB | 292.2 KB |

小規模では、global に posting を共有した構造の gzip は15.4 KB / 96.6 KBであり、配信・更新用の root/leaf 分離による増加分も見える。全件を1ファイルで取得する契約を選ぶならその分離が必要かも評価する。

特に反復 corpus の本文だけの Brotli が70.7 KBになった点は重要。最初の gzip 8.50 MBとの差の大部分は、圧縮窓の影響でも説明できる。「14 MBから数十 KB」の数字だけで索引設計の一般的な効果を主張しない。語の組み合わせを変えた corpus では、本文だけの Brotli 4.65 MBに対しても root/leaf 一式の gzip 約1.19 MBだった。

空白なしの日本語 corpus ではすべての文が singleton。辞書にほぼ本文の情報が残り、本文だけの gzip に対する削減は小さい。辞書の非圧縮部分は約6.9 MBにもなるため、転送量だけでなく decode / 保持メモリの評価が必要。

### 圧縮の追加チューニングが逆効果になる例

語の組み合わせを変えた1万文書の構造比較:

| 表現 | raw | gzip | Brotli quality 5 |
| --- | ---: | ---: | ---: |
| 本文なしの token → 文書番号 JSON | 8.71 MB | 3.51 MB | 2.73 MB |
| front-coded 辞書 + 差分 posting | 1.888 MB | 1.215 MB | 1.197 MB |
| 適応表現 | 1.878 MB | 1.215 MB | 1.197 MB |
| 適応表現 + Elias–Fano 候補 | 1.351 MB | 1.275 MB | 1.277 MB |

Elias–Fano は raw を約28%減らしたが、gzip 後は約5%増えた。差分列の偏りを汎用 compressor が利用できるため、bit packing がその利点を失わせる場合がある。**最適化の判定は最終的な保存・転送 byte 数で行う。** 適応符号化の raw 最小選択も最終圧縮の最適解とは限らず、次の改善対象になる。

この合成 corpus の複数文書に出る2,099語について、各語の文書所属を独立 Bernoulli とみなした `Σ N H₂(p) / 8` は約1.075 MB。実データの下限ではなく、語の所属がランダムに近いモデルの目安である。今の posting 部分はその桁に近い。さらに大きく減らすには、実 corpus の語の共起・テンプレート・文書ファミリーを利用する価値がある。

## 検索確定後の転送量とリクエスト

語の組み合わせを変えた1万文書。辞書内 singleton と hash 分割を使った実ファイルのモデル値で、decoder・HTTP header はこの表に含めない。各クエリは cold cache。未知の語は root で結果なしを確定できる。

| leaf 設定 | 保存合計 | `API cache` bytes / requests | `再試行` bytes / requests | `unique-7` bytes / requests |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1.186 MB | 1.186 MB / 2 | 1.186 MB / 2 | 36.1 KB / 1 |
| 8 | 1.193 MB | 606.6 KB / 5 | 177.7 KB / 2 | 36.6 KB / 1 |
| 32 | 1.194 MB | 263.2 KB / 7 | 71.0 KB / 2 | 37.9 KB / 1 |
| 128 | 1.193 MB | 94.1 KB / 7 | 50.6 KB / 2 | 41.2 KB / 1 |

128分割はこの corpus では転送量を下げたが、20実文書では保存合計が17.5 KBから30.5 KBへ増えた。クエリによっては多くの leaf に触れる。固定で128分割を製品の標準にする根拠にはしない。

最初の global posting ID を modulo で分割した案では `unique-7` が全 leaf に触れ、128分割なら130リクエストになった。singleton の辞書内埋め込みで1リクエストに減った。この改善には結果の間引きや未知の検索語の除外を使っていない。`unique-7` は部分一致なので965文書が一致する。

### ブラウザでの確認

32分割の実ファイルをローカル HTTP 配信し、headless Chromium 153.0.8010.12 で実行した。decoder は submit 後の dynamic import。root/leaf は `DecompressionStream('gzip')` で解凍する。decoder の gzip 3.5 KBも以下の byte / request 数に含む。

| cold 初回クエリ | 一致文書 | 転送 payload | requests | submit から計算完了 |
| --- | ---: | ---: | ---: | ---: |
| `API cache` | 279 | 266.7 KB | 8 | 32.1 ms |
| `再試行` | 100 | 74.5 KB | 3 | 16.8 ms |
| `unique-7` | 965 | 41.4 KB | 2 | 13.7 ms |
| 存在しない語 | 0 | 41.4 KB | 2 | 13.5 ms |

検証したこと:

- ページ表示と入力では検索データ / decoder の request が0。
- Enter で初めて取得する。
- 本文を取得せず、本文走査と同じ文書集合を返す。
- 同じ検索の再確定は memory cache を使い、追加 request が0。
- 別の検索文字列へ編集する間も request が0。`再試行` を確定すると、不足している leaf 33.1 KBだけを追加取得するケースがある。

測定は localhost の単発試行で、CDN / public network / mobile の latency を予測するものではない。byte 数は server が返した response body の合計で、HTTP/TLS header を含まない。通常の SPA・navigation index・client adapter は除外。検索結果のタイトル表示は既存 index に対応づける想定で、snippet・ranking・production UI の検証はしていない。decoder は build 関数も含む research module 全体で、製品用 bundle では別途削減できる。

## 更新コスト

1文書に新しい語と、既存の複数文書にある語を追加する実験を行った。語の組み合わせを変えた1万文書・32分割の場合:

- global ID 分割案: 新しい1語だけの追加でも全34ファイルが変わり、約1.23 MBを再公開する。
- hash 分割 + singleton inline + root 統合: root と関係する leaf の2ファイル、約73.1 KBを再公開する。変更後の全生成物は約1.194 MB。

削除・rename による文書 ordinal の変更は未対策。ordinal がずれると複数の posting が変わるため、実装前に generation の文書表と stable document ID / tombstone / compaction の設計を検討する必要がある。stable ID の byte 数も費用に含める。

root を再取得しないままの memory cache の更新規則、古い hash 付き leaf の保持・削除、index の世代対応、cache invalidation、unregister も未実装。今回の保存合計は現在世代のみで、古い世代を保持するコストは含まない。

## コストの評価方法

単一の「index 容量」ではなく次を記録する:

```text
追加保存量     = 現世代の検索生成物 + 保持する旧生成物
転送量         = cold root + 必要 leaf + decoder + 表示用 snippet 等
request 数     = root + 必要 leaf + decoder + 表示用取得
更新書込量     = 変更 root/leaf + generation 切替関連の生成物
```

実際の費用はこの byte / request / retention に、選んだ配信先の単価と cache hit の分布を掛けて算出する。今回は料金表を使った金額見積もりではない。特に小さい byte 数のために大量の小ファイルを取得すると、request 数と latency が増える。

snippet を表示するなら、上位結果の artifact を必要分だけ読むか、短い断片を別途作るかを比較する。その取得量を足してから採用判断する。本文を後から全件取得して正誤を確認する方式は、検索結果の確定コストにそれを含める。

## さらに探索する方向

1. **build 時にサイトごとの方式を選ぶ**: whole payload、stable root/leaf、圧縮本文走査を同じ意味の検索で比較する。小規模・反復・空白なし日本語で異なる最小構成を選べる reader 契約にする。
2. **文書ファミリーによる集合の因数分解**: 共通 posting の完全一致共有を、共通の文書群 + 小さい差分へ広げる。任意の corpus で有効かは未検証。既存文書番号の並び替えも有望だが、更新の安定性とのトレードオフがある。
3. **compression-aware の選択**: raw 最小の符号ではなく、配信 chunk ごとの実際の gzip/Brotli size と query touch 数で選ぶ。小さすぎる分割で辞書が増える問題も含めて探索する。
4. **文字列辞書の検索を圧縮したまま行う**: FM-index / r-index 等の self-index は、圧縮した文字列の部分一致を扱える研究系統。空白なし日本語で辞書を全面展開する問題、任意 phrase query に必要な位置情報を含めて比較する。今回は実装していない。occurrence の検索から文書集合を得る document listing と snippet 抽出の付帯構造も費用に含める。
5. **Pagefind との同条件比較**: 独自方式に勝てるかを、decoder・取得量・ranking・snippet まで含めて測る。独自実装だけの小さい core と完成した engine 全体を混ぜて比較しない。

背景となる一次資料: [Roaring の format](https://github.com/RoaringBitmap/RoaringFormatSpec)、[PISA の compression](https://pisa-engine.github.io/pisa/book/guide/compressing.html)、[Compressed Text Indexes: From Theory to Practice](https://arxiv.org/abs/0712.3360)、[Fast and Small Subsampled R-indexes](https://arxiv.org/abs/2409.14654)。これらが扱う方式と今回の custom codec の実装互換性を主張するものではない。

## 再現と限界

```sh
node scripts/benchmark-fulltext-cost.mjs
```

- `scripts/fulltext-packed.mjs`: browser-compatible な binary codec と検索処理。
- `scripts/benchmark-fulltext-cost.mjs`: corpus 生成、構造比較、分割・更新比較、HTTP/browser 検証。
- `.local/fulltext-cost/results.json`: 生の結果、corpus hash、全クエリ。
- `.local/fulltext-cost/*-corpus.json`: 測定時の入力 snapshot。repository 内の文書が変わっても当時の入力を確認できる。
- `.local/fulltext-cost/browser-bundle/`: gzip の配信用研究生成物。以前の実験ファイルが残ることがあるため、保存量は directory の総容量ではなく results の manifest 対象ファイル集合で数える。

実文書は fixtures + guide の20文書。122文書の corpus は `docs` 全体の HTML/Markdown で、publishable source の契約を変更するものではない。合成の varied corpus は実文書由来の約2,099語をランダムに組み合わせ、本文の平均は約1.7 KB。日本語 corpus は12の短い自然文を24回連結して10,000文書を作ったもので、自然言語全体の語彙や検索品質をモデル化したデータではない。

各 corpus の13クエリについて、各表現・1/8/32/128分割・stable 分割を decode して本文走査との完全一致を assertion で確認した。probe は部分語、日本語、Unicode正規化、補助平面文字、記号、2-gram の偽陽性を含む。posting codec は空集合・全件・疎密・連続・100通りの決定的乱数集合で round-trip を検証した。検索用 payload の HTTP/browser 検証は varied corpus の4クエリで行った。

Go の既存 extractor と npm/Playwright を使い、製品 dependency は追加していない。research format は production 向けの完全な validation・巨大サイズ対応・世代管理・ランキングを備えた実装ではない。今回の成果は、保存する情報と取得単位を変えることで容量を大きく減らせること、および効かない条件と更新上の問題を具体的に特定したことにある。
