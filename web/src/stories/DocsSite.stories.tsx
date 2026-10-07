import type { Meta, StoryObj } from '@storybook/react-vite'

// The published docs sites are served from docs/public/sites via Storybook's staticDirs (/docs-sites).
// Inside the app, site.js copies the app's <html data-theme>; here each frame gets it directly.
type Theme = 'light' | 'dark'

const frameStyle = (theme: Theme) => ({
  display: 'block',
  width: '100%',
  height: '100%',
  border: 0,
  colorScheme: theme,
})

const elementsDocument = (theme: Theme) => `<!doctype html>
<html lang="ja" class="js" data-theme="${theme}">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/docs-sites/guide/assets/site.css">
  <script src="/docs-sites/guide/assets/site.js" defer></script>
  <style>
    .sb-group { padding-block: 32px; border-top: 1px solid var(--line-soft); }
    .sb-group > .eyebrow { margin-bottom: 18px; }
    .sb-stack > * + * { margin-top: 14px; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="sb-group">
      <p class="eyebrow">Typography</p>
      <h1>Gitにある成果物を、読むための場所へ。</h1>
      <h2>一つずつ置くと、全体が見えてくる。</h2>
      <h3>文書ごとに固定のURL</h3>
      <p class="lead"><strong>HTMLもMarkdownも、Gitに置いたまま。</strong> 本文のリード文です。<code>site sync</code> や <kbd>⌘K</kbd> を含みます。</p>
      <p class="note">注記：図やコマンドのバージョンは説明用の例です。</p>
    </section>

    <section class="sb-group">
      <p class="eyebrow">Buttons</p>
      <div class="btn-row">
        <a class="btn" href="#">できるまでを4場面で見る <span aria-hidden="true">↓</span></a>
        <a class="btn ghost" href="#">できあがる画面へ <span aria-hidden="true">↓</span></a>
      </div>
    </section>

    <section class="sb-group">
      <p class="eyebrow">Promises</p>
      <div class="promises">
        <div class="promise"><span class="num">01</span><div><strong>そのまま公開</strong><p>HTMLとMarkdownを、ファイル名と拡張子ごと。</p></div></div>
        <div class="promise"><span class="num">02</span><div><strong>サイトで整理</strong><p>1つのリポジトリのディレクトリが、1つのサイトになります。</p></div></div>
        <div class="promise"><span class="num">03</span><div><strong>すぐ見つける</strong><p><kbd>⌘K</kbd> で検索、<kbd>@</kbd> でサイトを切り替え。</p></div></div>
      </div>
    </section>

    <section class="sb-group">
      <p class="eyebrow">Chapter (current)</p>
      <div class="chapter is-current" style="min-height: 0; padding-block: 0; border: 0">
        <span class="step-label">03 / PUBLISH FROM GIT <span class="role">各リポジトリ</span></span>
        <h3>それぞれのGitから、担当サイトへ。</h3>
        <p>各リポジトリが、担当するサイトを <code>--site</code> で明示して公開します。<strong>公開のたびに索引を作ります。</strong></p>
        <div class="term">
          <div class="term-head"><span>TERMINAL / EACH REPOSITORY</span><button class="copy-btn" type="button">コピー</button></div>
<pre><span class="c"># docs/public/sites/ja を、サイト ja へ</span>
<span class="p">$</span> <span data-copy>artifact-pages <span class="v">site sync</span> --site ja</span></pre>
        </div>
        <div class="term">
          <div class="term-head"><span>.artifact-pages.yaml / ADMIN</span></div>
<pre><span class="k">sites</span>:
  <span class="k">ja</span>:
    <span class="k">name</span>: 日本語</pre>
        </div>
        <p class="note">書き込む前に、配信先の登録内容を確認します。</p>
        <a class="chapter-next" href="#">最後に、読者へ <span aria-hidden="true">↓</span></a>
      </div>
    </section>

    <section class="sb-group">
      <p class="eyebrow">Reader mock (interactive)</p>
      <div data-reader-demo></div>
    </section>

    <section class="sb-group">
      <p class="eyebrow">Cards</p>
      <ul class="cards">
        <li><div class="card"><span class="tag">URL</span><h3>文書ごとに固定のURL</h3><p><code>/サイト/パス.html</code> を保持します。</p></div></li>
        <li><a class="card" href="#"><span class="tag">LINK</span><h3>リンク付きカード</h3><p>ホバーで背景が変わります。</p><span class="go">開く →</span></a></li>
        <li><div class="card"><span class="tag">BOUNDARY</span><h3>Gitが正本。閲覧は静的。</h3><p>アクセス制御は配信側で設定します。</p></div></li>
      </ul>
    </section>

    <section class="sb-group sb-stack">
      <p class="eyebrow">Callouts &amp; panes</p>
      <div class="callout"><span class="ico">NOTE</span><div><p><strong>索引は公開時に作られます。</strong> 読者側での処理はありません。</p></div></div>
      <div class="callout warn"><span class="ico">WARN</span><div><p><strong>sites から外すと削除されます。</strong> 次の registry sync で登録が外れ、投影データが削除されます。</p></div></div>
      <div class="split">
        <div class="pane trust"><span class="label">TRUST</span><h3>信頼できる公開元</h3><p>HTMLは公開元の文書として扱います。</p></div>
        <div class="pane access"><span class="label">ACCESS</span><h3>アクセス制御は対象外</h3><p>配信側で設定します。</p></div>
      </div>
    </section>

    <section class="sb-group sb-stack">
      <p class="eyebrow">Table, lists, file tree</p>
      <div class="table-wrap"><table>
        <thead><tr><th>コマンド</th><th>役割</th><th>書き込む先</th></tr></thead>
        <tbody>
          <tr><td>app deploy</td><td>管理者</td><td><code>/index.html</code>, <code>/assets/*</code></td></tr>
          <tr><td>registry sync</td><td>管理者</td><td><code>/_indexes/sites.json</code></td></tr>
          <tr><td>site sync</td><td>各リポジトリ</td><td><code>/_indexes/&lt;site&gt;/*</code>, <code>/_artifacts/&lt;site&gt;/*</code></td></tr>
        </tbody>
      </table></div>
      <div class="two-col">
        <ul class="checklist"><li><strong>静的</strong>：サーバー処理なし</li><li><strong>Gitが正本</strong>：変更はGitで</li></ul>
        <ul class="checklist no"><li><strong>アカウント管理</strong>は対象外</li><li><strong>編集機能</strong>は対象外</li></ul>
      </div>
      <ol class="timeline">
        <li><div><h3>アプリを置く</h3><p>一度だけデプロイします。</p></div></li>
        <li><div><h3>サイトを登録する</h3><p>設定ファイルに書いて登録します。</p></div></li>
        <li><div><h3>公開する</h3><p>各リポジトリから公開します。</p></div></li>
      </ol>
      <pre class="filetree"><b>docs/public/sites/ja/</b>
├── what-is-git-artifact-pages.html
└── assets/
    ├── site.css
    └── site.js</pre>
    </section>

    <nav class="pager" aria-label="ページ送り">
      <a class="prev" href="#"><small>PREVIOUS</small><strong>前のページ</strong></a>
      <a class="next" href="#"><small>NEXT</small><strong>次のページ</strong></a>
    </nav>
    <footer class="foot"><strong>Gitが正本。Webは読む場所。</strong><p>フッターの説明文です。</p></footer>
  </main>
</body>
</html>`

function PageFrame({ theme, src }: { theme: Theme; src: string }) {
  return (
    <div style={{ height: '100vh' }}>
      <iframe
        key={theme}
        title="Docs page"
        src={src}
        style={frameStyle(theme)}
        onLoad={(event) => {
          const root = event.currentTarget.contentDocument?.documentElement
          if (root) root.dataset.theme = theme
        }}
      />
    </div>
  )
}

function ElementsFrame({ theme }: { theme: Theme }) {
  return <iframe title={`Docs elements (${theme})`} srcDoc={elementsDocument(theme)} style={frameStyle(theme)} />
}

const meta = {
  title: 'Docs site/Guide',
  parameters: { layout: 'fullscreen' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Page: StoryObj<{ theme: Theme }> = {
  args: { theme: 'light' },
  argTypes: { theme: { control: 'inline-radio', options: ['light', 'dark'] } },
  render: ({ theme }) => <PageFrame theme={theme} src="/docs-sites/guide/ja/what-is-git-artifact-pages.html" />,
}

export const PageDark: StoryObj<{ theme: Theme }> = {
  ...Page,
  name: 'Page (dark)',
  args: { theme: 'dark' },
}

export const Elements: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', height: '100vh' }}>
      <ElementsFrame theme="light" />
      <ElementsFrame theme="dark" />
    </div>
  ),
}
