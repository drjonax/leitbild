import type { SimulationRunId } from '../../../../core/model/index.ts'
import type { ProcessUnit, ProcessVariableValue, VariablePath } from '../../../../packs/process-plant/graph/index.ts'
import type { ListedItem, ListedReset } from '../../../../packs/process-plant/operations/instance-ports.ts'
import type { ProposalListEntry } from './operation-presenter.ts'
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
  /** Every standing latched actuation with its RESET, offered or why not, and the drawn items whose controls it holds. */
  readonly resets: ReadonlyArray<ListedReset>
}

export interface HeldProposals {
  readonly plantElapsedMs: number
  readonly proposals: ReadonlyArray<{ readonly proposal: ProcessPlantProposal; readonly review?: ProposalReview }>
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
  /** The units of signals, to write their values as a display does (signals.resolve). */
  readonly units: (runId: SimulationRunId, plantId: string, paths: ReadonlyArray<VariablePath>) => Promise<ReadonlyMap<VariablePath, ProcessUnit>>
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
  units: async (runId, plantId, paths) => {
    if (paths.length === 0) return new Map()
    const resolved = await querySimulationRunCapability<{ readonly signals: ReadonlyArray<{ readonly path: VariablePath; readonly unit: ProcessUnit }> }>(runId, 'world.process-plant.signals.resolve', { plantId, signals: paths.map(path => ({ path })) }, timed())
    return new Map(resolved.signals.map(signal => [signal.path, signal.unit]))
  },
}

/**
 * A display operated in the process display window: the Run and Plant its
 * controls act on, the client they act through, and how it tells its display
 * the paths its controls write and read (sampled with the rest). In a chat
 * the same display is read-only: its items carry the operation state they are
 * in (a pending proposal, a protection actuation holding them, a command
 * travelling), and nothing is offered.
 */
export interface DisplayOperation {
  readonly runId: SimulationRunId
  readonly plantId: string
  readonly client: OperationClient
  /** In a chat: badges only, no PROPOSAL or CONTROL section, no proposal pinned or reported. */
  readonly readOnly: boolean
  readonly sampled: (paths: ReadonlyArray<string>) => void
  /** Tells the display window the Plant's pending proposals, most time-critical first, for its toolbar's chip. */
  readonly proposals: (entries: ReadonlyArray<ProposalListEntry>) => void
  /**
   * Names each time the window shows a display opened on equipment (an item's
   * detail, or an answer's display around it): each time, a pending
   * proposal's popover opens pinned on its item. Null for the unit overview.
   */
  readonly review: string | null
}
