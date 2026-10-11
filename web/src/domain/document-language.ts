/**
 * Where a document's language comes from (the reader never guesses for HTML):
 *
 * - HTML artifacts: the `lang` of the artifact's own `<html>`, read through the
 *   same-origin frame. A document without a valid declaration has none.
 * - Markdown artifacts: no declaration exists, so Japanese is recognized from the
 *   text itself (kana outside code). Other languages are left undeclared.
 *
 * The result is exposed as `lang` on the artifact region only. The shell chrome
 * stays English and keeps the `<html lang="en">` of the application document.
 */

/** A BCP 47-shaped tag (for example `ja`, `en-US`, `zh-Hant-TW`); anything else is ignored. */
export function normalizeLanguageTag(value: string | null | undefined): string | undefined {
  const tag = value?.trim()
  if (!tag || tag.length > 35) return undefined
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(tag)) return undefined
  return tag
}

const KANA = /[ぁ-ゖァ-ヺーｦ-ﾟ]/gu
const JAPANESE_LETTER = /[ぁ-ゖァ-ヺーｦ-ﾟ㐀-䶿一-鿿]/gu
const LETTER = /\p{L}/gu

/**
 * `ja` when the prose of a Markdown document is mostly Japanese: it contains kana
 * (Han characters alone are ambiguous with Chinese) and Japanese characters are at
 * least a third of its letters. Fenced code and inline code are ignored.
 */
export function detectMarkdownLanguage(source: string): string | undefined {
  const prose = withoutCode(source)
  const letters = prose.match(LETTER)?.length ?? 0
  if (letters === 0) return undefined
  const kana = prose.match(KANA)?.length ?? 0
  if (kana === 0) return undefined
  const japanese = prose.match(JAPANESE_LETTER)?.length ?? 0
  return japanese / letters >= 1 / 3 ? 'ja' : undefined
}

/** Drops fenced code blocks (``` or ~~~, closed or running to the end of the text) and inline code. */
function withoutCode(source: string) {
  const kept: string[] = []
  let fence: { char: string, length: number } | null = null
  for (const line of source.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = null
      continue
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length }
      continue
    }
    kept.push(line)
  }
  return kept.join('\n').replace(/`[^`\n]*`/g, '')
}
