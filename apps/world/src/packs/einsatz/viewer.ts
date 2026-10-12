import type { RoleSees, RunViewer, ScenarioRole } from '../../core/model/index.ts'
import { commandsEveryUnit, type EngineActor } from './engine/intents.ts'
import { notInPicture, refused, type Refused } from './engine/intent-support.ts'
import type { Catalog, TaskRecord, UnitRecord } from './engine/model.ts'
import { commandsUnit as pictureCommandsUnit, inPicture as pictureInPicture, queuesTask as pictureQueuesTask, roleCommands, type PictureTypes, type PictureViewer } from './picture.ts'

/**
 * Who a call to Einsatz plays. Every authority check, the commandable set,
 * recommendation candidates and controller-only checks read this one value;
 * none reads a role, side or caller another way.
 *
 * - `class`: a controller commands every unit and queues every task template;
 *   an operator commands what its roles' authority entries select.
 * - `sees`: the sides whose picture the caller holds, or the whole truth.
 * - `roles`: each held role as the Scenario declares it, in the order the
 *   caller holds them; none in open mode. A role commands and
 *   queues only within its own picture, so a role set commands the union of
 *   what each of its roles commands, never a role's selector across another
 *   role's sides. A side role commands only units of its sides, never a
 *   public one.
 *
 * It is a `PictureViewer`, so the engine and the Board read it through the
 * same picture rules.
 */
export interface EinsatzViewer extends PictureViewer {
  readonly class: 'controller' | 'operator'
  readonly sees: RoleSees
  readonly roles: ReadonlyArray<ScenarioRole>
}

/** Open mode and the Scenario timeline: no role, the whole truth, commanding every unit. */
export const openViewer: EinsatzViewer = Object.freeze({ class: 'controller', sees: 'all', roles: Object.freeze([]) })

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
  return { class: viewer.class, sees: viewer.sees, roles }
}

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

/**
 * The configuration the shared picture rules read, per catalog. The rules
 * themselves live in `picture.ts`, which the Board loads in the browser, so
 * the engine and the Board apply one statement of who sees, commands and
 * queues which record.
 */
const pictureTypesByCatalog = new WeakMap<Catalog, PictureTypes>()
const pictureTypes = (catalog: Catalog): PictureTypes => {
  const known = pictureTypesByCatalog.get(catalog)
  if (known !== undefined) return known
  const types: PictureTypes = {
    authority: catalog.config.authority,
    unitType: unitTypeId => {
      const type = catalog.types.get(unitTypeId)
      if (type === undefined) throw new Error(`Unit type ${unitTypeId} is not declared`)
      return type
    },
  }
  pictureTypesByCatalog.set(catalog, types)
  return types
}

/** Whether a viewer's picture holds a record: the union of its roles' pictures. */
export const inPicture = (catalog: Catalog, viewer: EinsatzViewer, record: UnitRecord | TaskRecord): boolean =>
  pictureInPicture(pictureTypes(catalog), viewer, record)

/** The commandable set (§3.1): a controller commands every unit in its picture; an operator, the union of what each of its roles commands. */
export const commandsUnit = (catalog: Catalog, viewer: EinsatzViewer, unit: UnitRecord): boolean =>
  pictureCommandsUnit(pictureTypes(catalog), viewer, unit)

/** A task is in a viewer's queue when it is in its picture and a controller holds it, or one of its roles queues it. */
export const queuesTask = (catalog: Catalog, viewer: EinsatzViewer, task: TaskRecord): boolean =>
  pictureQueuesTask(pictureTypes(catalog), viewer, task)

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
  const commanders = declared.filter(role => role.class === 'operator' && roleCommands(pictureTypes(catalog), role, unit)).map(role => role.label)
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
