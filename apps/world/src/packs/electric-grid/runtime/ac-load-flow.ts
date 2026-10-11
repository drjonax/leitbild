import type { GridExternalSystemDefinition, GridModelDefinition } from '../grid-model.ts'
import { generatorKineticEnergyMws } from './generator-dynamics.ts'
import type { GridIslandPlan, GridRuntimeInstance, GridTopologyIsland, GridTopologyPlan } from './instance.ts'
import { externalBoundaryShares, externalKineticEnergyMws, gridGeneratorIsSynchronised, islandAssetStates, islandMembers } from './island-input.ts'
import { createAcNetwork, type AcNetwork } from './network/ac-network.ts'
import type { GridIslandSystem } from './network/dc-power-flow.ts'
import {
  createAcIslandSystem,
  createAcPowerFlowState,
  solveAcIsland,
  type AcIslandFailure,
  type AcIslandSystem,
  type AcPowerFlowOptions,
  type AcPowerFlowSpecification,
  type AcPowerFlowState,
} from './network/fdlf.ts'

// AC load flow of the solved Grid, every tick after the DC balance: fast-decoupled (network/fdlf.ts)
// per AC component of every energised island, on the Model's branch charging, tap ratios and
// shunts. The active injections are the DC balance's without the losses it carries as load; the
// AC losses are then shared by the same participants as the DC balance's inertial sharing (kinetic
// energy H·S), so the AC slack only closes the difference between AC and carried losses.

/** Largest admissible |ΔP| and |ΔQ| per bus: 1e-6 pu = 0.1 kW and 0.1 kvar on the 100 MVA base. */
const tolerancePu = 1e-6
/**
 * Full P–Q iterations per inner solve. Warm-started ticks need a handful and flat starts on Norway
 * about 10–20 (FD1), but near the voltage-stability limit FDLF converges slowly: the corridor
 * fixture with its direct line open (1,000 MW over the A and B paths) needs 87 iterations.
 */
const maximumIterations = 200
/** The synchronous equivalent holds its boundary buses at nominal voltage: a stiff network behind the ties (modelling choice). */
const externalVoltageSetpointPu = 1

/** The AC network of a Model: π branches with charging and off-nominal taps, bus shunts at 1 pu. */
const acNetworks = new WeakMap<GridModelDefinition, AcNetwork>()

export const acNetworkForModel = (model: GridModelDefinition, busIndexById: ReadonlyMap<string, number>, branchFrom: Int32Array, branchTo: Int32Array): AcNetwork => {
  const cached = acNetworks.get(model)
  if (cached) return cached
  const shuntSusceptancePu = new Float64Array(model.buses.length)
  for (const shunt of model.shunts) {
    const bus = busIndexById.get(shunt.busId)!
    // Positive Mvar is a capacitor (injects at 1 pu); in per unit B = Q / S_base.
    shuntSusceptancePu[bus] = shuntSusceptancePu[bus]! + shunt.mvarAtNominalVoltage / model.sBaseMva
  }
  const network = createAcNetwork({
    sBaseMva: model.sBaseMva,
    busCount: model.buses.length,
    branchCount: model.branches.length,
    busIds: model.buses.map(bus => bus.id),
    branchFrom,
    branchTo,
    branchResistancePu: Float64Array.from(model.branches, branch => branch.resistancePu),
    branchReactancePu: Float64Array.from(model.branches, branch => branch.reactancePu),
    branchChargingSusceptancePu: Float64Array.from(model.branches, branch => branch.chargingSusceptancePu),
    // Lines and cables have no transformer: their ratio is exactly 1.
    branchTapRatio: Float64Array.from(model.branches, branch => branch.kind === 'transformer' ? branch.tapRatio! : 1),
    busShuntConductancePu: new Float64Array(model.buses.length),
    busShuntSusceptancePu: shuntSusceptancePu,
  })
  acNetworks.set(model, network)
  return network
}

/** One island's AC outcome this tick: converged with its losses, or the first failing component's failure. */
export type GridIslandAcOutcome =
  | { readonly converged: true; readonly activeLossesMw: number; readonly reactiveLossesMvar: number; readonly iterations: number }
  | { readonly converged: false; readonly failure: AcIslandFailure }

interface GridAcWork {
  readonly network: AcNetwork
  readonly state: AcPowerFlowState
  readonly specification: {
    readonly activeInjectionMw: Float64Array
    readonly reactiveInjectionMvar: Float64Array
    readonly voltageControlled: Uint8Array
    readonly voltageSetpointPu: Float64Array
    readonly reactiveMinimumMvar: Float64Array
    readonly reactiveMaximumMvar: Float64Array
  }
  readonly participation: Float64Array
  readonly systems: WeakMap<GridIslandSystem, AcIslandSystem>
  readonly localOfBus: Int32Array
}

const work = new WeakMap<GridRuntimeInstance, GridAcWork>()

const workFor = (grid: GridRuntimeInstance, plan: GridTopologyPlan): GridAcWork => {
  const cached = work.get(grid)
  const network = plan.network
  const acNetwork = acNetworkForModel(grid.definition.model, network.busIndexById, network.branchFrom, network.branchTo)
  if (cached && cached.network === acNetwork) return cached
  const busCount = network.busCount
  const created: GridAcWork = {
    network: acNetwork,
    state: createAcPowerFlowState(acNetwork),
    specification: {
      activeInjectionMw: new Float64Array(busCount),
      reactiveInjectionMvar: new Float64Array(busCount),
      voltageControlled: new Uint8Array(busCount),
      voltageSetpointPu: new Float64Array(busCount),
      reactiveMinimumMvar: new Float64Array(busCount),
      reactiveMaximumMvar: new Float64Array(busCount),
    },
    participation: new Float64Array(busCount),
    systems: new WeakMap(),
    localOfBus: new Int32Array(busCount),
  }
  work.set(grid, created)
  return created
}

/** Where an island's flows come from: its converged AC load flow, the DC solution when it did not converge, none when de-energised. */
export const gridIslandFlowModel = (grid: GridRuntimeInstance, island: { readonly id: string; readonly energized: boolean }): 'ac' | 'dc' | null => {
  if (!island.energized) return null
  const outcome = grid.acOutcomeByIsland.get(island.id)
  if (outcome === undefined) throw new Error(`Grid ${grid.definition.gridId} island ${island.id} is energised but has no AC load-flow outcome`)
  return outcome.converged ? 'ac' : 'dc'
}

/** The last AC solution of a Grid: voltages, angles and injections per bus, end flows per branch; NaN where none converged. */
export const gridAcState = (grid: GridRuntimeInstance): AcPowerFlowState | null => work.get(grid)?.state ?? null

/**
 * Writes one energised island's operating point into the specification: active injections from
 * the DC balance without its carried losses, load reactive demand at each load's power factor,
 * PV buses where synchronised synchronous units (Q limits ±ratedMva·√(1 − cos²φ)) or the
 * synchronous equivalent's boundary buses hold voltage, and slack participation by kinetic energy.
 */
const specifyIsland = (grid: GridRuntimeInstance, plan: GridTopologyPlan, island: GridTopologyIsland, acWork: GridAcWork): void => {
  const { specification, participation } = acWork
  const members = islandMembers(grid, island)
  for (const bus of members.busIndices) {
    specification.activeInjectionMw[bus] = plan.injectionsMw[bus]! + grid.lossLoadByBusMw[bus]!
    specification.reactiveInjectionMvar[bus] = 0
    specification.voltageControlled[bus] = 0
    specification.voltageSetpointPu[bus] = Number.NaN
    specification.reactiveMinimumMvar[bus] = 0
    specification.reactiveMaximumMvar[bus] = 0
    participation[bus] = 0
  }
  const states = islandAssetStates(grid, island)
  states.loads.forEach((state, index) => {
    const bus = members.loadBuses[index]!
    specification.reactiveInjectionMvar[bus] = specification.reactiveInjectionMvar[bus]! - state.servedMw * states.loadReactivePerMw[index]!
  })
  island.generators.forEach((definition, index) => {
    if (!definition.synchronous || !gridGeneratorIsSynchronised(states.generators[index]!)) return
    const bus = members.generatorBuses[index]!
    if (specification.voltageControlled[bus] === 1 && specification.voltageSetpointPu[bus] !== definition.voltageSetpointPu) {
      throw new Error(`Grid ${grid.definition.gridId}: units at ${plan.network.busIds[bus]} hold different voltage set-points (${specification.voltageSetpointPu[bus]} and ${definition.voltageSetpointPu} pu)`)
    }
    const limitMvar = definition.ratedMva * Math.sqrt(1 - definition.powerFactor ** 2)
    specification.voltageControlled[bus] = 1
    specification.voltageSetpointPu[bus] = definition.voltageSetpointPu
    specification.reactiveMaximumMvar[bus] = specification.reactiveMaximumMvar[bus]! + limitMvar
    specification.reactiveMinimumMvar[bus] = specification.reactiveMinimumMvar[bus]! - limitMvar
    participation[bus] = participation[bus]! + generatorKineticEnergyMws(definition)
  })
  for (const system of members.externals) specifyExternal(grid, plan, island, system, acWork)
}

const specifyExternal = (grid: GridRuntimeInstance, plan: GridTopologyPlan, island: GridTopologyIsland, system: GridExternalSystemDefinition, acWork: GridAcWork): void => {
  const { specification, participation } = acWork
  // The equivalent shares each component's AC slack by its kinetic energy, spread over that
  // component's boundary buses as it closes the DC balance there (externalBoundaryShares).
  for (const componentIndex of island.componentIndices) {
    const boundaries = system.boundaryBusIds.filter(busId => plan.componentIndexOfBus[plan.network.busIndexById.get(busId)!] === componentIndex)
    if (boundaries.length === 0) continue
    const shares = externalBoundaryShares(grid, system, boundaries)
    boundaries.forEach((busId, position) => {
      const bus = plan.network.busIndexById.get(busId)!
      specification.voltageControlled[bus] = 1
      specification.voltageSetpointPu[bus] = externalVoltageSetpointPu
      specification.reactiveMinimumMvar[bus] = Number.NEGATIVE_INFINITY
      specification.reactiveMaximumMvar[bus] = Number.POSITIVE_INFINITY
      participation[bus] = participation[bus]! + externalKineticEnergyMws(system) * shares[position]!
    })
  }
}

/** A warm start needs a finite previous solution at every bus of the component. */
const warmStartable = (state: AcPowerFlowState, buses: Int32Array): boolean => {
  for (const bus of buses) {
    if (!(state.voltagePu[bus]! > 0) || !Number.isFinite(state.voltagePu[bus]!) || !Number.isFinite(state.angleRad[bus]!)) return false
  }
  return true
}

/**
 * Solves the AC load flow of every energised island, component by component, into the Grid's AC
 * state. A warm start from the last converged solution that fails is retried once from a flat
 * start; an island whose component still fails is reported not converged and its buses keep no
 * voltage (NaN), never a DC or nominal value.
 */
export const solveGridAcLoadFlow = (grid: GridRuntimeInstance, islands: GridIslandPlan): ReadonlyMap<number, GridIslandAcOutcome> => {
  const { plan } = islands
  const acWork = workFor(grid, plan)
  const outcomes = new Map<number, GridIslandAcOutcome>()
  const specification: AcPowerFlowSpecification = acWork.specification
  for (const island of islands.islands) {
    if (!island.energized) continue
    const structure = plan.islands[island.planIndex]!
    specifyIsland(grid, plan, structure, acWork)
    let activeLossesMw = 0
    let reactiveLossesMvar = 0
    let iterations = 0
    let failure: AcIslandFailure | null = null
    for (const componentIndex of structure.componentIndices) {
      const component = plan.components[componentIndex]!
      const dcSystem = plan.systems[componentIndex]!
      let system = acWork.systems.get(dcSystem)
      if (system === undefined) {
        system = createAcIslandSystem({ network: acWork.network, islandId: `${island.id}/${component.referenceBusId}`, buses: dcSystem.buses, branches: dcSystem.branches, localOfBus: acWork.localOfBus })
        acWork.systems.set(dcSystem, system)
      }
      const options = (start: AcPowerFlowOptions['start']): AcPowerFlowOptions => ({
        slack: { kind: 'distributed', angleReferenceBus: dcSystem.buses[0]!, participation: acWork.participation },
        tolerancePu,
        maximumIterations,
        enforceReactiveLimits: true,
        start,
      })
      const warm = warmStartable(acWork.state, dcSystem.buses)
      let outcome = solveAcIsland(acWork.network, system, specification, options(warm ? 'warm' : 'flat'), acWork.state)
      if (!outcome.converged && warm) outcome = solveAcIsland(acWork.network, system, specification, options('flat'), acWork.state)
      iterations += outcome.iterations
      if (!outcome.converged) {
        failure ??= outcome
        continue
      }
      activeLossesMw += outcome.activeLossesMw
      reactiveLossesMvar += outcome.reactiveLossesMvar
    }
    outcomes.set(island.planIndex, failure === null
      ? { converged: true, activeLossesMw, reactiveLossesMvar, iterations }
      : { converged: false, failure })
  }
  return outcomes
}
