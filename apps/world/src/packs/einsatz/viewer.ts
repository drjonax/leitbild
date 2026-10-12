import type { RoleSees, RunViewer, ScenarioRole } from '../../core/model/index.ts'
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
 * - `roles`: each held role as the Scenario declares it. A role commands and
 *   queues only within its own picture, so a role set commands the union of
 *   what each of its roles commands, never a role's selector across another
 *   role's sides. A side role commands only units of its sides, never a
 *   public one.
 */
export interface EinsatzViewer {
  readonly roleIds: ReadonlyArray<string>
  readonly class: 'controller' | 'operator'
  readonly sees: RoleSees
  readonly roles: ReadonlyArray<ScenarioRole>
}

/** Open mode and the Scenario timeline: no role, the whole truth, commanding every unit. */
export const openViewer: EinsatzViewer = Object.freeze({ roleIds: Object.freeze([]), class: 'controller', sees: 'all', roles: Object.freeze([]) })

/**
 * The viewer of a call: the RunViewer core stamps from the caller's
 * connection, never from input, read against the roles the Run declares. No
 * viewer is open mode or the Scenario timeline, which play the truth. A role
 * the Run does not declare breaks core's stamping and is an error, never read
 * as open mode.
 */
export const resolveViewer = (viewer: RunViewer | undefined, declared: ReadonlyArray<ScenarioRole>): EinsatzViewer => {
  if (viewer === undefined) return openViewer
  const roles = viewer.roleIds.map(roleId => {
    const role = declared.find(entry => entry.id === roleId)
    if (role === undefined) throw new Error(`The caller holds role ${roleId}, which this Run does not declare`)
    return role
  })
  return { roleIds: roles.map(role => role.id), class: viewer.class, sees: viewer.sees, roles }
}

/** What one role sees: its declared `sees`; in a Run without sides a role declares none and sees everything. */
const seesOf = (role: ScenarioRole): RoleSees => role.sees ?? 'all'

/** "A", "A and B", "A, B and C". */
export const listText = (words: ReadonlyArray<string>): string =>
  words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`

/** A set of roles by their labels, in the order given: how `lastAction.by` and refusals name the roles a caller holds. */
export const rolesText = (roles: ReadonlyArray<ScenarioRole>): string => listText(roles.map(role => role.label))

/**
 * Who `lastAction.by` names for a call: the labels of the roles the caller
 * holds, or, in open mode and for the Scenario timeline, the core actor.
 */
export const attributionOf = (viewer: EinsatzViewer, actorId: string): string =>
  viewer.roles.length === 0 ? actorId : rolesText(viewer.roles)

/** A record is in a picture that holds the truth, and otherwise when it is public or of a side the picture holds. */
const inPictureOf = (catalog: Catalog, sees: RoleSees, record: UnitRecord | TaskRecord): boolean => {
  if (sees === 'all') return true
  if (record.type === 'unit' && unitTypeOf(catalog, record).public) return true
  return record.side !== undefined && sees.includes(record.side)
}

/** Whether a viewer's picture holds a record: the union of its roles' pictures. */
export const inPicture = (catalog: Catalog, viewer: EinsatzViewer, record: UnitRecord | TaskRecord): boolean =>
  inPictureOf(catalog, viewer.sees, record)

const authorityOf = (catalog: Catalog, role: ScenarioRole): Authority | undefined =>
  catalog.config.authority.find(entry => entry.roleId === role.id)

const selects = (catalog: Catalog, entry: Authority, unit: UnitRecord): boolean => {
  const selector = entry.units
  if ('all' in selector) return true
  if ('types' in selector) return selector.types.includes(unit.unitType)
  const tags = unitTypeOf(catalog, unit).tags
  return selector.tags.some(tag => tags.includes(tag))
}

/**
 * Whether a role's own `sees` lets it command a unit: a role seeing the truth
 * commands any unit; a side role only units of a side it sees. A public unit
 * has no side, so no side role commands it, though every side sees it.
 */
const commandableBy = (sees: RoleSees, unit: UnitRecord): boolean =>
  sees === 'all' || (unit.side !== undefined && sees.includes(unit.side))

/** One role's commandable set: a controller role commands every unit; an operator role, the units its authority selects on a side it sees. */
const roleCommands = (catalog: Catalog, role: ScenarioRole, unit: UnitRecord): boolean => {
  if (role.class === 'controller') return true
  const entry = authorityOf(catalog, role)
  return entry !== undefined && selects(catalog, entry, unit) && commandableBy(seesOf(role), unit)
}

/** One role's queue: a controller role queues every task; an operator role, its authority's templates within its own picture. */
const roleQueues = (catalog: Catalog, role: ScenarioRole, task: TaskRecord): boolean => {
  if (role.class === 'controller') return true
  return authorityOf(catalog, role)?.taskTemplates.includes(task.template) === true && inPictureOf(catalog, seesOf(role), task)
}

/** The commandable set (§3.1): a controller commands every unit in its picture; an operator, the union of what each of its roles commands. */
export const commandsUnit = (catalog: Catalog, viewer: EinsatzViewer, unit: UnitRecord): boolean =>
  inPicture(catalog, viewer, unit) && (viewer.class === 'controller' || viewer.roles.some(role => roleCommands(catalog, role, unit)))

/** A task is in a viewer's queue when it is in its picture and a controller holds it, or one of its roles queues it. */
export const queuesTask = (catalog: Catalog, viewer: EinsatzViewer, task: TaskRecord): boolean =>
  inPicture(catalog, viewer, task) && (viewer.class === 'controller' || viewer.roles.some(role => roleQueues(catalog, role, task)))

const heldText = (viewer: EinsatzViewer): string => rolesText(viewer.roles)

/**
 * Refused unless the viewer commands the unit; a unit outside its picture is
 * not echoed. The refusal names, by label, the operator roles of the Run
 * that do command the unit, so the screen can add one.
 */
export const unitAuthority = (catalog: Catalog, viewer: EinsatzViewer, declared: ReadonlyArray<ScenarioRole>, unit: UnitRecord): Refused | undefined => {
  if (!inPicture(catalog, viewer, unit)) return notInPicture()
  if (commandsUnit(catalog, viewer, unit)) return undefined
  const denied = `${heldText(viewer)} ${viewer.roles.length === 1 ? 'does' : 'do'} not command ${unit.label}`
  const commanders = declared.filter(role => role.class === 'operator' && roleCommands(catalog, role, unit)).map(role => role.label)
  return refused('unit_not_authorized', commanders.length === 0
    ? `${denied}, and no operator role does`
    : `${denied}. It belongs to ${listText(commanders)}: add ${commanders.length === 1 ? 'that role' : 'one of those roles'} to command it`)
}

/**
 * Refused unless the task is in the viewer's queue; a task outside its
 * picture is not echoed. Recommendations and closing a task answer for the
 * viewer's work list only; sends take any task in the picture.
 */
export const taskAuthority = (catalog: Catalog, viewer: EinsatzViewer, task: TaskRecord): Refused | undefined => {
  if (!inPicture(catalog, viewer, task)) return notInPicture()
  return queuesTask(catalog, viewer, task) ? undefined : refused('task_not_in_role_queue', `${task.label} is not in the queue of ${heldText(viewer)}`)
}

/** Controller-only Capabilities: creating units and tasks, and adjusting property values. */
export const controllerOnly = (viewer: EinsatzViewer, what: string): Refused | undefined =>
  viewer.class === 'controller' ? undefined : refused('role_controller_only', `${what} needs a controller role`)

/** The engine actor a viewer acts as: its attribution and its commandable set. */
export const actorFor = (catalog: Catalog, viewer: EinsatzViewer, by: string): EngineActor => ({
  by,
  commandable: viewer.class === 'controller' && viewer.sees === 'all' ? commandsEveryUnit : unit => commandsUnit(catalog, viewer, unit),
})
