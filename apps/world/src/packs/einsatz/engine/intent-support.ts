import { refusal, type EinsatzRefusalCode } from '../refusal.ts'
import type { Draft } from './draft.ts'
import type { EngineActor } from './intents.ts'
import { unitTypeOf, type EngineState, type LastAction, type UnitRecord } from './model.ts'
import { isDestroyed } from './rules.ts'
import { loadText, phaseWord, unitWord } from './wording.ts'

export interface Refused { readonly ok: false; readonly reason: string }

export const refused = (code: EinsatzRefusalCode, message: string): Refused => ({ ok: false, reason: refusal(code, message) })

/** An id the engine does not hold. No label is echoed. */
export const notInPicture = (): Refused => refused('not_in_picture', 'Not in your picture')

export const actionBy = (draft: Draft, actor: EngineActor, verb: LastAction['verb'], target?: string, cause?: string): LastAction => ({
  verb,
  by: actor.by,
  atMs: draft.timeMs,
  ...(target === undefined ? {} : { target }),
  ...(cause === undefined ? {} : { cause }),
})

/** "A2 now en route to C-20 · Dispatcher", worded from the unit's phase and last order. */
export const committedText = (state: EngineState, unit: UnitRecord): string => {
  const task = unit.taskId === undefined ? undefined : state.tasks.get(unit.taskId)
  const where = task === undefined ? '' : ` ${unit.phase === 'on-task' ? 'at' : 'to'} ${task.label}`
  const by = unit.lastAction === undefined ? '' : ` · ${unit.lastAction.by}`
  return `${unit.label} now ${phaseWord(state.catalog, unit)}${where}${by}`
}

export const loadedText = (state: EngineState, unit: UnitRecord): string =>
  `${unit.label} has ${loadText(state.catalog, unit.load)} on board, deliver first`

/** A unit that cannot move at all: destroyed, or of a type without mobility. */
export const immobile = (state: EngineState, unit: UnitRecord): Refused | undefined => {
  if (isDestroyed(unit)) return refused('unit_unavailable', `${unit.label} is ${unitWord(state.catalog, unit, 'destroyed')}`)
  if (unitTypeOf(state.catalog, unit).components.mobility === undefined) return refused('unit_unavailable', `${unit.label} cannot move`)
  return undefined
}

/**
 * Side rules for a new record: a public type takes no side; otherwise a
 * side is required exactly when the Run declares sides, and must be one.
 */
export const sideRefusal = (state: EngineState, side: string | undefined, isPublic: boolean, label: string): Refused | undefined => {
  if (isPublic) return side === undefined ? undefined : refused('public_takes_no_side', `${label} is public and belongs to no side`)
  if (state.sides.length === 0) return side === undefined ? undefined : refused('side_not_declared', `This Run declares no sides, so "${side}" is not one`)
  if (side === undefined) return refused('side_required', `Name a side: ${state.sides.join(', ')}`)
  return state.sides.includes(side) ? undefined : refused('side_not_declared', `Side "${side}" is not declared`)
}
