/**
 * Folds names for search (architecture A4): NFKD without marks, lower case,
 * æ → ae, ø → o, ß → ss. NFKD alone folds neither ø nor æ. An indexed word
 * also keeps the spellings ø → oe and å → aa, so "Kjølberg", "Kjolberg" and
 * "Kjoelberg" all find it.
 */
const folded = (text: string, o: string, a: string): string => text.toLowerCase()
  .replace(/ø/g, o).replace(/å/g, a).replace(/æ/g, 'ae').replace(/ß/g, 'ss')
  .normalize('NFKD').replace(/\p{M}/gu, '')

const split = (text: string): ReadonlyArray<string> => text.split(/[^a-z0-9]+/).filter(word => word.length > 0)
// camelCase boundaries survive folding: "sgA.feedwaterFlow" → sg a feedwater flow.
const spaced = (text: string): string => text.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')

/** One text as a query reads it. */
export const fold = (text: string): string => folded(text, 'o', 'a')

/** A query's words. */
export const queryWords = (text: string): ReadonlyArray<string> => split(fold(spaced(text)))

/** An indexed text's words, each with every spelling it answers to. */
export const indexWords = (text: string): ReadonlyArray<ReadonlyArray<string>> => {
  const variants = [['o', 'a'], ['oe', 'a'], ['o', 'aa'], ['oe', 'aa']].map(([o, a]) => split(folded(spaced(text), o!, a!)))
  // Folding never adds or removes word boundaries, so variants align word by word.
  return variants[0]!.map((_, index) => [...new Set(variants.map(words => words[index]!))])
}
