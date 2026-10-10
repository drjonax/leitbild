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
export type EinsatzRefusalCode = ConfigurationRefusalCode

const knownCodes: ReadonlySet<string> = new Set(configurationRefusalCodes)

export const refusal = (code: EinsatzRefusalCode, message: string): string => `${code}: ${message}`

/** Reads the code back from a refusal; anything outside the convention is an error, never a guess. */
export const refusalCode = (reason: string): EinsatzRefusalCode => {
  const code = /^([a-z][a-z0-9_]*): \S/.exec(reason)?.[1]
  if (code === undefined || !knownCodes.has(code)) throw new Error(`Not an Einsatz refusal: ${reason}`)
  return code as EinsatzRefusalCode
}
