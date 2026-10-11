import { compileGridModelV2 } from '../../../src/packs/electric-grid/models/compile-v2.ts'
import { createAcNetwork, type AcNetwork } from '../../../src/packs/electric-grid/runtime/network/ac-network.ts'
import {
  createAcIslandSystem,
  createAcPowerFlowState,
  solveAcIsland,
  type AcIslandOutcome,
  type AcPowerFlowState,
} from '../../../src/packs/electric-grid/runtime/network/fdlf.ts'
import type { GridModelV2 } from '../../../src/packs/electric-grid/schemas/grid-model.ts'
import type { GridOperatingPointV2 } from '../../../src/packs/electric-grid/schemas/grid-operating-point.ts'

// AC load flow of a generated Grid Model v2 at one Operating Point, per energised island, with
// the runtime's fast-decoupled solver. Demand comes from the runtime mapping (compile-v2); the AC
// data compile-v2 does not carry yet (charging, taps, shunts, power factors, set-points) from v2.
//
// - Online units hold their bus at their set-point within ±ratedMva·sin(acos cos φ) (PV buses).
// - HVDC links inject their scheduled transfer at the Norwegian converter bus (reactive power is
//   balanced at the converter by its filters or VSC control).
// - The boundary buses of a synchronous external system hold 1 pu with unlimited reactive power
//   (a strong external grid) and take its scheduled export in proportion to the continuous rating
//   of the AC ties ending there, as compile-v2 shares the system's parameters.
// - A branch's ratings scale by its Operating Point availability, as the runtime's derate does.
// - Losses close by a distributed slack over the online storage hydro, in proportion to capacity
//   (governor droop on rating); an island without storage hydro shares over its synchronous units.

export interface IslandFlow {
  readonly islandId: string
  readonly busIds: ReadonlyArray<string>
  readonly outcome: AcIslandOutcome
}

export interface V2PowerFlow {
  readonly network: AcNetwork
  readonly state: AcPowerFlowState
  readonly islands: ReadonlyArray<IslandFlow>
  /** Network index of each bus id. */
  readonly busIndex: ReadonlyMap<string, number>
  /** v2 branches in network order. */
  readonly branches: ReadonlyArray<GridModelV2['branches'][number]>
  /** Continuous and emergency rating of each branch in network order at the Operating Point's availability, MVA. */
  readonly ratings: ReadonlyArray<{ readonly continuousMva: number; readonly emergencyMva: number }>
  /** Σ compiled demand, MW, and Σ of the loads' MW the solve used: the two must agree. */
  readonly compiledDemandMw: number
  readonly solvedDemandMw: number
}

const scheduledAt = <Point,>(points: ReadonlyArray<Point>): Point => {
  if (points.length !== 1) throw new Error('the power-flow check reads constant (single-point) schedules only')
  return points[0]!
}

export const solveV2PowerFlow = (model: GridModelV2, operatingPoint: GridOperatingPointV2, options: { readonly tolerancePu: number; readonly maximumIterations: number }): V2PowerFlow => {
  const compiled = compileGridModelV2(model, operatingPoint)
  const busIndex = new Map(model.buses.map((bus, index) => [bus.id, index]))
  const open = new Set((operatingPoint.branchStates ?? []).filter(state => state.state === 'open').map(state => state.assetId))
  const availability = new Map((operatingPoint.branchStates ?? []).flatMap(state => state.availability === undefined ? [] : [[state.assetId, state.availability] as const]))
  const branches = model.branches.filter(branch => !open.has(branch.id))
  const n = model.buses.length
  const shunt = new Float64Array(n)
  for (const entry of model.shunts) shunt[busIndex.get(entry.busId)!] = shunt[busIndex.get(entry.busId)!]! + entry.mvarAtNominalVoltage / model.sBaseMva
  const network = createAcNetwork({
    sBaseMva: model.sBaseMva,
    busCount: n,
    branchCount: branches.length,
    busIds: model.buses.map(bus => bus.id),
    branchFrom: Int32Array.from(branches, branch => busIndex.get(branch.fromBusId)!),
    branchTo: Int32Array.from(branches, branch => busIndex.get(branch.toBusId)!),
    branchResistancePu: Float64Array.from(branches, branch => branch.resistancePu),
    branchReactancePu: Float64Array.from(branches, branch => branch.reactancePu),
    branchChargingSusceptancePu: Float64Array.from(branches, branch => branch.chargingSusceptancePu),
    branchTapRatio: Float64Array.from(branches, branch => branch.kind === 'transformer' ? branch.tapRatio! : 1),
    busShuntConductancePu: new Float64Array(n),
    busShuntSusceptancePu: shunt,
  })

  const active = new Float64Array(n)
  const reactive = new Float64Array(n)
  const controlled = new Uint8Array(n)
  const setpoint = new Float64Array(n).fill(Number.NaN)
  const qMinimum = new Float64Array(n)
  const qMaximum = new Float64Array(n)
  const storageShare = new Float64Array(n)
  const synchronousShare = new Float64Array(n)
  let solvedDemandMw = 0
  for (const load of compiled.model.loads) {
    const bus = busIndex.get(load.busId)!
    active[bus] = active[bus]! - load.demandMw
    reactive[bus] = reactive[bus]! - load.reactiveDemandMvar
    solvedDemandMw += load.demandMw
  }
  const states = new Map((operatingPoint.generatorStates ?? []).map(state => [state.assetId, state]))
  for (const generator of model.generators) {
    const state = states.get(generator.id)
    if (state === undefined) throw new Error(`${operatingPoint.id} gives ${generator.id} no initial state`)
    if (state.state !== 'online') continue
    const bus = busIndex.get(generator.busId)!
    if (state.targetMw === undefined) throw new Error(`${operatingPoint.id} puts ${generator.id} online without a dispatch target`)
    active[bus] = active[bus]! + state.targetMw
    const range = generator.ratedMva * Math.sqrt(1 - generator.powerFactor ** 2)
    if (controlled[bus] === 1 && setpoint[bus] !== generator.voltageSetpointPu) throw new Error(`bus ${generator.busId}: units with different voltage set-points`)
    controlled[bus] = 1
    setpoint[bus] = generator.voltageSetpointPu
    qMinimum[bus] = qMinimum[bus]! - range
    qMaximum[bus] = qMaximum[bus]! + range
    if (generator.kind === 'hydro-reservoir' || generator.kind === 'hydro-pumped') storageShare[bus] = storageShare[bus]! + generator.capacityMw
    if (generator.synchronous) synchronousShare[bus] = synchronousShare[bus]! + generator.capacityMw
  }
  for (const schedule of operatingPoint.hvdcSchedules ?? []) {
    const link = model.hvdcLinks.find(candidate => candidate.id === schedule.assetId)
    if (link === undefined) throw new Error(`unknown HVDC link ${schedule.assetId}`)
    const transfer = scheduledAt(schedule.points).transferMw
    const from = busIndex.get(link.fromBusId)!
    const to = busIndex.get(link.toBusId)!
    active[from] = active[from]! - transfer
    active[to] = active[to]! + transfer
  }
  for (const schedule of operatingPoint.externalExchangeSchedules ?? []) {
    const system = model.externalSystems.find(candidate => candidate.id === schedule.assetId)
    if (system === undefined) throw new Error(`unknown external system ${schedule.assetId}`)
    const exportMw = scheduledAt(schedule.points).exportMw
    const tieMw = (busId: string): number => model.branches.filter(branch => branch.fromBusId === busId || branch.toBusId === busId).reduce((sum, branch) => sum + branch.ratingMw, 0)
    const total = system.boundaryBusIds.reduce((sum, busId) => sum + tieMw(busId), 0)
    for (const busId of system.boundaryBusIds) {
      const bus = busIndex.get(busId)!
      active[bus] = active[bus]! - exportMw * tieMw(busId) / total
      controlled[bus] = 1
      setpoint[bus] = 1
      qMinimum[bus] = Number.NEGATIVE_INFINITY
      qMaximum[bus] = Number.POSITIVE_INFINITY
    }
  }

  // Islands over the closed branches; HVDC-only boundary buses form islands of their own.
  const neighbours: number[][] = Array.from({ length: n }, () => [])
  branches.forEach((branch, index) => {
    neighbours[network.branchFrom[index]!]!.push(network.branchTo[index]!)
    neighbours[network.branchTo[index]!]!.push(network.branchFrom[index]!)
  })
  const islandOf = new Int32Array(n).fill(-1)
  const members: number[][] = []
  for (let start = 0; start < n; start += 1) {
    if (islandOf[start] !== -1) continue
    const island: number[] = []
    const stack = [start]
    islandOf[start] = members.length
    while (stack.length > 0) {
      const bus = stack.pop()!
      island.push(bus)
      for (const next of neighbours[bus]!) {
        if (islandOf[next] !== -1) continue
        islandOf[next] = members.length
        stack.push(next)
      }
    }
    members.push(island.sort((left, right) => left - right))
  }
  const state = createAcPowerFlowState(network)
  const localOfBus = new Int32Array(n)
  const islands: IslandFlow[] = []
  members.forEach((island, islandIndex) => {
    if (island.length === 1 && neighbours[island[0]!]!.length === 0) return
    if (!island.some(bus => controlled[bus] === 1)) return
    const islandBranches: number[] = []
    branches.forEach((_, index) => { if (islandOf[network.branchFrom[index]!] === islandIndex) islandBranches.push(index) })
    const share = island.some(bus => storageShare[bus]! > 0) ? storageShare : synchronousShare
    const participation = new Float64Array(n)
    let reference = island[0]!
    for (const bus of island) {
      participation[bus] = share[bus]!
      if (share[bus]! > share[reference]!) reference = bus
    }
    const islandId = `island-${islandIndex}`
    const system = createAcIslandSystem({ network, islandId, buses: Int32Array.from(island), branches: Int32Array.from(islandBranches), localOfBus })
    const outcome = solveAcIsland(network, system, {
      activeInjectionMw: active,
      reactiveInjectionMvar: reactive,
      voltageControlled: controlled,
      voltageSetpointPu: setpoint,
      reactiveMinimumMvar: qMinimum,
      reactiveMaximumMvar: qMaximum,
    }, {
      slack: { kind: 'distributed', angleReferenceBus: reference, participation },
      tolerancePu: options.tolerancePu,
      maximumIterations: options.maximumIterations,
      enforceReactiveLimits: true,
      start: 'flat',
    }, state)
    islands.push({ islandId, busIds: island.map(bus => model.buses[bus]!.id), outcome })
  })
  return {
    network,
    state,
    islands,
    busIndex,
    branches,
    ratings: branches.map(branch => {
      const share = availability.get(branch.id) ?? 1
      return { continuousMva: branch.ratingMw * share, emergencyMva: branch.emergencyRatingMw * share }
    }),
    compiledDemandMw: compiled.model.loads.reduce((sum, load) => sum + load.demandMw, 0),
    solvedDemandMw,
  }
}

/** Apparent power of a branch: the larger of its two end flows, MVA. */
export const branchLoadingMva = (flow: V2PowerFlow, index: number): number => Math.max(
  Math.hypot(flow.state.branchFromActiveMw[index]!, flow.state.branchFromReactiveMvar[index]!),
  Math.hypot(flow.state.branchToActiveMw[index]!, flow.state.branchToReactiveMvar[index]!),
)
