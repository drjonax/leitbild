import { z } from 'zod'
import { idSchema } from './ids.ts'

/**
 * Roles are a Scenario's play perspectives: a screen holds a set of them and
 * plays their union. They are an honour system, not authentication; anyone may
 * pick any role. A Run without roles is open mode, where every screen plays
 * everything as today.
 *
 * A Scenario with roles may also declare sides. A side is only a visibility
 * key: it names whose picture an object belongs to, and core never learns who
 * is hostile to whom. Each role then says what it sees: everything ('all', a
 * truth role) or the pictures of some sides. A screen's view is the union of
 * its roles' `sees`. Fog is fair play, not secrecy: the Scenario stays open to
 * anyone, and anyone may pick any role.
 */
export const roleClassSchema = z.enum(['controller', 'operator'])
export type RoleClass = z.infer<typeof roleClassSchema>

export const scenarioSideSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(80),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a side colour is #rrggbb'),
}).strict()
export type ScenarioSide = z.infer<typeof scenarioSideSchema>

/** What a role sees: everything, or the pictures of these sides. */
export type RoleSees = 'all' | ReadonlyArray<string>
export const roleSeesSchema = z.union([z.literal('all'), z.array(idSchema).min(1)])

export const scenarioRoleSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(80),
  class: roleClassSchema,
  /** Required in a Scenario that declares sides, refused in one without. */
  sees: roleSeesSchema.optional(),
  /**
   * A heading the role picker lists the role under, such as "Haulers" or
   * "Crews". Display grouping only: no gate, filter or Pack rule reads it.
   */
  category: z.string().trim().min(1).max(80).optional(),
}).strict()
export type ScenarioRole = z.infer<typeof scenarioRoleSchema>

/**
 * A one-click bundle of roles offered beside the roles themselves. Data only.
 * It may bundle declared roles and roles a Pack derives at compile.
 */
export const scenarioRolePresetSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(80),
  roles: z.array(idSchema).min(1),
}).strict()
export type ScenarioRolePreset = z.infer<typeof scenarioRolePresetSchema>

/** The roles (and sides) a Run declares, fixed when its Scenario is compiled. */
export interface RunRoles {
  readonly roles: ReadonlyArray<ScenarioRole>
  readonly presets: ReadonlyArray<ScenarioRolePreset>
  /** Present only when the Scenario declares sides. */
  readonly sides?: ReadonlyArray<ScenarioSide>
}

export const runRolesSchema = z.object({
  roles: z.array(scenarioRoleSchema).min(1),
  presets: z.array(scenarioRolePresetSchema),
  sides: z.array(scenarioSideSchema).min(1).optional(),
}).strict()

export interface RoleDeclarationIssue {
  readonly path: ReadonlyArray<string | number>
  readonly message: string
  /** A refusal code a caller can tell apart, when the issue has one. */
  readonly code?: string
}

/**
 * What is wrong with what one role sees, given the Scenario's sides, with
 * paths relative to the role. Compile also checks each role a Pack derives
 * with it, before the derived role joins the declared ones.
 */
export const roleSeesIssues = (
  role: ScenarioRole,
  sides: ReadonlyArray<ScenarioSide> | undefined,
): ReadonlyArray<RoleDeclarationIssue> => {
  const path = ['sees']
  if (sides === undefined) {
    return role.sees === undefined ? [] : [{ path, message: `role ${role.id} declares sees, but the Scenario declares no sides: without sides every role sees everything` }]
  }
  if (role.sees === undefined) {
    return [{ path, code: 'role_sees_required', message: `role_sees_required: role ${role.id} must declare what it sees in a Scenario with sides: 'all' or the sides whose picture it plays` }]
  }
  if (role.class === 'controller' && role.sees !== 'all') {
    return [{ path, code: 'role_sees_required', message: `role_sees_required: controller role ${role.id} sees everything; declare sees: 'all'` }]
  }
  if (role.sees === 'all') return []
  const sideIds = new Set(sides.map(side => side.id))
  const seen = new Set<string>()
  return role.sees.flatMap((sideId, sideIndex) => {
    const issues: RoleDeclarationIssue[] = []
    if (!sideIds.has(sideId)) issues.push({ path: [...path, sideIndex], message: `role ${role.id} sees an undeclared side: ${sideId}` })
    if (seen.has(sideId)) issues.push({ path: [...path, sideIndex], message: `role ${role.id} names a side twice: ${sideId}` })
    seen.add(sideId)
    return issues
  })
}

const seesIssues = (
  roles: ReadonlyArray<ScenarioRole>,
  sides: ReadonlyArray<ScenarioSide> | undefined,
): ReadonlyArray<RoleDeclarationIssue> =>
  roles.flatMap((role, index) => roleSeesIssues(role, sides).map(issue => ({ ...issue, path: ['roles', index, ...issue.path] })))

/**
 * Which roles a preset may name. `complete`: the roles given are every role
 * of the Run (a Compiled Scenario, a Run's state), so a preset names only
 * those. `declared`: the roles given are a Definition's declared roles, and
 * the roles Packs derive join them only at compile, so a preset may also
 * name a role not given here; compile checks it against the merged roles.
 */
export type PresetMembers = 'complete' | 'declared'

/**
 * Every problem in one role declaration, with paths relative to the object
 * that holds `roles`, `rolePresets` and `sides` (a Definition or Compiled
 * Scenario). `presetMembers` says whether the roles given are all the Run's.
 */
export const roleDeclarationIssues = (
  roles: ReadonlyArray<ScenarioRole> | undefined,
  presets: ReadonlyArray<ScenarioRolePreset> | undefined,
  sides: ReadonlyArray<ScenarioSide> | undefined,
  presetMembers: PresetMembers,
): ReadonlyArray<RoleDeclarationIssue> => {
  const issues: RoleDeclarationIssue[] = []
  if (roles === undefined) {
    if (presets !== undefined) issues.push({ path: ['rolePresets'], message: 'Role presets need declared roles' })
    if (sides !== undefined) issues.push({ path: ['sides'], message: 'Sides need declared roles: a side is what a role sees' })
    return issues
  }
  const sideIds = new Set<string>()
  ;(sides ?? []).forEach((side, index) => {
    if (sideIds.has(side.id)) issues.push({ path: ['sides', index, 'id'], message: `duplicate side: ${side.id}` })
    sideIds.add(side.id)
  })
  const roleIds = new Set<string>()
  roles.forEach((role, index) => {
    if (roleIds.has(role.id)) issues.push({ path: ['roles', index, 'id'], message: `duplicate role: ${role.id}` })
    roleIds.add(role.id)
  })
  issues.push(...seesIssues(roles, sides))
  const presetIds = new Set<string>()
  ;(presets ?? []).forEach((preset, index) => {
    if (presetIds.has(preset.id)) issues.push({ path: ['rolePresets', index, 'id'], message: `duplicate role preset: ${preset.id}` })
    if (roleIds.has(preset.id)) issues.push({ path: ['rolePresets', index, 'id'], message: `role preset id is already a role id: ${preset.id}` })
    presetIds.add(preset.id)
    const members = new Set<string>()
    preset.roles.forEach((roleId, roleIndex) => {
      if (presetMembers === 'complete' && !roleIds.has(roleId)) issues.push({ path: ['rolePresets', index, 'roles', roleIndex], message: `role preset names an undeclared role: ${roleId}` })
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
  readonly sides?: ReadonlyArray<ScenarioSide>
}): RunRoles | null =>
  source.roles === undefined ? null : {
    roles: source.roles,
    presets: source.rolePresets ?? [],
    ...(source.sides === undefined ? {} : { sides: source.sides }),
  }

/** An Actor's class from the roles it holds: controller when any held role is. */
export const roleClassForRoleSet = (declaration: RunRoles, roleIds: ReadonlyArray<string>): RoleClass =>
  declaration.roles.some(role => role.class === 'controller' && roleIds.includes(role.id)) ? 'controller' : 'operator'

/**
 * What a set of roles sees together: the union of its roles' `sees`. Any
 * role that sees 'all' makes the set a truth view, and without sides every
 * role is a truth role. Sides come back in declaration order.
 */
export const seesForRoleSet = (declaration: RunRoles, roleIds: ReadonlyArray<string>): RoleSees => {
  if (declaration.sides === undefined) return 'all'
  const held = declaration.roles.filter(role => roleIds.includes(role.id))
  if (held.some(role => role.sees === 'all')) return 'all'
  const seen = new Set(held.flatMap(role => role.sees === undefined || role.sees === 'all' ? [] : role.sees))
  return declaration.sides.map(side => side.id).filter(sideId => seen.has(sideId))
}

/** A side view sees the pictures of some sides; a truth view sees everything. */
export const isSideView = (sees: RoleSees): sees is ReadonlyArray<string> => sees !== 'all'

/**
 * Who reads or acts in a role Run, as core stamps it for Packs from the
 * caller's connection (never from input): the role set held, its class, and
 * what it sees. A Run without roles, and the Scenario timeline, have none.
 */
export interface RunViewer {
  readonly roleIds: ReadonlyArray<string>
  readonly class: RoleClass
  readonly sees: RoleSees
}

export const viewerForRoleSet = (declaration: RunRoles, roleIds: ReadonlyArray<string>): RunViewer => ({
  roleIds: declaration.roles.map(role => role.id).filter(roleId => roleIds.includes(roleId)),
  class: roleClassForRoleSet(declaration, roleIds),
  sees: seesForRoleSet(declaration, roleIds),
})
