import { caseGeneratorOutputMw, type CaseParticipation, type ContingencyCase, type CaseChanges } from './contingency-case.ts'
import { manualShedRejection } from './load-shedding.ts'
import { generatorMinimumStableMw } from './unit-commitment.ts'

/** A candidate remedial action, evaluated on a private case; the Agent applies the real one by command. */
export type GridRemedialAction =
  | { readonly kind: 'redispatch'; readonly assetId: string; readonly targetMw: number }
  | { readonly kind: 'shed-load'; readonly assetId: string; readonly targetDemandMw: number; readonly emergency: boolean }
  | { readonly kind: 'open-branch'; readonly assetId: string }
  | { readonly kind: 'close-branch'; readonly assetId: string }

const mw = (value: number): string => `${Math.round(value * 10) / 10} MW`

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
 * ends). switchedContingencyCase then rebalances every island by reserve participation.
 */
export const remedialCaseChanges = (base: ContingencyCase, actions: ReadonlyArray<GridRemedialAction>): CaseChanges => {
  const { grid, network } = base
  const closed = base.closed.slice()
  const injections = base.injectionsMw.slice()
  const participation = cloneParticipation(base.participation)
  const redispatchedMw = new Map(base.redispatchedMw)
  const energisedBus = (busId: string): boolean => base.islands[base.islandOfBus[network.busIndexById.get(busId)!]!]!.energised
  const touched = new Set<string>()
  for (const action of actions) {
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
    if (!energisedBus(entry.definition.fromBusId) || !energisedBus(entry.definition.toBusId)) {
      throw new Error(`closing ${action.assetId} onto a de-energised island is restoration, not a remedial action this evaluation covers`)
    }
    closed[index] = 1
  }
  return { closed, injections, participation, redispatchedMw }
}
