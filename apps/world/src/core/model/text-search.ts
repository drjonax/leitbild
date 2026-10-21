/** Small literal matcher shared by discoverable World catalogs. It deliberately
 * adds no synonyms or domain meaning: every query term must occur in the
 * advertised text, while punctuation and case do not matter. */
export const literalSearchTerms = (value: string): ReadonlyArray<string> =>
  [...new Set(value.normalize('NFKD').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]

export const matchesLiteralSearch = (
  query: string | undefined,
  fields: ReadonlyArray<string | undefined>,
): boolean => {
  if (query === undefined || query.trim() === '') return true
  const haystack = fields.filter((field): field is string => field !== undefined)
    .join(' ')
    .normalize('NFKD')
    .toLocaleLowerCase()
  return literalSearchTerms(query).every(term => haystack.includes(term))
}

// Word matching for near-miss names: suggestions help a caller correct a
// guess; they never select anything themselves.

export const normalized = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '')

export const editDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0]!
    previous[0] = i
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j]!
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return previous[right.length]!
}

/** How many near misses a rejection offers. */
export const SUGGESTION_COUNT = 3

/** Words of an id, tag, path or label: "sgA.feedwaterFlowKgPerS" → sg, a, feedwater, flow, kg, per, s. */
export const words = (value: string): ReadonlyArray<string> => value
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter(word => word.length > 0)

const isSubsequence = (short: string, long: string): boolean => {
  let index = 0
  for (const letter of long) if (letter === short[index]) index += 1
  return index === short.length
}

// The plant's display names (displays/compose.ts, mimic scope, equipment
// items): a guessed word matches a name's word when it is the same, a prefix
// of it, or an abbreviation of it either way with the same first letter
// ("fw" for "feedwater", and a tag's "lvl" for a guessed "level").
const wordMatches = (guess: string, word: string): boolean => {
  if (guess === word) return true
  if (guess.length < 2 || word.length < 2 || guess[0] !== word[0]) return false
  return word.startsWith(guess) || isSubsequence(guess, word) || isSubsequence(word, guess)
}

/** Guessed words matched one-to-one to a name's words (augmenting paths), so "fw" and "flow" cannot both claim "flow". */
export const matchedWords = (guessed: ReadonlyArray<string>, nameWords: ReadonlyArray<string>): ReadonlyArray<string> => {
  const owner = new Map<number, number>()
  const assign = (guess: number, visited: Set<number>): boolean => nameWords.some((word, index) => {
    if (visited.has(index) || !wordMatches(guessed[guess]!, word)) return false
    visited.add(index)
    const current = owner.get(index)
    if (current !== undefined && !assign(current, visited)) return false
    owner.set(index, guess)
    return true
  })
  guessed.forEach((_, guess) => { assign(guess, new Set()) })
  return [...owner.values()].map(guess => guessed[guess]!)
}

/** A name's word as search indexes it: its spellings, and whether it may abbreviate a guess (a tag's "lvl" for "level"). */
export interface IndexedWord {
  readonly spellings: ReadonlyArray<string>
  readonly abbreviates: boolean
}

/**
 * How well a guessed word matches a name's word: 3 the same (a plural "s" or
 * "es" aside), 2 a prefix of it, 1 an abbreviation of it with the same first
 * letter ("fw" for "feedwater"), 0 not at all. A name's word abbreviates a
 * guess only where the name allows it (a tag), so a short label word never
 * stands in for a long query word ("soa" is no abbreviation of "skogssater").
 */
// A tag's word stands for a guessed word when it begins it ("press" for
// "pressure", "pos" for "position") or keeps at least half its letters in
// order ("lvl" for "level"); "sg" is no abbreviation of "skagerrak".
const abbreviation = (short: string, long: string): boolean =>
  (short.length >= 3 && long.startsWith(short)) || (short.length * 2 >= long.length && isSubsequence(short, long))

export const wordMatch = (guess: string, word: IndexedWord): number => {
  const plural = guess.length > 3 && guess.endsWith('s')
  let best = 0
  for (const spelling of word.spellings) {
    if (guess === spelling || (plural && (guess.slice(0, -1) === spelling || (guess.endsWith('es') && guess.slice(0, -2) === spelling)))) return 3
    if (guess.length < 2 || spelling.length < 2 || guess[0] !== spelling[0]) continue
    if (spelling.startsWith(guess)) best = 2
    else if (best === 0 && (isSubsequence(guess, spelling) || (word.abbreviates && abbreviation(spelling, guess)))) best = 1
  }
  return best
}

/**
 * Guessed words matched one-to-one to a name's words, the best matches first
 * (augmenting paths over exact, then prefix, then abbreviation matches): for
 * each guess, the word it claimed and how well, or null.
 */
export const assignWords = (guessed: ReadonlyArray<string>, nameWords: ReadonlyArray<IndexedWord>): ReadonlyArray<{ readonly word: number; readonly quality: number } | null> => {
  const quality = guessed.map(guess => nameWords.map(word => wordMatch(guess, word)))
  const owner = new Map<number, number>()
  for (const floor of [3, 2, 1]) {
    const assign = (guess: number, visited: Set<number>): boolean => nameWords.some((_, index) => {
      if (visited.has(index) || quality[guess]![index]! < floor) return false
      visited.add(index)
      const current = owner.get(index)
      if (current !== undefined && !assign(current, visited)) return false
      owner.set(index, guess)
      return true
    })
    guessed.forEach((_, guess) => { if (![...owner.values()].includes(guess)) assign(guess, new Set()) })
  }
  const claimed = new Map([...owner].map(([word, guess]) => [guess, word]))
  return guessed.map((_, guess) => claimed.has(guess) ? { word: claimed.get(guess)!, quality: quality[guess]![claimed.get(guess)!]! } : null)
}

export const letters = (list: ReadonlyArray<string>): number => list.reduce((sum, word) => sum + word.length, 0)
