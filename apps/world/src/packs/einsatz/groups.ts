import type { ScenarioRole } from '../../core/model/index.ts'
import type { PackScenarioRolesContext } from '../../core/packs/protocol.ts'
import { einsatzConfigShapeSchema, type Group } from './config-schema.ts'
import { groupRoleId } from './ids.ts'

/**
 * Groups as roles. Each declared group becomes one operator role, which core
 * adds to the Scenario's declared roles at compile (`WorldPack.scenarioRoles`):
 * its id is `group:<group id>`, its label the group's label, its category the
 * group's category, and it sees the group's side, or everything in a Scenario
 * without sides. It commands exactly the group's units, and its queue holds
 * the tasks of its picture that those units can serve (`picture.ts`).
 */
export const groupRole = (group: Group, sided: boolean): ScenarioRole => ({
  id: groupRoleId(group.id),
  label: group.label,
  class: 'operator',
  category: group.category,
  // A sided Scenario's group without a side is refused (`group_side_required`) before its role compiles.
  ...(sided && group.side !== undefined ? { sees: [group.side] } : {}),
})

/** The roles an Einsatz configuration derives: one per declared group, in declaration order. */
export const einsatzScenarioRoles = (raw: unknown, context: PackScenarioRolesContext): ReadonlyArray<ScenarioRole> =>
  einsatzConfigShapeSchema.parse(raw).groups.map(group => groupRole(group, context.sides.length > 0))
