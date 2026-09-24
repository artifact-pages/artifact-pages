export type FuzzyMatch = {
  score: number
  positions: number[]
}

export type FuzzyQuery = {
  terms: Array<{ normalized: string; characters: string[] }>
}

export type FuzzyText = {
  words: Word[]
}

type Word = {
  normalized: string
  sourceStart: number
  hasAstralCharacter: boolean
}

export function fuzzyMatch(text: string, query: string): FuzzyMatch | undefined {
  return fuzzyMatchPrepared(text, prepareFuzzyQuery(query))
}

export function prepareFuzzyQuery(query: string): FuzzyQuery {
  const terms = query.toLocaleLowerCase().split(/[\s/-]+/u).filter(Boolean)
  return {
    terms: terms.map((normalized) => ({ normalized, characters: Array.from(normalized) })),
  }
}

export function fuzzyMatchPrepared(text: string, query: FuzzyQuery): FuzzyMatch | undefined {
  return fuzzyMatchPreparedText(prepareFuzzyText(text), query)
}

export function prepareFuzzyText(text: string): FuzzyText {
  return { words: splitWords(text) }
}

export function fuzzyMatchPreparedText(text: FuzzyText, query: FuzzyQuery): FuzzyMatch | undefined {
  if (query.terms.length === 0) return undefined
  const positions = new Set<number>()
  let score = 0

  for (const term of query.terms) {
    let bestWord: Word | undefined
    let bestScore = Number.NEGATIVE_INFINITY
    for (const word of text.words) {
      const candidateScore = scoreWord(word, term)
      if (candidateScore !== undefined && candidateScore > bestScore) {
        bestWord = word
        bestScore = candidateScore
      }
    }
    if (!bestWord) return undefined

    matchedPositions(bestWord, term).forEach((position) => positions.add(bestWord.sourceStart + position))
    score += bestScore
  }

  return { score, positions: [...positions].sort((left, right) => left - right) }
}

function splitWords(text: string): Word[] {
  const sourceCharacters = Array.from(text)
  const words: Word[] = []
  let start = 0

  for (let index = 0; index <= sourceCharacters.length; index += 1) {
    if (index < sourceCharacters.length && !/[\s/-]/u.test(sourceCharacters[index])) continue
    if (index > start) {
      const normalizedWord = sourceCharacters.slice(start, index).join('').toLocaleLowerCase()
      words.push({
        normalized: normalizedWord,
        sourceStart: start,
        hasAstralCharacter: /[\u{10000}-\u{10FFFF}]/u.test(normalizedWord),
      })
    }
    start = index + 1
  }

  return words
}

function scoreWord(
  word: Word,
  term: { normalized: string; characters: string[] },
): number | undefined {
  const firstPosition = word.normalized.indexOf(term.characters[0])
  if (firstPosition < 0) return undefined

  let previousPosition = firstPosition
  let consecutivePairs = 0
  for (let index = 1; index < term.characters.length; index += 1) {
    const position = word.normalized.indexOf(
      term.characters[index],
      previousPosition + term.characters[index - 1].length,
    )
    if (position < 0) return undefined
    if (position === previousPosition + term.characters[index - 1].length) consecutivePairs += 1
    previousPosition = position
  }

  const startsWithTerm = word.normalized.startsWith(term.normalized)
  const baseScore = startsWithTerm
    ? word.normalized === term.normalized ? 100 : 80
    : 50

  const lastPosition = word.hasAstralCharacter
    ? Array.from(word.normalized.slice(0, previousPosition)).length
    : previousPosition
  return baseScore + consecutivePairs * 3 - lastPosition * 0.15
}

function matchedPositions(word: Word, term: { characters: string[] }): number[] {
  const positions: number[] = []
  let cursor = 0
  for (const character of term.characters) {
    const position = word.normalized.indexOf(character, cursor)
    positions.push(word.hasAstralCharacter
      ? Array.from(word.normalized.slice(0, position)).length
      : position)
    cursor = position + character.length
  }
  return positions
}
