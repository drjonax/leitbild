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
    description: 'Opens a closed line, cable, transformer, HVDC link, or switch without changing its availability. Opening can split the network into islands.',
    payloadSchema: gridOpenBranchPayloadSchema,
    risk: 'destructive',
    searchTerms: [...branchTerms, 'open', 'switching', 'breaker', 'disconnect', 'outage', 'islanding', 'effektbryter', 'bryter', 'utkobling', 'kobling', 'frakobling', 'øydrift'],
  }),
  gridCommandCapability({
    id: gridCloseBranchCommandKind,
    title: 'Close branch',
    description: 'Closes an open branch, keeping its derate. Between two energised islands the synchro-check requires their frequency difference to be within the Automation\'s synchroCheckHz; closing onto a dead island is allowed.',
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
