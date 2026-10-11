import type { GridHvdcLinkDefinition } from '../grid-model.ts'
import { queueGridSignal } from './grid-signals.ts'
import type { GridHvdcLinkState, GridHvdcTrip, GridHvdcTripCause, GridIsland, GridRuntimeInstance } from './instance.ts'
import { gridTablesFor } from './state/tables.ts'

/**
 * HVDC links are controllable injection pairs, never AC branches. The sending converter draws
 * |transfer| from its AC bus and the receiving converter delivers |transfer|·(1 − loss). A terminal
 * on the boundary bus of an asynchronous external system lies outside the modelled AC network: that
 * system absorbs or supplies it. A blocked or tripped link transfers nothing. This is the injection
 * of link `index`'s from-end converter into its AC bus (MW).
 */
export const hvdcFromTerminalMw = (grid: GridRuntimeInstance, index: number): number => {
  const tables = gridTablesFor(grid.definition)
  if (tables.asynchronousBoundaryBus[tables.hvdcFromBus[index]!] === 1) return 0
  const transferMw = grid.arrays.hvdcLinks[index]!.transferMw
  return transferMw >= 0 ? -transferMw : Math.abs(transferMw) * (1 - grid.definition.index.hvdcLinks[index]!.lossPercent / 100)
}

/** Injection of link `index`'s to-end converter into its AC bus (MW); see hvdcFromTerminalMw. */
export const hvdcToTerminalMw = (grid: GridRuntimeInstance, index: number): number => {
  const tables = gridTablesFor(grid.definition)
  if (tables.asynchronousBoundaryBus[tables.hvdcToBus[index]!] === 1) return 0
  const transferMw = grid.arrays.hvdcLinks[index]!.transferMw
  return transferMw >= 0 ? Math.abs(transferMw) * (1 - grid.definition.index.hvdcLinks[index]!.lossPercent / 100) : transferMw
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
    if (from) injectionMw += hvdcFromTerminalMw(grid, index)
    if (to) injectionMw += hvdcToTerminalMw(grid, index)
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
const terminalEnergizedAt = (grid: GridRuntimeInstance, bus: number): boolean => {
  if (gridTablesFor(grid.definition).asynchronousBoundaryBus[bus] === 1) return true
  const islands = grid.islandPlan
  if (!islands) throw new Error(`Grid ${grid.definition.gridId} has no islands yet; HVDC converters act inside an advance`)
  return islands.islands[islands.plan.islandIndexOfBus[bus]!]!.energized
}

const terminalEnergized = (grid: GridRuntimeInstance, busId: string): boolean =>
  terminalEnergizedAt(grid, gridTablesFor(grid.definition).network.busIndexById.get(busId)!)

/** Whether both converter terminals of link `index` have AC voltage. */
const terminalsEnergized = (grid: GridRuntimeInstance, index: number): boolean => {
  const tables = gridTablesFor(grid.definition)
  return terminalEnergizedAt(grid, tables.hvdcFromBus[index]!) && terminalEnergizedAt(grid, tables.hvdcToBus[index]!)
}

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
  const links = grid.definition.index.hvdcLinks
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index]!
    const state = grid.arrays.hvdcLinks[index]!
    if (state.state !== 'deblocked') continue
    if (!terminalsEnergized(grid, index)) {
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
export const hvdcLinksRamping = (grid: GridRuntimeInstance): boolean => {
  const links = grid.definition.index.hvdcLinks
  for (let index = 0; index < links.length; index += 1) {
    const state = grid.arrays.hvdcLinks[index]!
    if (state.state === 'deblocked' && state.transferMw !== state.setpointMw && terminalsEnergized(grid, index)) return true
  }
  return false
}
