import type { SimulationRunId } from '../../../core/model/index.ts'
import { invokeSimulationRunCapability, querySimulationRunCapability } from '../../../ui/simulation-run-client.ts'
import { boardQueryIds } from '../board/calls.ts'
import type { CallResult } from '../board/types.ts'
import type { EinsatzCommandId } from '../capabilities.ts'
import { configurationOutputSchema, type EinsatzConfig } from '../config-schema.ts'

/**
 * The Board's calls to its Run: the World-direct run-scoped invoke, which
 * carries the screen's role set, never the Host broker, which carries none.
 */

/** The configuration in force, read once when the Board opens. */
export const readBoardConfiguration = async (simulationRunId: SimulationRunId): Promise<EinsatzConfig> =>
  configurationOutputSchema.parse(await querySimulationRunCapability<unknown>(simulationRunId, boardQueryIds.configuration, {})).config

/** A command's outcome as the Run answers this screen; a failed request rejects and the Board shows it as a refusal. */
export const invokeBoardCommand = async (simulationRunId: SimulationRunId, capabilityId: EinsatzCommandId, input: unknown): Promise<CallResult> => {
  const response = await invokeSimulationRunCapability(simulationRunId, { capabilityId, input })
  if (response.kind !== 'command') throw new Error(`${capabilityId} answered as a query, not a command`)
  return response.result.ok ? { ok: true } : { ok: false, reason: response.result.reason }
}

/** The recommendation for a task, as received: the Board validates it. */
export const queryBoardRecommendation = async (simulationRunId: SimulationRunId, taskId: string): Promise<unknown> =>
  await querySimulationRunCapability<unknown>(simulationRunId, boardQueryIds.recommend, { taskId })
