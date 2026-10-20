/** The worry verdict (plan v3.1 Appendix F, G1: four "worry" scenarios × k=3,
 * at least 11 of 12 runs pass). An answer passes when it names what its
 * pre-registered claim keys require (the worst pack's top alert) and calls no
 * healthy pack abnormal (its absence keys). The keys are rules, not a
 * calibrated judge: every verdict lists the clauses it rests on, so each one
 * is hand-checked before it is reported. */
import { clausesOf } from './operation-checks.ts'
import type { EvidenceKey } from './scenarios.ts'

// A clause that denies, conditions or looks ahead asserts nothing about the present state (English and Norwegian).
const NOT_AFFIRMED = /\b(?:not|no|none|zero|never|nothing|neither|nor|without|if|would|could|might|may|unless|risks?|ikke|ingen|intet|uten|hvis|dersom|kan|kunne|ville)\b|n't\b/iu

export interface WorryKeyResult {
  readonly key: string
  readonly kind: 'claim' | 'absence'
  readonly hit: boolean
  /** A claim: where it matched. An absence: the affirmative clauses that break it. */
  readonly clauses: ReadonlyArray<string>
}

export interface WorryVerdict { readonly keys: ReadonlyArray<WorryKeyResult>; readonly pass: boolean }

// Where a claim's patterns first match: the clause whose window (it and the next) matches every pattern, and the
// offset of the first pattern's match in that window; null when no window does.
const firstMatch = (clauses: ReadonlyArray<string>, patterns: ReadonlyArray<RegExp>): readonly [number, number] | null => {
  for (const [index, clause] of clauses.entries()) {
    const window = `${clause} ${clauses[index + 1] ?? ''}`
    if (patterns.every(pattern => pattern.test(window))) return [index, window.search(patterns[0]!)]
  }
  return null
}
const before = (left: readonly [number, number], right: readonly [number, number]): boolean => left[0] < right[0] || (left[0] === right[0] && left[1] < right[1])

/**
 * Scores an answer against a worry scenario's keys. A claim holds when one
 * clause, read with the next (a bullet's label and its text), matches every
 * pattern, and, with a ranking rule (`then`), when it comes before anything
 * the `then` patterns name; an absence holds when no affirmative clause
 * matches all its patterns. Keys without patterns are not this verdict's.
 */
export const worryVerdict = (evidence: ReadonlyArray<EvidenceKey>, content: string): WorryVerdict => {
  const clauses = clausesOf(content)
  const keys = evidence.flatMap((key): ReadonlyArray<WorryKeyResult> => {
    if (key.patterns === undefined || key.kind === 'signal') return []
    const patterns = key.patterns.map(source => new RegExp(source, 'iu'))
    if (key.kind === 'claim') {
      const at = firstMatch(clauses, patterns)
      const later = key.then === undefined ? null : firstMatch(clauses, key.then.map(source => new RegExp(source, 'iu')))
      const ranked = at !== null && (later === null || before(at, later))
      return [{ key: key.key, kind: 'claim', hit: ranked, clauses: at === null ? [] : clauses.slice(at[0], at[0] + 2) }]
    }
    const breaking = clauses.filter(clause => !NOT_AFFIRMED.test(clause) && patterns.every(pattern => pattern.test(clause)))
    return [{ key: key.key, kind: 'absence', hit: breaking.length === 0, clauses: breaking }]
  })
  return { keys, pass: keys.length > 0 && keys.every(result => result.hit) }
}
