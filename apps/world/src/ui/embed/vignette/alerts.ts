// A vignette's alerts and its header's worst chip (architecture B), over the
// shared alert rows (features/displays/alerts/rows.ts), each drawn with
// OpenBridge's own alert icon (register #23: the OpenBridge-free twin stays in
// the main app's strip). Rows keep the sample's order, which ranks them as the
// Run context does; a row without a priority is shown by its severity word,
// "priority not declared", and never ranks as a priority (R1).
import type { Observation } from '../../../core/observation/model.ts'
import type { VignetteSection } from '../../../features/displays/compose/model.ts'
import { priorityRank, stateWords, type AlertRow } from '../../../features/displays/alerts/rows.ts'
import { severityStyle } from '../../displays/severity.ts'

export interface AlertLine {
  readonly row: AlertRow
  readonly heading?: string
  readonly firstOut: boolean
}

/**
 * OpenBridge's alert icon for a row (obc-alert-icon): its alert type by the
 * declared priority (emergency is OpenBridge's critical level), acknowledged
 * and still active as the record says; a returned alarm is OpenBridge's
 * rectified icon. Notice has no icon and an undeclared priority none: both
 * read as their word.
 */
export const alertIcon = (row: AlertRow): { readonly type: 'level-critical' | 'alarm' | 'warning' | 'caution'; readonly acknowledged: boolean; readonly active: boolean } | { readonly word: string } => {
  const type = row.priority === 'emergency' ? 'level-critical' : row.priority === 'alarm' || row.priority === 'warning' || row.priority === 'caution' ? row.priority : null
  if (type === null) return { word: severityStyle(row.priority, row.alert.severity)?.word ?? 'Notice' }
  return { type, acknowledged: row.state === 'active-ack', active: row.state !== 'returned-unack' }
}

/** What a row says after its message: its marks, its state where it is not plain unacknowledged, its time. */
export const alertDetail = (row: AlertRow): string => [
  ...(row.alert.standing === true ? ['standing'] : []),
  ...(row.alert.advisory === true ? ['advisory'] : []),
  ...(row.state === 'active-unack' ? [] : [stateWords(row)]),
  row.raised?.clock === 'simulation' ? `${row.raised.at.slice(11, 19)} UTC` : 'time unknown',
].join(' · ')

type AlertsSection = Pick<Extract<VignetteSection, { kind: 'alerts' }>, 'objectIds' | 'elements' | 'refs'>

/** Whether a row belongs to a section: one of its objects (any in the Run), and where it names elements or observables, on one of them. */
const inSection = (section: AlertsSection) => (row: AlertRow): boolean => {
  if (section.objectIds !== 'run' && !section.objectIds.includes(row.objectId)) return false
  if (section.elements === undefined && section.refs === undefined) return true
  const subject = row.alert.subject
  const element = subject !== undefined && 'element' in subject ? subject.element : undefined
  return (element !== undefined && (section.elements ?? []).includes(element)) || (row.alert.observable !== undefined && (section.refs ?? []).includes(row.alert.observable))
}

/** The rows a section shows within its rows (one is its head), in the sample's order, the last saying how many more there are. */
export const sectionLines = (rows: ReadonlyArray<AlertRow>, section: AlertsSection, room: number): { readonly lines: ReadonlyArray<AlertLine>; readonly more: number } => {
  const own = rows.filter(inSection(section))
  const several = new Set(own.map(row => row.objectId)).size > 1
  const shown = own.length <= room ? own : own.slice(0, Math.max(0, room - 1))
  return {
    lines: shown.map(row => ({ row, firstOut: row.alert.firstOut?.rank === 1, ...(several ? { heading: row.objectLabel } : {}) })),
    more: own.length - shown.length,
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
