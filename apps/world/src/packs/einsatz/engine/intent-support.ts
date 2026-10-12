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

/**
 * "A2 now en route to C-20", worded from the unit's phase and task. It names
 * no actor: outside role Runs `lastAction.by` records a core actor id or a
 * standing order, not a word for people, and a Run without roles holds no
 * role to name, since every screen acts as the same operator.
 */
export const committedText = (state: EngineState, unit: UnitRecord): string => {
  const task = unit.taskId === undefined ? undefined : state.tasks.get(unit.taskId)
  const where = task === undefined ? '' : ` ${unit.phase === 'on-task' ? 'at' : 'to'} ${task.label}`
  return `${unit.label} now ${phaseWord(state.catalog, unit)}${where}`
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

/**
 * Group rules for a new unit: once the configuration declares groups, a unit
 * that is not of a public type names one of them, on its own side; a public
 * unit belongs to no side and so to no group; without declared groups a unit
 * names none.
 */
export const groupRefusal = (state: EngineState, intent: { readonly group?: string | undefined; readonly side?: string | undefined }, isPublic: boolean, label: string): Refused | undefined => {
  const groups = state.catalog.config.groups
  if (groups.length === 0) return intent.group === undefined ? undefined : refused('group_not_declared', `This configuration declares no groups, so "${intent.group}" is not one`)
  if (isPublic) return intent.group === undefined ? undefined : refused('public_takes_no_group', `${label} is public and belongs to no group`)
  if (intent.group === undefined) return refused('group_required', `Name a group: ${groups.map(group => group.id).join(', ')}`)
  const group = groups.find(entry => entry.id === intent.group)
  if (group === undefined) return refused('unknown_group', `Group "${intent.group}" is not declared`)
  return group.side === intent.side ? undefined : refused('group_side_mismatch', `Group "${group.id}" is on side "${group.side ?? 'none'}", not "${intent.side ?? 'none'}"`)
}
