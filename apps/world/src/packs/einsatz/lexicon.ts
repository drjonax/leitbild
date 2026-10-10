import { z } from 'zod'

/** The closed phase set of a unit. Integrity (healthy, damaged, destroyed) is separate state. */
export const unitPhases = ['available', 'mobilizing', 'en-route', 'on-task', 'transporting', 'at-site', 'returning', 'holding', 'destroyed'] as const
export type UnitPhase = typeof unitPhases[number]

/** Words a unit type may set for its own units: its phases and the verb for halting in place. */
export const unitLexiconKeys = ['hold', ...unitPhases] as const
/** Words only the whole configuration sets: list headings, track tiers and the empty work list. */
export const boardLexiconKeys = ['workList', 'unitBoard', 'tracks', 'contact', 'identified', 'noWork'] as const
export const lexiconKeys = [...boardLexiconKeys, ...unitLexiconKeys] as const

export type UnitLexiconKey = typeof unitLexiconKeys[number]
export type LexiconKey = typeof lexiconKeys[number]

/** Neutral wording used until a configuration words it otherwise; all domain words come from configuration. */
export const neutralLexicon: Readonly<Record<LexiconKey, string>> = {
  workList: 'Tasks',
  unitBoard: 'Units',
  tracks: 'Tracks',
  contact: 'Contact',
  identified: 'Identified',
  noWork: 'No tasks waiting',
  hold: 'Hold',
  available: 'Available',
  mobilizing: 'Mobilizing',
  'en-route': 'En route',
  'on-task': 'On task',
  transporting: 'Transporting',
  'at-site': 'At site',
  returning: 'Returning',
  holding: 'Holding',
  destroyed: 'Destroyed',
}

const word = z.string().trim().min(1).max(120)
export const lexiconSchema = z.partialRecord(z.enum(lexiconKeys), word)
export const unitLexiconSchema = z.partialRecord(z.enum(unitLexiconKeys), word)
export type Lexicon = z.output<typeof lexiconSchema>
export type UnitLexicon = z.output<typeof unitLexiconSchema>

const isUnitKey = (key: LexiconKey): key is UnitLexiconKey => (unitLexiconKeys as ReadonlyArray<string>).includes(key)

/** A unit type's own word, else the configuration's, else the neutral one. */
export const wordFor = (lexicon: Lexicon, key: LexiconKey, unitLexicon?: UnitLexicon): string =>
  (unitLexicon !== undefined && isUnitKey(key) ? unitLexicon[key] : undefined) ?? lexicon[key] ?? neutralLexicon[key]
