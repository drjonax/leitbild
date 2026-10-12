import type { WorldPack } from '../../core/packs/protocol.ts'
import { einsatzAuthoring } from './authoring.ts'
import { einsatzConfigSchema } from './config-validation.ts'
import { einsatzScenarioRoles } from './groups.ts'
import { validateEinsatzScenarioConfig } from './scenario-config.ts'
import { einsatzScenarioSupport } from './scenario.ts'
import { einsatzPackView } from './ui-pack.ts'

/**
 * The Einsatz World Pack, registered with its runtime adapter in the World
 * application assembly beside the other road Pack, on the same routing.
 *
 * It is role-aware: in a Run that declares sides every object it writes
 * carries its side, or `public` for a public type; its queries and refusals
 * answer within the viewer core stamps; a public object holds counts only;
 * a command id stays on objects its caller's view holds; and it emits no
 * realtime messages. Each declared group becomes an operator role
 * (`groups.ts`).
 */
export const einsatzPack: WorldPack = {
  ...einsatzPackView,
  scenarioConfigSchema: einsatzConfigSchema,
  authoring: einsatzAuthoring,
  knowledge: { wikiRefs: [{ name: 'Einsatz knowledge', url: '/wiki?path=world%2Fpacks%2Feinsatz%2Findex.md' }] },
  roleAware: true,
  validateScenarioConfig: validateEinsatzScenarioConfig,
  scenarioRoles: einsatzScenarioRoles,
  scenario: einsatzScenarioSupport,
}
