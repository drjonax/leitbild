import type { RoleClass, RoleSees } from '../../core/model/index.ts'
import type { Authority, TaskTemplate, UnitType } from './config-schema.ts'
import { groupOfRoleId, groupRoleId } from './ids.ts'

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
 * - A group's role (`group:<id>`, derived from a declared group) commands
 *   exactly the units of its group, and queues the tasks of its picture that
 *   those units can serve: a requirement one of their types provides, or a
 *   load class one of them carries. Which types a group holds is Run state,
 *   so the queue reads it from the units the caller holds (`GroupUnitTypes`).
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

/** The configuration the rules read: authority entries, each unit type's visibility, tags and components, and each template's requirements. */
export interface PictureTypes {
  readonly authority: ReadonlyArray<Authority>
  readonly unitType: (unitTypeId: string) => Pick<UnitType, 'public' | 'tags' | 'components'>
  readonly taskTemplate: (templateId: string) => Pick<TaskTemplate, 'requires'>
}

export interface PictureUnit {
  readonly type: 'unit'
  readonly unitType: string
  readonly side?: string | undefined
  readonly group?: string | undefined
}
export interface PictureTask {
  readonly type: 'task'
  readonly template: string
  readonly side?: string | undefined
  /** Load waiting and load picked up, per class: what a carrier could serve. */
  readonly loads: Readonly<Record<string, number>>
  readonly pickedUp: Readonly<Record<string, number>>
}

/** The unit types the units of a group have now; none for a group without units. */
export type GroupUnitTypes = (groupId: string) => ReadonlyArray<string>

/** The unit types of each group among these units, in the order first met. */
export const groupUnitTypesOf = (units: Iterable<PictureUnit>): GroupUnitTypes => {
  const byGroup = new Map<string, string[]>()
  for (const unit of units) {
    if (unit.group === undefined) continue
    const known = byGroup.get(unit.group) ?? []
    if (!known.includes(unit.unitType)) known.push(unit.unitType)
    byGroup.set(unit.group, known)
  }
  return groupId => byGroup.get(groupId) ?? []
}

/** Whether units of these types can serve a task: one provides a requirement of its template, or carries a class of its load. */
const typesServe = (types: PictureTypes, unitTypeIds: ReadonlyArray<string>, task: PictureTask): boolean => {
  const required = types.taskTemplate(task.template).requires.map(requirement => requirement.provides)
  const classes = [...Object.keys(task.loads), ...Object.keys(task.pickedUp)]
  return unitTypeIds.some(unitTypeId => {
    const { service, carry } = types.unitType(unitTypeId).components
    return service?.provides.some(provided => required.includes(provided)) === true || carry?.classes.some(carried => classes.includes(carried)) === true
  })
}

/** The group a held role plays, when it is a group's operator role. */
const groupOf = (role: PictureRole): string | undefined => role.class === 'operator' ? groupOfRoleId(role.id) : undefined

const seesOf = (role: PictureRole): RoleSees => role.sees ?? 'all'

const inPictureOf = (types: PictureTypes, sees: RoleSees, record: PictureUnit | PictureTask): boolean => {
  if (sees === 'all') return true
  if (record.type === 'unit' && types.unitType(record.unitType).public === true) return true
  return record.side !== undefined && sees.includes(record.side)
}

/** Whether a viewer's picture holds a record: the union of its roles' pictures. */
export const inPicture = (types: PictureTypes, viewer: PictureViewer, record: PictureUnit | PictureTask): boolean =>
  inPictureOf(types, viewer.sees, record)

/**
 * The See display filter: whether the screen chose not to see the role of
 * a unit's group (the role dialog's See boxes, given as the roles it shows;
 * absent in open mode). Such a unit is drawn nowhere on that screen, on the
 * map or in the Board, even where another held role commands it. It is
 * this tab's choice only; what a side sees stays the Run's.
 */
export const groupUnseen = (group: string | undefined, seenRoleIds: ReadonlyArray<string> | undefined): boolean =>
  group !== undefined && seenRoleIds !== undefined && !seenRoleIds.includes(groupRoleId(group))

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

/**
 * One role's commandable set: a controller role commands every unit; a
 * group's role, the units of its group; another operator role, the units its
 * authority selects; an operator role only on a side it sees.
 */
export const roleCommands = (types: PictureTypes, role: PictureRole, unit: PictureUnit): boolean => {
  if (role.class === 'controller') return true
  const group = groupOf(role)
  if (group !== undefined) return unit.group === group && commandableBy(seesOf(role), unit)
  const entry = authorityOf(types, role)
  return entry !== undefined && selectsType(entry.units, unit.unitType, types.unitType(unit.unitType).tags) && commandableBy(seesOf(role), unit)
}

const roleQueues = (types: PictureTypes, role: PictureRole, task: PictureTask, groups: GroupUnitTypes): boolean => {
  if (role.class === 'controller') return true
  if (!inPictureOf(types, seesOf(role), task)) return false
  const group = groupOf(role)
  if (group !== undefined) return typesServe(types, groups(group), task)
  return authorityOf(types, role)?.taskTemplates.includes(task.template) === true
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
export const queuesTask = (types: PictureTypes, viewer: PictureViewer, task: PictureTask, groups: GroupUnitTypes): boolean =>
  inPicture(types, viewer, task) && (viewer.class === 'controller' || viewer.roles.some(role => roleQueues(types, role, task, groups)))

/**
 * The declared unit types an operator's roles select, and those its groups'
 * units have: what its unit board and arrangement draw on. A controller holds
 * them all.
 */
export const commandedTypes = <T extends Pick<UnitType, 'id' | 'tags'>>(types: PictureTypes, viewer: PictureViewer, unitTypes: ReadonlyArray<T>, groups: GroupUnitTypes): ReadonlyArray<T> => {
  if (viewer.class === 'controller') return unitTypes
  const operators = viewer.roles.filter(role => role.class === 'operator')
  const entries = operators.flatMap(role => {
    const entry = groupOf(role) === undefined ? authorityOf(types, role) : undefined
    return entry === undefined ? [] : [entry]
  })
  const grouped = new Set(operators.flatMap(role => {
    const group = groupOf(role)
    return group === undefined ? [] : groups(group)
  }))
  return unitTypes.filter(type => grouped.has(type.id) || entries.some(entry => selectsType(entry.units, type.id, type.tags)))
}

/**
 * Whether an operator's queue can ever hold a task: a role's authority names
 * a template, or a group's units provide a service or carry load. A
 * controller's can whenever templates are declared.
 */
export const queuesAnyTask = (types: PictureTypes, viewer: PictureViewer, templates: ReadonlyArray<Pick<TaskTemplate, 'id'>>, groups: GroupUnitTypes): boolean => {
  if (viewer.class === 'controller') return templates.length > 0
  return viewer.roles.some(role => {
    if (role.class !== 'operator') return false
    const group = groupOf(role)
    if (group === undefined) return (authorityOf(types, role)?.taskTemplates.length ?? 0) > 0
    return groups(group).some(unitTypeId => {
      const { service, carry } = types.unitType(unitTypeId).components
      return service !== undefined || carry !== undefined
    })
  })
}
