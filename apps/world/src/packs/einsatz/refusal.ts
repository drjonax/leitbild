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
  'priority_class_required',
  'self_hostility',
] as const

export type ConfigurationRefusalCode = typeof configurationRefusalCodes[number]

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
] as const

export type EngineRefusalCode = typeof engineRefusalCodes[number]
export type EinsatzRefusalCode = ConfigurationRefusalCode | EngineRefusalCode

const knownCodes: ReadonlySet<string> = new Set<string>([...configurationRefusalCodes, ...engineRefusalCodes])

export const refusal = (code: EinsatzRefusalCode, message: string): string => `${code}: ${message}`

/** Reads the code back from a refusal; anything outside the convention is an error, never a guess. */
export const refusalCode = (reason: string): EinsatzRefusalCode => {
  const code = /^([a-z][a-z0-9_]*): \S/.exec(reason)?.[1]
  if (code === undefined || !knownCodes.has(code)) throw new Error(`Not an Einsatz refusal: ${reason}`)
  return code as EinsatzRefusalCode
}
