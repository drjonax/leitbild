import { describe, expect, test } from 'bun:test'
import { createAcNetwork, type AcNetwork } from '../src/packs/electric-grid/runtime/network/ac-network.ts'
import {
  acBusControl,
  createAcIslandSystem,
  createAcPowerFlowState,
  solveAcIsland,
  type AcIslandOutcome,
  type AcIslandSolution,
  type AcIslandSystem,
  type AcPowerFlowOptions,
  type AcPowerFlowSpecification,
  type AcPowerFlowState,
} from '../src/packs/electric-grid/runtime/network/fdlf.ts'
import { matpowerAcCase, type MatpowerCase } from './fixtures/electric-grid/ac/matpower-case.ts'
import { matpowerCase14, matpowerCase30, matpowerCaseIeee30 } from './fixtures/electric-grid/ac/matpower-cases.ts'
import { solveNewtonReference } from './fixtures/electric-grid/ac/newton-reference.ts'
import { radialFeederNetwork, radialFeederSpecification } from './fixtures/electric-grid/ac/radial-overload.ts'
import { syntheticAcCase, syntheticGridRegion } from './fixtures/electric-grid/ac/synthetic-ac.ts'
import { syntheticGridModel } from './fixtures/synthetic-grid.ts'

const degrees = (radians: number): number => radians * 180 / Math.PI

const wholeNetworkSystem = (network: AcNetwork, islandId: string): AcIslandSystem => createAcIslandSystem({
  network,
  islandId,
  buses: Int32Array.from({ length: network.busCount }, (_, bus) => bus),
  branches: Int32Array.from({ length: network.branchCount }, (_, branch) => branch),
  localOfBus: new Int32Array(network.busCount),
})

const baseOptions = (slackBus: number): AcPowerFlowOptions => ({
  slack: { kind: 'single', bus: slackBus },
  tolerancePu: 1e-6,
  maximumIterations: 30,
  enforceReactiveLimits: true,
  start: 'flat',
})

const converged = (outcome: AcIslandOutcome): AcIslandSolution => {
  if (!outcome.converged) throw new Error(`expected convergence, got ${outcome.reason}: ${outcome.detail}`)
  return outcome
}

const maximumOf = (count: number, value: (index: number) => number): number => {
  let maximum = 0
  for (let index = 0; index < count; index += 1) maximum = Math.max(maximum, Math.abs(value(index)))
  return maximum
}

/** Solves a MATPOWER case and an independent dense Newton solve with the FDLF's final bus controls. */
const solveCase = (data: MatpowerCase, reactiveLimits: 'none' | 'pv-buses') => {
  const ac = matpowerAcCase(data, { reactiveLimits })
  const system = wholeNetworkSystem(ac.network, data.name)
  const state = createAcPowerFlowState(ac.network)
  const outcome = converged(solveAcIsland(ac.network, system, ac.specification, { ...baseOptions(ac.referenceBus), enforceReactiveLimits: reactiveLimits !== 'none' }, state))
  const newton = solveNewtonReference(ac.network, ac.specification, { kind: 'single', bus: ac.referenceBus }, state.busControl)
  return { ac, system, state, outcome, newton }
}

/** Published converged solution of a case whose VM/VA columns carry one: |V|, θ in degrees, and losses as Σ PG − Σ PD. */
const publishedSolution = (data: MatpowerCase) => ({
  voltagePu: data.bus.map(row => row[6]),
  angleDegrees: data.bus.map(row => row[7]),
  lossesMw: data.gen.reduce((sum, row) => sum + row[1], 0) - data.bus.reduce((sum, row) => sum + row[2], 0),
})

const expectMatchesNewton = (state: AcPowerFlowState, newton: ReturnType<typeof solveNewtonReference>, busCount: number): void => {
  expect(maximumOf(busCount, bus => state.voltagePu[bus]! - newton.voltagePu[bus]!)).toBeLessThan(1e-6)
  expect(maximumOf(busCount, bus => state.angleRad[bus]! - newton.angleRad[bus]!)).toBeLessThan(1e-6)
}

describe('fast-decoupled AC load flow on published IEEE cases', () => {
  test('IEEE 14-bus: matches the published solution and an independent Newton solve', () => {
    const { ac, state, outcome, newton } = solveCase(matpowerCase14, 'pv-buses')
    const published = publishedSolution(matpowerCase14)
    expect(outcome.iterations).toBeLessThanOrEqual(10)
    expect(outcome.maximumActiveMismatchMw).toBeLessThan(1e-4)
    expect(outcome.maximumReactiveMismatchMvar).toBeLessThan(1e-4)
    expect(outcome.reactiveLimitedBusCount).toBe(0)
    expectMatchesNewton(state, newton, ac.network.busCount)
    for (let bus = 0; bus < ac.network.busCount; bus += 1) {
      // The archive lists bus 4 at 1.019 pu; its own data solve to 1.0177 pu (MATPOWER prints 1.018),
      // so the published value carries a 1.3e-3 pu error that no exact solver can remove.
      const voltageTolerance = bus === 3 ? 1.5e-3 : 1e-3
      expect(Math.abs(state.voltagePu[bus]! - published.voltagePu[bus]!)).toBeLessThan(voltageTolerance)
      expect(Math.abs(degrees(state.angleRad[bus]!) - published.angleDegrees[bus]!)).toBeLessThan(0.05)
    }
    expect(Math.abs(outcome.activeLossesMw - published.lossesMw) / published.lossesMw).toBeLessThan(0.01)
    expect(outcome.activeLossesMw).toBeCloseTo(13.393, 3)
  })

  test('IEEE 30-bus (CDF): bus 2 reaches its 50 Mvar limit as published, voltages within 1e-3 pu, Newton agrees', () => {
    const { ac, state, outcome, newton } = solveCase(matpowerCaseIeee30, 'pv-buses')
    const published = publishedSolution(matpowerCaseIeee30)
    expect(outcome.reactiveLimitPasses).toBe(1)
    expect(state.busControl[1]).toBe(acBusControl.atReactiveMaximum)
    expect(state.reactiveInjectionMvar[1]! - ac.specification.reactiveInjectionMvar[1]!).toBeCloseTo(50, 3)
    expectMatchesNewton(state, newton, ac.network.busCount)
    for (let bus = 0; bus < ac.network.busCount; bus += 1) {
      expect(Math.abs(state.voltagePu[bus]! - published.voltagePu[bus]!)).toBeLessThan(1e-3)
    }
    // The 1961 archive solution is not a solution of its own data: its angles sit up to 0.43°
    // from the exact solve and its slack generation implies 16.8 MW of losses against 17.55 MW.
    // Pin the exact values so regressions show, and bound the published gap.
    expect(outcome.activeLossesMw).toBeCloseTo(17.552, 2)
    expect(maximumOf(ac.network.busCount, bus => degrees(state.angleRad[bus]!) - published.angleDegrees[bus]!)).toBeLessThan(0.45)
  })

  test('MATPOWER case30 (Alsac–Stott): matches an independent Newton solve, 2.444 MW of losses', () => {
    const { ac, state, outcome, newton } = solveCase(matpowerCase30, 'pv-buses')
    expect(outcome.iterations).toBeLessThanOrEqual(10)
    expect(outcome.reactiveLimitedBusCount).toBe(0)
    expectMatchesNewton(state, newton, ac.network.busCount)
    expect(outcome.activeLossesMw).toBeCloseTo(2.444, 3)
    expect(outcome.slackActiveMw).toBeCloseTo(newton.slackActiveMw, 4)
  })

  test('closes the AC balance at every bus: injections equal branch end flows plus shunt power', () => {
    const { ac, state, outcome } = solveCase(matpowerCase14, 'none')
    const { network } = ac
    const activeResidual = new Float64Array(network.busCount)
    const reactiveResidual = new Float64Array(network.busCount)
    for (let bus = 0; bus < network.busCount; bus += 1) {
      const voltageSquared = state.voltagePu[bus]! ** 2
      activeResidual[bus] = state.activeInjectionMw[bus]! - network.busShuntConductancePu[bus]! * voltageSquared * network.sBaseMva
      reactiveResidual[bus] = state.reactiveInjectionMvar[bus]! + network.busShuntSusceptancePu[bus]! * voltageSquared * network.sBaseMva
    }
    let losses = 0
    for (let branch = 0; branch < network.branchCount; branch += 1) {
      const from = network.branchFrom[branch]!
      const to = network.branchTo[branch]!
      activeResidual[from] = activeResidual[from]! - state.branchFromActiveMw[branch]!
      activeResidual[to] = activeResidual[to]! - state.branchToActiveMw[branch]!
      reactiveResidual[from] = reactiveResidual[from]! - state.branchFromReactiveMvar[branch]!
      reactiveResidual[to] = reactiveResidual[to]! - state.branchToReactiveMvar[branch]!
      losses += state.branchFromActiveMw[branch]! + state.branchToActiveMw[branch]!
    }
    expect(maximumOf(network.busCount, bus => activeResidual[bus]!)).toBeLessThan(1e-9)
    expect(maximumOf(network.busCount, bus => reactiveResidual[bus]!)).toBeLessThan(1e-9)
    expect(Math.abs(losses - outcome.activeLossesMw)).toBeLessThan(1e-9)
    // Scheduled injections plus the slack's addition reproduce the computed injections.
    for (let bus = 0; bus < network.busCount; bus += 1) {
      const scheduled = ac.specification.activeInjectionMw[bus]! + (bus === ac.referenceBus ? outcome.slackActiveMw : 0)
      expect(Math.abs(state.activeInjectionMw[bus]! - scheduled)).toBeLessThan(1e-4)
    }
  })
})

describe('slack, reactive limits and warm starts', () => {
  test('distributed slack shares losses by participation factor and matches Newton with the same slack', () => {
    const ac = matpowerAcCase(matpowerCase14, { reactiveLimits: 'none' })
    const participation = new Float64Array(ac.network.busCount)
    // Participation in proportion to generator PMAX (332.4, 140, 100, 100, 100 MW at buses 1, 2, 3, 6, 8).
    participation.set([332.4, 140, 100], 0)
    participation[5] = 100
    participation[7] = 100
    const slack = { kind: 'distributed', angleReferenceBus: ac.referenceBus, participation } as const
    const system = wholeNetworkSystem(ac.network, 'case14')
    const state = createAcPowerFlowState(ac.network)
    const outcome = converged(solveAcIsland(ac.network, system, ac.specification, { ...baseOptions(0), slack, enforceReactiveLimits: false }, state))
    const newton = solveNewtonReference(ac.network, ac.specification, slack, state.busControl)
    expectMatchesNewton(state, newton, ac.network.busCount)
    expect(outcome.slackActiveMw).toBeCloseTo(newton.slackActiveMw, 4)
    const totalParticipation = 332.4 + 140 + 100 + 100 + 100
    for (let bus = 0; bus < ac.network.busCount; bus += 1) {
      const share = outcome.slackActiveMw * participation[bus]! / totalParticipation
      expect(Math.abs(state.activeInjectionMw[bus]! - ac.specification.activeInjectionMw[bus]! - share)).toBeLessThan(1e-4)
    }
    expect(state.angleRad[ac.referenceBus]).toBe(0)
    // The scheduled injections fall 13.4 MW short of losses; participants cover it, not one bus.
    expect(outcome.slackActiveMw).toBeCloseTo(outcome.activeLossesMw - (232.4 + 40 - ac.totalLoadMw), 3)
  })

  test('angles are referenced to the requested bus, whichever bus anchors B′', () => {
    const ac = matpowerAcCase(matpowerCase14, { reactiveLimits: 'none' })
    const participation = new Float64Array(ac.network.busCount).fill(1)
    const system = wholeNetworkSystem(ac.network, 'case14')
    const first = createAcPowerFlowState(ac.network)
    const second = createAcPowerFlowState(ac.network)
    const options = { ...baseOptions(0), enforceReactiveLimits: false }
    converged(solveAcIsland(ac.network, system, ac.specification, { ...options, slack: { kind: 'distributed', angleReferenceBus: 0, participation } }, first))
    converged(solveAcIsland(ac.network, system, ac.specification, { ...options, slack: { kind: 'distributed', angleReferenceBus: 8, participation } }, second))
    expect(second.angleRad[8]).toBe(0)
    for (let bus = 0; bus < ac.network.busCount; bus += 1) {
      expect(Math.abs(second.angleRad[bus]! - (first.angleRad[bus]! - first.angleRad[8]!))).toBeLessThan(1e-12)
      expect(second.voltagePu[bus]).toBeCloseTo(first.voltagePu[bus]!, 12)
    }
  })

  test('holds PV buses inside their reactive range and buses at a limit on the correct side of their set-point', () => {
    const ac = matpowerAcCase(matpowerCase14, { reactiveLimits: 'pv-buses' })
    const specification: AcPowerFlowSpecification = { ...ac.specification, reactiveMaximumMvar: ac.specification.reactiveMaximumMvar.slice() }
    specification.reactiveMaximumMvar[1] = 20
    specification.reactiveMaximumMvar[7] = 10
    const system = wholeNetworkSystem(ac.network, 'case14')
    const state = createAcPowerFlowState(ac.network)
    const outcome = converged(solveAcIsland(ac.network, system, specification, baseOptions(ac.referenceBus), state))
    expect(outcome.reactiveLimitedBusCount).toBe(2)
    for (let bus = 0; bus < ac.network.busCount; bus += 1) {
      const regulated = state.reactiveInjectionMvar[bus]! - specification.reactiveInjectionMvar[bus]!
      const control = state.busControl[bus]
      if (control === acBusControl.pv) {
        expect(regulated).toBeLessThanOrEqual(specification.reactiveMaximumMvar[bus]! + 1e-4)
        expect(regulated).toBeGreaterThanOrEqual(specification.reactiveMinimumMvar[bus]! - 1e-4)
        expect(state.voltagePu[bus]).toBeCloseTo(specification.voltageSetpointPu[bus]!, 12)
      }
      if (control === acBusControl.atReactiveMaximum) {
        expect(regulated).toBeCloseTo(specification.reactiveMaximumMvar[bus]!, 3)
        expect(state.voltagePu[bus]!).toBeLessThan(specification.voltageSetpointPu[bus]!)
      }
    }
    expect(state.busControl[1]).toBe(acBusControl.atReactiveMaximum)
    expect(state.busControl[7]).toBe(acBusControl.atReactiveMaximum)
    expectMatchesNewton(state, solveNewtonReference(ac.network, specification, { kind: 'single', bus: ac.referenceBus }, state.busControl), ac.network.busCount)
  })

  test('re-enables voltage control at a warm-started limit bus whose voltage crosses its set-point', () => {
    const ac = matpowerAcCase(matpowerCase14, { reactiveLimits: 'pv-buses' })
    const tight: AcPowerFlowSpecification = { ...ac.specification, reactiveMaximumMvar: ac.specification.reactiveMaximumMvar.slice() }
    tight.reactiveMaximumMvar[1] = 20
    const system = wholeNetworkSystem(ac.network, 'case14')
    const state = createAcPowerFlowState(ac.network)
    converged(solveAcIsland(ac.network, system, tight, baseOptions(ac.referenceBus), state))
    expect(state.busControl[1]).toBe(acBusControl.atReactiveMaximum)
    // Restoring the 50 Mvar limit: held at 50 Mvar the bus would rise above 1.045 pu, so it regulates again.
    const outcome = converged(solveAcIsland(ac.network, system, ac.specification, { ...baseOptions(ac.referenceBus), start: 'warm' }, state))
    expect(outcome.reactiveLimitPasses).toBe(1)
    expect(state.busControl[1]).toBe(acBusControl.pv)
    expect(state.voltagePu[1]).toBeCloseTo(1.045, 12)
    expect(outcome.activeLossesMw).toBeCloseTo(13.393, 3)
  })

  test('limit switching terminates on a stressed grid within its bound of three switches per PV bus', () => {
    const model = syntheticGridModel(1000)
    const ac = syntheticAcCase(model, 0.25, 100)
    const system = wholeNetworkSystem(ac.network, 'synthetic-1000')
    const state = createAcPowerFlowState(ac.network)
    const outcome = converged(solveAcIsland(ac.network, system, ac.specification, { ...baseOptions(0), slack: ac.slack, maximumIterations: 60 }, state))
    expect(outcome.reactiveLimitedBusCount).toBeGreaterThan(0)
    expect(outcome.reactiveLimitPasses).toBeLessThanOrEqual(3 * model.generators.length)
    const again = converged(solveAcIsland(ac.network, system, ac.specification, { ...baseOptions(0), slack: ac.slack, maximumIterations: 60 }, createAcPowerFlowState(ac.network)))
    expect(again.iterations).toBe(outcome.iterations)
    expect(again.reactiveLimitedBusCount).toBe(outcome.reactiveLimitedBusCount)
  })

  test('a warm start from the previous solution converges at once and reuses both factors', () => {
    const ac = matpowerAcCase(matpowerCaseIeee30, { reactiveLimits: 'pv-buses' })
    const system = wholeNetworkSystem(ac.network, 'case_ieee30')
    const state = createAcPowerFlowState(ac.network)
    const flat = converged(solveAcIsland(ac.network, system, ac.specification, baseOptions(ac.referenceBus), state))
    const activeFactor = system.activeFactor
    const reactiveFactorCount = system.reactiveFactors.length
    const voltages = state.voltagePu.slice()
    const warm = converged(solveAcIsland(ac.network, system, ac.specification, { ...baseOptions(ac.referenceBus), start: 'warm' }, state))
    expect(flat.iterations).toBeGreaterThan(warm.iterations)
    expect(warm.iterations).toBeLessThanOrEqual(1)
    expect(warm.reactiveLimitPasses).toBe(0)
    expect(system.activeFactor).toBe(activeFactor)
    expect(system.reactiveFactors.length).toBe(reactiveFactorCount)
    expect(maximumOf(voltages.length, bus => state.voltagePu[bus]! - voltages[bus]!)).toBeLessThan(1e-6)
  })

  test('solves each island of a split network into its own entries only', () => {
    // Two copies of the radial feeder side by side: buses 0-2 and 3-5, branches 0-1 and 2-3.
    const feeder = radialFeederNetwork()
    const network = createAcNetwork({
      ...feeder,
      busCount: 6,
      branchCount: 4,
      busIds: ['a:source', 'a:middle', 'a:end', 'b:source', 'b:middle', 'b:end'],
      branchFrom: Int32Array.of(0, 1, 3, 4),
      branchTo: Int32Array.of(1, 2, 4, 5),
      branchResistancePu: Float64Array.of(...feeder.branchResistancePu, ...feeder.branchResistancePu),
      branchReactancePu: Float64Array.of(...feeder.branchReactancePu, ...feeder.branchReactancePu),
      branchChargingSusceptancePu: Float64Array.of(...feeder.branchChargingSusceptancePu, ...feeder.branchChargingSusceptancePu),
      branchTapRatio: Float64Array.of(1, 1, 1, 1),
      busShuntConductancePu: new Float64Array(6),
      busShuntSusceptancePu: new Float64Array(6),
    })
    const single = radialFeederSpecification(60)
    const twice = (values: Float64Array) => Float64Array.of(...values, ...values)
    const specification: AcPowerFlowSpecification = {
      activeInjectionMw: twice(single.activeInjectionMw),
      reactiveInjectionMvar: twice(single.reactiveInjectionMvar),
      voltageControlled: Uint8Array.of(...single.voltageControlled, ...single.voltageControlled),
      voltageSetpointPu: twice(single.voltageSetpointPu),
      reactiveMinimumMvar: twice(single.reactiveMinimumMvar),
      reactiveMaximumMvar: twice(single.reactiveMaximumMvar),
    }
    const localOfBus = new Int32Array(6)
    const islandA = createAcIslandSystem({ network, islandId: 'a', buses: Int32Array.of(0, 1, 2), branches: Int32Array.of(0, 1), localOfBus })
    const islandB = createAcIslandSystem({ network, islandId: 'b', buses: Int32Array.of(3, 4, 5), branches: Int32Array.of(2, 3), localOfBus })
    const state = createAcPowerFlowState(network)
    converged(solveAcIsland(network, islandA, specification, baseOptions(0), state))
    expect(Number.isNaN(state.voltagePu[4]!)).toBe(true)
    expect(Number.isNaN(state.branchFromActiveMw[2]!)).toBe(true)
    converged(solveAcIsland(network, islandB, specification, baseOptions(3), state))
    for (let bus = 0; bus < 3; bus += 1) {
      expect(state.voltagePu[bus + 3]).toBeCloseTo(state.voltagePu[bus]!, 12)
      expect(state.angleRad[bus + 3]).toBeCloseTo(state.angleRad[bus]!, 12)
    }
    expect(state.voltagePu[2]).toBeCloseTo(0.9376, 4)
  })
})

describe('visible failures', () => {
  test('an overloaded radial feeder fails with residuals and its worst buses, and leaves NaN, never a fallback', () => {
    const network = radialFeederNetwork()
    const system = wholeNetworkSystem(network, 'radial')
    const state = createAcPowerFlowState(network)
    converged(solveAcIsland(network, system, radialFeederSpecification(60), baseOptions(0), state))
    expect(state.voltagePu[2]).toBeCloseTo(0.9376, 4)
    const outcome = solveAcIsland(network, system, radialFeederSpecification(300), { ...baseOptions(0), start: 'warm' }, state)
    if (outcome.converged) throw new Error('an end load beyond the feeder nose point must not converge')
    expect(outcome.reason).toBe('diverged')
    expect(outcome.detail).toMatch(/radial diverged after \d+ iterations: \|V\| at bus:end reached -/)
    expect(outcome.islandId).toBe('radial')
    expect(outcome.maximumActiveMismatchMw + outcome.maximumReactiveMismatchMvar).toBeGreaterThan(1)
    expect(outcome.worstBuses.length).toBe(3)
    expect(['bus:middle', 'bus:end']).toContain(outcome.worstBuses[0]!.busId)
    expect(Math.max(Math.abs(outcome.worstBuses[0]!.activeMismatchMw), Math.abs(outcome.worstBuses[0]!.reactiveMismatchMvar))).toBeGreaterThan(1)
    for (let bus = 0; bus < 3; bus += 1) expect(Number.isNaN(state.voltagePu[bus]!)).toBe(true)
    for (let branch = 0; branch < 2; branch += 1) expect(Number.isNaN(state.branchFromActiveMw[branch]!)).toBe(true)
    // A failed island cannot be warm-started: the caller must choose a flat start explicitly.
    expect(() => solveAcIsland(network, system, radialFeederSpecification(60), { ...baseOptions(0), start: 'warm' }, state)).toThrow(/warm start/)
    converged(solveAcIsland(network, system, radialFeederSpecification(60), baseOptions(0), state))
  })

  test('stops at the iteration limit with the residual it reached', () => {
    const ac = matpowerAcCase(matpowerCase14, { reactiveLimits: 'none' })
    const system = wholeNetworkSystem(ac.network, 'case14')
    const outcome = solveAcIsland(ac.network, system, ac.specification, { ...baseOptions(ac.referenceBus), maximumIterations: 2 }, createAcPowerFlowState(ac.network))
    if (outcome.converged) throw new Error('two iterations cannot reach 1e-6 pu on case14')
    expect(outcome.reason).toBe('iteration-limit')
    expect(outcome.iterations).toBe(2)
    expect(outcome.maximumActiveMismatchMw + outcome.maximumReactiveMismatchMvar).toBeGreaterThan(1e-4)
    expect(outcome.worstBuses[0]!.busId).toMatch(/^bus-\d+$/)
  })

  test('an island whose only regulator is pinned at its limit fails as having no voltage control', () => {
    const network = radialFeederNetwork()
    const system = wholeNetworkSystem(network, 'radial')
    const specification = { ...radialFeederSpecification(60), reactiveMinimumMvar: Float64Array.of(0, 0, 0), reactiveMaximumMvar: Float64Array.of(5, 0, 0) }
    const outcome = solveAcIsland(network, system, specification, baseOptions(0), createAcPowerFlowState(network))
    if (outcome.converged) throw new Error('a 5 Mvar source cannot hold the feeder voltage')
    expect(outcome.reason).toBe('no-voltage-control')
    expect(outcome.detail).toContain('radial')
  })

  test('rejects invalid input explicitly', () => {
    const feeder = radialFeederNetwork()
    expect(() => createAcNetwork({ ...feeder, branchReactancePu: Float64Array.of(0, feeder.branchReactancePu[1]!) })).toThrow(/positive reactance/)
    expect(() => createAcNetwork({ ...feeder, branchTapRatio: Float64Array.of(0, 1) })).toThrow(/tap ratio/)
    const system = wholeNetworkSystem(feeder, 'radial')
    const state = createAcPowerFlowState(feeder)
    const specification = radialFeederSpecification(60)
    const zeroParticipation = { kind: 'distributed', angleReferenceBus: 0, participation: new Float64Array(3) } as const
    expect(() => solveAcIsland(feeder, system, specification, { ...baseOptions(0), slack: zeroParticipation }, state)).toThrow(/no positive slack participation/)
    expect(() => solveAcIsland(feeder, system, specification, { ...baseOptions(7), slack: { kind: 'single', bus: 7 } }, state)).toThrow(/does not contain its slack bus/)
    expect(() => solveAcIsland(feeder, system, { ...specification, activeInjectionMw: Float64Array.of(0, Number.NaN, -60) }, baseOptions(0), state)).toThrow(/finite scheduled injections/)
    expect(() => solveAcIsland(feeder, system, specification, { ...baseOptions(0), start: 'warm' }, state)).toThrow(/warm start/)
    expect(() => createAcIslandSystem({ network: feeder, islandId: 'bad', buses: Int32Array.of(0, 2), branches: Int32Array.of(0), localOfBus: new Int32Array(3) })).toThrow(/outside the island/)
  })
})

const median = (values: ReadonlyArray<number>): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

const timeSolves = (count: number, solve: () => AcIslandOutcome): { readonly medianMs: number; readonly outcome: AcIslandSolution } => {
  const durations: number[] = []
  let outcome: AcIslandOutcome | null = null
  for (let run = 0; run < count; run += 1) {
    const startedAt = performance.now()
    outcome = solve()
    durations.push(performance.now() - startedAt)
  }
  return { medianMs: median(durations), outcome: converged(outcome!) }
}

describe('fast-decoupled AC load flow performance (3x CI margin on the budgets)', () => {
  test('a 250-bus main-island-sized region solves from a flat start in under 5 ms', () => {
    const ac = syntheticAcCase(syntheticGridRegion(syntheticGridModel(10_000), 250), 0.5, 100)
    const system = wholeNetworkSystem(ac.network, 'region-250')
    const state = createAcPowerFlowState(ac.network)
    const options = { ...baseOptions(0), slack: ac.slack }
    converged(solveAcIsland(ac.network, system, ac.specification, options, state))
    const { medianMs, outcome } = timeSolves(11, () => solveAcIsland(ac.network, system, ac.specification, options, state))
    expect(outcome.iterations).toBeLessThanOrEqual(10)
    expect(outcome.activeLossesMw / ac.totalLoadMw).toBeGreaterThan(0.005)
    expect(medianMs).toBeLessThan(3 * 5)
  })

  test('a 10k-bus synthetic grid solves from a flat start in under 60 ms once its factors are cached', () => {
    const ac = syntheticAcCase(syntheticGridModel(10_000), 0.5, 100)
    const system = wholeNetworkSystem(ac.network, 'synthetic-10k')
    const state = createAcPowerFlowState(ac.network)
    const options = { ...baseOptions(0), slack: ac.slack, maximumIterations: 50 }
    converged(solveAcIsland(ac.network, system, ac.specification, options, state))
    const { medianMs, outcome } = timeSolves(5, () => solveAcIsland(ac.network, system, ac.specification, options, state))
    expect(outcome.iterations).toBeLessThanOrEqual(12)
    let minimumVoltage = Infinity
    for (let bus = 0; bus < ac.network.busCount; bus += 1) minimumVoltage = Math.min(minimumVoltage, state.voltagePu[bus]!)
    expect(minimumVoltage).toBeGreaterThan(0.9)
    expect(medianMs).toBeLessThan(3 * 60)
  })
})
