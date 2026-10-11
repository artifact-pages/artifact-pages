// Mock corpus for the full-text search results page concept. Content paraphrases the
// architecture site (overview, storage layout, publish pipeline, indexes, delivery, trust model).
// Each match is the passage the real index would return: the heading trail it sits under plus a
// short excerpt with ellipses at the cut points. Nothing here is fetched.

export type SearchMatch = { trail: string[]; text: string }
export type SearchPage = { path: string; title: string; matches: SearchMatch[] }

export const searchCorpus: SearchPage[] = [
  {
    path: 'ja/01-overview.html',
    title: '01 概要',
    matches: [
      { trail: ['全体像', 'コンポーネント'], text: '…主なコンポーネントは CLI、Web リーダー、配信レイヤーの 3 種類です。それぞれが独立してバージョンを固定できます。…' },
      { trail: ['全体像', 'データの流れ'], text: '…公開されたファイルは index.json と一緒に保存され、リーダーはまずこの index.json を読み込みます。…' },
    ],
  },
  {
    path: 'ja/02-storage-layout.html',
    title: '02 ストレージ構成',
    matches: [
      { trail: ['オブジェクトの配置', 'キーの命名'], text: '…オブジェクトキーは種類ごとのプレフィックス（artifacts/、indexes/、previews/）で始まり、同じ種類のものをまとめて列挙できます。…' },
      { trail: ['オブジェクトの配置', '不変性'], text: '…公開済みの成果物は上書きされず、index の更新は新しいキーへの書き込みとして扱われます。…' },
      { trail: ['インデックスファイル', '配置'], text: '…インデックスは種類別に indexes/<site>/ 以下へ置かれ、公開のたびに内容アドレスで別名のファイルとして書き込まれます。…' },
      { trail: ['インデックスファイル', 'index.json'], text: '…各サイトの index.json にはページ一覧とハッシュだけが入り、本文は含まれません。…' },
    ],
  },
  {
    path: 'ja/03-publish-pipeline.html',
    title: '03 公開パイプライン',
    matches: [
      { trail: ['ステージ', '索引の生成'], text: '…ビルド後に index を生成し、成果物のアップロードが完了してから index.json を最後に切り替えます。…' },
      { trail: ['アトミックな切り替え'], text: '…index.json の差し替えが公開の境界で、途中の状態は読者から見えません。…' },
    ],
  },
  {
    path: 'ja/04-indexes-and-search.html',
    title: '04 インデックスと検索',
    matches: [
      { trail: ['検索とインデックス', 'インデックスの種類'], text: '…サイトには用途の異なる 3 種類のインデックスがあり、サイトインデックスはタイトルとパスだけを、全文インデックスは本文を対象にします。…' },
      { trail: ['検索とインデックス', 'インデックスの種類'], text: '…本文を対象にする全文インデックスは、Markdown と HTML の種類を問わず見出し単位に分割して保存されます。…' },
      { trail: ['検索とインデックス', '全文検索のしくみ'], text: '…クエリは見出しごとの断片に対して評価します。断片の種類（見出し・本文・コードブロック）で重みを変えることはありません。…' },
      { trail: ['検索とインデックス', '制限事項'], text: '…対応しているファイルの種類は Markdown と HTML のみです。PDF や画像の中身は検索できません。…' },
      { trail: ['公開時の生成', 'インデックスの更新'], text: '…変更された種類のインデックスだけを再生成し、変更のないものは前回のオブジェクトをそのまま再利用します。…' },
      { trail: ['検索とインデックス', 'サイトインデックス'], text: '…サイトインデックス（index.json）はタイトル、パス、更新日時を持ち、サイドバーの絞り込みはこれだけで動きます。…' },
      { trail: ['検索とインデックス', '全文インデックス'], text: '…全文用の index は fulltext: true を指定したサイトだけで生成され、サイズは本文の合計にほぼ比例します。…' },
    ],
  },
  {
    path: 'ja/05-delivery.html',
    title: '05 配信',
    matches: [
      { trail: ['キャッシュ', 'ヘッダー'], text: '…index.json は短いキャッシュ、内容アドレスのファイルは長期キャッシュにします。…' },
    ],
  },
  {
    path: 'ja/06-trust-model.html',
    title: '06 信頼モデル',
    matches: [
      { trail: ['成果物の分離', 'Cookie とストレージ'], text: '…成果物は種類にかかわらず別オリジンの iframe で表示され、リーダーの Cookie やストレージに触れません。…' },
    ],
  },
  {
    path: 'ja/07-operations.html',
    title: '07 運用',
    matches: [
      { trail: ['監視', '失敗時の対応'], text: '…index の再生成に失敗した場合は前回の index.json が配信され続けるため、読者への影響はありません。…' },
      { trail: ['保持期間'], text: '…古い index は 30 日間保持され、ロールバック時にそのまま参照できます。…' },
    ],
  },
  {
    path: 'en/01-overview.html',
    title: '01 Overview',
    matches: [
      { trail: ['Overview', 'Components'], text: '…There are three types of components: the CLI, the web reader and the delivery layer. The reader loads the site index first.…' },
    ],
  },
  {
    path: 'en/02-storage-layout.html',
    title: '02 Storage layout',
    matches: [
      { trail: ['Object map', 'Key naming'], text: '…Object keys start with a prefix per type (artifacts/, indexes/, previews/), so objects of one type can be listed together.…' },
      { trail: ['Index files', 'Layout'], text: '…Indexes are stored by type under indexes/<site>/ and written under a new content-addressed name on every publish.…' },
    ],
  },
  {
    path: 'en/04-indexes-and-search.html',
    title: '04 Indexes and search',
    matches: [
      { trail: ['Search and indexes', 'Index types'], text: '…A site has three types of index. The site index covers titles and paths only; the full-text index covers page bodies.…' },
      { trail: ['Search and indexes', 'Index types'], text: '…Only the types of index that changed are rebuilt on publish; unchanged ones are reused as they are.…' },
      { trail: ['Search and indexes', 'Limits'], text: '…Supported file types are Markdown and HTML. The contents of PDFs and images are not indexed.…' },
    ],
  },
]

export const searchFolders = ['ja', 'en'] as const
export type SearchFolder = (typeof searchFolders)[number]
export type FolderFilter = SearchFolder | 'all'

export const folderOf = (path: string) => path.split('/')[0]

export function queryTerms(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean)
}

/** Pages whose passages contain every query term (case-insensitive), keeping only the matching passages. */
export function searchPages(query: string): SearchPage[] {
  const terms = queryTerms(query).map((t) => t.toLowerCase())
  if (!terms.length) return []
  return searchCorpus
    .map((page) => ({
      ...page,
      matches: page.matches.filter((m) => terms.every((t) => m.text.toLowerCase().includes(t))),
    }))
    .filter((page) => page.matches.length > 0)
}

/** Body of the destination page used by the match navigator story (page 04, Japanese). */
export const navigatorArticle: Array<{ kind: 'h1' | 'h2' | 'p'; text: string }> = [
  { kind: 'h1', text: '04 インデックスと検索' },
  { kind: 'p', text: '公開のたびに、サイトごとの検索用ファイルが生成されます。この章では生成されるインデックスの構成と、リーダーが検索にどう使うかを説明します。' },
  { kind: 'h2', text: 'インデックスの種類' },
  { kind: 'p', text: 'サイトには用途の異なる 3 種類のインデックスがあり、サイトインデックスはタイトルとパスだけを、全文インデックスは本文を対象にします。' },
  { kind: 'p', text: '本文を対象にする全文インデックスは、Markdown と HTML の種類を問わず見出し単位に分割して保存されます。' },
  { kind: 'h2', text: '全文検索のしくみ' },
  { kind: 'p', text: 'クエリは見出しごとの断片に対して評価します。断片の種類（見出し・本文・コードブロック）で重みを変えることはありません。' },
  { kind: 'h2', text: '制限事項' },
  { kind: 'p', text: '対応しているファイルの種類は Markdown と HTML のみです。PDF や画像の中身は検索できません。' },
  { kind: 'h2', text: 'インデックスの更新' },
  { kind: 'p', text: '変更された種類のインデックスだけを再生成し、変更のないものは前回のオブジェクトをそのまま再利用します。' },
]
