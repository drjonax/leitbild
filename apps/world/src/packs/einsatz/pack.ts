import type { WorldPack } from '../../core/packs/protocol.ts'
import { einsatzConfigSchema } from './config-validation.ts'
import { validateEinsatzScenarioConfig } from './scenario-config.ts'
import { einsatzScenarioSupport } from './scenario.ts'
import { einsatzPackView } from './ui-pack.ts'

/**
 * The Einsatz World Pack. The product registers it only at the cut; until
 * then tests assemble it with its runtime adapter.
 *
 * It is role-aware: in a Run that declares sides every object it writes
 * carries its side, or `public` for a public type; its queries and refusals
 * answer within the viewer core stamps; a public object holds counts only;
 * a command id stays on objects its caller's view holds; and it emits no
 * realtime messages.
 */
export const einsatzPack: WorldPack = {
  ...einsatzPackView,
  scenarioConfigSchema: einsatzConfigSchema,
  roleAware: true,
  validateScenarioConfig: validateEinsatzScenarioConfig,
  scenario: einsatzScenarioSupport,
}
