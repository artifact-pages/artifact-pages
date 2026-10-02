// Checks that page text highlighting normalizes text like the full-text core.
// Run with: npm run test:text-highlight
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalize } from '../web/src/domain/fulltext-codec.ts'
import { normalizeWithOffsets, searchTerms } from '../web/src/domain/text-highlight.ts'

// Returns the source substrings the highlight would cover for each term.
function highlighted(text, query) {
  const { normalized, starts, ends } = normalizeWithOffsets(text)
  const matches = []
  for (const term of searchTerms(query)) {
    for (let at = normalized.indexOf(term); at !== -1; at = normalized.indexOf(term, at + term.length)) {
      matches.push(text.slice(starts[at], ends[at + term.length - 1]))
    }
  }
  return matches
}

function coreMatches(text, query) {
  const terms = normalize(query).split(' ').filter(Boolean)
  return terms.length > 0 && terms.every((term) => normalize(text).includes(term))
}

const cases = [
  { name: 'half-width katakana with separate dakuten', text: '読むｶﾞｲﾄﾞです', query: 'ガイド', expected: ['ｶﾞｲﾄﾞ'] },
  { name: 'half-width query against full-width text', text: 'ガイド', query: 'ｶﾞｲﾄﾞ', expected: ['ガイド'] },
  { name: 'NFD text, NFC query', text: 'un café noir', query: 'café', expected: ['café'] },
  { name: 'NFC text, NFD query', text: 'un café', query: 'café', expected: ['café'] },
  { name: 'Hangul conjoining jamo', text: '각 x', query: '각', expected: ['각'] },
  { name: 'Hangul LV syllable plus trailing jamo', text: '각', query: '각', expected: ['각'] },
  { name: 'final sigma, uppercase query', text: 'η ΟΔΟΣ μας', query: 'ΟΔΟΣ', expected: ['ΟΔΟΣ'] },
  { name: 'final sigma, lowercase query', text: 'η ΟΔΟΣ μας', query: 'οδος', expected: ['ΟΔΟΣ'] },
  { name: 'non-final sigma inside a word', text: 'ΣΟΦΙΑ', query: 'σοφια', expected: ['ΣΟΦΙΑ'] },
  { name: 'surrogate pairs', text: 'a 𐐀𐐁 b', query: '𐐨𐐩', expected: ['𐐀𐐁'] },
  { name: 'emoji between words', text: 'x😀cache', query: 'cache', expected: ['cache'] },
  { name: 'full-width ASCII', text: 'ＣＡＣＨＥ hit', query: 'cache', expected: ['ＣＡＣＨＥ'] },
  { name: 'dotted capital I', text: 'İstanbul', query: 'i̇stanbul', expected: ['İstanbul'] },
  { name: 'ligature', text: 'oﬃce', query: 'office', expected: ['oﬃce'] },
  { name: 'ligature partially matched extends to the cluster', text: 'oﬃce', query: 'fi', expected: ['ﬃ'] },
  { name: 'circled digits and compatibility forms', text: '① ㎏', query: '1 kg', expected: ['①', '㎏'] },
]

for (const { name, text, query, expected } of cases) {
  test(name, () => {
    assert.equal(coreMatches(text, query), true, 'the core matches this text')
    const { normalized } = normalizeWithOffsets(text)
    assert.equal(normalized, text.normalize('NFKC').toLowerCase(), 'highlight normalization equals the core before whitespace folding')
    assert.deepEqual(highlighted(text, query), expected)
  })
}

test('a term the core would not match is not highlighted', () => {
  // The core lowercases ΟΔΟΣ to "οδος" with a final sigma; a medial sigma query does not match it.
  assert.equal(coreMatches('ΟΔΟΣ', 'οδοσ'), false)
  assert.deepEqual(highlighted('ΟΔΟΣ', 'οδοσ'), [])
})
