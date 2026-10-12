import type { SimulationRunId } from '../../../../core/model/index.ts'
import type { ProcessUnit, ProcessVariableValue, VariablePath } from '../../../../packs/process-plant/graph/index.ts'
import type { ListedItem } from '../../../../packs/process-plant/operations/instance-ports.ts'
import type { ProcessPlantProposal, ProposalDecision, ProposalReview } from '../../../../packs/process-plant/operations/proposals.ts'
import { invokeSimulationRunCapability, querySimulationRunCapability } from '../../../simulation-run-client.ts'

// The operation capabilities a display in the process display window uses,
// each through the Run's one capability endpoint as the screen's own actor:
// a person's command goes through the one validated queued write path, and
// a decision on a proposal through World's propose/decide book.

export type OperationWrite = { readonly path: VariablePath; readonly value: ProcessVariableValue }
export type OperationCheck = { readonly accepted: true } | { readonly accepted: false; readonly reason: string }
/** A command's result: accepted (with the id the Run gave it) or refused with the reason. */
export type OperationOutcome = { readonly ok: true; readonly commandId: string } | { readonly ok: false; readonly reason: string }

export interface ListedControls {
  readonly plantElapsedMs: number
  readonly items: ReadonlyArray<ListedItem>
}

export interface HeldProposals {
  readonly plantElapsedMs: number
  readonly proposals: ReadonlyArray<{ readonly proposal: ProcessPlantProposal; readonly review?: ProposalReview }>
}

export interface OperationClient {
  /** Each named drawn item's controls where they stand now (controls.list). */
  readonly controls: (runId: SimulationRunId, plantId: string, items: ReadonlyArray<string>) => Promise<ListedControls>
  /** World's check of the exact write, as the screen's actor would issue it (control.validate). */
  readonly validate: (runId: SimulationRunId, plantId: string, write: OperationWrite) => Promise<OperationCheck>
  /** The write, as a command of the screen's actor (control.write). */
  readonly write: (runId: SimulationRunId, plantId: string, write: OperationWrite) => Promise<OperationOutcome>
  /** A person's decision on a proposal (control.decide). */
  readonly decide: (runId: SimulationRunId, plantId: string, proposalId: string, decision: ProposalDecision, reason: string | null) => Promise<OperationOutcome>
  /** The Plant's proposals, pending ones with World's review now (control.proposals). */
  readonly proposals: (runId: SimulationRunId, plantId: string) => Promise<HeldProposals>
  /** The units of signals, to write their values as a display does (signals.resolve). */
  readonly units: (runId: SimulationRunId, plantId: string, paths: ReadonlyArray<VariablePath>) => Promise<ReadonlyMap<VariablePath, ProcessUnit>>
}

const commandOutcome = async (runId: SimulationRunId, capabilityId: string, input: unknown): Promise<OperationOutcome> => {
  const response = await invokeSimulationRunCapability(runId, { capabilityId, input })
  if (response.kind !== 'command') throw new Error(`${capabilityId} is not a command`)
  return response.result.ok ? { ok: true, commandId: response.result.commandId } : { ok: false, reason: response.result.reason }
}

export const operationClient: OperationClient = {
  controls: (runId, plantId, items) => querySimulationRunCapability<ListedControls>(runId, 'world.process-plant.controls.list', { plantId, items: [...items] }),
  validate: async (runId, plantId, write) => {
    const result = await querySimulationRunCapability<{ readonly accepted: boolean; readonly reason?: string }>(runId, 'world.process-plant.control.validate', { plantId, path: write.path, value: write.value })
    if (result.accepted) return { accepted: true }
    if (result.reason === undefined) throw new Error('control.validate refused a write without a reason')
    return { accepted: false, reason: result.reason }
  },
  write: (runId, plantId, write) => commandOutcome(runId, 'world.process-plant.control.write', { plantId, path: write.path, value: write.value }),
  decide: (runId, plantId, proposalId, decision, reason) =>
    commandOutcome(runId, 'world.process-plant.control.decide', { plantId, proposalId, decision, ...(reason === null ? {} : { reason }) }),
  proposals: (runId, plantId) => querySimulationRunCapability<HeldProposals>(runId, 'world.process-plant.control.proposals', { plantId }),
  units: async (runId, plantId, paths) => {
    if (paths.length === 0) return new Map()
    const resolved = await querySimulationRunCapability<{ readonly signals: ReadonlyArray<{ readonly path: VariablePath; readonly unit: ProcessUnit }> }>(runId, 'world.process-plant.signals.resolve', { plantId, signals: paths.map(path => ({ path })) })
    return new Map(resolved.signals.map(signal => [signal.path, signal.unit]))
  },
}
