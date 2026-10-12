import type { SignalId, SimulationRunId } from '../../../core/model/index.ts'
import { nowIso } from '../../../core/model/index.ts'
import type { PackRuntimeEvent } from '../../../simulation/protocol.ts'
import { proposalEvent, type ProposalTransition } from '../operations/proposals.ts'
import { processPlantSimAdapterId, processPlantSimRuntimeId } from './constants.ts'

// Each change to a proposal is a durable Run event, as the I&C's alarm and
// trip transitions are: recorded, extended, approved, rejected, expired,
// superseded, withdrawn (plan-final §4.4). An approval's write is journaled
// apart, as the approving person's own command.

const severity: Readonly<Record<ProposalTransition['type'], 'info' | 'notice'>> = {
  recorded: 'notice',
  extended: 'info',
  approved: 'info',
  rejected: 'info',
  expired: 'notice',
  superseded: 'info',
  withdrawn: 'info',
}

export const proposalSignalEvents = (simulationRunId: SimulationRunId, transitions: ReadonlyArray<ProposalTransition>): ReadonlyArray<PackRuntimeEvent> =>
  transitions.map(transition => {
    const at = nowIso()
    const event = proposalEvent(transition)
    return {
      type: 'interaction.signal',
      at,
      provenance: { source: 'simulator', adapterId: processPlantSimAdapterId },
      signal: {
        id: `process-plant-proposal:${transition.proposal.id}:${transition.type}` as SignalId,
        simulationRunId,
        at,
        source: { kind: 'simulation', id: processPlantSimRuntimeId },
        targets: [{ kind: 'broadcast' }],
        type: event.type,
        severity: severity[transition.type],
        payload: event.payload,
      },
    }
  })
