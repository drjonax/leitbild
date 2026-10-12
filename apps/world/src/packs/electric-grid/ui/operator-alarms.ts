import type { GridAlarmView } from '../queries/alarms.ts'

// Operator presentation of world.electric-grid.alarms.list: one row per alarm record with its
// priority, lifecycle state, simulation time, asset and the lifecycle actions that change it.

export type GridAlarmLifecycleAction = 'acknowledge' | 'shelve' | 'unshelve'
export type GridAlarmFilter = 'active' | 'unacknowledged' | 'shelved' | 'all'

export interface GridAlarmRow {
  readonly id: string
  readonly priority: 1 | 2 | 3
  readonly priorityLabel: string
  readonly tone: 'critical' | 'warning' | 'notice'
  readonly active: boolean
  readonly stateLabel: string
  readonly title: string
  readonly message: string
  readonly assetLabel: string
  readonly mapAssetId: string | null
  /** Raise time of the latest occurrence, HH:MM:SS in the Grid's time zone. */
  readonly time: string
  /** Raise, clear and shelving times in full, for a tooltip. */
  readonly timeDetail: string
  readonly valueText: string | null
  readonly occurrences: number
  readonly actions: ReadonlyArray<GridAlarmLifecycleAction>
}

/** The alarm states each filter asks alarms.list for; `all` asks for every record. */
export const gridAlarmFilterStates: Readonly<Record<GridAlarmFilter, ReadonlyArray<'active' | 'unacknowledged' | 'cleared' | 'shelved'> | null>> = {
  active: ['active'],
  unacknowledged: ['unacknowledged'],
  shelved: ['shelved'],
  all: null,
}

/** Grid Operating Points schedule in Norwegian local time (schemas/grid-operating-point.ts); alarm times read in it too. */
export const gridLocalTimeZone = 'Europe/Oslo'

/** Shelving is time-limited (the command allows at most 24 h). */
export const gridAlarmShelveDurations: ReadonlyArray<{ readonly seconds: number; readonly label: string }> = [
  { seconds: 900, label: '15 min' },
  { seconds: 3_600, label: '1 h' },
  { seconds: 8 * 3_600, label: '8 h' },
]

/** world.electric-grid.alarm.lifecycle changes at most this many alarms per command. */
export const gridAlarmLifecycleBatchLimit = 100

/** A count with its noun in the matching number: "1 active alarm", "9 active alarms". */
export const gridCount = (count: number, one: string, other: string): string => `${count} ${count === 1 ? one : other}`

const priorityLabels = { 1: 'P1', 2: 'P2', 3: 'P3' } as const
const tones = { 1: 'critical', 2: 'warning', 3: 'notice' } as const

/** HH:MM:SS of an ISO timestamp in a time zone (24-hour clock). */
export const formatGridAlarmTime = (iso: string, timeZone: string): string => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) throw new Error(`not an ISO timestamp: ${iso}`)
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(at)
}

const valueText = (alarm: GridAlarmView): string | null => {
  if (alarm.value === null || alarm.unit === null) return null
  const digits = alarm.unit === 'Hz' ? 3 : 1
  const value = `${alarm.value.toFixed(digits)} ${alarm.unit}`
  return alarm.limit === null ? value : `${value} (limit ${alarm.limit.toFixed(alarm.unit === 'Hz' ? 2 : 1)} ${alarm.unit})`
}

const stateLabel = (alarm: GridAlarmView, timeZone: string): string => {
  if (alarm.shelved) return `Shelved until ${formatGridAlarmTime(alarm.shelvedUntil!, timeZone)}`
  return `${alarm.active ? 'Active' : 'Cleared'} · ${alarm.acknowledged ? 'acknowledged' : 'unacknowledged'}`
}

const actionsFor = (alarm: GridAlarmView): ReadonlyArray<GridAlarmLifecycleAction> => alarm.shelved
  ? ['unshelve']
  : [...(alarm.acknowledged ? [] : ['acknowledge' as const]), 'shelve']

export const gridAlarmRows = (alarms: ReadonlyArray<GridAlarmView>, timeZone: string): ReadonlyArray<GridAlarmRow> => alarms.map(alarm => ({
  id: alarm.id,
  priority: alarm.priority,
  priorityLabel: priorityLabels[alarm.priority],
  tone: tones[alarm.priority],
  active: alarm.active,
  stateLabel: stateLabel(alarm, timeZone),
  title: alarm.title,
  message: alarm.message,
  assetLabel: alarm.assetLabel,
  mapAssetId: alarm.mapAssetId,
  time: formatGridAlarmTime(alarm.raisedAt, timeZone),
  timeDetail: [
    `Raised ${alarm.raisedAt}`,
    ...(alarm.clearedAt === null ? [] : [`cleared ${alarm.clearedAt}`]),
    ...(alarm.acknowledgedAt === null ? [] : [`acknowledged ${alarm.acknowledgedAt}`]),
    ...(alarm.shelvedUntil === null ? [] : [`shelved until ${alarm.shelvedUntil}`]),
  ].join(' · '),
  valueText: valueText(alarm),
  occurrences: alarm.occurrences,
  actions: actionsFor(alarm),
}))

/** Ids of the listed rows an acknowledge-all acknowledges, within one command's limit. */
export const gridAlarmIdsToAcknowledge = (rows: ReadonlyArray<GridAlarmRow>): ReadonlyArray<string> =>
  rows.filter(row => row.actions.includes('acknowledge')).slice(0, gridAlarmLifecycleBatchLimit).map(row => row.id)
