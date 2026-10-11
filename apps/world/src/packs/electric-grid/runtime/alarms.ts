import type { IsoTimestamp } from '../../../core/model/index.ts'
import type { GridAlarmTiming } from '../schemas/grid-protection-automation.ts'
import { gridAlarmObservations } from './alarm-conditions.ts'
import { queueGridSignal } from './grid-signals.ts'
import type { GridIslandPlan, GridRuntimeInstance } from './instance.ts'

// Persistent alarm records with stable ids `<scope>:<asset>:<condition>`, after the process-plant
// I&C lifecycle: a record is raised and cleared by its condition (with delays, hysteresis and a
// minimum interval between transitions), acknowledged or shelved by command, and never cleared by
// acknowledgement. Every transition is queued as a Simulation Run signal.

export type GridAlarmScope = 'island' | 'branch' | 'generator' | 'hvdc'
export type GridAlarmPriority = 1 | 2 | 3

export interface GridAlarmRecord {
  readonly id: string
  readonly scope: GridAlarmScope
  readonly assetId: string
  readonly condition: string
  priority: GridAlarmPriority
  title: string
  /** Latest description of the condition, with the measured value while active. */
  message: string
  /** Island holding the asset at the latest evaluation; null when it lies in no island. */
  islandId: string | null
  value: number | null
  limit: number | null
  unit: 'Hz' | '%' | 'MW' | null
  active: boolean
  raisedAt: IsoTimestamp
  raisedAtElapsedMs: number
  clearedAt: IsoTimestamp | null
  clearedAtElapsedMs: number | null
  acknowledged: boolean
  acknowledgedAt: IsoTimestamp | null
  shelvedUntil: IsoTimestamp | null
  shelvedUntilElapsedMs: number | null
  /** Since when the clear condition holds while the record is active; null when it does not. */
  clearSinceElapsedMs: number | null
  clearDelayMs: number
  lastTransitionElapsedMs: number
  /** Times the record has been raised. */
  occurrences: number
}

/**
 * What one alarm condition shows at one evaluation. A condition produces an observation only at or
 * beyond its clear limit (hysteresis); one that produces none has its clear condition holding.
 */
export interface GridAlarmObservation {
  readonly id: string
  readonly scope: GridAlarmScope
  readonly assetId: string
  readonly condition: string
  readonly timing: GridAlarmTiming
  readonly islandId: string | null
  /** The raise condition holds; otherwise the value lies between the clear and raise limits. */
  readonly raising: boolean
  readonly title: string
  readonly message: string
  readonly value: number | null
  readonly limit: number | null
  readonly unit: GridAlarmRecord['unit']
}

export interface GridAlarmState {
  readonly records: Map<string, GridAlarmRecord>
  /** Raise conditions holding within their raise delay: since when they hold (elapsed ms). */
  readonly pendingSinceElapsedMs: Map<string, number>
  /** Island ids at the Grid's first evaluation; an energised island outside them raises island-formed. */
  baseIslandIds: ReadonlySet<string> | null
  /** Islands whose latest AC load flow did not converge, with the reason (noteGridAcSolution). */
  readonly acNonConvergence: Map<string, string>
  /** Simulation time of the latest evaluation; lifecycle commands act at it. */
  clock: { readonly at: IsoTimestamp; readonly elapsedMs: number } | null
}

export type PersistedGridAlarmState = {
  readonly records: GridAlarmRecord[]
  readonly pending: Array<{ readonly id: string; readonly sinceElapsedMs: number }>
  readonly baseIslandIds: string[] | null
  readonly clock: { readonly at: IsoTimestamp; readonly elapsedMs: number } | null
}

export const createGridAlarmState = (restored?: PersistedGridAlarmState): GridAlarmState => ({
  records: new Map((restored?.records ?? []).map(record => [record.id, { ...record }])),
  pendingSinceElapsedMs: new Map((restored?.pending ?? []).map(item => [item.id, item.sinceElapsedMs])),
  baseIslandIds: restored?.baseIslandIds == null ? null : new Set(restored.baseIslandIds),
  acNonConvergence: new Map(),
  clock: restored?.clock ?? null,
})

export const persistedGridAlarmState = (state: GridAlarmState): PersistedGridAlarmState => ({
  records: [...state.records.values()].map(record => ({ ...record })),
  pending: [...state.pendingSinceElapsedMs].map(([id, sinceElapsedMs]) => ({ id, sinceElapsedMs })),
  baseIslandIds: state.baseIslandIds === null ? null : [...state.baseIslandIds],
  clock: state.clock,
})

/** `<scope>:<asset>:<condition>`; asset ids may contain colons, the condition never does. */
export const gridAlarmId = (scope: GridAlarmScope, assetId: string, condition: string): string => `${scope}:${assetId}:${condition}`

/**
 * Reports one island's AC load-flow result for its non-convergence alarm. The AC solver calls it
 * after each solve of an energised island; a result is kept until the next one.
 */
export const noteGridAcSolution = (grid: GridRuntimeInstance, islandId: string, result: { readonly converged: true } | { readonly converged: false; readonly reason: string }): void => {
  if (result.converged) grid.alarms.acNonConvergence.delete(islandId)
  else grid.alarms.acNonConvergence.set(islandId, result.reason)
}

const severityFor = (priority: GridAlarmPriority): 'critical' | 'warning' | 'notice' =>
  priority === 1 ? 'critical' : priority === 2 ? 'warning' : 'notice'

export type GridAlarmPhase = 'active-unacknowledged' | 'active-acknowledged' | 'cleared-unacknowledged' | 'cleared-acknowledged'

export const gridAlarmPhase = (record: GridAlarmRecord): GridAlarmPhase =>
  `${record.active ? 'active' : 'cleared'}-${record.acknowledged ? 'acknowledged' : 'unacknowledged'}`

export const gridAlarmShelved = (record: GridAlarmRecord): boolean => record.shelvedUntilElapsedMs !== null

const queueTransition = (grid: GridRuntimeInstance, record: GridAlarmRecord, transition: string, elapsedMs: number, at: IsoTimestamp, extra: Readonly<Record<string, unknown>> = {}): void => {
  queueGridSignal(grid, {
    type: `electric-grid.alarm.${transition}`,
    severity: transition === 'raised' ? severityFor(record.priority) : 'info',
    key: `alarm|${record.id}|${transition}|${elapsedMs}|${record.occurrences}`,
    payload: {
      gridId: grid.definition.gridId,
      alarmId: record.id,
      scope: record.scope,
      assetId: record.assetId,
      condition: record.condition,
      priority: record.priority,
      islandId: record.islandId,
      title: record.title,
      message: record.message,
      value: record.value,
      limit: record.limit,
      unit: record.unit,
      phase: gridAlarmPhase(record),
      shelvedUntil: record.shelvedUntil,
      simulationTime: at,
      elapsedSeconds: elapsedMs / 1_000,
      ...extra,
    },
  })
}

const describe = (record: GridAlarmRecord, observation: GridAlarmObservation): void => {
  record.priority = observation.timing.priority
  record.title = observation.title
  record.message = observation.message
  record.islandId = observation.islandId
  record.value = observation.value
  record.limit = observation.limit
  record.unit = observation.unit
}

const raise = (grid: GridRuntimeInstance, observation: GridAlarmObservation, existing: GridAlarmRecord | undefined, at: IsoTimestamp, elapsedMs: number): void => {
  const record: GridAlarmRecord = existing ?? {
    id: observation.id,
    scope: observation.scope,
    assetId: observation.assetId,
    condition: observation.condition,
    priority: observation.timing.priority,
    title: observation.title,
    message: observation.message,
    islandId: observation.islandId,
    value: observation.value,
    limit: observation.limit,
    unit: observation.unit,
    active: true,
    raisedAt: at,
    raisedAtElapsedMs: elapsedMs,
    clearedAt: null,
    clearedAtElapsedMs: null,
    acknowledged: false,
    acknowledgedAt: null,
    shelvedUntil: null,
    shelvedUntilElapsedMs: null,
    clearSinceElapsedMs: null,
    clearDelayMs: 0,
    lastTransitionElapsedMs: elapsedMs,
    occurrences: 0,
  }
  describe(record, observation)
  record.active = true
  record.raisedAt = at
  record.raisedAtElapsedMs = elapsedMs
  record.clearedAt = null
  record.clearedAtElapsedMs = null
  // A new occurrence needs a new acknowledgement.
  record.acknowledged = false
  record.acknowledgedAt = null
  record.clearSinceElapsedMs = null
  record.clearDelayMs = observation.timing.clearDelaySeconds * 1_000
  record.lastTransitionElapsedMs = elapsedMs
  record.occurrences += 1
  grid.alarms.records.set(record.id, record)
  if (!gridAlarmShelved(record)) queueTransition(grid, record, 'raised', elapsedMs, at)
}

const clear = (grid: GridRuntimeInstance, record: GridAlarmRecord, at: IsoTimestamp, elapsedMs: number): void => {
  record.active = false
  record.clearedAt = at
  record.clearedAtElapsedMs = elapsedMs
  record.clearSinceElapsedMs = null
  record.lastTransitionElapsedMs = elapsedMs
  if (!gridAlarmShelved(record)) queueTransition(grid, record, 'cleared', elapsedMs, at)
}

/** Active record whose clear condition holds: clears after its clear delay and the minimum transition interval. */
const tryClear = (grid: GridRuntimeInstance, record: GridAlarmRecord, at: IsoTimestamp, elapsedMs: number, intervalMs: number): void => {
  record.clearSinceElapsedMs ??= elapsedMs
  if (elapsedMs - record.clearSinceElapsedMs >= record.clearDelayMs && elapsedMs - record.lastTransitionElapsedMs >= intervalMs) {
    clear(grid, record, at, elapsedMs)
  }
}

/**
 * Evaluates every alarm condition of the solved Grid at simulation time `at` (Grid elapsed
 * `elapsedMs`): raises, clears, expires shelving and forgets records that are cleared,
 * acknowledged and past the minimum transition interval.
 */
export const evaluateGridAlarms = (grid: GridRuntimeInstance, islands: GridIslandPlan, at: IsoTimestamp, elapsedMs: number): void => {
  const settings = grid.definition.automation.alarms
  const state = grid.alarms
  const intervalMs = settings.minimumTransitionIntervalSeconds * 1_000
  state.clock = { at, elapsedMs }
  state.baseIslandIds ??= new Set(islands.islands.map(island => island.id))
  for (const record of state.records.values()) {
    if (record.shelvedUntilElapsedMs === null || record.shelvedUntilElapsedMs > elapsedMs) continue
    record.shelvedUntil = null
    record.shelvedUntilElapsedMs = null
    queueTransition(grid, record, 'shelve-expired', elapsedMs, at)
  }
  const visited = new Set<string>()
  for (const observation of gridAlarmObservations(grid, islands, settings, state)) {
    if (visited.has(observation.id)) throw new Error(`Grid ${grid.definition.gridId} alarm ${observation.id} was observed twice in one evaluation`)
    visited.add(observation.id)
    const record = state.records.get(observation.id)
    if (record?.active === true) {
      describe(record, observation)
      record.clearSinceElapsedMs = null
      continue
    }
    if (!observation.raising) {
      state.pendingSinceElapsedMs.delete(observation.id)
      continue
    }
    const since = state.pendingSinceElapsedMs.get(observation.id) ?? elapsedMs
    state.pendingSinceElapsedMs.set(observation.id, since)
    const delayed = elapsedMs - since < observation.timing.raiseDelaySeconds * 1_000
    const tooSoon = record !== undefined && elapsedMs - record.lastTransitionElapsedMs < intervalMs
    if (delayed || tooSoon) continue
    state.pendingSinceElapsedMs.delete(observation.id)
    raise(grid, observation, record, at, elapsedMs)
  }
  // A condition that produced no observation is below its clear limit or no longer applies (an
  // island that merged away, a branch that opened): its clear condition holds.
  for (const id of state.pendingSinceElapsedMs.keys()) if (!visited.has(id)) state.pendingSinceElapsedMs.delete(id)
  for (const record of [...state.records.values()]) {
    if (visited.has(record.id)) continue
    if (record.active) {
      tryClear(grid, record, at, elapsedMs, intervalMs)
      continue
    }
    if (record.acknowledged && !gridAlarmShelved(record) && elapsedMs - record.lastTransitionElapsedMs >= intervalMs) state.records.delete(record.id)
  }
}

export type GridAlarmLifecycleAction =
  | { readonly action: 'acknowledge' }
  | { readonly action: 'shelve'; readonly shelveSeconds: number }
  | { readonly action: 'unshelve' }

/**
 * Applies one lifecycle action to alarm records: acknowledgement, time-limited shelving (which also
 * acknowledges) or unshelving. It changes alarm state only, never the network. Every id must name a
 * record the action changes, or nothing is applied.
 */
export const applyGridAlarmLifecycle = (grid: GridRuntimeInstance, alarmIds: ReadonlyArray<string>, lifecycle: GridAlarmLifecycleAction, reason: string | null): void => {
  const clock = grid.alarms.clock
  if (clock === null) throw new Error(`Grid ${grid.definition.gridId} has not evaluated its alarms yet; advance the Grid first`)
  if (new Set(alarmIds).size !== alarmIds.length) throw new Error('alarm ids must be unique')
  const records = alarmIds.map(id => {
    const record = grid.alarms.records.get(id)
    if (!record) throw new Error(`Grid alarm not found: ${id}. Discover current alarm ids with world.electric-grid.alarms.list.`)
    return record
  })
  const unchanged = records.filter(record => lifecycle.action === 'acknowledge'
    ? record.acknowledged
    : lifecycle.action === 'unshelve' ? !gridAlarmShelved(record) : false)
  if (unchanged.length > 0) {
    const state = lifecycle.action === 'acknowledge' ? 'already acknowledged' : 'not shelved'
    throw new Error(`alarm ${unchanged.map(record => record.id).join(', ')} ${unchanged.length === 1 ? 'is' : 'are'} ${state}; nothing was changed`)
  }
  const extra = reason === null ? {} : { reason }
  for (const record of records) {
    if (lifecycle.action === 'acknowledge') {
      record.acknowledged = true
      record.acknowledgedAt = clock.at
      queueTransition(grid, record, 'acknowledged', clock.elapsedMs, clock.at, extra)
    } else if (lifecycle.action === 'shelve') {
      record.shelvedUntilElapsedMs = clock.elapsedMs + lifecycle.shelveSeconds * 1_000
      record.shelvedUntil = new Date(Date.parse(clock.at) + lifecycle.shelveSeconds * 1_000).toISOString() as IsoTimestamp
      if (!record.acknowledged) {
        record.acknowledged = true
        record.acknowledgedAt = clock.at
      }
      queueTransition(grid, record, 'shelved', clock.elapsedMs, clock.at, extra)
    } else {
      record.shelvedUntil = null
      record.shelvedUntilElapsedMs = null
      queueTransition(grid, record, 'unshelved', clock.elapsedMs, clock.at, extra)
    }
  }
}

export interface GridAlarmCounts {
  /** Active alarms that are not shelved. */
  readonly active: number
  /** Unshelved alarms not acknowledged, active or cleared. */
  readonly unacknowledged: number
  /** Active unshelved alarms not acknowledged. */
  readonly activeUnacknowledged: number
  readonly shelved: number
  /** Most urgent priority among active unshelved alarms; null when none. */
  readonly highestPriority: GridAlarmPriority | null
  /** Earliest raise time among active unshelved alarms. */
  readonly oldestActiveRaisedAt: IsoTimestamp | null
  /** Active unshelved island-scope alarms per island. */
  readonly activeByIsland: ReadonlyMap<string, number>
}

export const gridAlarmCounts = (grid: GridRuntimeInstance): GridAlarmCounts => {
  let active = 0
  let unacknowledged = 0
  let activeUnacknowledged = 0
  let shelved = 0
  let highestPriority: GridAlarmPriority | null = null
  let oldest: GridAlarmRecord | null = null
  const activeByIsland = new Map<string, number>()
  for (const record of grid.alarms.records.values()) {
    if (gridAlarmShelved(record)) {
      shelved += 1
      continue
    }
    if (!record.acknowledged) unacknowledged += 1
    if (!record.active) continue
    active += 1
    if (!record.acknowledged) activeUnacknowledged += 1
    if (highestPriority === null || record.priority < highestPriority) highestPriority = record.priority
    if (oldest === null || record.raisedAtElapsedMs < oldest.raisedAtElapsedMs) oldest = record
    if (record.scope === 'island') activeByIsland.set(record.assetId, (activeByIsland.get(record.assetId) ?? 0) + 1)
  }
  return { active, unacknowledged, activeUnacknowledged, shelved, highestPriority, oldestActiveRaisedAt: oldest?.raisedAt ?? null, activeByIsland }
}
