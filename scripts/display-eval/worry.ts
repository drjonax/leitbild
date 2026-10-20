/** The worry verdict (plan v3.1 Appendix F, G1: four "worry" scenarios × k=3,
 * at least 11 of 12 runs pass). An answer passes when it names what its
 * pre-registered claim keys require (the worst pack's top alert) and calls no
 * healthy pack abnormal (its absence keys). The keys are rules, not a
 * calibrated judge: every verdict lists the clauses it rests on, so each one
 * is hand-checked before it is reported. */
import { clausesOf } from './operation-checks.ts'
import type { EvidenceKey } from './scenarios.ts'

// A clause that denies, conditions or looks ahead asserts nothing about the present state (English and Norwegian).
const NOT_AFFIRMED = /\b(?:not|no|none|never|nothing|neither|nor|without|if|would|could|might|may|unless|risks?|ikke|ingen|intet|uten|hvis|dersom|kan|kunne|ville)\b|n't\b/iu

export interface WorryKeyResult {
  readonly key: string
  readonly kind: 'claim' | 'absence'
  readonly hit: boolean
  /** A claim: where it matched. An absence: the affirmative clauses that break it. */
  readonly clauses: ReadonlyArray<string>
}

export interface WorryVerdict { readonly keys: ReadonlyArray<WorryKeyResult>; readonly pass: boolean }

/**
 * Scores an answer against a worry scenario's keys. A claim holds when one
 * clause, read with the next (a bullet's label and its text), matches every
 * pattern; an absence holds when no affirmative clause matches them all.
 * Keys without patterns are not this verdict's.
 */
export const worryVerdict = (evidence: ReadonlyArray<EvidenceKey>, content: string): WorryVerdict => {
  const clauses = clausesOf(content)
  const keys = evidence.flatMap((key): ReadonlyArray<WorryKeyResult> => {
    if (key.patterns === undefined || key.kind === 'signal') return []
    const patterns = key.patterns.map(source => new RegExp(source, 'iu'))
    if (key.kind === 'claim') {
      const at = clauses.findIndex((clause, index) => patterns.every(pattern => pattern.test(`${clause} ${clauses[index + 1] ?? ''}`)))
      return [{ key: key.key, kind: 'claim', hit: at >= 0, clauses: at < 0 ? [] : clauses.slice(at, at + 2) }]
    }
    const breaking = clauses.filter(clause => !NOT_AFFIRMED.test(clause) && patterns.every(pattern => pattern.test(clause)))
    return [{ key: key.key, kind: 'absence', hit: breaking.length === 0, clauses: breaking }]
  })
  return { keys, pass: keys.length > 0 && keys.every(result => result.hit) }
}
