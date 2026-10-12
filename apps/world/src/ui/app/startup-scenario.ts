import type { CompiledScenario } from '../../core/model/index.ts'
import type { SimulationRunResponse } from '../types.ts'

/**
 * Where a joining screen takes the Compiled Scenario it works from: the one
 * it already installed, the one the Run read carries, or, in open mode only,
 * the Scenario fetch. A screen holding roles always takes the Run read's,
 * which the Run has built for its view; the Scenario fetch would hand a side
 * view the whole compiled truth.
 */
export type StartupScenarioSource =
  | { readonly kind: 'installed'; readonly scenario: CompiledScenario }
  | { readonly kind: 'run-read'; readonly scenario: CompiledScenario }
  | { readonly kind: 'scenario-fetch'; readonly scenarioId: string }

export const startupScenarioSource = (
  response: SimulationRunResponse,
  installed: CompiledScenario | null,
  holdsRoles: boolean,
): StartupScenarioSource => {
  const scenarioId = response.snapshot.scenario?.scenarioId
  if (!scenarioId) throw new Error('simulation run snapshot is missing scenario state')
  if (installed?.id === scenarioId) return { kind: 'installed', scenario: installed }
  if (response.scenario?.id === scenarioId) return { kind: 'run-read', scenario: response.scenario }
  if (holdsRoles) throw new Error(`The Run read of a role Run must carry its Compiled Scenario ${scenarioId}`)
  return { kind: 'scenario-fetch', scenarioId }
}
