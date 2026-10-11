import type { GridBranchDefinition } from '../grid-model.ts'
import type { CaseParticipation } from './contingency-balance.ts'
import { caseGeneratorOutputMw, switchedContingencyCase, type ContingencyCase, type CaseChanges } from './contingency-case.ts'
import { gridIslandAtBus, gridIslandFrequencyHz, solvedGridIslands } from './island-lifecycle.ts'
import { manualShedRejection } from './load-shedding.ts'
import { generatorMinimumStableMw } from './unit-commitment.ts'

/** A candidate remedial action, evaluated on a private case; the Agent applies the real one by command. */
export type GridRemedialAction =
  | { readonly kind: 'redispatch'; readonly assetId: string; readonly targetMw: number }
  | { readonly kind: 'shed-load'; readonly assetId: string; readonly targetDemandMw: number; readonly emergency: boolean }
  | { readonly kind: 'open-branch'; readonly assetId: string }
  | { readonly kind: 'close-branch'; readonly assetId: string }

const mw = (value: number): string => `${Math.round(value * 10) / 10} MW`
const degreesPerRadian = 180 / Math.PI

/** Case components holding boundary buses of one synchronous external system: they share its frequency. */
const synchronouslyCoupled = (current: ContingencyCase, fromComponent: number, toComponent: number): boolean => {
  const { grid, network } = current
  return grid.definition.index.externalSystems.some(system => {
    if (!system.synchronous) return false
    // A boundary bus whose ties are all open is a component of its own and couples nothing.
    const coupled = new Set(system.boundaryBusIds
      .map(busId => current.islandOfBus[network.busIndexById.get(busId)!]!)
      .filter(component => current.islands[component]!.buses.length > 1))
    return coupled.has(fromComponent) && coupled.has(toComponent)
  })
}

/**
 * The synchro-check of close-branch with the Automation's limits, as the command applies it, on the
 * case the earlier actions make: ends in one AC component (closing a loop) by their DC voltage
 * angles; ends in two components coupled through a synchronous external equivalent close freely;
 * ends in two islands by the measured frequencies of the live islands they lie in (a split the
 * earlier actions make leaves both parts at one frequency). Returns why the command would be
 * rejected, with the measured difference, or null.
 */
const synchroCheckRejection = (current: ContingencyCase, branch: GridBranchDefinition, afterActions: boolean): string | null => {
  const { grid, network } = current
  const limits = grid.definition.automation.synchroCheck
  const fromBus = network.busIndexById.get(branch.fromBusId)!
  const toBus = network.busIndexById.get(branch.toBusId)!
  const fromComponent = current.islandOfBus[fromBus]!
  const toComponent = current.islandOfBus[toBus]!
  const rejected = `close-branch ${branch.id} would be rejected by synchro-check`
  if (fromComponent === toComponent) {
    const angleDegrees = Math.abs(current.anglesRad[fromBus]! - current.anglesRad[toBus]!) * degreesPerRadian
    if (angleDegrees <= limits.maximumAngleDifferenceDegrees) return null
    return `${rejected}: both ends are in one energised island${afterActions ? ' after the earlier actions' : ''} and their voltage angles differ by Δθ ${angleDegrees.toFixed(1)}°, `
      + `above the ${limits.maximumAngleDifferenceDegrees}° loop-closing limit; redispatch to reduce the angle before closing`
  }
  if (synchronouslyCoupled(current, fromComponent, toComponent)) return null
  const islands = solvedGridIslands(grid)
  const from = gridIslandAtBus(islands, branch.fromBusId)
  const to = gridIslandAtBus(islands, branch.toBusId)
  if (from.id === to.id) return null
  const fromHz = gridIslandFrequencyHz(from)!
  const toHz = gridIslandFrequencyHz(to)!
  const slipHz = Math.abs(fromHz - toHz)
  if (slipHz <= limits.maximumFrequencyDifferenceHz) return null
  return `${rejected}: ${from.id} at ${fromHz.toFixed(3)} Hz and ${to.id} at ${toHz.toFixed(3)} Hz differ by Δf ${slipHz.toFixed(3)} Hz, `
    + `above the ${limits.maximumFrequencyDifferenceHz} Hz limit; bring the islands within ${limits.maximumFrequencyDifferenceHz} Hz first`
}

const cloneParticipation = (participation: CaseParticipation): CaseParticipation => ({
  upMw: participation.upMw.slice(),
  downMw: participation.downMw.slice(),
  kineticEnergyMws: participation.kineticEnergyMws.slice(),
  formingCount: participation.formingCount.slice(),
  servedLoadMw: participation.servedLoadMw.slice(),
})

/**
 * Validates the actions, in order, with the same rules as the commands they stand for, and returns
 * the changes they make to the case: a redispatched unit holds its new set-point (it leaves the
 * balancing), shed load is no longer served, branches open or close (closing only between energised
 * ends and through the synchro-check, measured after the earlier actions). switchedContingencyCase
 * then rebalances every island by reserve participation.
 */
export const remedialCaseChanges = (base: ContingencyCase, actions: ReadonlyArray<GridRemedialAction>): CaseChanges => {
  const { grid, network } = base
  const closed = base.closed.slice()
  const injections = base.injectionsMw.slice()
  const participation = cloneParticipation(base.participation)
  const redispatchedMw = new Map(base.redispatchedMw)
  const energisedBus = (busId: string): boolean => base.islands[base.islandOfBus[network.busIndexById.get(busId)!]!]!.energised
  const touched = new Set<string>()
  // The case the earlier actions make, solved anew for each close that follows one.
  const caseBefore = (position: number): ContingencyCase => position === 0
    ? base
    : switchedContingencyCase(base, { closed: closed.slice(), injections, participation, redispatchedMw }).case
  for (const [position, action] of actions.entries()) {
    if (touched.has(action.assetId)) throw new Error(`remedial actions name ${action.assetId} more than once`)
    touched.add(action.assetId)
    const entry = grid.definition.index.assetById.get(action.assetId)
    if (action.kind === 'redispatch') {
      if (entry?.kind !== 'generator') throw new Error(`redispatch needs a generator Grid Asset: ${action.assetId}`)
      const state = grid.generators.get(action.assetId)!
      if (state.state !== 'online' || !energisedBus(entry.definition.busId)) throw new Error(`generator ${action.assetId} is ${state.state}; only an online unit in an energised island can be redispatched`)
      const minimumMw = generatorMinimumStableMw(entry.definition)
      if (action.targetMw > state.availableMw || action.targetMw < minimumMw) {
        throw new Error(`redispatch target ${mw(action.targetMw)} of ${action.assetId} lies outside its minimum stable ${mw(minimumMw)} to available ${mw(state.availableMw)}`)
      }
      const bus = network.busIndexById.get(entry.definition.busId)!
      injections[bus] = injections[bus]! + action.targetMw - caseGeneratorOutputMw(base, action.assetId)
      participation.upMw[bus] = participation.upMw[bus]! - (state.reserves.fcrNMw + state.reserves.fcrDUpMw)
      participation.downMw[bus] = participation.downMw[bus]! - (state.reserves.fcrNMw + state.reserves.fcrDDownMw)
      redispatchedMw.set(action.assetId, action.targetMw)
      continue
    }
    if (action.kind === 'shed-load') {
      if (entry?.kind !== 'load') throw new Error(`shed-load needs a load Grid Asset: ${action.assetId}`)
      const state = grid.loads.get(action.assetId)!
      const rejection = manualShedRejection({ definition: entry.definition, state, demandMw: state.demandMw, targetMw: action.targetDemandMw, emergency: action.emergency })
      if (rejection !== null) throw new Error(rejection)
      const servedMw = state.servedMw
      if (action.targetDemandMw >= servedMw) throw new Error(`target demand ${mw(action.targetDemandMw)} would shed nothing: ${action.assetId} is served ${mw(servedMw)}`)
      const bus = network.busIndexById.get(entry.definition.busId)!
      injections[bus] = injections[bus]! + servedMw - action.targetDemandMw
      participation.servedLoadMw[bus] = participation.servedLoadMw[bus]! - (servedMw - action.targetDemandMw)
      continue
    }
    if (entry?.kind !== 'branch') throw new Error(`${action.kind} needs a branch Grid Asset: ${action.assetId}`)
    const index = network.branchIds.indexOf(action.assetId)
    const state = grid.branches.get(action.assetId)!.state
    if (action.kind === 'open-branch') {
      if (closed[index] !== 1) throw new Error(`branch ${action.assetId} is already open`)
      closed[index] = 0
      continue
    }
    if (state === 'tripped') throw new Error(`branch ${action.assetId} is tripped; reset-branch-protection comes before closing it`)
    if (closed[index] === 1) throw new Error(`branch ${action.assetId} is already closed`)
    const current = caseBefore(position)
    const energisedInCase = (busId: string): boolean => current.islands[current.islandOfBus[network.busIndexById.get(busId)!]!]!.energised
    if (!energisedInCase(entry.definition.fromBusId) || !energisedInCase(entry.definition.toBusId)) {
      throw new Error(`closing ${action.assetId} onto a de-energised island is restoration, not a remedial action this evaluation covers`)
    }
    const rejection = synchroCheckRejection(current, entry.definition, current !== base)
    if (rejection !== null) throw new Error(rejection)
    closed[index] = 1
  }
  return { closed, injections, participation, redispatchedMw }
}
