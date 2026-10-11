// Pure derivations for composed-display panels. Thresholds come from World;
// these functions only relate them to the latest sampled values. How a trend
// reads (rates, the limit ahead, times to it) is World's trend-reading.ts,
// which the compose result states too.
import { marginTextForms } from '../../../packs/process-plant/displays/display-text.ts'
import { gateStatesOf, limitStateText, type GateStates, type LimitState } from '../../../packs/process-plant/displays/trend-reading.ts'
import type { DisplayAnnunciation } from '../../../packs/process-plant/displays/annunciators.ts'
import type { ComposedDisplayAlarm, ComposedDisplaySample } from './composed-display-client.ts'

/**
 * A limit state worded from whole to shortest: in full (with the time to the
 * limit, or how it moves back across one it is past), then its margin alone,
 * each form dropping one more whole part (marginTextForms).
 */
export const limitStateForms = (state: LimitState, unit: string, resolution: number | null): ReadonlyArray<string> =>
  [...new Set([limitStateText(state, unit, resolution), ...(state.kind === 'margin' || state.kind === 'past' ? marginTextForms(state.margin, unit, resolution) : [])])]

/** The fullest wording of a limit state that fits its room (limitStateForms); the shortest where none does. */
export const fitLimitStateText = (state: LimitState, unit: string, resolution: number | null, fits: (text: string) => boolean): string => {
  const forms = limitStateForms(state, unit, resolution)
  return forms.find(fits) ?? forms.at(-1)!
}

export const agoText = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`
}

export const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const severityRank = { critical: 0, warning: 1, notice: 2, info: 3 } as const

/** The on/off states and values a sample reads, which the gated limits a display draws are judged by (gatesHold); none before the first. */
export const sampledGates = (latest: Pick<ComposedDisplaySample, 'values'> | undefined): GateStates => {
  const values = new Map((latest?.values ?? []).map(entry => [entry.path, entry.value]))
  return gateStatesOf(path => values.get(path))
}

/**
 * The first-out group an alarm came in as the expected consequence of
 * ("RX TRIP"), or null: one its annunciator declares expected after that
 * group's actuation (DisplayAnnunciation.expected), not first out itself,
 * that came in after the group's first-out and within the declared time of
 * it. Steam generator low-low levels from the shrink after a reactor trip
 * read so; the low-low level that tripped the reactor, which came in with
 * the trip, and anything before it never do (HMI review of run 23: all four
 * generators red alike, the initiator not set apart). Such an alarm is
 * shown de-emphasised, never hidden.
 */
export const expectedAfter = (
  alarm: Pick<ComposedDisplayAlarm, 'id' | 'firstOut' | 'firstActiveElapsedMs'>,
  alarms: ReadonlyArray<Pick<ComposedDisplayAlarm, 'id' | 'firstOut' | 'firstActiveElapsedMs'>>,
  annunciation: Pick<DisplayAnnunciation, 'expected' | 'groups'>,
): string | null => {
  const expected = annunciation.expected[alarm.id]
  if (expected === undefined || alarm.firstOut || alarm.firstActiveElapsedMs === undefined) return null
  const trigger = alarms.find(candidate => candidate.firstOut && annunciation.groups[candidate.id] === expected.after && candidate.firstActiveElapsedMs !== undefined)
  if (trigger === undefined) return null
  const lag = alarm.firstActiveElapsedMs - trigger.firstActiveElapsedMs!
  return lag > 0 && lag <= expected.withinMs ? expected.after : null
}

/** The OpenBridge alert type each severity is drawn as, everywhere an alarm shows: list, tiles and drawing. */
export const alertTypeOf = (severity: ComposedDisplayAlarm['severity']): 'alarm' | 'warning' | 'caution' =>
  severity === 'critical' ? 'alarm' : severity === 'warning' ? 'warning' : 'caution'

/**
 * The first-out flag an alarm row carries, scoped to its group: "1st RX
 * TRIP". Null where it is not first out, or its group has no other alarm or
 * trip to be first among (displayAnnunciation).
 */
export const firstOutFlag = (alarm: Pick<ComposedDisplayAlarm, 'firstOut' | 'id'>, annunciation: Pick<DisplayAnnunciation, 'firstOutGroups'>): string | null => {
  const group = annunciation.firstOutGroups[alarm.id]
  return alarm.firstOut && group !== undefined ? `1st ${group}` : null
}

/**
 * The reactor trip the banner leads with: the active first-out of the
 * reactor trip's group, else its earliest active member; the reactor trip
 * safety injection caused is one of them. Never another actuation, which the
 * actuation line lists (evaluation run 22's banner read "TRIP · Auxiliary
 * feedwater start" beside the reactor trip's first-out).
 */
export const bannerTrip = (alarms: ReadonlyArray<ComposedDisplayAlarm>, annunciation: Pick<DisplayAnnunciation, 'reactorTrip'>): ComposedDisplayAlarm | undefined => {
  const group = new Set(annunciation.reactorTrip?.ids ?? [])
  const tripped = alarms.filter(alarm => alarm.active && group.has(alarm.id))
    .sort((left, right) => Number(right.firstOut) - Number(left.firstOut) || (left.firstActiveElapsedMs ?? 0) - (right.firstActiveElapsedMs ?? 0))
  return tripped[0]
}

/** The automatic actuations other than the reactor trip that are active now, by name, in the order the I&C declares them: "AFW · SI · FWI". */
export const actuatedNames = (alarms: ReadonlyArray<ComposedDisplayAlarm>, annunciation: Pick<DisplayAnnunciation, 'actuations'>): ReadonlyArray<string> => {
  const active = new Set(alarms.filter(alarm => alarm.active).map(alarm => alarm.id))
  return annunciation.actuations.filter(actuation => actuation.ids.some(id => active.has(id))).map(actuation => actuation.name)
}

/**
 * Alarms in reading order: a first-out alarm, then by severity so trips are
 * never hidden behind warnings, then by onset. "related" keeps only the rules
 * acting on the display.
 */
export const visibleAlarms = (
  alarms: ReadonlyArray<ComposedDisplayAlarm>,
  scope: 'related' | 'plant',
  ruleIds: ReadonlyArray<string>,
  annunciation: Pick<DisplayAnnunciation, 'firstOutGroups'>,
): ReadonlyArray<ComposedDisplayAlarm> => {
  const related = new Set(ruleIds)
  const first = (alarm: ComposedDisplayAlarm): number => Number(firstOutFlag(alarm, annunciation) !== null)
  return alarms
    .filter(alarm => scope === 'plant' || related.has(alarm.ruleId))
    .sort((left, right) =>
      first(right) - first(left)
      || Number(right.kind === 'trip') - Number(left.kind === 'trip')
      || severityRank[left.severity] - severityRank[right.severity]
      || Number(right.active) - Number(left.active)
      || (left.firstActiveElapsedMs ?? Number.POSITIVE_INFINITY) - (right.firstActiveElapsedMs ?? Number.POSITIVE_INFINITY)
      || left.title.localeCompare(right.title))
}

/** Age as m:ss under an hour, otherwise h:mm, so onset order is readable at a glance. */
export const alarmAge = (plantElapsedMs: number, firstActiveElapsedMs: number | undefined): string => {
  if (firstActiveElapsedMs === undefined) return ''
  const seconds = Math.max(0, Math.round((plantElapsedMs - firstActiveElapsedMs) / 1000))
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`
}

export interface AnnunciatorState {
  readonly id: string
  readonly name: string
  readonly active: number
  readonly unacknowledged: number
  /** The most severe active alarm's severity; null while the system is quiet. */
  readonly severity: ComposedDisplayAlarm['severity'] | null
  /**
   * What its active alarms and trips do, by their first-out groups' short
   * labels ("RX TRIP", "SI", "AFW START"), each first out where this system
   * holds its group's first-out: those first out first, so a narrow tile
   * keeps them, then the reactor trip, then as the I&C declares them. Never
   * "TRIP" for an actuation that is not the reactor trip (QA review of run
   * 22: SI, AFW START and FWI tiles read "TRIP 1st").
   */
  readonly actions: ReadonlyArray<{ readonly name: string; readonly firstOut: boolean }>
  readonly firstOut: boolean
}

/** Each annunciator system's share of the active alarms, in the order the model declares the systems; first out only as its group scopes it (firstOutFlag). */
export const annunciatorStates = (
  systems: ReadonlyArray<{ readonly id: string; readonly name: string; readonly ruleIds: ReadonlyArray<string> }>,
  alarms: ReadonlyArray<ComposedDisplayAlarm>,
  annunciation: Pick<DisplayAnnunciation, 'firstOutGroups' | 'groups' | 'groupOrder'>,
): ReadonlyArray<AnnunciatorState> => systems.map(system => {
  const rules = new Set(system.ruleIds)
  const active = alarms.filter(alarm => alarm.active && rules.has(alarm.ruleId))
  const worst = [...active].sort((left, right) => severityRank[left.severity] - severityRank[right.severity])[0]
  const actions = [...new Set(active.flatMap(alarm => annunciation.groups[alarm.id] ?? []))]
    .map(name => ({ name, firstOut: active.some(alarm => annunciation.groups[alarm.id] === name && firstOutFlag(alarm, annunciation) !== null) }))
    .sort((left, right) => Number(right.firstOut) - Number(left.firstOut) || annunciation.groupOrder.indexOf(left.name) - annunciation.groupOrder.indexOf(right.name))
  return {
    id: system.id,
    name: system.name,
    active: active.length,
    unacknowledged: active.filter(alarm => !alarm.acknowledged).length,
    severity: worst?.severity ?? null,
    actions,
    firstOut: active.some(alarm => firstOutFlag(alarm, annunciation) !== null),
  }
})

/**
 * The actions a tile names in the room its counts leave: as many whole as
 * fit, in order ("SI 1st · RX TRIP"), the rest counted ("+1"); else any
 * other first-out that fits with the rest counted ("FWI 1st +1" where "AFW
 * START 1st +1" does not); where none fits, only whether the system holds a
 * first-out ("1st"). Never cut.
 */
export const tileActions = (
  actions: AnnunciatorState['actions'],
  fits: (text: string) => boolean,
): string => {
  const named = actions.map(action => `${action.name}${action.firstOut ? ' 1st' : ''}`)
  const rest = (shown: number): string => shown < named.length ? ` +${named.length - shown}` : ''
  const candidates = [
    ...named.map((_, index) => `${named.slice(0, named.length - index).join(' · ')}${rest(named.length - index)}`),
    // A first-out is never counted away behind one that is not.
    ...named.slice(1).filter((_, index) => actions[index + 1]!.firstOut || !actions[0]!.firstOut).map(name => `${name}${rest(1)}`),
  ]
  return candidates.find(fits) ?? (actions.some(action => action.firstOut) ? '1st' : '')
}
