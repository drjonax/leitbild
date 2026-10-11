// AC load-flow inputs for the deterministic synthetic transmission grids of
// `tests/fixtures/synthetic-grid.ts`: the fixture's per-unit r and x, line charging from
// typical overhead-line capacitance per voltage class, generators as PV buses with
// capability-curve reactive limits, loads at the fixture's power factor, and a slack
// distributed over generator capacity.
import type { GridModelDefinition } from '../../../../src/packs/electric-grid/grid-model.ts'
import { createAcNetwork, type AcNetwork } from '../../../../src/packs/electric-grid/runtime/network/ac-network.ts'
import type { AcPowerFlowSpecification, AcSlack } from '../../../../src/packs/electric-grid/runtime/network/fdlf.ts'

// Positive-sequence shunt susceptance of overhead lines, µS/km: B = 2π·50 Hz·C with typical
// capacitances C ≈ 12.7 nF/km at 420 kV (triplex), 12 nF/km at 300 kV (duplex), 9 nF/km at 132 kV.
const chargingMicrosiemensPerKm = (kv: number): number => (kv >= 400 ? 4.0 : kv >= 300 ? 3.8 : 2.8)
// Rated power factor of a hydro unit; Qmax = S·sin φ at rated MVA, Qmin = −Qmax/2 (under-excitation limit).
const generatorRatedPowerFactor = 0.9
// Same corridor-length estimate as the synthetic fixture (km per degree of longitude/latitude at ~60° N).
const corridorKm = (from: readonly [number, number], to: readonly [number, number]): number =>
  Math.max(1, Math.hypot((from[0] - to[0]) * 55, (from[1] - to[1]) * 111))

export interface SyntheticAcCase {
  readonly network: AcNetwork
  readonly specification: AcPowerFlowSpecification
  readonly slack: AcSlack
  readonly totalLoadMw: number
}

/** `loadScale` multiplies every load (P and Q); generation is dispatched pro rata to capacity to cover it. */
export const syntheticAcCase = (model: GridModelDefinition, loadScale: number, sBaseMva: number): SyntheticAcCase => {
  const busIndex = new Map(model.buses.map((bus, index) => [bus.id, index]))
  const busCount = model.buses.length
  const index = (busId: string): number => {
    const found = busIndex.get(busId)
    if (found === undefined) throw new Error(`synthetic AC case references unknown bus ${busId}`)
    return found
  }
  const network = createAcNetwork({
    sBaseMva,
    busCount,
    branchCount: model.branches.length,
    busIds: model.buses.map(bus => bus.id),
    branchFrom: Int32Array.from(model.branches, branch => index(branch.fromBusId)),
    branchTo: Int32Array.from(model.branches, branch => index(branch.toBusId)),
    branchResistancePu: Float64Array.from(model.branches, branch => branch.resistancePu),
    branchReactancePu: Float64Array.from(model.branches, branch => branch.reactancePu),
    branchChargingSusceptancePu: Float64Array.from(model.branches, branch => {
      const from = model.buses[index(branch.fromBusId)]!
      const to = model.buses[index(branch.toBusId)]!
      return chargingMicrosiemensPerKm(branch.nominalKv) * 1e-6 * corridorKm(from.location, to.location) * branch.nominalKv ** 2 / sBaseMva
    }),
    branchTapRatio: new Float64Array(model.branches.length).fill(1),
    busShuntConductancePu: new Float64Array(busCount),
    busShuntSusceptancePu: new Float64Array(busCount),
  })
  const activeInjectionMw = new Float64Array(busCount)
  const reactiveInjectionMvar = new Float64Array(busCount)
  const voltageControlled = new Uint8Array(busCount)
  const voltageSetpointPu = new Float64Array(busCount).fill(Number.NaN)
  const reactiveMinimumMvar = new Float64Array(busCount)
  const reactiveMaximumMvar = new Float64Array(busCount)
  const participation = new Float64Array(busCount)
  const totalLoadMw = model.loads.reduce((sum, load) => sum + load.demandMw * loadScale, 0)
  const totalCapacityMw = model.generators.reduce((sum, generator) => sum + generator.capacityMw, 0)
  for (const load of model.loads) {
    const bus = index(load.busId)
    activeInjectionMw[bus] = activeInjectionMw[bus]! - load.demandMw * loadScale
    reactiveInjectionMvar[bus] = reactiveInjectionMvar[bus]! - load.demandMw * Math.tan(Math.acos(load.powerFactor)) * loadScale
  }
  for (const generator of model.generators) {
    const bus = index(generator.busId)
    const ratedMva = generator.capacityMw / generatorRatedPowerFactor
    const maximumMvar = ratedMva * Math.sqrt(1 - generatorRatedPowerFactor ** 2)
    activeInjectionMw[bus] = activeInjectionMw[bus]! + generator.capacityMw * totalLoadMw / totalCapacityMw
    voltageControlled[bus] = 1
    voltageSetpointPu[bus] = 1.02
    reactiveMaximumMvar[bus] = reactiveMaximumMvar[bus]! + maximumMvar
    reactiveMinimumMvar[bus] = reactiveMinimumMvar[bus]! - maximumMvar / 2
    participation[bus] = participation[bus]! + generator.capacityMw
  }
  const angleReferenceBus = index(model.generators[0]!.busId)
  return {
    network,
    specification: { activeInjectionMw, reactiveInjectionMvar, voltageControlled, voltageSetpointPu, reactiveMinimumMvar, reactiveMaximumMvar },
    slack: { kind: 'distributed', angleReferenceBus, participation },
    totalLoadMw,
  }
}

/**
 * The first `busCount` buses reached breadth-first from the model's first bus, with the
 * branches, generators and loads among them: a connected region of the synthetic grid that
 * keeps its realistic line lengths (unlike a small synthetic grid, whose lines span the whole box).
 */
export const syntheticGridRegion = (model: GridModelDefinition, busCount: number): GridModelDefinition => {
  const adjacency = new Map<string, string[]>(model.buses.map(bus => [bus.id, []]))
  for (const branch of model.branches) {
    adjacency.get(branch.fromBusId)!.push(branch.toBusId)
    adjacency.get(branch.toBusId)!.push(branch.fromBusId)
  }
  const order = [model.buses[0]!.id]
  const seen = new Set(order)
  for (let head = 0; head < order.length && order.length < busCount; head += 1) {
    for (const next of adjacency.get(order[head]!)!) {
      if (seen.has(next) || order.length >= busCount) continue
      seen.add(next)
      order.push(next)
    }
  }
  if (order.length < busCount) throw new Error(`synthetic grid ${model.id} has only ${order.length} buses connected to its first bus`)
  return {
    ...model,
    id: `${model.id}-region-${busCount}`,
    buses: model.buses.filter(bus => seen.has(bus.id)),
    branches: model.branches.filter(branch => seen.has(branch.fromBusId) && seen.has(branch.toBusId)),
    generators: model.generators.filter(generator => seen.has(generator.busId)),
    loads: model.loads.filter(load => seen.has(load.busId)),
  }
}
