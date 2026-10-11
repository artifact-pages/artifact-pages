// Realistic content mirroring https://artifact-pages.dev (guide + architecture) for the
// 2026-10 reader UX concept stories. Dates and committers are illustrative.

export type ConceptPage = {
  path: string
  title: string
  updated: string
  by: string
  h2: string[]
  /** Not on the live site; added to show deeper folders. */
  illustrative?: boolean
}

function page(path: string, title: string, updated: string, by: string, h2: string[], illustrative = false): ConceptPage {
  return { path, title, updated, by, h2, illustrative }
}

export const guideEn: ConceptPage[] = [
  page('en/what-is-git-artifact-pages.html', 'What is Git Artifact Pages', 'Oct 6', 'tasuku43', ['Why it exists', 'How it works', 'What it is not']),
  page('en/getting-started.html', 'Getting started', 'Oct 9', 'tasuku43', ['Before you begin', 'Start with Cloudflare', 'Start with AWS', 'Verify the first publish']),
  page('en/configuration.html', 'Configuration', 'Oct 9', 'tasuku43', ['The registry file', 'Sites and folders', 'Cloudflare R2 settings', 'Environments']),
  page('en/publishing.html', 'Publishing', 'Oct 8', 'claude-bot', ['Publish on push', 'Publish-on rules', 'Previews for pull requests', 'Rolling back']),
  page('en/previews.html', 'Previews', 'Oct 7', 'tasuku43', ['Preview URLs', 'Retention', 'Who can open a preview']),
  page('en/reading.html', 'Reading', 'Oct 10', 'tasuku43', ['Navigation', 'Page text search', 'Command palette', 'Folder URLs']),
  page('en/versions.html', 'Versions', 'Oct 6', 'claude-bot', ['Pinning a version', 'Upgrading', 'Compatibility']),
]

export const guideJa: ConceptPage[] = [
  page('ja/what-is-git-artifact-pages.html', 'Git Artifact Pages とは', 'Oct 6', 'tasuku43', ['なぜ必要か', '仕組み', 'できないこと']),
  page('ja/getting-started.html', 'はじめに', 'Oct 9', 'tasuku43', ['始める前に', 'Cloudflare で始める', 'AWS で始める', '最初の公開を確認する']),
  page('ja/configuration.html', '設定', 'Oct 9', 'tasuku43', ['レジストリファイル', 'サイトとフォルダー', 'Cloudflare R2 の設定', '環境']),
  page('ja/publishing.html', '公開', 'Oct 8', 'claude-bot', ['push で公開する', 'publish-on の条件', 'ロールバック']),
  page('ja/previews.html', 'プレビュー', 'Oct 7', 'tasuku43', ['プレビュー URL', '保持期間', '閲覧できる人']),
  page('ja/reading.html', '閲覧', 'Oct 10', 'tasuku43', ['ナビゲーション', 'ページ本文の検索', 'コマンドパレット', 'フォルダー URL']),
  page('ja/versions.html', 'バージョン', 'Oct 6', 'claude-bot', ['バージョンの固定', 'アップグレード', '互換性']),
]

/** Not on the live site: used only to show a deep folder and a one-page folder. */
export const guideReference: ConceptPage[] = [
  page('en/reference/cli/publish.html', 'publish command', 'Oct 10', 'tasuku43', ['Synopsis', 'Flags', 'Exit codes'], true),
  page('en/reference/cli/registry.html', 'registry command', 'Oct 10', 'tasuku43', ['Synopsis', 'Flags'], true),
  page('en/reference/cli/index-build.html', 'index command', 'Oct 9', 'claude-bot', ['Synopsis', 'Output files'], true),
  page('en/reference/config/schema.html', 'Configuration schema', 'Oct 8', 'tasuku43', ['Top-level keys', 'Site keys', 'Examples'], true),
]

export const architecturePages: ConceptPage[] = [
  page('01-overview.html', '01 Overview', 'Oct 5', 'tasuku43', ['Goals', 'Components', 'Data flow']),
  page('02-storage-layout.html', '02 Storage layout', 'Oct 9', 'tasuku43', ['Object map', 'Immutable artifacts', 'Index files']),
  page('03-publish-pipeline.html', '03 Publish pipeline', 'Oct 8', 'tasuku43', ['Stages', 'Atomic switch', 'Failure modes']),
  page('04-indexes-and-search.html', '04 Indexes and search', 'Oct 10', 'claude-bot', ['Site index', 'Page text search', 'Limits']),
  page('05-delivery.html', '05 Delivery', 'Oct 7', 'tasuku43', ['Edge delivery', 'Caching', 'Headers']),
  page('06-trust-model.html', '06 Trust model', 'Oct 5', 'tasuku43', ['Who can publish', 'Artifact isolation', 'What the reader trusts']),
]

export type SiteInfo = {
  id: string
  title: string
  description: string
  pages: ConceptPage[]
  updated: string
  /** Top-level folder counts, derivable from paths today. */
  folderCounts: Array<[string, number]>
}

function folderCounts(pages: ConceptPage[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const p of pages) {
    const top = p.path.includes('/') ? p.path.split('/')[0] : ''
    if (!top) continue
    counts.set(top, (counts.get(top) ?? 0) + 1)
  }
  return [...counts.entries()]
}

export const guideSite: SiteInfo = {
  id: 'guide',
  title: 'Guide',
  description: 'How to publish, preview and read artifacts with Git Artifact Pages.',
  pages: [...guideEn, ...guideJa],
  updated: 'Oct 10',
  folderCounts: folderCounts([...guideEn, ...guideJa]),
}

export const architectureSite: SiteInfo = {
  id: 'architecture',
  title: 'Architecture',
  description: 'How storage, the publish pipeline, indexes and delivery fit together.',
  pages: [...architecturePages.map((p) => ({ ...p, path: `en/${p.path}` })), ...architecturePages.map((p) => ({ ...p, path: `ja/${p.path}` }))],
  updated: 'Oct 10',
  folderCounts: [['en', 6], ['ja', 6]],
}

// ---- folder tree helper -------------------------------------------------

export type DirNode = {
  name: string
  path: string
  dirs: DirNode[]
  pages: ConceptPage[]
}

export function buildTree(pages: ConceptPage[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], pages: [] }
  for (const p of pages) {
    const segments = p.path.split('/')
    let node = root
    for (let i = 0; i < segments.length - 1; i++) {
      const path = segments.slice(0, i + 1).join('/')
      let next = node.dirs.find((d) => d.path === path)
      if (!next) {
        next = { name: segments[i], path, dirs: [], pages: [] }
        node.dirs.push(next)
      }
      node = next
    }
    node.pages.push(p)
  }
  return root
}

export function findDir(root: DirNode, path: string): DirNode {
  let node = root
  for (const segment of path.split('/').filter(Boolean)) {
    const next = node.dirs.find((d) => d.name === segment)
    if (!next) throw new Error(`no dir ${path}`)
    node = next
  }
  return node
}

export function countPages(node: DirNode): number {
  return node.pages.length + node.dirs.reduce((sum, d) => sum + countPages(d), 0)
}

export function latestUpdate(node: DirNode): string {
  const order = (d: string) => Number(d.replace(/\D/g, ''))
  const all: string[] = [...node.pages.map((p) => p.updated), ...node.dirs.map(latestUpdate)]
  return all.sort((a, b) => order(b) - order(a))[0]
}

export function sortByTitle<T extends { title: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.title.localeCompare(b.title, 'en'))
}

export function pageFileName(p: ConceptPage): string {
  return p.path.split('/').pop() ?? p.path
}
