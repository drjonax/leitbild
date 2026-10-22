// ============================================================================
// Citations — does a number an answer cites match the card line it cites?
//
// World returns a card with every display it composes: lines of key, label and
// reading, each with the numbers its reading shows at their typed precision
// and the limits declared for it. The answer cites a line by its key (⟦k3⟧).
// This is guard v3 (T10 round 3, R41) with pack-neutral naming (P2 E0): only
// the card's own labels and language words name a part, never a pack's words.
//
// A number answers to the nearer key group before or after it within its unit
// (a table cell, else a clause), one key per number: a group of n keys answers
// from behind only to the n numbers nearest before it. It holds when it is one of a cited item's
// numbers at the decimals it is written with, or a declared limit after a
// limit word, or a difference of two values its own keys cite in its unit. Every answer
// is read both in English ("2,291.5") and Norwegian ("2 291,5"): only a number
// both readings flag is a contradiction, so the check errs towards silence.
//
// evaluation.ts turns contradictions into its one correction turn; a key that
// is on no card of the turn gets a visible chip in the answer instead.
// ============================================================================

import type { DisplayCardItem } from '@leitbild/contracts'

/** What the check reads of a card item, keyed as the answer cites it. */
export type CitedItem = Pick<DisplayCardItem, 'key' | 'label' | 'reading' | 'numbers' | 'limits'>
type CardNumber = DisplayCardItem['numbers'][number]
export type Language = 'en' | 'nb'

const KEY = /⟦k(\d+)⟧/g
// Clock times, dates, refs and ids are no values: masked before numbers are read.
const TIMES = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b|\b\d{1,2}:\d{2}(?::\d{2})?\b|[\w.@-]+:[\w.@:-]+(?:#[\w.@:-]+)?/g
// A number may carry its unit ("15.5MPa"); a letter or digit before it makes it part of a word. Thousands are grouped
// by commas in English ("2,291") and by spaces in Norwegian ("2 291"), whose decimal mark is the comma ("15,5").
const NUMBER: Readonly<Record<Language, RegExp>> = {
  en: /(?<![\p{L}\d.,])[-−]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d:,])|(?<![\p{L}\d.,])[-−]?\d+(?:\.\d+)?(?![\d:])/gu,
  nb: /(?<![\p{L}\d.,])[-−]?\d{1,3}(?:[   ]\d{3})+(?:,\d+)?(?![\d:])|(?<![\p{L}\d.,])[-−]?\d+(?:[.,]\d+)?(?![\d:])/gu,
}
// Names: a number after a language word, directly or through a list of named numbers ("Units 1 and 2"), or after a
// display or row word names a part, not a value.
const UNIT_WORD = /\b(?:unit|units|enhet|enheter|enhetene)[\s-]*(?:\d+\s*(?:,|and|og|&)\s*)*$/i
const DISPLAY_WORD = /\b(?:display|displays|displayet|displayene|skjerm|card|kort|row|rad|raden)\s*$/i
// A number within three words after a limit word may match a declared limit.
const LIMIT = /\b(?:limit|limits|rating|rated|threshold|setpoint|trip|alarm|above|below|over|under|exceeds?|grense|grensen|grenseverdi\w*|merkeverdi\w*|alarmgrense\w*)\b(?:\W+\S+){0,3}\W*$/i
// A key group, exact keys only (a range ⟦k1–k8⟧ is none).
const GROUP = /⟦k\d+⟧(?:\s*(?:,|and|og|\/)?\s*⟦k\d+⟧)*/g
// Clauses end at ; ! ? a line break, or a full stop that is not a decimal point.
const CLAUSE_END = /[;!?\n]|\.(?!\d)/g
// A difference: a difference word right after the number and its unit, or "by"/"med" right before it.
const DIFFERENCE_AFTER = /^\s*(?:[%‰°\p{L}/]{1,6}\s*)?(?:percentage points?|points?|pp|prosentpoeng|poeng|above|below|over|under|higher than|lower than|more than|less than|short of|høyere enn|lavere enn|mer enn|mindre enn)(?![\p{L}])/iu
const DIFFERENCE_BEFORE = /\b(?:by|med)\s*$/i

interface Found { readonly text: string; readonly value: number; readonly decimals: number; readonly index: number }

const numbersIn = (answer: string, language: Language): ReadonlyArray<Found> => {
  const masked = answer.replace(TIMES, match => ' '.repeat(match.length)).replace(KEY, match => ' '.repeat(match.length))
  return [...masked.matchAll(NUMBER[language])].map(match => {
    const plain = match[0].replace('−', '-')
    const text = language === 'en' ? plain.replaceAll(',', '') : plain.replace(/[   ]/g, '').replace(',', '.')
    return { text: match[0], value: Number(text), decimals: text.includes('.') ? text.split('.')[1]!.length : 0, index: match.index! }
  })
}

/** Whether a number written with d decimals is one of these rounded to d (never more digits than the item shows). */
const matches = (found: Found, numbers: ReadonlyArray<CardNumber>): boolean => numbers.some(number =>
  found.decimals <= number.decimals && Math.abs(found.value - number.value) <= 0.5 * 10 ** -found.decimals + 1e-9)

// A card label's name: the number with the word after it, or in parentheses, as a label writes it ("420 kV", "(1)");
// or the whole token the word before it forms with it, as joined there ("A-21", "Ambulance 21"). The word alone in a
// label is never enough: "Pump A 75 %" against "Pump A" reads 75 as a value.
const labelled = (answer: string, labels: ReadonlyArray<string>, found: Found): boolean => {
  const after = /^\s*([\p{L}\d]+)/u.exec(answer.slice(found.index + found.text.length))?.[1]!.toLowerCase() ?? ''
  const before = /(?<![\p{L}\d])[\p{L}\d]+[ -]$/u.exec(answer.slice(Math.max(0, found.index - 40), found.index))?.[0].toLowerCase()
  const token = before === undefined ? null : new RegExp(`(?<![\\p{L}\\d])${escaped(`${before}${found.text.toLowerCase()}`)}(?![\\p{L}\\d]|[.,]\\d)`, 'u')
  const parenthesised = answer[found.index - 1] === '(' && answer[found.index + found.text.length] === ')'
  return labels.some(label => (after !== '' && label.includes(`${found.text.toLowerCase()} ${after}`)) || (token !== null && token.test(label))
    || (parenthesised && label.includes(`(${found.text})`)))
}
// The characters a unicode pattern must escape; a hyphen outside a class is literal there.
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** A cited number that holds by none of the rules, with the keys it answers to and where it stands. */
export interface CitationFlag {
  readonly number: string
  readonly keys: ReadonlyArray<string>
  readonly index: number
  readonly end: number
  readonly derived: boolean
}

/** One reading's flags: the guard as an answer in this language reads it (P2 E0 scored round 3 with this rule). */
export const readingFlags = (answer: string, items: ReadonlyMap<string, CitedItem>, language: Language): ReadonlyArray<CitationFlag> => {
  // Units: clause ends and, in a table row, the cell bars; an integer that is a row's whole first cell is a row number.
  const bounds = [...answer.matchAll(CLAUSE_END)].map(match => match.index!)
  const rowNumbers = new Set<number>()
  let offset = 0
  for (const line of answer.split('\n')) {
    if (line.trimStart().startsWith('|')) {
      const bars = [...line.matchAll(/\|/g)].map(match => offset + match.index!)
      bounds.push(...bars)
      const first = bars.length > 1 ? /^\s*\d+\s*$/.exec(answer.slice(bars[0]! + 1, bars[1]!)) : null
      if (first !== null) rowNumbers.add(bars[0]! + 1 + first[0].search(/\d/))
    }
    offset += line.length + 1
  }
  bounds.sort((a, b) => a - b)
  const unitOf = (index: number) => bounds.filter(bound => bound < index).length
  const labels = [...items.values()].map(item => item.label.toLowerCase())
  const before30 = (found: Found) => answer.slice(Math.max(0, found.index - 30), found.index)
  const named = (found: Found) => UNIT_WORD.test(before30(found)) || labelled(answer, labels, found) || DISPLAY_WORD.test(before30(found)) || rowNumbers.has(found.index)
  const plain = numbersIn(answer, language).filter(found => !named(found))
  // A range ("a–b", "a to b", "a til b") is one entry with two ends.
  const entries: Array<{ readonly ends: ReadonlyArray<Found>; readonly start: number; readonly end: number; readonly unit: number }> = []
  for (let index = 0; index < plain.length; index++) {
    const found = plain[index]!
    const next = plain[index + 1]
    const range = next !== undefined && unitOf(next.index) === unitOf(found.index) && /^\s*(?:%\s*)?(?:[–—-]|to|til)\s*$/.test(answer.slice(found.index + found.text.length, next.index))
    const last = range ? next! : found
    entries.push({ ends: range ? [found, next!] : [found], start: found.index, end: last.index + last.text.length, unit: unitOf(found.index) })
    if (range) index += 1
  }
  const groups = [...answer.matchAll(GROUP)].map(match => {
    const written = [...match[0].matchAll(KEY)].map(key => `k${key[1]}`)
    return { index: match.index!, end: match.index! + match[0].length, unit: unitOf(match.index!), size: written.length, keys: written.filter(key => items.has(key)) }
  })
  // One key per number: a group of n keys answers from behind only to the n numbers nearest before it in its unit, so a
  // number written without a key earlier in the clause ("from 15.48 MPa … to 14.33 MPa ⟦k1⟧") is cited by none.
  const nearest = new Map(groups.map(group => {
    const covered = new Set<typeof entries[number]>()
    let room = group.size
    for (const entry of entries.filter(other => other.unit === group.unit && other.end <= group.index).reverse()) {
      if (room <= 0) break
      covered.add(entry)
      room -= entry.ends.length
    }
    return [group, covered] as const
  }))
  // In reading order: the first group after the entry when it is among that group's nearest, or the last group before
  // it when no other number stands between and no earlier number answers to it from behind; the nearer in characters
  // wins, a tie going to the group after.
  const takenFromBehind = new Set<number>()
  const answered = entries.map(entry => {
    const first = groups.find(group => group.unit === entry.unit && group.index >= entry.end)
    const after = first !== undefined && nearest.get(first)!.has(entry) ? first : undefined
    const lastBefore = groups.filter(group => group.unit === entry.unit && group.end <= entry.start).at(-1)
    const before = lastBefore !== undefined && !takenFromBehind.has(lastBefore.index)
      && !entries.some(other => other !== entry && other.unit === entry.unit && other.start >= lastBefore.end && other.end <= entry.start) ? lastBefore : undefined
    const takesAfter = after !== undefined && (before === undefined || after.index - entry.end <= entry.start - before.end)
    if (takesAfter) takenFromBehind.add(after.index)
    return { entry, group: takesAfter ? after : before }
  })
  const holds = (found: Found, keys: ReadonlyArray<string>) => keys.some(key => matches(found, items.get(key)!.numbers))
    || (LIMIT.test(answer.slice(Math.max(0, found.index - 60), found.index)) && keys.some(key => matches(found, items.get(key)!.limits ?? [])))
  const held = (entry: typeof entries[number], group: typeof groups[number]): boolean => entry.ends.every(found => holds(found, group.keys))
  const flags: CitationFlag[] = []
  for (const { entry, group } of answered) {
    if (group === undefined || !group.keys.some(key => items.get(key)!.numbers.length > 0 || (items.get(key)!.limits ?? []).length > 0)) continue
    if (held(entry, group)) continue
    const found = entry.ends[0]!
    // A difference is checked only against two cited values of its own keys in its unit, and holds when it equals the
    // difference of a pair of them. A reference that is cited nowhere (an unwritten 100 % limit) is never stood in for by
    // another item's number: with fewer than two such values the difference is unchecked.
    const derived = entry.ends.length === 1 && (DIFFERENCE_AFTER.test(answer.slice(entry.end)) || DIFFERENCE_BEFORE.test(answer.slice(Math.max(0, found.index - 10), found.index)))
    if (derived) {
      const operands = answered.filter(other => other.entry !== entry && other.entry.unit === entry.unit && other.entry.ends.length === 1
        && other.group !== undefined && held(other.entry, other.group) && other.group.keys.some(key => group.keys.includes(key))).map(other => other.entry.ends[0]!)
      if (operands.length < 2) continue
      if (operands.some((a, i) => operands.slice(i + 1).some(b => matches(found, [{ value: Math.abs(a.value - b.value), decimals: Math.max(a.decimals, b.decimals, found.decimals) }])))) continue
    }
    flags.push({ number: entry.ends.map(end => end.text).join('–'), keys: group.keys, index: entry.start, end: entry.end, derived })
  }
  return flags
}

/** A cited number its card lines contradict, and what to fix. */
export interface Contradiction {
  readonly number: string
  readonly keys: ReadonlyArray<string>
  readonly issue: string
}

export interface CitationIssues {
  /** Keys the answer cites that are on no card of its turn. */
  readonly unknownKeys: ReadonlyArray<string>
  readonly contradictions: ReadonlyArray<Contradiction>
}

/** Checks an answer against the card items of its turn: a number both readings flag is a contradiction. */
export const citationIssues = (answer: string, items: ReadonlyArray<CitedItem>): CitationIssues => {
  const byKey = new Map(items.map(item => [item.key, item]))
  const unknownKeys = [...new Set([...answer.matchAll(KEY)].map(match => `k${match[1]}`))].filter(key => !byKey.has(key))
  const norwegian = readingFlags(answer, byKey, 'nb')
  const contradictions = readingFlags(answer, byKey, 'en').flatMap(english => {
    const other = norwegian.find(flag => flag.index < english.end && english.index < flag.end)
    if (other === undefined) return []
    // The fuller reading names the number ("17,2", not "17").
    const flag = other.end - other.index > english.end - english.index ? other : english
    const lines = flag.keys.map(key => `${key} reads "${byKey.get(key)!.reading}" (${byKey.get(key)!.label})`).join(' and ')
    return [{ number: flag.number, keys: flag.keys, issue: `${flag.number} is cited with ${flag.keys.map(key => `⟦${key}⟧`).join(' ')}, but ${lines}.` }]
  })
  return { unknownKeys, contradictions }
}
