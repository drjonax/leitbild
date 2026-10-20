// ============================================================================
// Answer consistency — does an answer contradict the display it presents?
//
// The operator reads the answer and its display together. This live check
// holds an answer back only where it is plainly wrong against its display: a
// value written with an item the display shows, in that item's unit, that
// the display reads for none of its items — where the item shows only its
// current value (no trend), or where the answer says the value is current.
//
// Everything softer is measured offline, by the grounding metrics in
// scripts/display-eval/grounding.ts: values the display does not show at
// all, precision, watch items, time spans, first-outs, the display's lead,
// directions, limit wording and times to a limit. As blocking corrections
// they cost a full model turn on about half of display answers and made
// answers repeat boilerplate (skill-auditor B7, register A6).
//
// evaluation.ts turns contradictions into one bounded correction turn.
// ============================================================================

import type { EmbeddedViewContent } from '@leitbild/contracts'
import {
  CURRENT,
  NOT_SHOWN,
  derivedPercent,
  inUnit,
  itemQuantities,
  itemsNamed,
  names,
  quantitiesIn,
  reads,
  sentencesOf,
  shownItems,
  stripMarkdown,
  type Item,
} from './answer-reading.ts'

// A value given as a change ("rose by 5 %", "from 50 %") is not a reading.
const CHANGE = /\b(?:by|from)\s+(?:about\s+|approximately\s+|roughly\s+|around\s+|nearly\s+|some\s+)?[~≈]?\s*$/i
// Where the words a value is written with end: a clause mark or another value.
const SEGMENT = /[,;:()—–]/

/** The words a cited value is written with: back to the clause mark or value before it, on to the one after it. */
const wordsAround = (sentence: string, cited: { readonly index: number; readonly text: string }, others: ReadonlyArray<{ readonly index: number; readonly text: string }>): string => {
  const previous = others.filter(other => other.index < cited.index).at(-1)
  const next = others.find(other => other.index > cited.index)
  const before = sentence.slice(previous === undefined ? 0 : previous.index + previous.text.length, cited.index).split(SEGMENT).at(-1)!
  const after = sentence.slice(cited.index + cited.text.length, next?.index ?? sentence.length).split(SEGMENT)[0]!
  return `${before} ${after}`
}

const readsNow = (items: ReadonlyArray<Item>, unit: string): string =>
  items.flatMap(item => item.values.flatMap(value => inUnit(value, unit) === undefined ? [] : [`${item.names[0]!} ${Number(value.value.toPrecision(3))} ${value.unit}`])).join(', ')

/** A cited value its display contradicts: where it stands in the answer, and what to fix. */
export interface Contradiction {
  readonly sentence: string
  readonly index: number
  readonly issue: string
}

/**
 * Values an answer cites that its display contradicts. A value is checked
 * against the items its own words name; one shown by any item of the display,
 * one its words tie to no item, one given as a change, and anything the
 * answer marks "not shown" are left alone. A trended item may be cited with an
 * earlier value, unless the answer says that value is current.
 */
export const contradictionsOf = (answer: string, view: EmbeddedViewContent): ReadonlyArray<Contradiction> => {
  const items = shownItems(view)
  return sentencesOf(stripMarkdown(answer)).flatMap(sentence => {
    if (NOT_SHOWN.test(sentence)) return []
    const cited = quantitiesIn(sentence)
    return cited.flatMap(quantity => {
      const before = sentence.slice(0, quantity.index)
      if ((quantity.unit === '%' && derivedPercent(sentence, quantity.index)) || CHANGE.test(before)) return []
      if (items.some(item => itemQuantities(item).some(shown => reads(quantity, shown)))) return []
      const reading = items.filter(item => item.values.some(value => inUnit(value, quantity.unit) !== undefined))
      const named = itemsNamed(wordsAround(sentence, quantity, cited), reading)
      if (named.length === 0) return []
      const at = { sentence, index: quantity.index }
      if (CURRENT.test(before)) return [{ ...at, issue: `It cites ${quantity.text} as current, but the display reads ${readsNow(named, quantity.unit)} now.` }]
      return named.every(item => !item.history)
        ? [{ ...at, issue: `It cites ${quantity.text} for ${names(named)}, but the display reads ${readsNow(named, quantity.unit)}.` }]
        : []
    })
  })
}

/** What to fix in an answer its display contradicts, once each; none where it agrees. */
export const answerContradictions = (answer: string, view: EmbeddedViewContent): ReadonlyArray<string> =>
  [...new Set(contradictionsOf(answer, view).map(contradiction => contradiction.issue))]
