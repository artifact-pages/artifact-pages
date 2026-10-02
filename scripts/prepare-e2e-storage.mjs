// Builds the storage root served during `npm run test:e2e`.
//
// The committed fixtures are copied unchanged, and one extra site, `textsearch`,
// is generated with the Go builder's `--fulltext` option so page text search is
// exercised against a real projection. The extra site is not listed in the
// copied sites.json, so the committed registry and every fixture site keep their
// metadata-only behavior; tests that need the site register it by routing
// sites.json. Everything is written under .local/ and stays untracked.
//
// `scripts/run-e2e.mjs` calls this unless STORAGE_ROOT is set. A custom
// STORAGE_ROOT is served as is, so the page text search e2e tests skip
// themselves unless that root was produced by this script, e.g.
//   node scripts/prepare-e2e-storage.mjs && STORAGE_ROOT=./.local/e2e/storage npm run test:e2e
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export const E2E_STORAGE_ROOT = '.local/e2e/storage'
const E2E_SOURCE_ROOT = '.local/e2e/sources'
export const TEXT_SEARCH_SITE_ID = 'textsearch'
export const TEXT_SEARCH_BULK_PAGE_COUNT = 24
/**
 * A later search generation of the same site, served only when a test routes
 * the manifest to it (to republish the site between two result pages). It adds
 * TEXT_SEARCH_NEXT_GENERATION_PAGES, which sort before every bulk note.
 */
export const TEXT_SEARCH_NEXT_GENERATION_MANIFEST = 'manifest-next-generation.json'
export const TEXT_SEARCH_NEXT_GENERATION_PAGES = ['bulk/note-00a.md', 'bulk/note-00b.md']
const LONG_PAGE_FILLER_COUNT = 120

export function prepareE2eStorage({ root = process.cwd(), storageRoot = E2E_STORAGE_ROOT } = {}) {
  const storage = path.resolve(root, storageRoot)
  const sources = path.resolve(root, E2E_SOURCE_ROOT)
  rmSync(storage, { recursive: true, force: true })
  rmSync(sources, { recursive: true, force: true })
  mkdirSync(path.dirname(storage), { recursive: true })
  cpSync(path.resolve(root, 'fixtures/storage'), storage, { recursive: true })

  // Sources: the SRE fixture pages (HTML + Markdown) plus enough similar pages to need paging.
  // The builder does not index sources inside its output root, so they are built from a sibling directory.
  const source = path.join(sources, TEXT_SEARCH_SITE_ID)
  cpSync(path.resolve(root, 'fixtures/storage/_artifacts/sre'), source, { recursive: true })
  mkdirSync(path.join(source, 'bulk'), { recursive: true })
  for (let number = 1; number <= TEXT_SEARCH_BULK_PAGE_COUNT; number += 1) {
    const id = String(number).padStart(2, '0')
    writeFileSync(
      path.join(source, 'bulk', `note-${id}.md`),
      `# Beacon note ${id}\n\nEvery bulk note mentions the lighthouse keyword so a search needs more than one page of results.\n`,
    )
  }

  // Long pages for scroll-to-first-match checks: "midmarker" sits under the
  // "Middle section" heading and "zephyrmarker" at the very end.
  const filler = (from, to) => Array.from({ length: to - from }, (_, index) => `Filler paragraph ${from + index} keeps this page tall.`)
  const half = LONG_PAGE_FILLER_COUNT / 2
  mkdirSync(path.join(source, 'long'), { recursive: true })
  writeFileSync(path.join(source, 'long', 'scroll-target.md'), [
    '# Scroll target notes', '', ...filler(0, half).flatMap((line) => [line, '']),
    '## Middle section', '', 'The midmarker word is here.', '', ...filler(half, LONG_PAGE_FILLER_COUNT).flatMap((line) => [line, '']),
    '## Bottom section', '', 'The zephyrmarker word is at the end.', '',
  ].join('\n'))
  writeFileSync(path.join(source, 'long', 'scroll-target.html'), [
    '<!doctype html><html><head><meta charset="utf-8"><title>Scroll target page</title></head><body>',
    '<h1 id="top-section">Scroll target page</h1>', ...filler(0, half).map((line) => `<p>${line}</p>`),
    '<h2 id="middle-section">Middle section</h2><p>The midmarker word is here.</p>', ...filler(half, LONG_PAGE_FILLER_COUNT).map((line) => `<p>${line}</p>`),
    '<h2 id="bottom-section">Bottom section</h2><p>The zephyrmarker word is at the end.</p>',
    '</body></html>',
  ].join('\n'))

  buildTextSearchIndex(root, source, storage)
  // `index build` writes indexes only; serve the same bytes as the site's artifacts.
  cpSync(source, path.join(storage, '_artifacts', TEXT_SEARCH_SITE_ID), { recursive: true })

  // The next generation: the same sources plus two more "lighthouse" notes,
  // built separately. Its content-addressed search objects are added next to
  // the current ones and its manifest is stored under another name, so the
  // served manifest.json stays the current generation.
  const nextSource = path.join(sources, `${TEXT_SEARCH_SITE_ID}-next-generation`)
  const nextStorage = path.join(sources, `${TEXT_SEARCH_SITE_ID}-next-generation-storage`)
  cpSync(source, nextSource, { recursive: true })
  for (const page of TEXT_SEARCH_NEXT_GENERATION_PAGES) {
    writeFileSync(path.join(nextSource, page), `# Added note ${path.basename(page, '.md')}\n\nThis note was published later and also mentions the lighthouse keyword.\n`)
  }
  buildTextSearchIndex(root, nextSource, nextStorage)
  const searchDirectory = path.join(storage, '_indexes', TEXT_SEARCH_SITE_ID, 'search')
  const nextSearchDirectory = path.join(nextStorage, '_indexes', TEXT_SEARCH_SITE_ID, 'search')
  for (const name of readdirSync(nextSearchDirectory)) {
    if (name.endsWith('.gz') && !existsSync(path.join(searchDirectory, name))) cpSync(path.join(nextSearchDirectory, name), path.join(searchDirectory, name))
  }
  cpSync(path.join(nextSearchDirectory, 'manifest.json'), path.join(searchDirectory, TEXT_SEARCH_NEXT_GENERATION_MANIFEST))
  return storage
}

function buildTextSearchIndex(root, source, storage) {
  const result = spawnSync('go', [
    'run', './cli/cmd/artifact-pages', 'index', 'build',
    '--site', TEXT_SEARCH_SITE_ID,
    '--site-title', 'Text Search',
    '--source', path.relative(root, source),
    '--out', path.relative(root, storage),
    '--repository', 'example/text-search',
    '--repository-url', 'https://github.com/example/text-search',
    '--ref', 'main',
    '--fulltext',
  ], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`index build for ${TEXT_SEARCH_SITE_ID} exited with status ${result.status}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  prepareE2eStorage()
}
