import type { GridHvdcLinkDefinition } from '../grid-model.ts'
import type { GridRuntimeInstance } from './instance.ts'

/**
 * HVDC links are controllable injection pairs, never AC branches. The sending converter draws
 * |transfer| from its AC bus and the receiving converter delivers |transfer|·(1 − loss). A terminal
 * on the boundary bus of an asynchronous external system lies outside the modelled AC network: that
 * system absorbs or supplies it.
 */
export const hvdcTerminalInjectionsMw = (grid: GridRuntimeInstance, link: GridHvdcLinkDefinition): { readonly fromMw: number; readonly toMw: number } => {
  const transferMw = grid.hvdcLinks.get(link.id)!.transferMw
  const deliveredMw = Math.abs(transferMw) * (1 - link.lossPercent / 100)
  const outside = grid.definition.index.asynchronousBoundaryBusIds
  const fromMw = transferMw >= 0 ? -transferMw : deliveredMw
  const toMw = transferMw >= 0 ? deliveredMw : transferMw
  return { fromMw: outside.has(link.fromBusId) ? 0 : fromMw, toMw: outside.has(link.toBusId) ? 0 : toMw }
}

/** Net HVDC injection into the given buses (MW). */
export const hvdcInjectionAtBusesMw = (grid: GridRuntimeInstance, busIds: ReadonlySet<string>): number => {
  let injectionMw = 0
  for (const link of grid.definition.index.hvdcLinks) {
    if (!busIds.has(link.fromBusId) && !busIds.has(link.toBusId)) continue
    const terminals = hvdcTerminalInjectionsMw(grid, link)
    if (busIds.has(link.fromBusId)) injectionMw += terminals.fromMw
    if (busIds.has(link.toBusId)) injectionMw += terminals.toMw
  }
  return injectionMw
}

const busIsEnergized = (grid: GridRuntimeInstance, busId: string): boolean => {
  if (grid.definition.index.asynchronousBoundaryBusIds.has(busId)) return true
  const islands = grid.islandPlan
  if (!islands) return false
  const network = islands.plan.network
  return islands.islands[islands.plan.islandIndexOfBus[network.busIndexById.get(busId)!]!]!.energized
}

/**
 * Ramps each link's transfer towards its set-point at its ramp limit over `seconds`. A converter
 * whose AC terminal is de-energised blocks: its transfer drops to 0.
 */
export const advanceHvdcLinks = (grid: GridRuntimeInstance, seconds: number): void => {
  for (const link of grid.definition.index.hvdcLinks) {
    const state = grid.hvdcLinks.get(link.id)!
    if (!busIsEnergized(grid, link.fromBusId) || !busIsEnergized(grid, link.toBusId)) {
      state.transferMw = 0
    } else {
      const stepMw = link.rampMwPerMinute / 60 * seconds
      const differenceMw = state.setpointMw - state.transferMw
      state.transferMw = Math.abs(differenceMw) <= stepMw ? state.setpointMw : state.transferMw + Math.sign(differenceMw) * stepMw
    }
    state.lossesMw = Math.abs(state.transferMw) * link.lossPercent / 100
  }
}

/** True while some unblocked link's transfer is still ramping towards its set-point. */
export const hvdcLinksRamping = (grid: GridRuntimeInstance): boolean =>
  grid.definition.index.hvdcLinks.some(link => {
    const state = grid.hvdcLinks.get(link.id)!
    return state.transferMw !== state.setpointMw && busIsEnergized(grid, link.fromBusId) && busIsEnergized(grid, link.toBusId)
  })

/** Sets an HVDC link's set-point; the transfer follows at the link's ramp limit. */
export const setHvdcSetpoint = (grid: GridRuntimeInstance, linkId: string, setpointMw: number): void => {
  const link = grid.definition.index.hvdcLinks.find(candidate => candidate.id === linkId)
  if (!link) throw new Error(`HVDC link not found: ${linkId}`)
  if (!Number.isFinite(setpointMw) || Math.abs(setpointMw) > link.ratingMw) {
    throw new Error(`HVDC link ${linkId} set-point ${setpointMw} MW lies outside its ±${link.ratingMw} MW rating`)
  }
  grid.hvdcLinks.get(linkId)!.setpointMw = setpointMw
}
