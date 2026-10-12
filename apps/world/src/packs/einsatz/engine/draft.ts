import type { Sighting, TrackRecord, UnitCombat } from './combat-model.ts'
import type { Catalog, EngineState, TaskRecord, Transition, UnitMotion, UnitRecord } from './model.ts'
import { patch, sameValue } from './values.ts'

/**
 * A working copy of the engine state for one engine call. The input state is
 * never mutated; the call returns a new state built from the draft. Unit
 * changes are transitions at the draft's time as they happen. Task changes
 * are staged and recorded by the task refresh, so a recorded task always
 * carries the coverage and rank of its own moment.
 */
export interface Draft {
  readonly catalog: Catalog
  readonly sides: ReadonlyArray<string>
  timeMs: number
  readonly units: Map<string, UnitRecord>
  readonly tasks: Map<string, TaskRecord>
  readonly recordedTasks: Map<string, TaskRecord>
  readonly motion: Map<string, UnitMotion>
  readonly combat: CombatDraft
  readonly transitions: Transition[]
}

/** The engagement state of a draft; only the engagement step changes tracks and records their transitions. */
export interface CombatDraft {
  cycleMs: number | undefined
  readonly tracks: Map<string, TrackRecord>
  readonly sightings: Map<string, Sighting>
  readonly units: Map<string, UnitCombat>
  readonly serials: Map<string, number>
}

export const openDraft = (state: EngineState): Draft => ({
  catalog: state.catalog,
  sides: state.sides,
  timeMs: state.timeMs,
  units: new Map(state.units),
  tasks: new Map(state.tasks),
  recordedTasks: new Map(state.tasks),
  motion: new Map(state.motion),
  combat: {
    cycleMs: state.combat.cycleMs,
    tracks: new Map(state.combat.tracks),
    sightings: new Map(state.combat.sightings),
    units: new Map(state.combat.units),
    serials: new Map(state.combat.serials),
  },
  transitions: [],
})

export const closeDraft = (draft: Draft): EngineState => ({
  catalog: draft.catalog,
  sides: draft.sides,
  timeMs: draft.timeMs,
  units: draft.units,
  tasks: draft.tasks,
  motion: draft.motion,
  combat: {
    ...(draft.combat.cycleMs === undefined ? {} : { cycleMs: draft.combat.cycleMs }),
    tracks: draft.combat.tracks,
    sightings: draft.combat.sightings,
    units: draft.combat.units,
    serials: draft.combat.serials,
  },
})

export const unitIn = (draft: { readonly units: ReadonlyMap<string, UnitRecord> }, id: string): UnitRecord => {
  const unit = draft.units.get(id)
  if (unit === undefined) throw new Error(`Einsatz unit not found: ${id}`)
  return unit
}

export const taskIn = (draft: { readonly tasks: ReadonlyMap<string, TaskRecord> }, id: string): TaskRecord => {
  const task = draft.tasks.get(id)
  if (task === undefined) throw new Error(`Einsatz task not found: ${id}`)
  return task
}

export const setMotion = (draft: Draft, unitId: string, changes: { readonly [K in keyof UnitMotion]?: UnitMotion[K] | undefined }): void => {
  const motion = draft.motion.get(unitId)
  if (motion === undefined) throw new Error(`${unitId}: no motion state`)
  draft.motion.set(unitId, patch(motion, changes))
}

/**
 * Stores a unit record. A changed record is a transition at the draft's time,
 * carrying the unit's position then, so set motion before the record. A new
 * phase restarts the clock of a failed reflex.
 */
export const putUnit = (draft: Draft, record: UnitRecord): UnitRecord => {
  const previous = draft.units.get(record.id)
  if (previous !== undefined && sameValue(previous, record)) return previous
  const motion = draft.motion.get(record.id)
  if (motion === undefined) throw new Error(`${record.id}: no motion state`)
  draft.units.set(record.id, record)
  const current = previous !== undefined && previous.phase !== record.phase ? patch(motion, { reflexAttemptMs: undefined }) : motion
  if (current !== motion) draft.motion.set(record.id, current)
  draft.transitions.push({ kind: 'unit', atMs: draft.timeMs, record, point: current.point, progressMs: current.progressMs })
  return record
}

/** Stages a task change; `recordTask` makes it a transition once its derived fields are current. */
export const stageTask = (draft: Draft, record: TaskRecord): TaskRecord => {
  draft.tasks.set(record.id, record)
  return record
}

export const recordTask = (draft: Draft, record: TaskRecord): void => {
  draft.tasks.set(record.id, record)
  const recorded = draft.recordedTasks.get(record.id)
  if (recorded === record || (recorded !== undefined && sameValue(recorded, record))) return
  draft.recordedTasks.set(record.id, record)
  draft.transitions.push({ kind: 'task', atMs: draft.timeMs, record })
}
