import { gridSetExternalExchangeCommandKind, gridSetExternalExchangePayloadSchema } from '../commands/external.ts'
import { externalSystemIsland, operatingPointImportMw } from './boundary-separation.ts'
import type { GridRuntimeInstance } from './instance.ts'
import { boundaryTieCapacityMw } from './island-input.ts'
import { solvedGridIslands } from './island-lifecycle.ts'

// The scheduled exchange of a synchronous external system: the dispatch sets it, a separation from
// every Norwegian island voids it (boundary-separation.ts), and set-external-exchange sets a target
// it ramps to at the Automation's externalExchange.rampMwPerMinute.

const mw = (value: number): string => `${Math.round(value * 10) / 10} MW`

/**
 * Ramps each synchronous external system's scheduled import towards its target over `seconds`. An
 * exchange a separation voided is restored once the schedule is back at the Operating Point's.
 */
export const advanceExternalExchanges = (grid: GridRuntimeInstance, seconds: number): void => {
  const systems = grid.definition.index.externalSystems
  const stepMw = grid.definition.automation.externalExchange.rampMwPerMinute / 60 * seconds
  for (let position = 0; position < systems.length; position += 1) {
    const system = systems[position]!
    if (!system.synchronous) continue
    const state = grid.arrays.externalSystems[position]!
    const differenceMw = state.targetImportMw - state.scheduledImportMw
    state.scheduledImportMw = Math.abs(differenceMw) <= stepMw ? state.targetImportMw : state.scheduledImportMw + Math.sign(differenceMw) * stepMw
    if (state.exchangeVoided && state.scheduledImportMw === operatingPointImportMw(grid, system)) state.exchangeVoided = false
  }
}

/** True while some synchronous external system's schedule is still ramping towards its target. */
export const externalExchangesRamping = (grid: GridRuntimeInstance): boolean => {
  const systems = grid.definition.index.externalSystems
  for (let position = 0; position < systems.length; position += 1) {
    const state = grid.arrays.externalSystems[position]!
    if (systems[position]!.synchronous && state.scheduledImportMw !== state.targetImportMw) return true
  }
  return false
}

export const gridExternalCommandHandlers = {
  [gridSetExternalExchangeCommandKind]: (grid: GridRuntimeInstance, rawPayload: unknown): void => {
    const payload = gridSetExternalExchangePayloadSchema.parse(rawPayload)
    const systems = grid.definition.index.externalSystems
    const position = systems.findIndex(system => system.id === payload.assetId)
    if (position < 0) throw new Error(`external system not found: ${payload.assetId}. world.electric-grid.grid.summary lists the synchronous external systems under externalExchanges.`)
    const system = systems[position]!
    if (!system.synchronous) throw new Error(`${system.id} is reached only by HVDC; set-hvdc-setpoint sets the transfer of its links`)
    if (externalSystemIsland(solvedGridIslands(grid), position) === null) {
      throw new Error(`${system.id} is coupled to no Norwegian island: all its ties are open, so there is nothing to exchange with; close a tie to it first (close-branch, under the synchro-check)`)
    }
    const capabilityMw = system.boundaryBusIds.reduce((sum, busId) => sum + boundaryTieCapacityMw(grid, busId), 0)
    if (Math.abs(payload.scheduledExportMw) > capabilityMw) {
      throw new Error(`scheduled exchange ${mw(payload.scheduledExportMw)} with ${system.id} exceeds the ${mw(capabilityMw)} rating of its closed ties (positive exports from Norway)`)
    }
    const state = grid.arrays.externalSystems[position]!
    const targetImportMw = 0 - payload.scheduledExportMw
    if (targetImportMw === state.targetImportMw) {
      throw new Error(`${system.id} already has the target scheduled exchange ${mw(payload.scheduledExportMw)} (scheduled now ${mw(0 - state.scheduledImportMw)}, positive exports from Norway)`)
    }
    state.targetImportMw = targetImportMw
  },
} as const
