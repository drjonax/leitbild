import type { einsatzColors } from '../colors.ts'
import type { BoardView, ContactRow, LogEntry, UnitRow, WorkRow } from '../board/types.ts'

/**
 * What the Board panel shows beyond the controller's view, as pure
 * functions: which heading the strip carries, how a row's facts read on one
 * line, which badge tone an icon takes, and the time an event-log entry
 * carries. They add no word: every word comes from the view, and these only
 * choose and arrange the view's words.
 */

/** One fact on a row's detail line; numeric facts are set in tabular digits. */
export interface Fact {
  readonly text: string
  readonly numeric: boolean
}

export type IconTone = keyof typeof einsatzColors | 'free' | 'muted'

const fact = (text: string | null, numeric = false): ReadonlyArray<Fact> => text === null ? [] : [{ text, numeric }]

/** The strip's heading: the list the arrangement leads with, the unit board for a map-led role. */
export const stripHeading = (view: Pick<BoardView, 'arrangement' | 'headings'>): string =>
  view.arrangement.lead === 'work-list' ? view.headings.workList : view.headings.unitBoard

/** A unit's detail line: task and ETA, load, board properties, integrity, rules of engagement, target and posture. */
export const unitFacts = (row: UnitRow): ReadonlyArray<Fact> => [
  ...fact(row.taskText === null ? null : `→ ${row.taskText}`),
  ...fact(row.etaText, true),
  ...fact(row.loadText),
  ...row.properties.map(property => ({ text: `${property.label} ${property.value}`, numeric: true })),
  ...fact(row.integrityText),
  ...fact(row.roeText),
  ...fact(row.targetText),
  ...fact(row.postureText, true),
]

/** A work row's second line: the template's noun and the coverage. */
export const workFacts = (row: WorkRow): ReadonlyArray<Fact> => [...fact(row.noun), ...fact(row.coverageText === '' ? null : row.coverageText)]

/** A contact's facts: what it is, how far, how old; then why it cannot be fired on, and who fires on it. */
export const contactFacts = (row: ContactRow): ReadonlyArray<Fact> => [
  ...fact(row.typeLabel === null ? row.tierText : `${row.tierText} · ${row.typeLabel}`),
  ...fact(row.distanceText, true),
  ...fact(row.ageText, true),
  ...fact(row.fixText),
  ...fact(row.engagedText),
]

/** A unit out of action is muted; a free one shows it is free. */
export const unitIconTone = (row: UnitRow): IconTone => row.destroyed ? 'muted' : row.free ? 'free' : 'unit'

/** A destroyed track is muted; an identified one shows it was identified; a contact says nothing. */
export const contactIconTone = (row: ContactRow): IconTone => row.destroyed ? 'muted' : row.typeLabel === null ? 'contact' : 'identified'

/** The Run time of a log entry as the World clock shows it: "14:32:05", in UTC. */
export const logTime = (entry: LogEntry): string => {
  const at = new Date(entry.atMs)
  if (!Number.isFinite(at.getTime())) throw new Error(`A Board log entry holds no time: ${entry.atMs}`)
  return at.toISOString().slice(11, 19)
}
