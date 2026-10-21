// A vignette's alerts and its header's worst chip (architecture B), over the
// shared alert rows (features/displays/alerts/rows.ts) drawn by the strip's
// AlertList. Worst first; what asks no attention (standing, advisory) last; a
// row without a priority is shown by its severity word, "priority not
// declared", and never ranks as a priority (R1).
import type { Observation } from '../../../core/observation/model.ts'
import { priorityRank, worstFirst, type AlertRow } from '../../../features/displays/alerts/rows.ts'

/** A line as AlertList draws it (its module type, which a .ts file cannot import from a component). */
export interface AlertLine {
  readonly row: AlertRow
  readonly heading?: string
  readonly firstOut: boolean
}

/** The rows a section shows within its rows (one is its head), the last saying how many more there are. */
export const sectionLines = (rows: ReadonlyArray<AlertRow>, objectIds: ReadonlyArray<string> | 'run', room: number): { readonly lines: ReadonlyArray<AlertLine>; readonly more: number } => {
  const own = (objectIds === 'run' ? [...rows] : rows.filter(row => objectIds.includes(row.objectId))).sort(worstFirst)
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
