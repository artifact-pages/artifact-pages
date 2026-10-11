// Checks how the reader decides a document's language.
// Run with: npm run test:reader-shell
import assert from 'node:assert/strict'
import test from 'node:test'
import { detectMarkdownLanguage, normalizeLanguageTag } from './document-language.ts'

test('declared language tags are accepted only when they look like BCP 47', () => {
  assert.equal(normalizeLanguageTag('ja'), 'ja')
  assert.equal(normalizeLanguageTag(' en-US '), 'en-US')
  assert.equal(normalizeLanguageTag('zh-Hant-TW'), 'zh-Hant-TW')
  assert.equal(normalizeLanguageTag('en-x-foo'), 'en-x-foo')
  assert.equal(normalizeLanguageTag('de-u-co-phonebk'), 'de-u-co-phonebk')
  for (const invalid of ['', '   ', null, undefined, 'j', 'ja_JP', 'japanese language', '日本語']) {
    assert.equal(normalizeLanguageTag(invalid), undefined, String(invalid))
  }
})

test('Markdown is Japanese only when its prose has kana and is mostly Japanese', () => {
  assert.equal(detectMarkdownLanguage('# 障害対応手順\n\nこのページでは、障害発生時の初動をまとめます。'), 'ja')
  assert.equal(detectMarkdownLanguage('# Recovery runbook\n\nRestart the service and check the dashboard.'), undefined)
  // Han characters alone could be Chinese.
  assert.equal(detectMarkdownLanguage('# 服务恢复\n\n重启服务并检查仪表板。'), undefined)
  // One Japanese word in English prose does not change the language.
  assert.equal(detectMarkdownLanguage('# Release notes\n\nWe added a です label to the status page and fixed several unrelated bugs in the exporter.'), undefined)
  assert.equal(detectMarkdownLanguage(''), undefined)
})

test('Markdown language detection ignores code', () => {
  const english = '# Usage\n\nRun the command below.\n\n```\nこんにちは世界こんにちは世界こんにちは世界こんにちは世界\n```\n\nUse `ひらがなひらがな` sparingly.\n'
  assert.equal(detectMarkdownLanguage(english), undefined)
})

test('Markdown language detection ignores multi-line, unclosed and tilde fences', () => {
  const jp = Array.from({ length: 30 }, () => 'これは日本語のコードブロックの行です。').join('\n')
  const english = 'Run the command below to restart the service.\n\n'
  assert.equal(detectMarkdownLanguage(`${english}\`\`\`text\n${jp}\n\`\`\`\n\nDone.\n`), undefined)
  assert.equal(detectMarkdownLanguage(`${english}\`\`\`text\n${jp}\n`), undefined)
  assert.equal(detectMarkdownLanguage(`${english}~~~\n${jp}\n~~~\n`), undefined)
  // A shorter closing fence does not end the block; prose after a proper close counts again.
  assert.equal(detectMarkdownLanguage(`\`\`\`\`\n${jp}\n\`\`\`\n${jp}\n\`\`\`\`\n${english}`), undefined)
  assert.equal(detectMarkdownLanguage(`\`\`\`\ncode\n\`\`\`\n${jp}\n`), 'ja')
})
