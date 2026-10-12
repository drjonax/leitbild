/**
 * Einsatz refusal convention: every refusal reads `<code>: <message>`. The
 * code is stable and machine-readable, so tests and callers assert it; the
 * message is written in the configuration's own words. Command results reuse
 * this convention for `CommandResult.reason`.
 */

/** Refusals of a configuration that parses but cannot be run as written. */
export const configurationRefusalCodes = [
  'duplicate_id',
  'duplicate_code',
  'unknown_unit_type',
  'unknown_task_template',
  'unknown_load_class',
  'unknown_tag',
  'unknown_service',
  'unknown_property',
  'unknown_enum_value',
  'unknown_icon',
  'property_conflict',
  'property_kind_mismatch',
  'condition_out_of_range',
  'invalid_range',
  'default_out_of_range',
  'too_many_board_properties',
  'refused_combination',
  'identify_exceeds_detect',
  'order_requires_component',
  'component_requires_order',
  'priority_class_required',
  'self_hostility',
] as const

export type ConfigurationRefusalCode = typeof configurationRefusalCodes[number]

/**
 * Refusals of a configuration against the Scenario it runs in: authority
 * needs declared roles and names operator roles only, hostility names
 * declared sides, and the roles' labels fit `lastAction.by` and never read
 * as a standing order there. Groups need declared roles, name a declared
 * side exactly when the Scenario declares sides, and alone hold role ids of
 * the form `group:<id>`. An authority
 * entry naming an undeclared role is `authority_unknown_role`, apart from
 * core's `unknown_role` for a caller asking for an undeclared role.
 */
export const scenarioConfigRefusalCodes = [
  'authority_without_roles',
  'authority_unknown_role',
  'controller_authority',
  'unknown_side',
  'role_labels_too_long',
  'role_label_reserved',
  'groups_without_roles',
  'group_side_required',
  'group_side_not_declared',
  'reserved_role_id',
] as const
export type ScenarioConfigRefusalCode = typeof scenarioConfigRefusalCodes[number]

/**
 * Refusals of an intent against the current engine state. Intents reuse the
 * configuration codes where the meaning is the same (an unknown type, an
 * undeclared property, a load-less task without a floor, a repeated id).
 */
export const engineRefusalCodes = [
  'not_in_picture',
  'not_a_site',
  'cross_side_reference',
  'side_required',
  'side_not_declared',
  'public_takes_no_side',
  'unit_committed',
  'unit_loaded',
  'unit_unavailable',
  'divert_not_lower_priority',
  'divert_after_arrival',
  'requirement_unmet',
  'requirement_covered',
  'task_closed',
  'site_not_accepting',
  'property_out_of_range',
  'routing_unavailable',
  'no_road_near_point',
  'no_effector',
  'track_not_engageable',
  'track_not_deletable',
  'reserved_id',
  'chain_full',
  'step_not_found',
  'group_required',
  'unknown_group',
  'group_not_declared',
  'group_side_mismatch',
  'public_takes_no_group',
] as const

export type EngineRefusalCode = typeof engineRefusalCodes[number]

/**
 * Refusals of a caller by who it plays: a controller-only Capability, a unit
 * its roles do not command, a recommendation for a task outside its roles'
 * queue. Core gates use `role_controller_only` too; Einsatz reuses the code.
 */
export const authorityRefusalCodes = ['role_controller_only', 'unit_not_authorized', 'task_not_in_role_queue'] as const
export type AuthorityRefusalCode = typeof authorityRefusalCodes[number]

/**
 * Refusals of a command the runtime does not run: it is unavailable, does
 * not accept the command kind, the input does not parse, or the Run kept
 * deleting Einsatz records while the command was routing.
 */
export const runtimeRefusalCodes = ['runtime_unavailable', 'command_not_accepted', 'invalid_input', 'records_changed'] as const
export type RuntimeRefusalCode = typeof runtimeRefusalCodes[number]

export type EinsatzRefusalCode = ConfigurationRefusalCode | ScenarioConfigRefusalCode | EngineRefusalCode | AuthorityRefusalCode | RuntimeRefusalCode

const knownCodes: ReadonlySet<string> = new Set<string>([...configurationRefusalCodes, ...scenarioConfigRefusalCodes, ...engineRefusalCodes, ...authorityRefusalCodes, ...runtimeRefusalCodes])

export const refusal = (code: EinsatzRefusalCode, message: string): string => `${code}: ${message}`

/** Reads the code back from a refusal; anything outside the convention is an error, never a guess. */
export const refusalCode = (reason: string): EinsatzRefusalCode => {
  const code = /^([a-z][a-z0-9_]*): \S/.exec(reason)?.[1]
  if (code === undefined || !knownCodes.has(code)) throw new Error(`Not an Einsatz refusal: ${reason}`)
  return code as EinsatzRefusalCode
}
