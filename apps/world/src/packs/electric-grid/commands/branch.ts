import { z } from 'zod'
import type { SimulationCapability } from '../../../simulation/protocol.ts'
import { assetPayload, gridCommandCapability } from './capability.ts'

export const gridOpenBranchCommandKind = 'world.electric-grid.open-branch'
export const gridCloseBranchCommandKind = 'world.electric-grid.close-branch'
export const gridDerateBranchCommandKind = 'world.electric-grid.derate-branch'
export const gridClearDerateCommandKind = 'world.electric-grid.clear-derate'

export const gridOpenBranchPayloadSchema = assetPayload
export const gridCloseBranchPayloadSchema = assetPayload
export const gridDerateBranchPayloadSchema = assetPayload.extend({ availability: z.number().finite().min(0.05).max(1) }).strict()
export const gridClearDeratePayloadSchema = assetPayload

const branchTerms = ['branch', 'line', 'cable', 'transformer', 'corridor', 'linje', 'ledning', 'kabel', 'transformator', 'kraftlinje']

export const gridBranchCommandCapabilities: ReadonlyArray<SimulationCapability> = [
  gridCommandCapability({
    id: gridOpenBranchCommandKind,
    title: 'Open branch',
    description: 'Opens a closed AC line, cable or transformer without changing its availability; an HVDC link is not a branch: block-hvdc stops it. Opening can split the network into islands.',
    payloadSchema: gridOpenBranchPayloadSchema,
    risk: 'destructive',
    searchTerms: [...branchTerms, 'open', 'switching', 'breaker', 'disconnect', 'outage', 'islanding', 'effektbryter', 'bryter', 'utkobling', 'kobling', 'frakobling', 'øydrift'],
  }),
  gridCommandCapability({
    id: gridCloseBranchCommandKind,
    title: 'Close branch',
    description: 'Closes an open branch, keeping its derate. The Automation\'s synchro-check applies: between two energised islands their frequencies may differ by at most synchroCheck.maximumFrequencyDifferenceHz; inside one energised island (closing a loop) the end voltage angles may differ by at most synchroCheck.maximumAngleDifferenceDegrees, read from the island\'s AC load flow where it converged and from its DC solution where it did not; closing a tie onto a boundary bus whose ties are all open (still held by the Nordic equivalent, in no island) compares the island with the equivalent\'s frequency: the island it is still coupled to, or its nominal frequency when it is coupled to none; closing onto a de-energised island is allowed. A rejection states the measured difference and, for an angle, its basis.',
    payloadSchema: gridCloseBranchPayloadSchema,
    risk: 'write',
    searchTerms: [...branchTerms, 'close', 'reconnect', 'switching', 'breaker', 'synchro-check', 'synchronise', 'resynchronisation', 'innkobling', 'effektbryter', 'synkronisering', 'parallellkobling', 'gjenoppretting'],
  }),
  gridCommandCapability({
    id: gridDerateBranchCommandKind,
    title: 'Derate branch',
    description: 'Sets the available fraction (0.05–1) of a branch rating; loading percent is flow over the derated rating.',
    payloadSchema: gridDerateBranchPayloadSchema,
    risk: 'write',
    searchTerms: [...branchTerms, 'derate', 'rating', 'capacity limit', 'congestion', 'overføringsgrense', 'begrensning', 'kapasitet', 'flaskehals'],
  }),
  gridCommandCapability({
    id: gridClearDerateCommandKind,
    title: 'Clear branch derate',
    description: 'Restores the full rating of a derated branch without changing its open or closed state.',
    payloadSchema: gridClearDeratePayloadSchema,
    risk: 'write',
    searchTerms: [...branchTerms, 'clear derate', 'restore rating', 'full capacity', 'opphev begrensning', 'full kapasitet'],
  }),
]
