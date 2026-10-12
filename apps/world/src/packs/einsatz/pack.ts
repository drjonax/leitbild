import type { WorldPack } from '../../core/packs/protocol.ts'
import { einsatzConfigSchema } from './config-validation.ts'
import { einsatzScenarioSupport } from './scenario.ts'
import { einsatzPackView } from './ui-pack.ts'

/**
 * The Einsatz World Pack. The product registers it only at the cut; until
 * then tests assemble it with its runtime adapter.
 */
export const einsatzPack: WorldPack = {
  ...einsatzPackView,
  scenarioConfigSchema: einsatzConfigSchema,
  scenario: einsatzScenarioSupport,
}
