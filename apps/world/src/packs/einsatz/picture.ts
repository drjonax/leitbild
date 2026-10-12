import type { RoleClass, RoleSees } from '../../core/model/index.ts'
import type { Authority, UnitType } from './config-schema.ts'

/**
 * Who sees, commands and queues which Einsatz record (§3.1), as pure rules
 * over the configuration. They import nothing from the engine, so the Board
 * applies them in the browser exactly as written here.
 *
 * - The picture is the union of the held roles' `sees`: the whole truth, or
 *   the records of the sides seen and every public unit.
 * - A role commands and queues only within its own picture: a role set
 *   commands the union of what each of its roles commands, never one role's
 *   selector across another role's sides. A side role commands only units of
 *   its sides, never a public one, though every side sees it.
 * - A controller-class viewer commands every unit and queues every task in
 *   its picture.
 */

/** A held role as the Scenario declares it; without sides a role declares no `sees` and sees everything. */
export interface PictureRole {
  readonly id: string
  readonly class: RoleClass
  readonly sees?: RoleSees | undefined
}

/** A screen's role set: its class, the union of its roles' pictures, and the roles themselves. */
export interface PictureViewer {
  readonly class: RoleClass
  readonly sees: RoleSees
  readonly roles: ReadonlyArray<PictureRole>
}

/** Open mode: no role, the whole truth, commanding every unit. */
export const openModeViewer: PictureViewer = Object.freeze({ class: 'controller', sees: 'all', roles: Object.freeze([]) })

/** The configuration the rules read: authority entries and each unit type's visibility, tags and components. */
export interface PictureTypes {
  readonly authority: ReadonlyArray<Authority>
  readonly unitType: (unitTypeId: string) => Pick<UnitType, 'public' | 'tags' | 'components'>
}

export interface PictureUnit {
  readonly type: 'unit'
  readonly unitType: string
  readonly side?: string | undefined
}
export interface PictureTask {
  readonly type: 'task'
  readonly template: string
  readonly side?: string | undefined
}

const seesOf = (role: PictureRole): RoleSees => role.sees ?? 'all'

const inPictureOf = (types: PictureTypes, sees: RoleSees, record: PictureUnit | PictureTask): boolean => {
  if (sees === 'all') return true
  if (record.type === 'unit' && types.unitType(record.unitType).public === true) return true
  return record.side !== undefined && sees.includes(record.side)
}

/** Whether a viewer's picture holds a record: the union of its roles' pictures. */
export const inPicture = (types: PictureTypes, viewer: PictureViewer, record: PictureUnit | PictureTask): boolean =>
  inPictureOf(types, viewer.sees, record)

/** Whether a selector picks a unit type, by id, by tag or all. */
export const selectsType = (selector: Authority['units'], unitTypeId: string, tags: ReadonlyArray<string>): boolean => {
  if ('all' in selector) return true
  if ('types' in selector) return selector.types.includes(unitTypeId)
  return selector.tags.some(tag => tags.includes(tag))
}

const authorityOf = (types: PictureTypes, role: PictureRole): Authority | undefined =>
  types.authority.find(entry => entry.roleId === role.id)

/** A role seeing the truth commands any unit; a side role only units of a side it sees, so never a public one. */
const commandableBy = (sees: RoleSees, unit: PictureUnit): boolean =>
  sees === 'all' || (unit.side !== undefined && sees.includes(unit.side))

/** One role's commandable set: a controller role commands every unit; an operator role, the units its authority selects on a side it sees. */
export const roleCommands = (types: PictureTypes, role: PictureRole, unit: PictureUnit): boolean => {
  if (role.class === 'controller') return true
  const entry = authorityOf(types, role)
  return entry !== undefined && selectsType(entry.units, unit.unitType, types.unitType(unit.unitType).tags) && commandableBy(seesOf(role), unit)
}

const roleQueues = (types: PictureTypes, role: PictureRole, task: PictureTask): boolean => {
  if (role.class === 'controller') return true
  return authorityOf(types, role)?.taskTemplates.includes(task.template) === true && inPictureOf(types, seesOf(role), task)
}

/** The commandable set: a controller commands every unit in its picture; an operator, the union of what each of its roles commands. */
export const commandsUnit = (types: PictureTypes, viewer: PictureViewer, unit: PictureUnit): boolean =>
  inPicture(types, viewer, unit) && (viewer.class === 'controller' || viewer.roles.some(role => roleCommands(types, role, unit)))

/**
 * The units a screen gives orders by map clicks, so a click on one selects
 * it: the commandable set's units that can move. A receiving site never
 * moves, so a click on one while a unit is selected is that unit's target,
 * never a new selection. This is the Pack's `targeting.isController`.
 */
export const ordersOnMap = (types: PictureTypes, viewer: PictureViewer, unit: PictureUnit): boolean =>
  commandsUnit(types, viewer, unit) && types.unitType(unit.unitType).components.mobility !== undefined

/** The queue: a controller queues every task in its picture; an operator, the union of its roles' queues, each within its own picture. */
export const queuesTask = (types: PictureTypes, viewer: PictureViewer, task: PictureTask): boolean =>
  inPicture(types, viewer, task) && (viewer.class === 'controller' || viewer.roles.some(role => roleQueues(types, role, task)))

/** The declared unit types an operator's roles select: what its unit board and arrangement draw on. A controller holds them all. */
export const commandedTypes = <T extends Pick<UnitType, 'id' | 'tags'>>(types: PictureTypes, viewer: PictureViewer, unitTypes: ReadonlyArray<T>): ReadonlyArray<T> => {
  if (viewer.class === 'controller') return unitTypes
  const entries = viewer.roles.flatMap(role => {
    const entry = role.class === 'operator' ? authorityOf(types, role) : undefined
    return entry === undefined ? [] : [entry]
  })
  return unitTypes.filter(type => entries.some(entry => selectsType(entry.units, type.id, type.tags)))
}
