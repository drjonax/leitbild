import { audienceRefusalCodes, deleteObjectCommandKind, isSideView, roleClassForRoleSet, seesForRoleSet, viewerForRoleSet, type RoleClass, type RoleSees, type RunRoles, type RunViewer } from '../model/index.ts'
import type { Actor } from './actors.ts'

/**
 * Core gates of a Run that declares roles. Each refusal carries its own code
 * so a caller can tell them apart; a Run without roles never reaches them.
 * A Run that declares sides adds the side-view gate and its audience checks.
 */
export const roleGateCodes = [
  'role_required',
  'unknown_role',
  'role_controller_only',
  'ai_role_run_unsupported',
  'agent_restrictions_in_role_run',
  'role_view_not_supported',
  ...audienceRefusalCodes,
] as const
export type RoleGateCode = typeof roleGateCodes[number]

export type RoleGateRefusal = Error & {
  readonly code: RoleGateCode
  readonly status: 400 | 403 | 409
  readonly details?: Readonly<Record<string, unknown>>
}

const statusFor = (code: RoleGateCode): RoleGateRefusal['status'] =>
  code === 'unknown_role' || code === 'audience_required' || code === 'audience_undeclared_side' ? 400
    : code === 'agent_restrictions_in_role_run' || code === 'audience_changed' ? 409
      : 403

export const roleGateRefusal = (
  code: RoleGateCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): RoleGateRefusal => Object.assign(new Error(message), { code, status: statusFor(code), ...(details === undefined ? {} : { details }) })

export const isRoleGateRefusal = (error: unknown): error is RoleGateRefusal =>
  error instanceof Error
  && 'code' in error
  && (roleGateCodes as ReadonlyArray<unknown>).includes((error as { readonly code: unknown }).code)

/** A sided Run's refusal of an object for its audience. */
export const isAudienceRefusal = (error: unknown): error is RoleGateRefusal =>
  isRoleGateRefusal(error) && (audienceRefusalCodes as ReadonlyArray<string>).includes(error.code)

/** Who a call or connection plays in a Run. */
export type RunPerspective =
  | { readonly kind: 'open' }
  | { readonly kind: 'unroled' }
  | { readonly kind: 'roles'; readonly roleIds: ReadonlyArray<string>; readonly roleClass: RoleClass }

/** World-direct REST and the WebSocket upgrade carry a screen's role set here. */
export const roleSetParameter = 'roles'

/** `roles=a,b` as role ids; null when the parameter is absent. */
export const parseRoleSetParameter = (raw: string | null): ReadonlyArray<string> | null =>
  raw === null ? null : raw.split(',').map(value => value.trim()).filter(value => value.length > 0)

/**
 * The perspective a requested role set gives in a Run. A Run without roles is
 * open mode and refuses any role set; a role Run refuses role ids it does not
 * declare and orders the held set as the Scenario declares it.
 */
export const resolveRunPerspective = (
  declaration: RunRoles | null,
  requested: ReadonlyArray<string> | null,
): RunPerspective => {
  if (declaration === null) {
    if (requested === null) return { kind: 'open' }
    throw roleGateRefusal('unknown_role', 'This Run declares no roles', { unknownRoleIds: [...requested], declaredRoleIds: [] })
  }
  if (requested === null || requested.length === 0) return { kind: 'unroled' }
  const declaredIds = declaration.roles.map(role => role.id)
  const unknownRoleIds = [...new Set(requested.filter(roleId => !declaredIds.includes(roleId)))]
  if (unknownRoleIds.length > 0) {
    throw roleGateRefusal('unknown_role', `This Run does not declare the role${unknownRoleIds.length === 1 ? '' : 's'} ${unknownRoleIds.join(', ')}`, { unknownRoleIds, declaredRoleIds: declaredIds })
  }
  const roleIds = declaredIds.filter(roleId => requested.includes(roleId))
  return { kind: 'roles', roleIds, roleClass: roleClassForRoleSet(declaration, roleIds) }
}

export const roleRequiredRefusal = (): RoleGateRefusal =>
  roleGateRefusal('role_required', 'This Run declares roles; pick a role to use it')

export const assertHoldsRole = (perspective: RunPerspective): void => {
  if (perspective.kind === 'unroled') throw roleRequiredRefusal()
}

/** Delete, signal and reset need a controller-class role in a role Run. */
export const assertControllerRole = (perspective: RunPerspective, action: string): void => {
  assertHoldsRole(perspective)
  if (perspective.kind === 'roles' && perspective.roleClass !== 'controller') {
    throw roleGateRefusal('role_controller_only', `${action} needs a controller role`, { roleIds: [...perspective.roleIds] })
  }
}

/** What a perspective sees: everything in open mode, else its role set's union. */
export const seesOfPerspective = (declaration: RunRoles | null, perspective: RunPerspective): RoleSees =>
  declaration === null || perspective.kind !== 'roles' ? 'all' : seesForRoleSet(declaration, perspective.roleIds)

/**
 * The viewer core stamps for Packs on an actor's queries and commands: the
 * role set the actor's connection holds. Open mode and the Scenario timeline
 * have none.
 */
export const viewerForActor = (declaration: RunRoles | null, actor: Actor): RunViewer | undefined =>
  declaration === null || actor.roleIds === undefined ? undefined : viewerForRoleSet(declaration, actor.roleIds)

export const roleViewNotSupportedRefusal = (what: string): RoleGateRefusal =>
  roleGateRefusal('role_view_not_supported', `${what} is not offered to a role that sees only some sides`)

/** A side view reaches only the routes and Capabilities that build its picture. */
export const assertTruthView = (sees: RoleSees, what: string): void => {
  if (isSideView(sees)) throw roleViewNotSupportedRefusal(what)
}

/** The Actor a perspective plays: its role set and its class mapped onto Actor.role. */
export const actorForPerspective = (actor: Actor, perspective: RunPerspective): Actor =>
  perspective.kind === 'roles' ? { ...actor, role: perspective.roleClass, roleIds: perspective.roleIds } : actor

/**
 * The gate every Run-scoped Capability passes in a role Run. The Scenario
 * timeline acts as the system actor and passes; AI callers are refused, since
 * one shared Assistant would carry one role's view to another.
 */
export const assertRunCapabilityAllowed = (declaration: RunRoles | null, actor: Actor, capabilityId: string): void => {
  if (declaration === null || actor.role === 'system') return
  if (actor.role === 'ai_agent') throw aiRoleRunRefusal()
  const perspective = resolveRunPerspective(declaration, actor.roleIds ?? null)
  assertHoldsRole(perspective)
  if (capabilityId === deleteObjectCommandKind) assertControllerRole(perspective, 'Deleting an object')
}

export const aiRoleRunRefusal = (): RoleGateRefusal =>
  roleGateRefusal('ai_role_run_unsupported', 'AI is not supported in Runs that declare roles')

/**
 * Run-scoped Host-broker Capabilities a person may call in a role Run without
 * a role, because the Host carries none: the honour clock, copy, rename,
 * delete and the pinned Scenario source (authoring material outside play).
 */
export const roleRunOpenCapabilityIds: ReadonlySet<string> = new Set([
  'world.simulation-run.execution.read',
  'world.simulation-run.execution.set',
  'world.simulation-run.execution.advance',
  'world.simulation-run.copy',
  'world.simulation-run.rename',
  'world.simulation-run.delete',
  'world.simulation-run.scenario-source',
])

/** Run controls a role Run does not offer: AI restrictions and Inspect. */
export const hiddenInRoleRun = (capabilityId: string): boolean =>
  capabilityId.startsWith('world.simulation-run.agent-restrictions.')
  || capabilityId === 'world.simulation-run.inspect'
