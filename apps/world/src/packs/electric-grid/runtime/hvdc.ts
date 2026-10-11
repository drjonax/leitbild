import type { GridHvdcLinkDefinition } from '../grid-model.ts'
import { queueGridSignal } from './grid-signals.ts'
import { hvdcReceivingEndMw } from './hvdc-terminals.ts'
import type { GridHvdcLinkState, GridHvdcTrip, GridHvdcTripCause, GridIsland, GridRuntimeInstance } from './instance.ts'
import { gridTablesFor } from './state/tables.ts'

/**
 * HVDC links are controllable injection pairs, never AC branches. The sending converter draws
 * |transfer| from its AC bus and the receiving converter delivers |transfer|·(1 − loss). A terminal
 * on the boundary bus of an asynchronous external system lies outside the modelled AC network and
 * every island (hvdc-terminals.ts): that system absorbs or supplies it. A blocked or tripped link
 * transfers nothing. This is the injection of link `index`'s from-end converter into its AC bus (MW).
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
  return hvdcReceivingEndMw(grid.arrays.hvdcLinks[index]!.transferMw, grid.definition.index.hvdcLinks[index]!.lossPercent)
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

/**
 * A converter terminal has AC voltage: its bus is energised, or it lies in no island at the
 * boundary of an external system, which holds it (an HVDC terminal of an asynchronous system, or a
 * separated boundary bus of a synchronous one). Energisation is the physical test: an energised
 * island whose AC load flow did not converge has AC voltage that the solution failed to compute,
 * not a loss of it.
 */
const terminalEnergizedAt = (grid: GridRuntimeInstance, bus: number): boolean => {
  if (gridTablesFor(grid.definition).asynchronousBoundaryBus[bus] === 1) return true
  const islands = grid.islandPlan
  if (!islands) throw new Error(`Grid ${grid.definition.gridId} has no islands yet; HVDC converters act inside an advance`)
  const planIndex = islands.plan.islandIndexOfBus[bus]!
  return planIndex < 0 || islands.islands[planIndex]!.energized
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

/** Moves a deblocked link's transfer up to `stepMw` towards its set-point, arriving exactly. */
const rampLinkBy = (link: GridHvdcLinkDefinition, state: GridHvdcLinkState, stepMw: number): void => {
  const differenceMw = state.setpointMw - state.transferMw
  state.transferMw = Math.abs(differenceMw) <= stepMw ? state.setpointMw : state.transferMw + Math.sign(differenceMw) * stepMw
  state.lossesMw = Math.abs(state.transferMw) * link.lossPercent / 100
}

/** The step a deblocked link may take on its own ramp over `seconds`: its remaining distance, at most its ramp (MW). */
const ownStepMw = (link: GridHvdcLinkDefinition, state: GridHvdcLinkState, seconds: number): number =>
  Math.min(Math.abs(state.setpointMw - state.transferMw), link.rampMwPerMinute / 60 * seconds)

/** Σ over group k's deblocked links of min(share · distance, own step): what they move at `share` (MW). */
const groupMovedMw = (grid: GridRuntimeInstance, start: number, end: number, share: number, seconds: number): number => {
  const items = gridTablesFor(grid.definition).hvdcRampGroupLinks.items
  const links = grid.definition.index.hvdcLinks
  let movedMw = 0
  for (let position = start; position < end; position += 1) {
    const index = items[position]!
    const state = grid.arrays.hvdcLinks[index]!
    if (state.state !== 'deblocked') continue
    movedMw += Math.min(share * Math.abs(state.setpointMw - state.transferMw), ownStepMw(links[index]!, state, seconds))
  }
  return movedMw
}

/** Rounding of the shared steps (MW): a group's step this close to its links' remaining moves completes them, so they arrive exactly rather than a residue short. */
const groupStepRoundingMw = 1e-9

/**
 * Ramps the deblocked links of ramp group k over `seconds`: Σ|Δtransfer| stays within the group's
 * ramp and each link within its own. When the group binds it is shared in proportion to each link's
 * remaining distance (unbounded links arrive together), a link bounded by its own ramp passing its
 * unused share to the others: every link moves min(share · distance, own step) with the one share
 * that fills the group's step.
 */
const advanceRampGroup = (grid: GridRuntimeInstance, group: number, seconds: number): void => {
  const tables = gridTablesFor(grid.definition)
  const links = grid.definition.index.hvdcLinks
  const start = tables.hvdcRampGroupLinks.start[group]!
  const end = tables.hvdcRampGroupLinks.start[group + 1]!
  const budgetMw = grid.definition.index.hvdcRampGroups[group]!.rampMwPerMinute / 60 * seconds
  let share = 1
  if (groupMovedMw(grid, start, end, 1, seconds) > budgetMw + groupStepRoundingMw) {
    // Moved(share) is increasing and piecewise linear with a kink where a link reaches its own step:
    // from the last kink at or below the budget, the links still unbounded take the rest linearly.
    let lower = 0
    for (let position = start; position < end; position += 1) {
      const index = tables.hvdcRampGroupLinks.items[position]!
      const state = grid.arrays.hvdcLinks[index]!
      const distanceMw = Math.abs(state.setpointMw - state.transferMw)
      if (state.state !== 'deblocked' || distanceMw === 0) continue
      const kink = ownStepMw(links[index]!, state, seconds) / distanceMw
      if (kink > lower && groupMovedMw(grid, start, end, kink, seconds) <= budgetMw) lower = kink
    }
    let unboundedMw = 0
    for (let position = start; position < end; position += 1) {
      const index = tables.hvdcRampGroupLinks.items[position]!
      const state = grid.arrays.hvdcLinks[index]!
      const distanceMw = Math.abs(state.setpointMw - state.transferMw)
      if (state.state === 'deblocked' && distanceMw > 0 && ownStepMw(links[index]!, state, seconds) / distanceMw > lower) unboundedMw += distanceMw
    }
    share = lower + (budgetMw - groupMovedMw(grid, start, end, lower, seconds)) / unboundedMw
  }
  for (let position = start; position < end; position += 1) {
    const index = tables.hvdcRampGroupLinks.items[position]!
    const state = grid.arrays.hvdcLinks[index]!
    if (state.state !== 'deblocked') continue
    const link = links[index]!
    rampLinkBy(link, state, Math.min(share * Math.abs(state.setpointMw - state.transferMw), ownStepMw(link, state, seconds)))
  }
}

/**
 * Ramps each deblocked link's transfer towards its set-point at its ramp limit over `seconds`, and
 * the links of a ramp group together within the group's limit (advanceRampGroup). A converter
 * whose AC terminal has lost voltage (its island de-energised) trips first: its transfer drops to 0
 * and it takes no share of its group's ramp. On an energised island whose AC voltage is unsolved the
 * converters keep following their set-points: the non-convergence is numerical, so it trips, blocks
 * or ramps nothing and raises only the island's AC non-convergence alarm. A Plant reads the same
 * unsolved port conservatively as lost offsite power (electrical-ports.ts); that is the Plant's mapping.
 */
export const advanceHvdcLinks = (grid: GridRuntimeInstance, seconds: number): void => {
  const links = grid.definition.index.hvdcLinks
  const groupOfLink = gridTablesFor(grid.definition).hvdcRampGroupOfLink
  for (let index = 0; index < links.length; index += 1) {
    const state = grid.arrays.hvdcLinks[index]!
    if (state.state === 'deblocked' && !terminalsEnergized(grid, index)) tripHvdcLink(grid, links[index]!, state, 'ac-voltage-loss')
  }
  for (let index = 0; index < links.length; index += 1) {
    const state = grid.arrays.hvdcLinks[index]!
    if (state.state === 'deblocked' && groupOfLink[index] === -1) rampLinkBy(links[index]!, state, links[index]!.rampMwPerMinute / 60 * seconds)
  }
  for (let group = 0; group < grid.definition.index.hvdcRampGroups.length; group += 1) advanceRampGroup(grid, group, seconds)
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
