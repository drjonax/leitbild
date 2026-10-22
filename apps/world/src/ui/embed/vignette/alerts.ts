// A vignette's alerts and its header's worst chip (architecture B), over the
// shared alert rows (features/displays/alerts/rows.ts), each drawn with
// OpenBridge's own alert icon (register #23: the OpenBridge-free twin stays in
// the main app's strip). Rows keep the sample's order, which ranks them as the
// Run context does; a row without a priority is shown by its severity word,
// "priority not declared", and never ranks as a priority (R1).
// Nothing here can acknowledge an alert yet (W2.7), so no icon flashes: each
// is drawn steady, and the word UNACK carries the state (register deviation
// alert-icon-steady-unacknowledged).
import type { Observation } from '../../../core/observation/model.ts'
import type { VignetteSection } from '../../../features/displays/compose/model.ts'
import { asksAttention, leadsObject, priorityRank, stateWords, type AlertRow } from '../../../features/displays/alerts/rows.ts'
import { severityStyle } from '../../displays/severity.ts'

export interface AlertLine {
  readonly row: AlertRow
  readonly heading?: string
  readonly firstOut: boolean
}

/**
 * OpenBridge's alert icon for a row (obc-alert-icon): its alert type by the
 * declared priority (emergency is OpenBridge's critical level), drawn steady
 * in OpenBridge's acknowledged form whatever the record says, since nothing
 * here acknowledges (OpenBridge 2.0.0 flashes every unacknowledged icon and
 * has no steady unacknowledged form); a returned alarm is its steady
 * rectified icon. Notice has no icon and an undeclared priority none: both
 * read as their word.
 */
export const alertIcon = (row: AlertRow): { readonly type: 'level-critical' | 'alarm' | 'warning' | 'caution'; readonly acknowledged: true; readonly active: boolean } | { readonly word: string } => {
  const type = row.priority === 'emergency' ? 'level-critical' : row.priority === 'alarm' || row.priority === 'warning' || row.priority === 'caution' ? row.priority : null
  if (type === null) return { word: severityStyle(row.priority, row.alert.severity)?.word ?? 'Notice' }
  return { type, acknowledged: true, active: row.state !== 'returned-unack' }
}

/** The word an unacknowledged alert's row and its section's count carry, its steady icon not saying so. */
export const UNACK_WORD = 'UNACK'

/** Whether a row is unacknowledged and asks for attention: standing alarms and advisories never count as unacknowledged (R43). */
export const unacknowledged = (row: AlertRow): boolean => row.state !== 'active-ack' && asksAttention(row)

/** What a row says after its message: its marks, its state where the word UNACK does not say it, its time. */
export const alertDetail = (row: AlertRow): string => [
  ...(row.alert.standing === true ? ['standing'] : []),
  ...(row.alert.advisory === true ? ['advisory'] : []),
  ...(unacknowledged(row) ? (row.state === 'returned-unack' ? ['returned'] : []) : row.state === 'active-unack' ? [] : [stateWords(row)]),
  row.raised?.clock === 'simulation' ? `${row.raised.at.slice(11, 19)} UTC` : 'time unknown',
].join(' · ')

type AlertsSection = Pick<Extract<VignetteSection, { kind: 'alerts' }>, 'objectIds' | 'elements' | 'refs' | 'lead'>

/** Whether a row belongs to a section: one of its objects (any in the Run), and where it names elements or observables, on one of them or, with `lead`, one of its objects' lead alerts. */
const inSection = (section: AlertsSection) => (row: AlertRow): boolean => {
  if (section.objectIds !== 'run' && !section.objectIds.includes(row.objectId)) return false
  if ((section.elements === undefined && section.refs === undefined) || (section.lead === true && leadsObject(row.alert))) return true
  const subject = row.alert.subject
  const element = subject !== undefined && 'element' in subject ? subject.element : undefined
  return (element !== undefined && (section.elements ?? []).includes(element)) || (row.alert.observable !== undefined && (section.refs ?? []).includes(row.alert.observable))
}

/**
 * The rows a section shows within its rows (one is its head), in the sample's order, the last saying how many more
 * there are; and how many of all and of those not shown are unacknowledged.
 */
export const sectionLines = (rows: ReadonlyArray<AlertRow>, section: AlertsSection, room: number): {
  readonly lines: ReadonlyArray<AlertLine>; readonly more: number; readonly unacknowledged: { readonly all: number; readonly more: number }
} => {
  const own = rows.filter(inSection(section))
  const several = new Set(own.map(row => row.objectId)).size > 1
  const shown = own.length <= room ? own : own.slice(0, Math.max(0, room - 1))
  return {
    lines: shown.map(row => ({ row, firstOut: row.alert.firstOut?.rank === 1, ...(several ? { heading: row.objectLabel } : {}) })),
    more: own.length - shown.length,
    unacknowledged: { all: own.filter(unacknowledged).length, more: own.slice(shown.length).filter(unacknowledged).length },
  }
}

export type WorstChip =
  | { readonly kind: 'priority'; readonly priority: 'caution' | 'warning' | 'alarm' | 'emergency' }
  /** Only alerts without a priority stand out: their worst severity, in words. */
  | { readonly kind: 'undeclared'; readonly severity: AlertRow['alert']['severity'] }

/** The worst the vignette shows at caution or above, over its values and its alerts' rows; null where nothing is. */
export const worstChip = (observations: ReadonlyArray<Pick<Observation, 'priority'>>, rows: ReadonlyArray<AlertRow>): WorstChip | null => {
  const priorities = [...observations.map(observation => observation.priority), ...rows.flatMap(row => (row.priority === null ? [] : [row.priority]))]
  const worst = priorities.reduce<Observation['priority']>((best, priority) => (priorityRank(priority) > priorityRank(best) ? priority : best), 'none')
  if (worst === 'caution' || worst === 'warning' || worst === 'alarm' || worst === 'emergency') return { kind: 'priority', priority: worst }
  const undeclared = rows.filter(row => row.priority === null).map(row => row.alert.severity)
  const severity = undeclared.includes('critical') ? 'critical' : undeclared.includes('warning') ? 'warning' : undefined
  return severity === undefined ? null : { kind: 'undeclared', severity }
}
