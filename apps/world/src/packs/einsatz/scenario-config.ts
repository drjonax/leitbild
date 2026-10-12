import type { PackScenarioConfigContext, PackScenarioConfigIssue } from '../../core/packs/protocol.ts'
import { einsatzConfigShapeSchema } from './config-schema.ts'
import { lastActionByMaxLength } from './engine/model.ts'
import { isStandingOrderBy, standingOrderByPrefix } from './ids.ts'
import { refusal, type ScenarioConfigRefusalCode } from './refusal.ts'
import { rolesText } from './viewer.ts'

/**
 * Checks an Einsatz configuration against the Scenario it runs in, each issue
 * at its path within the configuration:
 * - `authority` needs the Scenario to declare roles (`authority_without_roles`);
 * - each entry names a declared role (`authority_unknown_role`) that is an
 *   operator role, since a controller role commands every unit and queues
 *   every task template already (`controller_authority`);
 * - hostility is between declared sides (`unknown_side`);
 * - `lastAction.by` names a caller's roles by label, so the labels of every
 *   declared role, held at once, must fit it (`role_labels_too_long`, at the
 *   configuration as a whole): a Run must never write a record it cannot
 *   read back;
 * - no role's label starts as `lastAction.by` names a standing order
 *   (`role_label_reserved`, at the configuration as a whole), so a person's
 *   order never reads as a reflex's, neither to the withdraw reflex nor on
 *   the Board.
 */
export const validateEinsatzScenarioConfig = (raw: unknown, context: PackScenarioConfigContext): ReadonlyArray<PackScenarioConfigIssue> => {
  const config = einsatzConfigShapeSchema.parse(raw)
  const issue = (path: ReadonlyArray<string | number>, code: ScenarioConfigRefusalCode, message: string): PackScenarioConfigIssue =>
    ({ path, code, message: refusal(code, message) })
  const sides = new Set(context.sides.map(side => side.id))
  const undeclaredSide = (side: string) => context.sides.length === 0
    ? `Side "${side}" is not declared: the Scenario declares no sides`
    : `Side "${side}" is not declared; the Scenario declares ${context.sides.map(entry => entry.id).join(', ')}`
  const authority = context.roles.length === 0
    ? config.authority.length === 0 ? [] : [issue(['authority'], 'authority_without_roles', 'Authority names roles, but the Scenario declares none: without roles every screen commands every unit')]
    : config.authority.flatMap((entry, index) => {
      const role = context.roles.find(declared => declared.id === entry.roleId)
      if (role === undefined) return [issue(['authority', index, 'roleId'], 'authority_unknown_role', `Role "${entry.roleId}" is not declared`)]
      return role.class === 'controller'
        ? [issue(['authority', index, 'roleId'], 'controller_authority', `${role.label} is a controller role, which commands every unit and queues every task template; authority names operator roles only`)]
        : []
    })
  const hostility = Object.entries(config.hostility).flatMap(([side, hostile]) => [
    ...(sides.has(side) ? [] : [issue(['hostility', side], 'unknown_side', undeclaredSide(side))]),
    ...hostile.flatMap((other, index) => sides.has(other) ? [] : [issue(['hostility', side, index], 'unknown_side', undeclaredSide(other))]),
  ])
  const attribution = rolesText(context.roles)
  const labels = attribution.length <= lastActionByMaxLength ? [] : [issue([], 'role_labels_too_long',
    `The labels of all ${context.roles.length} declared roles, held at once, read ${attribution.length} characters; Einsatz names the roles that gave an order in at most ${lastActionByMaxLength}: shorten the labels`)]
  const reserved = context.roles.filter(role => isStandingOrderBy(role.label)).map(role => issue([], 'role_label_reserved',
    `Role "${role.id}" is labelled "${role.label}"; Einsatz names its standing orders "${standingOrderByPrefix}…" where it names the roles that gave an order, so the label would make a person's order read as a standing order: relabel the role`))
  return [...authority, ...hostility, ...labels, ...reserved]
}
