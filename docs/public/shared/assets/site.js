/* Git Artifact Pages — ドキュメントサイト共通スクリプト
   すべて任意の強化です。JavaScriptが無効でも、全ページと図の全要素を読めます。
   <html lang> で日本語と英語の文言・例を切り替えます。
   正本は docs/public/shared/assets/ です。サイトごとに配信範囲（CSP）が分かれるため、各サイトの assets/ へは
   npm run docs:sync-assets で写し、直接編集しないでください（npm run docs:check-assets で一致を確認できます）。 */
(() => {
  'use strict';

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const inFrame = (() => { try { return window.parent !== window; } catch { return true; } })();
  const lang = (document.documentElement.lang || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
  const T = {
    ja: {
      copy: 'コピー', copied: 'コピーしました', selectToCopy: '選択してコピー',
      sidebar: '閲覧画面のサイドバー（見本）', tryIt: '検索を試す ↗', alsoOpens: 'でも開けます',
      palette: 'コマンドパレット（見本）', query: '検索語', empty: '一致する項目はありません',
      demoQuery: 'とは',
    },
    en: {
      copy: 'Copy', copied: 'Copied', selectToCopy: 'Select to copy',
      sidebar: 'Reader sidebar (sample)', tryIt: 'Try search ↗', alsoOpens: ' also opens it',
      palette: 'Command palette (sample)', query: 'Search', empty: 'No matching results',
      demoQuery: 'what',
    },
  }[lang];

  /* ── 0. テーマ ─────────────────────────────
     閲覧アプリは <html data-theme="light|dark"> でテーマを持ちます。iframe の color-scheme は
     ブラウザによっては文書側の prefers-color-scheme に届かないため、同一オリジンで読めるときは
     アプリのテーマを写し、切り替えにも追従します。読めなければ prefers-color-scheme のままです。 */
  if (inFrame) {
    try {
      const appRoot = window.parent.document.documentElement;
      const sync = () => {
        const theme = appRoot.dataset.theme;
        if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
      };
      sync();
      new MutationObserver(sync).observe(appRoot, { attributes: true, attributeFilter: ['data-theme'] });
    } catch { /* 別オリジン：prefers-color-scheme にまかせる */ }
  }

  /* ── 1. 兄弟ページへの移動 ─────────────────────────────
     閲覧アプリでは、このページは iframe（/_artifacts/<site>/…）の中に表示されます。
     そのままリンクを辿ると、アプリのURL・サイドバー・検索対象が現在の文書とずれるため、
     同一オリジンの場合に限り、アプリ側の論理ルート（/<site>/…）へ移動します。
     単独で開いたとき（生ファイルやローカルのHTTPサーバー）は通常のリンクとして動きます。 */
  if (inFrame) {
    const marker = '/_artifacts/';
    document.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      try {
        const to = new URL(anchor.href, location.href);
        if (to.origin !== location.origin || !location.pathname.includes(marker)) return;
        if (to.pathname === location.pathname) return; // 同じ文書内のアンカー
        const at = to.pathname.indexOf(marker);
        if (at !== 0) return;
        // 読者が確定した全文検索（?q=）は、同じサイト内の移動では引き継ぐ。
        const target = new URL('/' + to.pathname.slice(marker.length) + to.search + to.hash, window.top.location.origin);
        const query = new URLSearchParams(window.top.location.search).get('q');
        const sameSite = window.top.location.pathname.split('/')[1] === target.pathname.split('/')[1];
        if (query && sameSite && !target.searchParams.has('q')) target.searchParams.set('q', query);
        const route = target.pathname + target.search + target.hash;
        window.top.location.assign(route);
        event.preventDefault();
      } catch { /* 別オリジンなど：通常のリンク動作にまかせる */ }
    });
  }

  /* ── 2. コピー ボタン ── */
  document.querySelectorAll('.copy-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const source = button.closest('.term')?.querySelector('pre');
      if (!source) return;
      const text = [...source.querySelectorAll('[data-copy]')].map((line) => line.textContent).join('\n')
        || source.textContent.replace(/^\$ /gm, '');
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = T.copied;
      } catch {
        button.textContent = T.selectToCopy;
        const range = document.createRange();
        range.selectNodeContents(source);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setTimeout(() => { button.textContent = T.copy; }, 1800);
    });
  });

  /* ── 3. 紙芝居：スクロール位置に合わせて図の要素を増やす ── */
  const panel = document.querySelector('.diagram-panel');
  const chapters = [...document.querySelectorAll('.chapter[data-step]')];
  if (panel && chapters.length) {
    const count = panel.querySelector('.scene-count');
    let scheduled = false;
    const update = () => {
      scheduled = false;
      const guide = window.innerHeight * 0.55;
      let active = 1;
      for (const chapter of chapters) {
        if (chapter.getBoundingClientRect().top <= guide) active = Number(chapter.dataset.step);
      }
      panel.dataset.scene = String(active);
      if (count) count.textContent = String(active).padStart(2, '0') + ' / ' + String(chapters.length).padStart(2, '0');
      chapters.forEach((chapter) => chapter.classList.toggle('is-current', Number(chapter.dataset.step) === active));
    };
    const schedule = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(update); } };
    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', schedule);
    addEventListener('load', update);
    update();
  }

  /* ── 4. 閲覧画面のデモ（⌘K / Ctrl K、@ でサイト切替） ──
     内容は、この日本語サイト自身のページと、説明用の例です。実際の閲覧アプリの挙動を簡略化しています。
     サイトの説明は artifact-pages.yaml の description と同じ文言です。 */
  /* このガイド自身。1つのサイトの中に ja/ と en/ があり、読んでいる言語のページを先に並べる */
  const GUIDE_PAGES = {
    ja: [
      ['Git Artifact Pagesとは', 'ja/what-is-git-artifact-pages.html', 'Gitにある成果物を、読むための場所へ。'],
      ['読者の体験', 'ja/reading.html', 'URL、画面の構成、検索とサイトの切り替え。'],
    ],
    en: [
      ['What is Git Artifact Pages?', 'en/what-is-git-artifact-pages.html', 'A reading place for the work you keep in Git.'],
      ['Reading', 'en/reading.html', 'URLs, the screen, search, and switching sites.'],
    ],
  };
  const GUIDE = {
    id: 'guide', name: 'Guide', description: 'Adopt, publish, and read with Git Artifact Pages. 導入・公開・閲覧のガイド。',
    artifacts: [...GUIDE_PAGES[lang], ...GUIDE_PAGES[lang === 'ja' ? 'en' : 'ja']],
  };
  const DEMO_SRE = {
    ja: { id: 'sre', name: 'SREチーム', description: '障害の振り返り、SLO、オンコール手順（説明用の例）。', artifacts: [
      ['9/12 決済タイムアウト障害の振り返り', 'incidents/2026-09-12-review.html', '説明用の例のページ。'],
      ['オンコール引き継ぎ手順', 'runbooks/handoff.md', '説明用の例のページ。'],
    ] },
    en: { id: 'sre', name: 'SRE', description: 'Incident reviews, SLOs, and on-call runbooks (illustrative example).', artifacts: [
      ['Sep 12 payment timeout review', 'incidents/2026-09-12-review.html', 'An illustrative page.'],
      ['On-call handoff', 'runbooks/handoff.md', 'An illustrative page.'],
    ] },
  }[lang];
  /* このガイドを先頭に、説明用の例のサイトを並べる */
  const SITES = [GUIDE, DEMO_SRE];

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const highlight = (node, text, needle) => {
    const index = needle ? text.toLocaleLowerCase().indexOf(needle) : -1;
    if (index < 0) { node.textContent = text; return; }
    node.append(text.slice(0, index));
    node.append(el('mark', '', text.slice(index, index + needle.length)));
    node.append(text.slice(index + needle.length));
  };
  /* 閲覧アプリの Icon（web/src/components/Icon.tsx）と同じ線画 */
  const ICONS = {
    search: '<circle cx="6.7" cy="6.7" r="4.6"/><path d="m10.1 10.1 3.2 3.2"/>',
    file: '<path d="M4 1.8h5l3.2 3.3v9.1H4z"/><path d="M9 1.8v3.5h3.2"/>',
    folder: '<path d="M1.8 4.2h4l1.5 1.6h6.9v6.7H1.8z"/><path d="M1.8 5.8V3.5h4.4l1.4 1.4"/>',
  };
  const icon = (name, size = 14) => {
    const span = el('span', 'pal-ico');
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return span;
  };

  /* 閲覧アプリのコマンドパレット（CommandPalette.tsx）の見た目と主な挙動を再現する。
     通常はいまのサイトのページを検索し、@ で始めるとサイトを検索する。@ だけのときは何も選択しない。 */
  function createPalette({ sites, currentSite, onChooseSite, onChoosePage }) {
    const state = { query: '', selected: 0, results: [], siteMode: false };
    const scrim = el('div', 'rm-scrim'); scrim.hidden = true;
    const pal = el('div', 'pal'); pal.setAttribute('role', 'dialog'); pal.setAttribute('aria-label', T.palette);
    const inputRow = el('div', 'pal-input');
    const input = el('input'); input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
    input.setAttribute('aria-label', T.query);
    const scopeLabel = el('span', 'pal-scope');
    inputRow.append(icon('search', 16), input, scopeLabel, el('kbd', '', 'esc'));
    const tabs = el('div', 'pal-tabs');
    ['All', 'Recent', 'Pinned', 'Previews'].forEach((label, index) => {
      const tab = el('span', '', label);
      if (index === 0) tab.setAttribute('aria-current', 'true');
      tabs.append(tab);
    });
    const list = el('div', 'pal-list'); list.setAttribute('role', 'listbox');
    const foot = el('div', 'pal-foot');
    const hint = (keys, label) => { const span = el('span'); keys.forEach((key) => span.append(key)); span.append(' ' + label); return span; };
    foot.append(
      hint([el('kbd', '', '↑'), el('kbd', '', '↓'), ' or ', el('kbd', '', 'Ctrl+J/K')], 'navigate'),
      hint([el('kbd', '', '↵')], 'open'),
      hint([el('code', '', '>')], 'commands'),
      hint([el('code', '', '@')], 'sites'),
      hint([el('code', '', '#')], 'headings'),
    );
    pal.append(inputRow, tabs, list, foot); scrim.append(pal);

    function render(animate) {
      const raw = state.query;
      const siteMode = raw.startsWith('@');
      const needle = (siteMode ? raw.slice(1) : raw).trim().toLocaleLowerCase();
      const site = currentSite();
      state.siteMode = siteMode;
      if (siteMode) {
        state.results = sites
          .filter((entry) => !needle || (entry.name + ' ' + entry.id).toLocaleLowerCase().includes(needle))
          .map((entry) => ({ kind: 'site', site: entry }));
      } else {
        state.results = site.artifacts
          .map(([title, path], index) => ({ kind: 'page', title, path, index }))
          .filter((entry) => !needle || (entry.title + ' ' + entry.path).toLocaleLowerCase().includes(needle));
      }
      scopeLabel.textContent = siteMode ? 'Sites' : site.name + ' only';
      input.placeholder = siteMode ? 'Search sites...' : 'Search pages, headings, and commands...';
      tabs.hidden = siteMode;
      if (state.selected >= state.results.length) state.selected = state.results.length - 1;
      list.textContent = '';
      if (!state.results.length) { list.append(el('div', 'pal-empty', T.empty)); return; }
      list.append(el('div', 'pal-sec', siteMode ? 'Sites' : 'Pages'));
      state.results.forEach((entry, index) => {
        const item = el('button', 'pal-item' + (entry.kind === 'site' ? ' pal-item--site' : '') + (index === state.selected ? ' sel' : '') + (animate ? ' pop' : ''));
        if (animate) item.style.animationDelay = (index * 70) + 'ms';
        item.type = 'button'; item.setAttribute('role', 'option');
        if (entry.kind === 'site') {
          const copy = el('span', 'pal-copy');
          const title = el('span', 'pal-title'); highlight(title, entry.site.name, needle);
          const sub = el('span', 'pal-sub');
          const id = el('span', 'pal-id'); highlight(id, '/' + entry.site.id, needle);
          sub.append(id, ' · ' + entry.site.artifacts.length + ' artifacts');
          copy.append(title, el('span', 'pal-desc', entry.site.description), sub);
          item.append(icon('folder'), copy);
        } else {
          const title = el('span', 'pal-title'); highlight(title, entry.title, needle);
          const path = el('span', 'pal-path'); highlight(path, entry.path, needle);
          item.append(icon('file'), title, path);
        }
        item.addEventListener('mousedown', (event) => { event.preventDefault(); choose(index); });
        list.append(item);
      });
    }
    function setQuery(value, animate) {
      state.query = value; input.value = value;
      state.selected = value.trim() === '@' ? -1 : 0;
      render(animate);
    }
    function open(seed = '', focus = true) {
      scrim.hidden = false; setQuery(seed, seed === '@');
      if (focus) input.focus({ preventScroll: true });
    }
    function close() { scrim.hidden = true; }
    function choose(index) {
      const entry = state.results[index];
      if (!entry) return;
      close();
      if (entry.kind === 'site') onChooseSite(entry.site); else onChoosePage(entry.index);
    }
    input.addEventListener('input', () => setQuery(input.value, input.value === '@'));
    input.addEventListener('keydown', (event) => {
      const next = (step) => { event.preventDefault(); state.selected = Math.max(0, Math.min(state.selected + step, state.results.length - 1)); render(); };
      if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) next(1);
      else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) next(-1);
      else if (event.key === 'Enter') { event.preventDefault(); choose(Math.max(state.selected, 0)); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    });
    scrim.addEventListener('mousedown', (event) => { if (event.target === scrim) close(); });
    return { element: scrim, input, open, close, choose, setQuery, get isOpen() { return !scrim.hidden; }, get query() { return state.query; } };
  }

  /* 閲覧アプリのサイドバー（Browse）と同じ形のツリー。フォルダ名と件数、その下にページのタイトルを並べる。
     activePath があればそのページを選択状態にし、そのフォルダだけを開く。なければすべて開く。 */
  function renderTree(node, artifacts, activePath) {
    node.textContent = '';
    const dirs = new Map();
    artifacts.forEach(([title, path]) => {
      const at = path.lastIndexOf('/');
      const dir = at < 0 ? '' : path.slice(0, at);
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir).push({ title, path });
    });
    [...dirs.keys()].sort().forEach((dir) => {
      const pages = dirs.get(dir).sort((a, b) => a.title.localeCompare(b.title));
      const open = !activePath || pages.some((page) => page.path === activePath);
      if (dir) {
        const row = el('div', 'mk-dir');
        row.append(el('i', '', open ? '⌄' : '›'), el('span', '', dir), el('small', '', String(pages.length)));
        node.append(row);
      }
      if (!open) return;
      pages.forEach((page) => node.append(el('div', 'mk-file' + (dir ? '' : ' mk-root') + (page.path === activePath ? ' active' : ''), page.title)));
    });
  }

  function buildDemo(host) {
    const autoplay = host.dataset.readerDemo === 'autoplay';
    const startPage = () => Math.max(0, SITES[0].artifacts.findIndex(([, path]) => path === host.dataset.demoPage));
    const state = { site: SITES[0], page: startPage() };
    host.textContent = '';
    host.classList.add('reader-mock');

    const side = el('aside', 'rm-side');
    side.setAttribute('aria-label', T.sidebar);
    const siteRow = el('div', 'rm-site');
    const siteMark = el('b'); const siteName = el('span'); const caret = el('i', '', '⌄');
    siteRow.append(siteMark, siteName, caret);
    const searchButton = el('button', 'am-filter');
    searchButton.type = 'button';
    searchButton.append(el('span', '', '⌕ Filter navigation'), el('kbd', '', '⌘K'));
    const tree = el('div', 'mk-tree');
    side.append(siteRow, searchButton, el('div', 'rm-h', 'Browse'), tree);

    const main = el('div', 'rm-main');
    const chrome = el('div', 'rm-chrome');
    const crumb = el('span'); chrome.append(crumb, el('span', '', 'Contents  Details'));
    const article = el('article', 'rm-article');
    const kicker = el('small'); const title = el('h3'); const summary = el('p');
    const actions = el('div', 'rm-actions');
    const tryButton = el('button', 'rm-try', T.tryIt); tryButton.type = 'button';
    const hint = el('span'); hint.append(el('kbd', '', '⌘K'), ' / ', el('kbd', '', 'Ctrl K'), T.alsoOpens);
    actions.append(tryButton, hint);
    article.append(kicker, title, summary, el('div', 'rm-faux'), el('div', 'rm-faux m'), el('div', 'rm-faux s'), actions);

    function renderPage() {
      const site = state.site;
      const page = site.artifacts[state.page] || site.artifacts[0];
      siteMark.textContent = site.name.slice(0, 1).toUpperCase();
      siteName.textContent = site.name;
      crumb.textContent = '';
      const at = page[1].lastIndexOf('/');
      if (at > 0) crumb.append(page[1].slice(0, at) + ' / ');
      crumb.append(Object.assign(el('strong'), { textContent: page[0] }));
      kicker.textContent = 'GIT ARTIFACT PAGES / ' + site.id.toUpperCase();
      title.textContent = page[0];
      summary.textContent = page[2];
      renderTree(tree, site.artifacts, page[1]);
    }
    const palette = createPalette({
      sites: SITES,
      currentSite: () => state.site,
      onChooseSite: (site) => { state.site = site; state.page = 0; renderPage(); },
      onChoosePage: (index) => { state.page = index; renderPage(); },
    });
    main.append(chrome, article, palette.element);
    host.append(side, main);
    searchButton.addEventListener('click', () => palette.open(''));
    tryButton.addEventListener('click', () => palette.open(''));

    renderPage();
    if (autoplay) palette.open('', false);
    return {
      host, autoplay, palette, renderPage,
      reset() { state.site = SITES[0]; state.page = startPage(); renderPage(); },
    };
  }

  /* ── 3b. 狭い画面：各ステップに、その時点の図を1枚ずつ置く ──
     図の元は .diagram-panel の SVG だけにして、ここで複製する。ステップごとに注目する範囲を切り出し、
     文字が小さくなりすぎない幅を下限にする（入りきらない分は図の枠の中で横にスクロールする）。
     表示の切り替えは CSS（max-width: 900px）が行う。 */
  const STEP_VIEWS = { 1: [164, 20, 432, 222], 2: [30, 236, 700, 216], 3: [30, 236, 700, 410], 4: [384, 60, 366, 176] };
  /* 切り出した範囲の端で文字が途切れる要素は、そのステップの図から外す */
  const STEP_DROPS = { 4: ['.d-sub'] };
  const sourceSvg = panel && panel.querySelector('svg');
  const captions = panel ? [...panel.querySelectorAll('.diagram-caption span')] : [];
  if (sourceSvg) {
    chapters.forEach((chapter) => {
      const step = Number(chapter.dataset.step);
      const view = STEP_VIEWS[step];
      if (!view) return;
      const figure = el('figure', 'step-figure');
      figure.dataset.scene = String(step);
      const clone = sourceSvg.cloneNode(true);
      clone.querySelectorAll('title, desc').forEach((node) => node.remove());
      clone.removeAttribute('role');
      clone.removeAttribute('aria-labelledby');
      clone.setAttribute('aria-hidden', 'true');
      clone.setAttribute('viewBox', view.join(' '));
      (STEP_DROPS[step] || []).forEach((selector) => clone.querySelectorAll(selector).forEach((node) => node.remove()));
      const markerId = `ah-step-${step}`;
      clone.querySelector('marker').id = markerId;
      clone.querySelectorAll('[marker-end]').forEach((node) => node.setAttribute('marker-end', `url(#${markerId})`));
      // 拡大しすぎない上限（PC の図と同程度の文字の大きさ）と、横長の図だけ文字を読める幅の下限
      clone.style.maxWidth = Math.round(view[2] * 0.85) + 'px';
      if (view[2] > 450) clone.style.minWidth = Math.round(view[2] * 0.8) + 'px';
      const frame = el('div', 'step-figure-frame');
      frame.append(clone);
      figure.append(frame);
      if (captions[step - 1]) figure.append(el('figcaption', '', captions[step - 1].textContent));
      const lead = chapter.querySelector('h3 + p');
      (lead || chapter.querySelector('h3')).after(figure);
      /* 横に続きがあるときだけ右端をぼかし、最後までスクロールしたら外す */
      const syncEdge = () => {
        const scrollable = frame.scrollWidth > frame.clientWidth + 1;
        frame.classList.toggle('is-scrollable', scrollable);
        frame.classList.toggle('at-end', scrollable && frame.scrollLeft + frame.clientWidth >= frame.scrollWidth - 1);
      };
      frame.addEventListener('scroll', syncEdge, { passive: true });
      addEventListener('resize', syncEdge);
      requestAnimationFrame(syncEdge);
    });
  }

  const demos = [...document.querySelectorAll('[data-reader-demo]')].map(buildDemo);

  /* ── 5. 終盤の見本：説明用のチームサイトのトップページと、@ によるサイト切り替え ──
     サイトと文書は説明用の例です。見えたら一度だけ、パレットを開いて @ を入力し、サイト一覧を出します。 */
  const EXAMPLE_SITES = {
    ja: [
      { id: 'sre', name: 'SREチーム', description: '障害の振り返り、SLO、オンコール手順。', artifacts: [
        ['9/12 決済タイムアウト障害の振り返り', 'incidents/2026-09-12-review.html', 'Sep 16'],
        ['SLOの定義と計測方法', 'slo/definitions.md', 'Sep 11'],
        ['オンコール引き継ぎ手順', 'runbooks/handoff.md', 'Sep 2'],
      ] },
      { id: 'checkout', name: '決済チーム / Checkout', description: '決済画面とAPIの設計、障害対応、運用手順。', artifacts: [
        ['決済フロー設計', 'design/payment-flow.html', 'Sep 28'],
        ['9/12 決済タイムアウト障害', 'incidents/2026-09-12-timeout.html', 'Sep 14'],
        ['返金ステータスの遷移', 'design/refund-states.md', 'Sep 9'],
        ['オンコール手順', 'runbooks/on-call.md', 'Aug 30'],
      ] },
      { id: 'billing', name: '決済チーム / Billing', description: '請求・締め処理の設計と運用。', artifacts: [
        ['請求書発行バッチの設計', 'design/invoice-batch.html', 'Sep 25'],
        ['月次締めチェックリスト', 'runbooks/month-end.md', 'Sep 1'],
      ] },
      { id: 'platform', name: 'Platformチーム', description: 'クラスタ構成、デプロイ基盤、コストレポート。', artifacts: [
        ['Kubernetesのクラスタ構成', 'architecture/clusters.html', 'Sep 27'],
        ['デプロイパイプライン', 'guides/deploy-pipeline.md', 'Sep 19'],
        ['コスト月次レポート', 'reports/cost-2026-09.html', 'Sep 5'],
      ] },
      { id: 'data', name: 'データ基盤チーム', description: 'イベントスキーマとDWHの設計指針。', artifacts: [
        ['イベントスキーマ一覧', 'schemas/events.html', 'Sep 24'],
        ['DWHのテーブル設計指針', 'guides/dwh-modeling.md', 'Sep 12'],
      ] },
      { id: 'mobile-ios', name: 'モバイルチーム / iOS', description: 'iOSアプリのリリース手順と画面設計。', artifacts: [
        ['リリース手順', 'runbooks/release.md', 'Sep 26'],
        ['画面遷移図', 'design/navigation.html', 'Sep 8'],
      ] },
    ],
    en: [
      { id: 'sre', name: 'SRE', description: 'Incident reviews, SLOs, and on-call runbooks.', artifacts: [
        ['Sep 12 payment timeout review', 'incidents/2026-09-12-review.html', 'Sep 16'],
        ['SLO definitions and measurement', 'slo/definitions.md', 'Sep 11'],
        ['On-call handoff', 'runbooks/handoff.md', 'Sep 2'],
      ] },
      { id: 'checkout', name: 'Payments / Checkout', description: 'Checkout UI and API design, incidents, and runbooks.', artifacts: [
        ['Payment flow design', 'design/payment-flow.html', 'Sep 28'],
        ['Sep 12 payment timeout', 'incidents/2026-09-12-timeout.html', 'Sep 14'],
        ['Refund state transitions', 'design/refund-states.md', 'Sep 9'],
        ['On-call runbook', 'runbooks/on-call.md', 'Aug 30'],
      ] },
      { id: 'billing', name: 'Payments / Billing', description: 'Invoicing and month-end close design and operations.', artifacts: [
        ['Invoice batch design', 'design/invoice-batch.html', 'Sep 25'],
        ['Month-end close checklist', 'runbooks/month-end.md', 'Sep 1'],
      ] },
      { id: 'platform', name: 'Platform', description: 'Cluster architecture, deployment tooling, and cost reports.', artifacts: [
        ['Kubernetes cluster layout', 'architecture/clusters.html', 'Sep 27'],
        ['Deployment pipeline', 'guides/deploy-pipeline.md', 'Sep 19'],
        ['Monthly cost report', 'reports/cost-2026-09.html', 'Sep 5'],
      ] },
      { id: 'data', name: 'Data Platform', description: 'Event schemas and warehouse modeling guidelines.', artifacts: [
        ['Event schema catalog', 'schemas/events.html', 'Sep 24'],
        ['Warehouse modeling guidelines', 'guides/dwh-modeling.md', 'Sep 12'],
      ] },
      { id: 'mobile-ios', name: 'Mobile / iOS', description: 'iOS release runbooks and screen design.', artifacts: [
        ['Release runbook', 'runbooks/release.md', 'Sep 26'],
        ['Navigation map', 'design/navigation.html', 'Sep 8'],
      ] },
    ],
  }[lang];

  function buildFinale(host) {
    const stage = host.querySelector('.am-stage');
    const state = { site: EXAMPLE_SITES[1], played: false };
    const setAll = (key, fn) => host.querySelectorAll(`[data-am="${key}"]`).forEach(fn);

    function renderSite() {
      const site = state.site;
      setAll('mark', (node) => { node.textContent = site.name.slice(0, 1).toUpperCase(); });
      setAll('name', (node) => { node.textContent = site.name; });
      setAll('id', (node) => { node.textContent = '/' + site.id; });
      setAll('crumb', (node) => { node.textContent = '/' + site.id; });
      setAll('search', (node) => { node.textContent = '⌕ Search artifacts in ' + site.name; });
      setAll('lede', (node) => { node.textContent = `${site.artifacts.length} published artifacts. Browse the latest work or find an artifact by title or path.`; });
      setAll('recent', (node) => {
        node.textContent = '';
        site.artifacts.forEach(([title, path, date]) => {
          const item = el('div', 'am-item'); const copy = el('span');
          copy.append(el('strong', '', title), el('small', '', path));
          item.append(copy, el('time', '', date));
          node.append(item);
        });
      });
      setAll('tree', (node) => renderTree(node, site.artifacts));
    }

    const palette = createPalette({
      sites: EXAMPLE_SITES,
      currentSite: () => state.site,
      onChooseSite: (site) => { state.site = site; renderSite(); },
      onChoosePage: () => {},
    });
    stage.append(palette.element);

    /* 見えたら一度だけ：まずトップページを見せ、少し置いてパレットを開き、さらに @ を入力する */
    function play() {
      if (state.played) return;
      state.played = true;
      if (reduceMotion) return;
      setTimeout(() => {
        if (palette.isOpen) return;
        palette.open('', false);
        setTimeout(() => { if (palette.isOpen && !palette.query) palette.setQuery('@', true); }, 700);
      }, 1600);
    }
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) { play(); observer.disconnect(); }
      }, { threshold: 0.6 });
      observer.observe(host);
    } else { play(); }

    renderSite();
    return { host, open: palette.open };
  }

  const finaleHost = document.querySelector('[data-app-mock]');
  const finale = finaleHost ? buildFinale(finaleHost) : null;
  const openFinale = (seed) => {
    finale.host.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    finale.open(seed);
  };
  document.querySelectorAll('[data-app-mock-open]').forEach((button) => {
    if (finale) button.addEventListener('click', () => openFinale('@'));
    else button.hidden = true;
  });

  /* ⌘K / Ctrl K：単独表示のときだけ、終盤の見本の検索パレットを開く。
     閲覧アプリ内では、アプリ本体の検索パレットが同じキーで開くため、ここでは奪いません。 */
  if (!inFrame && finale) {
    addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openFinale('');
      }
    });
  }

  /* ヒーローの自動再生：見えているあいだだけ、検索 → 開く → @ でサイト切替 を繰り返す。 */
  const hero = demos.find((demo) => demo.autoplay);
  if (hero && !reduceMotion) {
    let timers = []; let running = false; let visible = false; let touched = false;
    const later = (ms, fn) => { timers.push(setTimeout(fn, ms)); };
    const clear = () => { timers.forEach(clearTimeout); timers = []; running = false; };
    const type = (text, start, fn) => {
      [...text].forEach((_, i) => later(start + i * 170, () => hero.palette.setQuery(text.slice(0, i + 1), text === '@')));
      later(start + text.length * 170 + 500, fn);
    };
    const play = () => {
      if (running || !visible || touched) return;
      running = true;
      hero.reset(); hero.palette.open('', false);
      later(900, () => type(T.demoQuery, 0, () => {
        hero.palette.choose(0);
        later(1400, () => { hero.palette.open('', false); type('@', 400, () => {
          later(700, () => { hero.palette.setQuery('@' + SITES[1].id); later(900, () => { hero.palette.choose(0); later(1800, () => { clear(); play(); }); }); });
        }); });
      }));
    };
    const stop = () => { touched = true; clear(); };
    hero.host.addEventListener('pointerdown', stop); hero.host.addEventListener('keydown', stop);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (visible) play(); else clear();
      }, { threshold: 0.4 }).observe(hero.host);
    } else { visible = true; play(); }
  }
})();
