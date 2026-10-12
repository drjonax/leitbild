import { z } from 'zod'
import { idSchema } from './ids.ts'

/**
 * Roles are a Scenario's play perspectives: a screen holds a set of them and
 * plays their union. They are an honour system, not authentication; anyone may
 * pick any role. A Run without roles is open mode, where every screen plays
 * everything as today.
 *
 * R2 adds a Run's sides and each role's `sees` here, beside `class`.
 */
export const roleClassSchema = z.enum(['controller', 'operator'])
export type RoleClass = z.infer<typeof roleClassSchema>

export const scenarioRoleSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(80),
  class: roleClassSchema,
}).strict()
export type ScenarioRole = z.infer<typeof scenarioRoleSchema>

/** A one-click bundle of roles offered beside the roles themselves. Data only. */
export const scenarioRolePresetSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(80),
  roles: z.array(idSchema).min(1),
}).strict()
export type ScenarioRolePreset = z.infer<typeof scenarioRolePresetSchema>

/** The roles a Run declares, fixed when its Scenario is compiled. */
export interface RunRoles {
  readonly roles: ReadonlyArray<ScenarioRole>
  readonly presets: ReadonlyArray<ScenarioRolePreset>
}

export const runRolesSchema = z.object({
  roles: z.array(scenarioRoleSchema).min(1),
  presets: z.array(scenarioRolePresetSchema),
}).strict()

export interface RoleDeclarationIssue {
  readonly path: ReadonlyArray<string | number>
  readonly message: string
}

/**
 * Every problem in one role declaration, with paths relative to the object
 * that holds `roles` and `rolePresets` (a Definition or Compiled Scenario).
 */
export const roleDeclarationIssues = (
  roles: ReadonlyArray<ScenarioRole> | undefined,
  presets: ReadonlyArray<ScenarioRolePreset> | undefined,
): ReadonlyArray<RoleDeclarationIssue> => {
  const issues: RoleDeclarationIssue[] = []
  if (roles === undefined) {
    if (presets !== undefined) issues.push({ path: ['rolePresets'], message: 'Role presets need declared roles' })
    return issues
  }
  const roleIds = new Set<string>()
  roles.forEach((role, index) => {
    if (roleIds.has(role.id)) issues.push({ path: ['roles', index, 'id'], message: `duplicate role: ${role.id}` })
    roleIds.add(role.id)
  })
  const presetIds = new Set<string>()
  ;(presets ?? []).forEach((preset, index) => {
    if (presetIds.has(preset.id)) issues.push({ path: ['rolePresets', index, 'id'], message: `duplicate role preset: ${preset.id}` })
    if (roleIds.has(preset.id)) issues.push({ path: ['rolePresets', index, 'id'], message: `role preset id is already a role id: ${preset.id}` })
    presetIds.add(preset.id)
    const members = new Set<string>()
    preset.roles.forEach((roleId, roleIndex) => {
      if (!roleIds.has(roleId)) issues.push({ path: ['rolePresets', index, 'roles', roleIndex], message: `role preset names an undeclared role: ${roleId}` })
      if (members.has(roleId)) issues.push({ path: ['rolePresets', index, 'roles', roleIndex], message: `role preset names a role twice: ${roleId}` })
      members.add(roleId)
    })
  })
  return issues
}

/** The Run's declaration, or null for open mode. */
export const runRolesOf = (source: {
  readonly roles?: ReadonlyArray<ScenarioRole>
  readonly rolePresets?: ReadonlyArray<ScenarioRolePreset>
}): RunRoles | null =>
  source.roles === undefined ? null : { roles: source.roles, presets: source.rolePresets ?? [] }

/** An Actor's class from the roles it holds: controller when any held role is. */
export const roleClassForRoleSet = (declaration: RunRoles, roleIds: ReadonlyArray<string>): RoleClass =>
  declaration.roles.some(role => role.class === 'controller' && roleIds.includes(role.id)) ? 'controller' : 'operator'
