import type { Priority } from '../../../core/model/alerts.ts'
import { groupKey, priorityRank, simulationMs, worstFirst, type AlertRow } from './rows.ts'

// The alarm strip (plan v3.1 §2.7; architecture A6): one row per group, the
// cap on rows, never on groups. Groups keep the Run's object order, then the
// subject group id, so they never reorder on a value or alarm change. Alarm,
// emergency and first-out groups always keep their row; the others fill the
// rows left, warning before caution, and the rest share one row, "+N groups ·
// worst · n unack". Standing alarms stay quiet: they never count as
// unacknowledged attention and never hold a row on their own.

export interface StripGroup {
  readonly key: string
  readonly label: string
  readonly order: number
  /** Over the group's alarms that are not standing, or all of them where every one is. */
  readonly worst: Priority | null
  readonly counts: { readonly active: number; readonly unack: number; readonly standing: number }
  /** The first-out pinned to the group's row; the earliest where it holds several groups' first-outs. */
  readonly firstOut: AlertRow | null
  /** The row shown first, then worst first. */
  readonly rows: ReadonlyArray<AlertRow>
  /** Every alarm in it is standing. */
  readonly quiet: boolean
  readonly collapsed: boolean
}

export interface AlertStrip {
  readonly groups: ReadonlyArray<StripGroup>
  /** Alert rows not shown: those behind each shown group's row, and every row of a collapsed group. */
  readonly hiddenRows: number
  readonly collapsed: { readonly groups: number; readonly worst: Priority | null; readonly unack: number } | null
}

const worstOf = (priorities: ReadonlyArray<Priority | null>): Priority | null =>
  priorities.reduce((worst, priority) => priorityRank(priority) > priorityRank(worst) ? priority : worst, null)

/** First in, then the worse, then by key; a first-out with no simulation time comes after those with one. */
const earliestFirst = (left: AlertRow, right: AlertRow): number =>
  (simulationMs(left) ?? Infinity) - (simulationMs(right) ?? Infinity) || worstFirst(left, right)

const stripGroup = (key: string, order: number, members: ReadonlyArray<AlertRow>): Omit<StripGroup, 'collapsed'> => {
  const firstOut = members.filter(row => row.alert.firstOut?.rank === 1).sort(earliestFirst)[0] ?? null
  const attention = members.filter(row => row.alert.standing !== true)
  return {
    key,
    label: members[0]!.objectLabel,
    order,
    worst: worstOf((attention.length > 0 ? attention : members).map(row => row.priority)),
    counts: {
      active: members.filter(row => row.state !== 'returned-unack').length,
      unack: attention.filter(row => row.state !== 'active-ack').length,
      standing: members.length - attention.length,
    },
    firstOut,
    rows: [...(firstOut === null ? [] : [firstOut]), ...members.filter(row => row !== firstOut).sort(worstFirst)],
    quiet: attention.length === 0,
  }
}

const keepsItsRow = (group: Omit<StripGroup, 'collapsed'>): boolean =>
  group.firstOut !== null || (!group.quiet && (group.worst === 'alarm' || group.worst === 'emergency'))

export const alertStrip = (rows: ReadonlyArray<AlertRow>, policy: { readonly maxRows: number }): AlertStrip => {
  if (!Number.isInteger(policy.maxRows) || policy.maxRows < 1) throw new Error(`An alarm strip needs at least one row, not ${policy.maxRows}`)
  const objectOrder = new Map<string, number>()
  const members = new Map<string, AlertRow[]>()
  for (const row of rows) {
    if (row.priority === 'none') continue
    if (!objectOrder.has(row.objectId)) objectOrder.set(row.objectId, objectOrder.size)
    const key = groupKey(row)
    if (!members.has(key)) members.set(key, [])
    members.get(key)!.push(row)
  }
  const groups = [...members.entries()]
    .sort(([, [left]], [, [right]]) => objectOrder.get(left!.objectId)! - objectOrder.get(right!.objectId)!
      || (left!.group.subjectGroup ?? '').localeCompare(right!.group.subjectGroup ?? ''))
    .map(([key, groupRows], order) => stripGroup(key, order, groupRows))
  const kept = new Set(groups.filter(keepsItsRow).map(group => group.key))
  const others = groups.filter(group => !kept.has(group.key))
    .sort((left, right) => Number(left.quiet) - Number(right.quiet) || priorityRank(right.worst) - priorityRank(left.worst) || left.order - right.order)
  const room = policy.maxRows - kept.size
  for (const group of others.length <= room ? others : others.slice(0, Math.max(0, room - 1))) kept.add(group.key)
  const shown = groups.map(group => ({ ...group, collapsed: !kept.has(group.key) }))
  const collapsed = shown.filter(group => group.collapsed)
  return {
    groups: shown,
    hiddenRows: shown.reduce((hidden, group) => hidden + group.rows.length - (group.collapsed ? 0 : 1), 0),
    collapsed: collapsed.length === 0 ? null : {
      groups: collapsed.length,
      worst: worstOf((collapsed.some(group => !group.quiet) ? collapsed.filter(group => !group.quiet) : collapsed).map(group => group.worst)),
      unack: collapsed.reduce((unack, group) => unack + group.counts.unack, 0),
    },
  }
}
