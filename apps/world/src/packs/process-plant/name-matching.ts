// Word matching for near-miss names: suggestions help the model correct a
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

/** Words of a tag, path or label: "sgA.feedwaterFlowKgPerS" → sg, a, feedwater, flow, kg, per, s. */
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

// A guessed word matches a signal word when it is the same, a prefix of it, or
// an abbreviation of it with the same first letter ("fw" for "feedwater", and
// a tag's "lvl" for a guessed "level").
const wordMatches = (guess: string, word: string): boolean => {
  if (guess === word) return true
  if (guess.length < 2 || word.length < 2 || guess[0] !== word[0]) return false
  return word.startsWith(guess) || isSubsequence(guess, word) || isSubsequence(word, guess)
}

/** Guessed words matched one-to-one to signal words (augmenting paths), so "fw" and "flow" cannot both claim "flow". */
export const matchedWords = (guessed: ReadonlyArray<string>, signalWords: ReadonlyArray<string>): ReadonlyArray<string> => {
  const owner = new Map<number, number>()
  const assign = (guess: number, visited: Set<number>): boolean => signalWords.some((word, index) => {
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

export const letters = (list: ReadonlyArray<string>): number => list.reduce((sum, word) => sum + word.length, 0)
