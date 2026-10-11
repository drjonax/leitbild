import type { GridHvdcLinkDefinition } from '../grid-model.ts'
import { queueGridSignal } from './grid-signals.ts'
import type { GridHvdcLinkState, GridHvdcTrip, GridHvdcTripCause, GridIsland, GridRuntimeInstance } from './instance.ts'
import { gridTablesFor } from './state/tables.ts'

/**
 * HVDC links are controllable injection pairs, never AC branches. The sending converter draws
 * |transfer| from its AC bus and the receiving converter delivers |transfer|·(1 − loss). A terminal
 * on the boundary bus of an asynchronous external system lies outside the modelled AC network: that
 * system absorbs or supplies it. A blocked or tripped link transfers nothing.
 */
export const hvdcTerminalInjectionsMw = (grid: GridRuntimeInstance, link: GridHvdcLinkDefinition): { readonly fromMw: number; readonly toMw: number } => {
  const transferMw = grid.hvdcLinks.get(link.id)!.transferMw
  const deliveredMw = Math.abs(transferMw) * (1 - link.lossPercent / 100)
  const outside = grid.definition.index.asynchronousBoundaryBusIds
  const fromMw = transferMw >= 0 ? -transferMw : deliveredMw
  const toMw = transferMw >= 0 ? deliveredMw : transferMw
  return { fromMw: outside.has(link.fromBusId) ? 0 : fromMw, toMw: outside.has(link.toBusId) ? 0 : toMw }
}

/** Whether an ascending list of bus indices holds `bus`. */
const holdsBus = (buses: Int32Array, bus: number): boolean => {
  let low = 0
  let high = buses.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const value = buses[middle]!
    if (value === bus) return true
    if (value < bus) low = middle + 1
    else high = middle - 1
  }
  return false
}

/** Net HVDC injection into an island's buses (MW); `buses` are its network bus indices, ascending. */
export const hvdcInjectionIntoIslandMw = (grid: GridRuntimeInstance, buses: Int32Array): number => {
  const tables = gridTablesFor(grid.definition)
  const links = grid.definition.index.hvdcLinks
  let injectionMw = 0
  for (let index = 0; index < links.length; index += 1) {
    const from = holdsBus(buses, tables.hvdcFromBus[index]!)
    const to = holdsBus(buses, tables.hvdcToBus[index]!)
    if (!from && !to) continue
    const terminals = hvdcTerminalInjectionsMw(grid, links[index]!)
    if (from) injectionMw += terminals.fromMw
    if (to) injectionMw += terminals.toMw
  }
  return injectionMw
}

/** The stable island holding a bus at the latest island reconciliation. */
const islandAtBus = (grid: GridRuntimeInstance, busId: string): GridIsland => {
  const islands = grid.islandPlan
  if (!islands) throw new Error(`Grid ${grid.definition.gridId} has no islands yet; HVDC converters act inside an advance`)
  const network = islands.plan.network
  return islands.islands[islands.plan.islandIndexOfBus[network.busIndexById.get(busId)!]!]!
}

/** A converter terminal has AC voltage: its bus is energised, or it is the boundary of an asynchronous system. */
const terminalEnergized = (grid: GridRuntimeInstance, busId: string): boolean =>
  grid.definition.index.asynchronousBoundaryBusIds.has(busId) || islandAtBus(grid, busId).energized

const terminalsEnergized = (grid: GridRuntimeInstance, link: GridHvdcLinkDefinition): boolean =>
  terminalEnergized(grid, link.fromBusId) && terminalEnergized(grid, link.toBusId)

/** The converter terminal without AC voltage as `label (bus id)`, or null when both terminals have it. */
export const unpoweredHvdcTerminal = (grid: GridRuntimeInstance, link: GridHvdcLinkDefinition): string | null => {
  const busId = [link.fromBusId, link.toBusId].find(candidate => !terminalEnergized(grid, candidate))
  return busId === undefined ? null : `${grid.definition.index.busById.get(busId)!.label} (${busId})`
}

export const hvdcLinkFor = (grid: GridRuntimeInstance, linkId: string): { readonly definition: GridHvdcLinkDefinition; readonly state: GridHvdcLinkState } => {
  const definition = grid.definition.index.hvdcLinks.find(link => link.id === linkId)
  const state = grid.hvdcLinks.get(linkId)
  if (!definition || !state) throw new Error(`HVDC link not found: ${linkId}. Discover HVDC link ids with world.electric-grid.assets.search (kind hvdc).`)
  return { definition, state }
}

/** A blocked or tripped link: no set-point, transfer or losses. */
export const stopHvdcLink = (state: GridHvdcLinkState): void => {
  state.setpointMw = 0
  state.transferMw = 0
  state.lossesMw = 0
}

const tripCauseText: Readonly<Record<GridHvdcTripCause, string>> = {
  command: 'was tripped by command',
  'ac-voltage-loss': 'tripped on loss of AC voltage',
}

/** What tripped a link, for rejection reasons and its alarm. */
export const hvdcTripReason = (trip: GridHvdcTrip): string =>
  `${tripCauseText[trip.cause]} while sending ${Math.round(trip.transferMw * 10) / 10} MW`

/** Queues an operator transition of a link as a Simulation Run signal. */
export const queueHvdcTransition = (grid: GridRuntimeInstance, link: GridHvdcLinkDefinition, transition: 'blocked' | 'deblocked' | 'trip-reset', transferBeforeMw: number): void => {
  queueGridSignal(grid, {
    type: `electric-grid.hvdc.${transition}`,
    // A block disconnects an import or export at once.
    severity: transition === 'blocked' ? 'warning' : 'info',
    key: `hvdc|${link.id}|${transition}|${grid.elapsedMs}|${grid.tick}`,
    payload: {
      gridId: grid.definition.gridId,
      assetId: link.id,
      label: link.label,
      transferBeforeMw,
      islandId: islandAtBus(grid, link.fromBusId).id,
      elapsedSeconds: grid.elapsedMs / 1_000,
    },
  })
}

/** Trips a deblocked link: its transfer drops to 0 at once and it stays tripped until reset-hvdc-trip. */
export const tripHvdcLink = (grid: GridRuntimeInstance, link: GridHvdcLinkDefinition, state: GridHvdcLinkState, cause: GridHvdcTripCause): void => {
  const transferMw = state.transferMw
  state.state = 'tripped'
  state.trip = { cause, atElapsedMs: grid.elapsedMs, transferMw }
  stopHvdcLink(state)
  queueGridSignal(grid, {
    type: 'electric-grid.protection.tripped',
    severity: 'warning',
    key: `trip|${link.id}|${grid.elapsedMs}|${grid.tick}`,
    payload: {
      gridId: grid.definition.gridId,
      assetId: link.id,
      assetKind: 'hvdc',
      label: link.label,
      element: cause,
      transferMw,
      islandId: islandAtBus(grid, link.fromBusId).id,
      elapsedSeconds: grid.elapsedMs / 1_000,
    },
  })
}

/**
 * Ramps each deblocked link's transfer towards its set-point at its ramp limit over `seconds`. A
 * converter whose AC terminal has lost voltage trips first: its transfer drops to 0.
 */
export const advanceHvdcLinks = (grid: GridRuntimeInstance, seconds: number): void => {
  for (const link of grid.definition.index.hvdcLinks) {
    const state = grid.hvdcLinks.get(link.id)!
    if (state.state !== 'deblocked') continue
    if (!terminalsEnergized(grid, link)) {
      tripHvdcLink(grid, link, state, 'ac-voltage-loss')
      continue
    }
    const stepMw = link.rampMwPerMinute / 60 * seconds
    const differenceMw = state.setpointMw - state.transferMw
    state.transferMw = Math.abs(differenceMw) <= stepMw ? state.setpointMw : state.transferMw + Math.sign(differenceMw) * stepMw
    state.lossesMw = Math.abs(state.transferMw) * link.lossPercent / 100
  }
}

/** True while some deblocked link's transfer is still ramping towards its set-point. */
export const hvdcLinksRamping = (grid: GridRuntimeInstance): boolean =>
  grid.definition.index.hvdcLinks.some(link => {
    const state = grid.hvdcLinks.get(link.id)!
    return state.state === 'deblocked' && state.transferMw !== state.setpointMw && terminalsEnergized(grid, link)
  })
