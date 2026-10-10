import { allowedCombinations, standingOrderComponents } from './config-components.ts'
import type { ConfigCheck, ConfigIssue } from './config-issues.ts'
import { consistentProperties, satisfiableRequirements } from './config-properties.ts'
import { catalogueIcons, hostilityPairs, knownReferences, uniqueIds } from './config-references.ts'
import { einsatzConfigShapeSchema, type EinsatzConfig } from './config-schema.ts'
import { refusal } from './refusal.ts'

const checks: ReadonlyArray<ConfigCheck> = [
  uniqueIds,
  knownReferences,
  consistentProperties,
  satisfiableRequirements,
  allowedCombinations,
  standingOrderComponents,
  catalogueIcons,
  hostilityPairs,
]

/**
 * Every issue of a structurally valid configuration, each at its path. These
 * checks need nothing but the configuration; checks against a Scenario's roles
 * and sides take that context and report the same `ConfigIssue`s.
 */
export const validateEinsatzConfig = (config: EinsatzConfig): ReadonlyArray<ConfigIssue> => checks.flatMap(check => check(config))

/** The Einsatz Pack Selection config parser: strict structure, then every semantic refusal as `<code>: <message>` at its path. */
export const einsatzConfigSchema = einsatzConfigShapeSchema.superRefine((config, context) => {
  for (const found of validateEinsatzConfig(config)) context.addIssue({ code: 'custom', path: [...found.path], message: refusal(found.code, found.message) })
})
