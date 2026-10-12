import type { Authority } from './config-schema.ts'
import { commandsEveryUnit, type EngineActor } from './engine/intents.ts'
import { notInPicture, refused, type Refused } from './engine/intent-support.ts'
import { unitTypeOf, type Catalog, type TaskRecord, type UnitRecord } from './engine/model.ts'

/**
 * Who a call to Einsatz plays. Every authority check, the commandable set,
 * recommendation candidates and controller-only checks read this one value;
 * none reads a role, side or caller another way.
 *
 * - `roleIds`: the Scenario roles held, in declared order; none in open mode.
 * - `class`: a controller commands every unit and queues every task template;
 *   an operator commands what its roles' authority entries select.
 * - `sees`: the sides whose picture the caller holds, or the whole truth.
 */
export interface EinsatzViewer {
  readonly roleIds: ReadonlyArray<string>
  readonly class: 'controller' | 'operator'
  readonly sees: 'all' | ReadonlyArray<string>
}

/** Open mode: a Run without roles. Every caller holds the truth and commands every unit. */
export const openViewer: EinsatzViewer = Object.freeze({ roleIds: Object.freeze([]), class: 'controller', sees: 'all' })

/**
 * What core passes with a call. A command envelope carries the screen's
 * role set only in a Run that declares roles; a query carries nothing.
 */
export interface CoreCallContext {
  readonly roleIds?: ReadonlyArray<string>
}

/**
 * The viewer of a call, from what core passes. Einsatz is not role-aware
 * yet, so compiling a role Run with it is refused and core never passes a
 * role set; nothing passed is open mode. A role set reaching Einsatz breaks
 * that invariant and is an error, never read as open mode.
 */
export const resolveViewer = (context: CoreCallContext): EinsatzViewer => {
  if (context.roleIds !== undefined) throw new Error(`Einsatz is not role-aware, so no role Run can call it (roles ${context.roleIds.join(', ')})`)
  return openViewer
}

/** The authority entries of the roles a viewer holds. */
const authorityOf = (catalog: Catalog, viewer: EinsatzViewer): ReadonlyArray<Authority> =>
  catalog.config.authority.filter(entry => viewer.roleIds.includes(entry.roleId))

const selects = (catalog: Catalog, entry: Authority, unit: UnitRecord): boolean => {
  const selector = entry.units
  if ('all' in selector) return true
  if ('types' in selector) return selector.types.includes(unit.unitType)
  const tags = unitTypeOf(catalog, unit).tags
  return selector.tags.some(tag => tags.includes(tag))
}

/** A record is in a viewer's picture when the viewer holds the truth, or the record is public or of a side it sees. */
export const inPicture = (catalog: Catalog, viewer: EinsatzViewer, record: UnitRecord | TaskRecord): boolean => {
  if (viewer.sees === 'all') return true
  if (record.type === 'unit' && unitTypeOf(catalog, record).public) return true
  return record.side !== undefined && viewer.sees.includes(record.side)
}

/** The commandable set: a controller commands every unit in its picture; an operator, those its roles' authority selects. */
export const commandsUnit = (catalog: Catalog, viewer: EinsatzViewer, unit: UnitRecord): boolean =>
  inPicture(catalog, viewer, unit) && (viewer.class === 'controller' || authorityOf(catalog, viewer).some(entry => selects(catalog, entry, unit)))

/** A task is in a viewer's queue when it is in its picture and a controller holds it, or one of its roles queues the task's template. */
export const queuesTask = (catalog: Catalog, viewer: EinsatzViewer, task: TaskRecord): boolean =>
  inPicture(catalog, viewer, task) && (viewer.class === 'controller' || authorityOf(catalog, viewer).some(entry => entry.taskTemplates.includes(task.template)))

/** Refused unless the viewer commands the unit; a unit outside its picture is not echoed. */
export const unitAuthority = (catalog: Catalog, viewer: EinsatzViewer, unit: UnitRecord): Refused | undefined => {
  if (!inPicture(catalog, viewer, unit)) return notInPicture()
  if (commandsUnit(catalog, viewer, unit)) return undefined
  const commanders = catalog.config.authority.filter(entry => selects(catalog, entry, unit)).map(entry => entry.roleId)
  return refused('unit_not_authorized', commanders.length === 0
    ? `${unit.label} is commanded by no role`
    : `${unit.label} belongs to ${commanders.join(', ')}. Add that role to command it`)
}

/** Refused unless the task is in the viewer's queue; a task outside its picture is not echoed. */
export const taskAuthority = (catalog: Catalog, viewer: EinsatzViewer, task: TaskRecord): Refused | undefined => {
  if (!inPicture(catalog, viewer, task)) return notInPicture()
  return queuesTask(catalog, viewer, task) ? undefined : refused('task_not_in_role_queue', `${task.label} is not in your roles' queue`)
}

/** Controller-only Capabilities: creating units and tasks, and adjusting property values. */
export const controllerOnly = (viewer: EinsatzViewer, what: string): Refused | undefined =>
  viewer.class === 'controller' ? undefined : refused('role_controller_only', `${what} needs a controller role`)

/** The engine actor a viewer acts as: its attribution and its commandable set. */
export const actorFor = (catalog: Catalog, viewer: EinsatzViewer, by: string): EngineActor => ({
  by,
  commandable: viewer.class === 'controller' && viewer.sees === 'all' ? commandsEveryUnit : unit => commandsUnit(catalog, viewer, unit),
})
