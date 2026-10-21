import type { SimulationRunId } from '../../../../../core/model/index.ts'
import type { ProcessVariableValue, VariablePath } from '../../../graph/index.ts'
import type { ListedItem, ListedReset } from '../../../operations/instance-ports.ts'
import type { OperationRecord, ResetRecord } from '../../../operations/plant-operations.ts'
import type { ProcessPlantProposal, ProposalDecision, ProposalReview } from '../../../operations/proposals.ts'
import type { Observable, Observation } from '../../../../../core/observation/model.ts'
import { invokeSimulationRunCapability, querySimulationRunCapability } from '../../../../../ui/simulation-run-client.ts'

// The operation capabilities the Plant's panels use, each through the Run's
// one capability endpoint as the screen's own actor: a person's command goes
// through the one validated queued write path, and a decision on a proposal
// through World's propose/decide book.

export type OperationWrite = { readonly path: VariablePath; readonly value: ProcessVariableValue }
export type OperationCheck = { readonly accepted: true } | { readonly accepted: false; readonly reason: string }
/** A command's result: accepted (with the id the Run gave it) or refused with the reason. */
export type OperationOutcome = { readonly ok: true; readonly commandId: string } | { readonly ok: false; readonly reason: string }

export interface ListedControls {
  readonly plantElapsedMs: number
  readonly items: ReadonlyArray<ListedItem>
  /** Every standing latched actuation with its RESET, offered or why not, and the drawn items whose controls it holds. */
  readonly resets: ReadonlyArray<ListedReset>
}

export interface HeldProposals {
  readonly plantElapsedMs: number
  readonly proposals: ReadonlyArray<{ readonly proposal: ProcessPlantProposal; readonly review?: ProposalReview }>
}

/** A signal as World observes it: its unit code and quantity, declared limits, and observation now. */
export interface ObservedSignal {
  readonly unit: string
  readonly quantity: Observable['quantity']
  readonly thresholds: Observable['thresholds']
  readonly observation: Observation | null
}

/** The Plant on some signals now (signals.read with its operations): their values and units, and what people and AI agents did on them. */
export interface PlantRead {
  readonly sample: { readonly simulationTime: string; readonly plantElapsedMs: number; readonly values: ReadonlyArray<{ readonly path: string; readonly value: ProcessVariableValue }> }
  readonly units: ReadonlyMap<string, string>
  readonly log: ReadonlyArray<OperationRecord>
  readonly resets: ReadonlyArray<ResetRecord>
  /** Where asked: each signal's observation and declared limits, by path; null for one the Plant does not declare. */
  readonly observed: ReadonlyMap<string, ObservedSignal | null>
}

export interface OperationClient {
  /** Each named drawn item's controls where they stand now, or every item's (controls.list). */
  readonly controls: (runId: SimulationRunId, plantId: string, items: ReadonlyArray<string> | null) => Promise<ListedControls>
  /** World's check of the exact write, as the screen's actor would issue it (control.validate). */
  readonly validate: (runId: SimulationRunId, plantId: string, write: OperationWrite) => Promise<OperationCheck>
  /** The write, as a command of the screen's actor (control.write). */
  readonly write: (runId: SimulationRunId, plantId: string, write: OperationWrite) => Promise<OperationOutcome>
  /** A person's reset of a standing actuation, as the screen's actor (actuation.reset). */
  readonly reset: (runId: SimulationRunId, plantId: string, ruleId: string) => Promise<OperationOutcome>
  /** A person's decision on a proposal (control.decide). */
  readonly decide: (runId: SimulationRunId, plantId: string, proposalId: string, decision: ProposalDecision, reason: string | null) => Promise<OperationOutcome>
  /** The Plant's proposals, pending ones with World's review now (control.proposals). */
  readonly proposals: (runId: SimulationRunId, plantId: string) => Promise<HeldProposals>
  /** The signals' values and units now, with the commands and resets on them (signals.read). */
  readonly read: (runId: SimulationRunId, plantId: string, paths: ReadonlyArray<string>, observed?: boolean) => Promise<PlantRead>
}

/**
 * How long a read may take before the display gives up on it and says so: a
 * read that never returns (a dropped connection) would otherwise hold back
 * every later one, and the popover would show controls as they stood then.
 */
export const OPERATION_READ_TIMEOUT_MS = 10_000
const timed = () => ({ signal: AbortSignal.timeout(OPERATION_READ_TIMEOUT_MS) })

const commandOutcome = async (runId: SimulationRunId, capabilityId: string, input: unknown): Promise<OperationOutcome> => {
  const response = await invokeSimulationRunCapability(runId, { capabilityId, input })
  if (response.kind !== 'command') throw new Error(`${capabilityId} is not a command`)
  return response.result.ok ? { ok: true, commandId: response.result.commandId } : { ok: false, reason: response.result.reason }
}

export const operationClient: OperationClient = {
  controls: (runId, plantId, items) => querySimulationRunCapability<ListedControls>(runId, 'world.process-plant.controls.list', { plantId, ...(items === null ? {} : { items: [...items] }) }, timed()),
  validate: async (runId, plantId, write) => {
    const result = await querySimulationRunCapability<{ readonly accepted: boolean; readonly reason?: string }>(runId, 'world.process-plant.control.validate', { plantId, path: write.path, value: write.value }, timed())
    if (result.accepted) return { accepted: true }
    if (result.reason === undefined) throw new Error('control.validate refused a write without a reason')
    return { accepted: false, reason: result.reason }
  },
  write: (runId, plantId, write) => commandOutcome(runId, 'world.process-plant.control.write', { plantId, path: write.path, value: write.value }),
  reset: (runId, plantId, ruleId) => commandOutcome(runId, 'world.process-plant.actuation.reset', { plantId, ruleId }),
  decide: (runId, plantId, proposalId, decision, reason) =>
    commandOutcome(runId, 'world.process-plant.control.decide', { plantId, proposalId, decision, ...(reason === null ? {} : { reason }) }),
  proposals: (runId, plantId) => querySimulationRunCapability<HeldProposals>(runId, 'world.process-plant.control.proposals', { plantId }, timed()),
  read: async (runId, plantId, paths, observed = false) => {
    const read = await querySimulationRunCapability<{
      readonly operations: Pick<PlantRead, 'log' | 'resets'> & { readonly simulationTime: string; readonly plantElapsedMs: number }
      readonly signals: ReadonlyArray<{
        readonly signal: { readonly path: string }; readonly variable: { readonly value: ProcessVariableValue; readonly unit: string }
        readonly observed?: ObservedSignal | null
      }>
    }>(runId, 'world.process-plant.signals.read', { plantId, signals: paths.map(path => ({ path })), operations: true, ...(observed ? { observed } : {}) }, timed())
    return {
      sample: { simulationTime: read.operations.simulationTime, plantElapsedMs: read.operations.plantElapsedMs, values: read.signals.map(entry => ({ path: entry.signal.path, value: entry.variable.value })) },
      units: new Map(read.signals.map(entry => [entry.signal.path, entry.variable.unit])),
      log: read.operations.log,
      resets: read.operations.resets,
      observed: new Map(read.signals.flatMap(entry => entry.observed === undefined ? [] : [[entry.signal.path, entry.observed] as const])),
    }
  },
}
