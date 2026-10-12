import type { Eta } from '../recommendation-schema.ts'
import type { UnitProperty } from '../config-schema.ts'
import { wordFor, type LexiconKey } from '../lexicon.ts'
import type { BoardRules } from './rules.ts'
import type { BoardUnit } from './records.ts'

/**
 * Board wording. Every domain word comes from the configuration: labels,
 * load-class codes and nouns, property labels and units, and the lexicon.
 * The few fixed words here are neutral mechanism words.
 */

const inline = (word: string): string => word.charAt(0).toLowerCase() + word.slice(1)

/** A configuration word for a lexicon key, as a heading. */
export const word = (rules: BoardRules, key: LexiconKey): string => wordFor(rules.config.lexicon, key)

/** A configuration word for a lexicon key, inside a sentence: "Tap one of your units first". */
export const inlineWord = (rules: BoardRules, key: LexiconKey): string => inline(word(rules, key))

/** A unit's own word for a lexicon key, inside a sentence. */
export const unitWord = (rules: BoardRules, unit: BoardUnit, key: LexiconKey): string =>
  inline(wordFor(rules.config.lexicon, key, rules.typeOf(unit).lexicon))

/** "4:20", or "1:04:20" past an hour; never negative. */
export const clockText = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds))
  const [hours, minutes, rest] = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60]
  const pad = (value: number) => value.toString().padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

/** "850 m", or "1.4 km" from a kilometre on. */
export const distanceText = (metres: number): string => metres < 1_000 ? `${Math.round(metres)} m` : `${(metres / 1_000).toFixed(1)} km`

/**
 * The Board's neutral mechanism words: what the sound control, an ETA and a
 * selected task's remainder say, the names of its strip and log, and what
 * the panel says before a configuration is there to word anything. Domain
 * words and verbs are the lexicon's.
 */
export const boardWords = {
  soundOff: 'Sound off · tap to enable',
  soundOn: 'Sound on',
  confirm: 'Confirm',
  cancel: 'Cancel',
  doNow: 'Do now',
  addToEnd: 'Add to end',
  addTarget: 'Add a target',
  engage: 'Engage',
  removeStep: 'Remove',
  divert: 'Divert',
  /** What closing a call says when no unit has served it and it names no remainder. */
  unserved: 'Not served yet',
  resume: 'Resume',
  clear: 'Clear',
  paused: 'paused',
  next: 'next',
  mapPoint: 'a map point',
  undo: 'Undo',
  /** A call units hold as their next job, which they would serve: "Covered next by U1". */
  coveredNext: 'Covered next by',
  /** After it, where alternatives can still be sent at once. */
  orSendNow: 'or send another now',
  /** Inside a line, before what a call held next still needs beside the units that hold it: "U1 next · still needs 1 more server". */
  stillNeeds: 'still needs',
  /** The Calls list's marker for waiting rows scrolled out of view above, after their count: "↑ 2 waiting". */
  waitingAbove: 'waiting',
  confirmFirst: 'Confirm or cancel first',
  preparing: 'Preparing…',
  nothingToSend: 'Nothing to send',
  eta: 'ETA',
  remainder: 'Still needs',
  alerts: 'Alerts',
  log: 'Event log',
  board: 'Board',
  loading: 'Reading the configuration…',
  retry: 'Retry',
  readFailed: 'The Board could not read the configuration',
  failed: 'The Board failed',
  soundFailed: 'Sound could not start',
} as const

/** An ETA as shown: a routed time, a straight-line time marked "≈", or why there is none with the straight distance. */
export const etaText = (eta: Eta): string => {
  if (eta.kind === 'routed') return clockText(eta.seconds)
  if (eta.kind === 'straight-line') return `≈${clockText(eta.seconds)}`
  return `${boardWords.eta} unavailable · ${distanceText(eta.straightDistanceM)}`
}

/**
 * "1 pallet, 2 crates" in declared class order. Classes that share a noun
 * count together, so two classes of crates read "2 crates", never
 * "1 crate, 1 crate".
 */
export const loadText = (rules: BoardRules, load: Readonly<Record<string, number>>): string => nounCounts(rules.config.loadClasses, classId => load[classId] ?? 0)

/** Counts per noun, in the order each noun is first declared: "2 crates", "1 pallet, 2 crates". */
const nounCounts = (classes: ReadonlyArray<{ readonly id: string; readonly noun: { readonly one: string; readonly other: string } }>, countOf: (classId: string) => number): string => {
  const byNoun = new Map<string, { readonly noun: { readonly one: string; readonly other: string }; count: number }>()
  for (const entry of classes) {
    const count = countOf(entry.id)
    if (count <= 0) continue
    const key = JSON.stringify([entry.noun.one, entry.noun.other])
    const shared = byNoun.get(key)
    if (shared === undefined) byNoun.set(key, { noun: entry.noun, count })
    else shared.count += count
  }
  return [...byNoun.values()].map(({ noun, count }) => `${count} ${count === 1 ? noun.one : noun.other}`).join(', ')
}

export const classCode = (rules: BoardRules, classId: string): string => rules.loadClass(classId).code

/** A property value in its own words: a number with its unit, yes or no, or an enum value's label. */
export const propertyText = (property: UnitProperty, value: number | boolean | string | undefined): string => {
  if (value === undefined) throw new Error(`Property ${property.id} has no value`)
  if (property.kind === 'number') return property.unit === undefined ? `${String(value)}` : `${String(value)} ${property.unit}`
  if (property.kind === 'boolean') return value === true ? 'yes' : 'no'
  const label = property.values.find(entry => entry.id === value)?.label
  if (label === undefined) throw new Error(`${String(value)} is not a value of ${property.label}`)
  return label
}

/** The message of an Einsatz refusal, `<code>: <message>`; any other reason is shown whole. */
export const reasonText = (reason: string): string => /^[a-z][a-z0-9_]*: (\S[\s\S]*)$/.exec(reason)?.[1] ?? reason

export const joinUnits = (labels: ReadonlyArray<string>): string => labels.join(' + ')

/**
 * A reason about a unit that names the unit once: the engine's reasons
 * mostly start with the unit's label ("Unit 2 · Payload 300 kg · needs ≥
 * 500 kg", "H1 now mobilizing to C-1"), and those stand as they are; any
 * other is put after the label.
 */
export const namedOnce = (label: string, reason: string): string =>
  reason === label || reason.startsWith(`${label} `) ? reason : `${label} · ${reason}`
