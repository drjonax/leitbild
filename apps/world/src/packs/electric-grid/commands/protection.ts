import type { SimulationCapability } from '../../../simulation/protocol.ts'
import { assetPayload, gridCommandCapability } from './capability.ts'

export const gridResetBranchProtectionCommandKind = 'world.electric-grid.reset-branch-protection'

export const gridResetBranchProtectionPayloadSchema = assetPayload

export const gridProtectionCommandCapabilities: ReadonlyArray<SimulationCapability> = [
  gridCommandCapability({
    id: gridResetBranchProtectionCommandKind,
    title: 'Reset branch protection',
    description: 'Resets the protection of a branch its relays tripped (thermal, emergency-duration or instantaneous element). The breaker stays open: the branch becomes open, and close-branch with its synchro-check puts it back in service. Rejected unless the branch is tripped.',
    payloadSchema: gridResetBranchProtectionPayloadSchema,
    risk: 'write',
    searchTerms: ['protection', 'relay', 'trip', 'tripped', 'reset', 'overload', 'thermal', 'branch', 'line', 'vern', 'utløst', 'tilbakestill', 'overlast', 'linje'],
  }),
]
