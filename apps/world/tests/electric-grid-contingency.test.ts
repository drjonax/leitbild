import { describe, expect, test } from 'bun:test'
import { norwayRuntimeTestOperatingPointRef } from './fixtures/grid-operating-point.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { norwayGridModelRef, nordicFrequencyAutomationRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition, gridLoadProfiles } from '../src/packs/electric-grid/definitions.ts'
import { compileGridModelV2 } from '../src/packs/electric-grid/models/compile-v2.ts'
import { answerElectricGridQuery } from '../src/packs/electric-grid/queries/index.ts'
import { rebalancePart, type RemovedParticipant } from '../src/packs/electric-grid/runtime/contingency-balance.ts'
import { captureContingencySnapshot } from '../src/packs/electric-grid/runtime/contingency-capture.ts'
import { liveContingencyCase, switchedContingencyCase, type ContingencyCase } from '../src/packs/electric-grid/runtime/contingency-case.ts'
import { remedialCaseChanges } from '../src/packs/electric-grid/runtime/remedial-actions.ts'
import { screenRecordsInline } from '../src/packs/electric-grid/runtime/contingency-execution.ts'
import { screenContingencies, selectContingencies } from '../src/packs/electric-grid/runtime/contingency-screen.ts'
import type { ContingencySnapshot, GridContingency } from '../src/packs/electric-grid/runtime/contingency-snapshot.ts'
import { branchLoadingPercent, createContingencyEngine, remainingCircuitsLoadingPercent, type ContingencyOutcome } from '../src/packs/electric-grid/runtime/contingency.ts'
import { generatorIsVoltageForming, generatorKineticEnergyMws } from '../src/packs/electric-grid/runtime/generator-dynamics.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { gridGeneratorIsSynchronised } from '../src/packs/electric-grid/runtime/island-input.ts'
import type { CompiledGridNetwork } from '../src/packs/electric-grid/runtime/network/compiled-network.ts'
import { createGridIslandSystem, solveGridIslandInto } from '../src/packs/electric-grid/runtime/network/dc-power-flow.ts'
import { findGridIslands } from '../src/packs/electric-grid/runtime/network/islands.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { validateGridModel } from '../src/packs/electric-grid/schemas/grid-model.ts'
import { gridOperatingPointTargetsForModel, validateGridOperatingPoint } from '../src/packs/electric-grid/schemas/grid-operating-point.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../src/packs/electric-grid/sim/adapter.ts'
import { electricGridRuntimeId } from '../src/packs/electric-grid/sim/constants.ts'
import { runtimeStateForElectricGrids } from '../src/packs/electric-grid/sim/runtime-state.ts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { scenarios } from './fixtures/scenarios.ts'
import { referenceComputation, referenceQuietMs, threadCpuMs } from './cpu-cost.ts'
import { corridorDefinition, parallelCircuitCorridorModel, steppedGrid } from './fixtures/grid-corridor.ts'
import { gridDefinitionForModel } from './fixtures/synthetic-grid.ts'

const norway = compileGridDefinition(gridDefinitionSchema.parse({
  id: 'grid:norway', model: { ref: norwayGridModelRef }, operatingPoint: { ref: norwayRuntimeTestOperatingPointRef }, automation: { ref: nordicFrequencyAutomationRef },
}))

const solvedNorway = (): GridRuntimeInstance => {
  const run = steppedGrid(norway)
  run.advanceTo(60_000)
  return run.grid
}

type Query = { readonly capabilityId: string; readonly input: Readonly<Record<string, unknown>> }
/** The contingency queries answer asynchronously (large screenings run on worker threads). */
const ask = async (grid: GridRuntimeInstance, capabilityId: string, input: Readonly<Record<string, unknown>>): Promise<any> =>
  await answerElectricGridQuery({ request: { capabilityId, input: { gridId: grid.definition.gridId, ...input } } satisfies Query, grids: new Map([[grid.definition.gridId, grid]]) })

/** Main-thread CPU of an async run, in references timed just before it: the median of `rounds` (cpu-cost.ts). */
const asyncCostInReferences = async (run: () => Promise<unknown>, rounds: number): Promise<number> => {
  const ratios: number[] = []
  for (let round = 0; round < rounds; round += 1) {
    const referenceMs = threadCpuMs(referenceComputation)
    const before = process.threadCpuUsage()
    await run()
    const used = process.threadCpuUsage(before)
    ratios.push((used.user + used.system) / 1_000 / referenceMs)
  }
  return ratios.sort((a, b) => a - b)[Math.floor(rounds / 2)]!
}

/**
 * Brute force: a fresh factorisation of every island of the changed network (`network` when the
 * outage changes a branch's susceptance), injections rebalanced by the same participation rule.
 * Returns the DC flows and which branches stay on the energised network.
 */
const bruteForceDcFlows = (grid: GridRuntimeInstance, closed: Uint8Array, injections: Float64Array, removed: RemovedParticipant | null, changedNetwork: CompiledGridNetwork | null = null) => {
  const screeningCase = liveContingencyCase(grid)
  const network = changedNetwork === null ? screeningCase.network : changedNetwork
  const found = findGridIslands(network, closed)
  const balanced = injections.slice()
  const angles = new Float64Array(network.busCount)
  const flows = new Float64Array(network.branchCount)
  const live = new Uint8Array(network.branchCount)
  const scratch = new Int32Array(network.busCount)
  for (let island = 0; island < found.count; island += 1) {
    const buses = found.busOrder.slice(found.busStart[island]!, found.busStart[island + 1]!)
    const branches = found.branchOrder.slice(found.branchStart[island]!, found.branchStart[island + 1]!)
    if (rebalancePart({ participation: screeningCase.participation, members: buses, injections: balanced, removed }).balancing === 'de-energised') continue
    solveGridIslandInto(network, createGridIslandSystem({ network, islandId: `brute-${island}`, buses, branches, localOfBus: scratch }), balanced, angles)
    for (const branch of branches) {
      flows[branch] = (angles[network.branchFrom[branch]!]! - angles[network.branchTo[branch]!]!) * network.sBaseMva * network.branchSusceptancePu[branch]!
      live[branch] = 1
    }
  }
  return { flows, live }
}

/**
 * The hybrid method by re-solves: the base flows (AC where the island converged) plus the DC
 * change `change` makes, on the branches that stay on the energised network; none elsewhere.
 */
const hybridFlows = (base: Float64Array, change: { readonly flows: Float64Array; readonly live: Uint8Array }, dcBase: Float64Array | null): Float64Array =>
  Float64Array.from(change.flows, (flow, branch) => change.live[branch] === 1 ? base[branch]! + flow - (dcBase === null ? 0 : dcBase[branch]!) : 0)

const largestDifference = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let largest = 0
  for (let index = 0; index < a.length; index += 1) largest = Math.max(largest, Math.abs(a[index]! - b[index]!))
  return largest
}

/** A branch left in service on the share `remaining` of its circuits. */
interface Derated {
  readonly branch: number
  readonly remaining: number
}

/**
 * Loading (%) the runtime's way, from the Grid's branch states: on a branch carrying AC flow the
 * larger end apparent power, each end's reactive power held at its base and its active power moved
 * by the change from the base flow (the to end's base being the AC series loss less the from end's);
 * |flow| on a DC branch; 0 on a branch out of service. A derated branch's remaining circuits hold
 * their share of its base reactive power, AC series loss and capacity.
 */
const runtimeWayLoading = (grid: GridRuntimeInstance, flowsMw: Float64Array, inService: Uint8Array, derated: Derated | null = null): Float64Array =>
  Float64Array.from(grid.definition.model.branches, (branch, index) => {
    if (inService[index] !== 1) return 0
    const state = grid.branches.get(branch.id)!
    const share = derated !== null && derated.branch === index ? derated.remaining : 1
    const capacityMw = branch.ratingMw * state.availability * share
    if (state.flowModel !== 'ac') return Math.abs(flowsMw[index]!) / capacityMw * 100
    const changeMw = flowsMw[index]! - state.flowMw * share
    const toMw = (state.lossesMw - state.flowMw) * share - changeMw
    return Math.max(Math.hypot(flowsMw[index]!, state.reactiveFromMvar! * share), Math.hypot(toMw, state.reactiveToMvar! * share)) / capacityMw * 100
  })

/** The kernel's loading of every branch after an evaluation. */
const kernelLoading = (snapshot: ContingencySnapshot, flowsMw: Float64Array, outOfService: Uint8Array, outcome: ContingencyOutcome | null = null): Float64Array =>
  Float64Array.from(flowsMw, (flow, branch) => outOfService[branch] === 1
    ? 0
    : outcome !== null && outcome.deratedBranch === branch ? remainingCircuitsLoadingPercent(snapshot, branch, flow, outcome.remainingShare) : branchLoadingPercent(snapshot, branch, flow))

const liveMask = (flows: ArrayLike<number>, outOfService: Uint8Array, closed: Uint8Array): Uint8Array =>
  Uint8Array.from(flows, (_, branch) => closed[branch] === 1 && outOfService[branch] !== 1 ? 1 : 0)

/**
 * The hybrid method for `circuitsLost` of a branch's circuits, by re-solve: the branch stays closed
 * with the remaining share of its susceptance, and the lost circuits' base flow is routed from its
 * from-bus to its to-bus through the changed network; the remaining circuits keep their share of the
 * base flow plus their part of that change.
 */
const circuitOutageByResolve = (grid: GridRuntimeInstance, screeningCase: ContingencyCase, branch: number, circuitsLost: number) => {
  const { network } = screeningCase
  const circuits = grid.definition.model.branches[branch]!.circuits
  const remaining = (circuits - circuitsLost) / circuits
  const changed: CompiledGridNetwork = { ...network, branchSusceptancePu: Float64Array.from(network.branchSusceptancePu, (value, index) => index === branch ? value * remaining : value) }
  const lostMw = screeningCase.flowsMw[branch]! * circuitsLost / circuits
  const transfer = new Float64Array(network.busCount)
  transfer[network.branchFrom[branch]!] = lostMw
  transfer[network.branchTo[branch]!] = -lostMw
  const resolved = bruteForceDcFlows(grid, screeningCase.closed, transfer, null, changed)
  const flows = hybridFlows(screeningCase.flowsMw, resolved, null)
  flows[branch] = screeningCase.flowsMw[branch]! * remaining + resolved.flows[branch]!
  return { flows, live: resolved.live, lostMw, derated: { branch, remaining } }
}

/** The v2 Norway model at the winter weekday peak, 08:00 local time. */
const v2WinterPeak = async (): Promise<GridRuntimeInstance> => {
  const directory = join(import.meta.dir, '../src/packs/electric-grid/models')
  const generated = validateGridModel(JSON.parse(await readFile(join(directory, 'norway-transmission.grid-model.json'), 'utf8')), 'v2')
  const winter = validateGridOperatingPoint(JSON.parse(await readFile(join(directory, 'norway-winter-weekday-peak.operating-point.json'), 'utf8')), 'winter', gridOperatingPointTargetsForModel(generated))
  const definition = gridDefinitionForModel(compileGridModelV2(generated, winter, gridLoadProfiles(norwayGridModelRef)).model)
  const at = '2026-01-15T07:00:00.000Z' as IsoTimestamp
  const grid = createGridRuntimeInstance({ definition, at })
  advanceGrid(grid, 0, at)
  return grid
}

describe('electric grid N-1 screening', () => {
  test('post-contingency flows and loading match brute-force re-solves of the hybrid method on every branch, for every branch, circuit and unit outage', () => {
    const grid = solvedNorway()
    const screeningCase = liveContingencyCase(grid)
    const network = screeningCase.network
    // The base is the AC solution where the islands converged; the increments are DC.
    expect(screeningCase.baseFlowModels.some(island => island.flowModel === 'ac')).toBe(true)
    expect(largestDifference(screeningCase.flowsMw, screeningCase.dcFlowsMw)).toBeGreaterThan(1)
    const inService = (bus: number): boolean => screeningCase.islands[screeningCase.islandOfBus[bus]!]!.energised
    const units = norway.model.generators.filter(definition =>
      gridGeneratorIsSynchronised(grid.generators.get(definition.id)!) && inService(network.busIndexById.get(definition.busId)!))
    const circuitsOf = (branch: number): number => grid.definition.model.branches[branch]!.circuits
    // Every branch whole, then one circuit of each multi-circuit branch, then every unit.
    const contingencies: GridContingency[] = [
      ...selectContingencies(screeningCase, { kind: 'all-branches' }, 'branch'),
      ...selectContingencies(screeningCase, { kind: 'all-branches' }, 'circuit').filter(contingency => contingency.kind === 'branch' && circuitsOf(contingency.branchIndex) > 1),
      ...units.map((definition): GridContingency => ({ kind: 'generator', generatorId: definition.id })),
    ]
    const snapshot = captureContingencySnapshot(screeningCase, contingencies, 'normal')
    // Before any outage the loading is the runtime's own, on its own basis.
    const live = Uint8Array.from(grid.definition.model.branches, branch => grid.branches.get(branch.id)!.flowModel === null ? 0 : 1)
    const baseLoading = kernelLoading(snapshot, screeningCase.flowsMw, new Uint8Array(network.branchCount))
    expect(largestDifference(baseLoading, Float64Array.from(grid.definition.model.branches, branch => grid.branches.get(branch.id)!.loadingPercent))).toBeLessThan(1e-9)
    expect(largestDifference(baseLoading, runtimeWayLoading(grid, screeningCase.flowsMw, live))).toBeLessThan(1e-9)
    expect(Array.from(snapshot.loading.mva).filter(flag => flag === 1).length).toBeGreaterThan(1_000)
    const engine = createContingencyEngine(snapshot)
    const flows = new Float64Array(network.branchCount)
    const outOfService = new Uint8Array(network.branchCount)
    let branchCount = 0
    let islanding = 0
    let separating = 0
    let circuitCount = 0
    let radialCircuits = 0
    let largest = 0
    let largestLoading = 0
    const check = (expected: { readonly flows: Float64Array; readonly live: Uint8Array }, outcome: ContingencyOutcome | null = null, derated: Derated | null = null): void => {
      largest = Math.max(largest, largestDifference(flows, expected.flows))
      largestLoading = Math.max(largestLoading, largestDifference(kernelLoading(snapshot, flows, outOfService, outcome), runtimeWayLoading(grid, expected.flows, expected.live, derated)))
      // The kernel takes out exactly the branches the re-solve leaves off the energised network.
      expect(Array.from(liveMask(flows, outOfService, screeningCase.closed))).toEqual(Array.from(expected.live))
    }
    contingencies.forEach((contingency, position) => {
      if (contingency.kind !== 'branch') return
      const branch = contingency.branchIndex
      const outcome = engine.evaluate(position, flows, outOfService)
      const circuits = circuitsOf(branch)
      if (contingency.circuitsLost < circuits) {
        // One circuit of n: the branch stays closed with (n − 1)/n of its susceptance and nothing splits.
        const resolved = circuitOutageByResolve(grid, screeningCase, branch, contingency.circuitsLost)
        expect(outcome).toMatchObject({ islanding: false, parts: [], deratedBranch: branch, remainingShare: resolved.derated.remaining })
        check(resolved, outcome, resolved.derated)
        // The same product in another order: the circuits' share times the flow, to rounding.
        expect(outcome.lostMw).toBeCloseTo(resolved.lostMw, 9)
        if (snapshot.bridges.childOf[branch]! >= 0) radialCircuits += 1
        circuitCount += 1
        return
      }
      const closed = screeningCase.closed.slice()
      closed[branch] = 0
      let resolved: { readonly flows: Float64Array; readonly live: Uint8Array }
      if (outcome.islanding || outcome.parts.length > 0) {
        // A split, or a boundary bus separated from its island (no split; one part rebalances): each
        // part rebalances its DC injections; the DC change of the re-solve adds to the base.
        resolved = bruteForceDcFlows(grid, closed, screeningCase.injectionsMw, null)
        check({ flows: hybridFlows(screeningCase.flowsMw, resolved, screeningCase.dcFlowsMw), live: resolved.live })
        if (outcome.islanding) islanding += 1
        else {
          expect(outcome.parts).toHaveLength(1)
          expect([network.branchFrom[branch]!, network.branchTo[branch]!].some(bus => snapshot.network.norwegianBus[bus] === 0)).toBe(true)
          separating += 1
        }
        // The part cut off (the rest, when a boundary bus is separated) absorbs exactly what the branch carried in the DC solution.
        expect(Math.abs(Math.abs(outcome.parts[0]!.imbalanceMw) - Math.abs(screeningCase.dcFlowsMw[branch]!))).toBeLessThan(1e-6)
      } else {
        // A meshed outage: the branch's base flow, routed from its from-bus to its to-bus through the rest of the network.
        const transfer = new Float64Array(network.busCount)
        transfer[network.branchFrom[branch]!] = screeningCase.flowsMw[branch]!
        transfer[network.branchTo[branch]!] = -screeningCase.flowsMw[branch]!
        resolved = bruteForceDcFlows(grid, closed, transfer, null)
        check({ flows: hybridFlows(screeningCase.flowsMw, resolved, null), live: resolved.live })
      }
      expect(outcome.lostMw).toBe(screeningCase.flowsMw[branch]!)
      branchCount += 1
    })
    let unitCount = 0
    units.forEach((definition, index) => {
      const state = grid.generators.get(definition.id)!
      const bus = network.busIndexById.get(definition.busId)!
      engine.evaluate(contingencies.length - units.length + index, flows, outOfService)
      const injections = screeningCase.injectionsMw.slice()
      injections[bus] = injections[bus]! - state.dispatchMw
      const removed = {
        bus,
        upMw: state.reserves.fcrNMw + state.reserves.fcrDUpMw,
        downMw: state.reserves.fcrNMw + state.reserves.fcrDDownMw,
        kineticEnergyMws: generatorKineticEnergyMws(definition),
        forming: generatorIsVoltageForming(definition) ? 1 : 0,
      }
      const resolved = bruteForceDcFlows(grid, screeningCase.closed, injections, removed)
      check({ flows: hybridFlows(screeningCase.flowsMw, resolved, screeningCase.dcFlowsMw), live: resolved.live })
      unitCount += 1
    })
    // A remedial case's base: the live base plus the DC change of its actions, judged on the same basis.
    const meshed = contingencies.find((contingency, position) => contingency.kind === 'branch' && !engine.evaluate(position, flows, outOfService).islanding)!
    const opened = network.branchIds[(meshed as { branchIndex: number }).branchIndex]!
    const remedial = switchedContingencyCase(screeningCase, remedialCaseChanges(screeningCase, [{ kind: 'open-branch', assetId: opened }])).case
    const resolved = bruteForceDcFlows(grid, remedial.closed, screeningCase.injectionsMw, null)
    const expectedRemedial = hybridFlows(screeningCase.flowsMw, resolved, screeningCase.dcFlowsMw)
    largest = Math.max(largest, largestDifference(remedial.flowsMw, expectedRemedial))
    const remedialSnapshot = captureContingencySnapshot(remedial, [], 'normal')
    largestLoading = Math.max(largestLoading, largestDifference(kernelLoading(remedialSnapshot, remedial.flowsMw, new Uint8Array(network.branchCount)), runtimeWayLoading(grid, expectedRemedial, resolved.live)))
    expect(remedial.baseFlowModels).toEqual(screeningCase.baseFlowModels)
    console.info(`N-1 vs brute force (AC base, DC increments): ${branchCount} branch outages (${islanding} islanding, ${separating} separating a boundary bus), ${circuitCount} one-circuit outages (${radialCircuits} of a bridge), ${unitCount} unit outages, largest difference ${largest.toExponential(2)} MW, ${largestLoading.toExponential(2)} % loading`)
    expect(branchCount).toBeGreaterThan(250)
    expect(circuitCount).toBeGreaterThan(50)
    // A parallel circuit of a bridge carries the whole transfer on: islanding needs every circuit lost.
    expect(radialCircuits).toBeGreaterThan(0)
    expect(islanding).toBeGreaterThan(0)
    // The six Nordic boundary buses with a single tie: losing it is no split.
    expect(separating).toBe(6)
    expect(largest).toBeLessThan(1e-6)
    expect(largestLoading).toBeLessThan(1e-6)
  }, 120_000)

  test('screens 300 contingencies inline within 100 ms of quiet CPU time (reported at the v2 model size too)', async () => {
    const grid = solvedNorway()
    const branchIds = norway.model.branches.filter(branch => grid.branches.get(branch.id)!.state === 'closed' && grid.busStates.get(branch.fromBusId)!.energized).map(branch => branch.id)
    const unitIds = norway.model.generators.filter(generator => grid.generators.get(generator.id)!.state === 'online').map(generator => generator.id)
    const contingencies = [...branchIds, ...unitIds].slice(0, 300)
    expect(contingencies).toHaveLength(300)
    // The whole screening on the calling thread, as below the size rule's threshold: the main thread's worst case.
    const inline = (screened: GridRuntimeInstance, assetIds: ReadonlyArray<string> | 'all') => async (): Promise<unknown> => {
      const live = liveContingencyCase(screened)
      const selected = selectContingencies(live, assetIds === 'all' ? { kind: 'all-branches' } : { kind: 'assets', assetIds }, 'circuit')
      return await screenContingencies({ screeningCase: live, contingencies: selected, ratingBasis: 'normal', screen: async snapshot => screenRecordsInline(snapshot) })
    }
    const query = (screened: GridRuntimeInstance, ids: ReadonlyArray<string> | 'all-branches') => async (): Promise<unknown> =>
      await ask(screened, 'world.electric-grid.contingency.screen', { contingencies: ids })
    const budget = 100 / referenceQuietMs
    const cost = await asyncCostInReferences(inline(grid, contingencies), 7)
    const queryCost = await asyncCostInReferences(query(grid, contingencies), 7)
    console.info(`N-1 (${norway.model.buses.length} buses): 300 contingencies inline ${cost.toFixed(2)} references (budget ${budget.toFixed(2)}); the query's main-thread share ${queryCost.toFixed(2)} references`)
    expect(cost).toBeLessThan(budget)

    const v2Grid = await v2WinterPeak()
    const v2 = v2Grid.definition
    const v2Branches = v2.model.branches.filter(branch => v2Grid.branches.get(branch.id)!.state === 'closed' && v2Grid.busStates.get(branch.fromBusId)!.energized).map(branch => branch.id)
    const v2ThreeCost = await asyncCostInReferences(inline(v2Grid, v2Branches.slice(0, 300)), 5)
    const v2AllCost = await asyncCostInReferences(inline(v2Grid, 'all'), 5)
    const v2AllQueryCost = await asyncCostInReferences(query(v2Grid, 'all-branches'), 5)
    console.info(`N-1 v2 (${v2.model.buses.length} buses, ${v2.model.branches.length} branches) inline: 300 contingencies ${v2ThreeCost.toFixed(2)} references; all ${v2Branches.length} in-service branches ${v2AllCost.toFixed(2)} references; the all-branches query's main-thread share ${v2AllQueryCost.toFixed(2)} references`)
    expect(v2ThreeCost).toBeLessThan(budget)
  }, 120_000)

  test('screening and remedial evaluation are read-only: state, topology, factors and projection are unchanged', async () => {
    const grid = solvedNorway()
    const snapshot = () => JSON.stringify({
      state: runtimeStateForElectricGrids(new Map([[grid.definition.gridId, grid]])),
      projection: grid.projection,
      tick: grid.tick,
      rebuilds: grid.diagnostics.topologyRebuildCount,
      injections: Array.from(grid.topologyPlan!.injectionsMw),
      angles: Array.from(grid.topologyPlan!.anglesRad),
      closed: Array.from(grid.topologyPlan!.closedBranches),
      factors: grid.topologyPlan!.systems.map(system => Array.from(system.factor.values)),
      branches: [...grid.branches.values()],
      generators: [...grid.generators.values()],
      signals: grid.signalQueue.length,
    })
    const plan = grid.topologyPlan
    const before = snapshot()
    const screened = await ask(grid, 'world.electric-grid.contingency.screen', { contingencies: 'all-branches', ratingBasis: 'emergency', limit: 500 })
    expect(screened.screenedCount).toBeGreaterThan(250)
    await ask(grid, 'world.electric-grid.contingency.screen', { contingencies: 'largest-generators', largestGeneratorCount: 10 })
    const meshed = screened.results.find((result: any) => !result.islanding && result.contingency.kind === 'branch').contingency.assetId
    const unit = norway.model.generators.find(generator => grid.generators.get(generator.id)!.state === 'online' && grid.generators.get(generator.id)!.dispatchMw > 50)!
    // The largest Oslo load (Grid Model v2 municipality 0301).
    const oslo = [...norway.model.loads].filter(load => load.id.startsWith('load:0301-')).sort((a, b) => b.demandMw - a.demandMw)[0]!
    await ask(grid, 'world.electric-grid.remedial-actions.evaluate', {
      contingencies: 'all-branches',
      actions: [
        { kind: 'open-branch', assetId: meshed },
        { kind: 'redispatch', assetId: unit.id, targetMw: grid.generators.get(unit.id)!.dispatchMw - 20 },
        { kind: 'shed-load', assetId: oslo.id, targetDemandMw: (grid.loads.get(oslo.id)!.servedMw + oslo.criticalMw) / 2, emergency: true },
      ],
    })
    expect(grid.topologyPlan).toBe(plan)
    expect(snapshot()).toBe(before)
  }, 60_000)

  test('reports islanding with each part\'s imbalance, unit outages rebalanced by reserves, and the rating basis', async () => {
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(10_000)
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' }).ok).toBe(true)
    run.advanceTo(12_000)
    const normal = await ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: 'all-branches', ratingBasis: 'normal' })
    const emergency = await ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: 'all-branches', ratingBasis: 'emergency' })
    // The A path runs at 129 % / 125 % of its rating, 108 % / 104 % of its emergency rating.
    expect(normal.baseCase).toMatchObject({ overloadedCount: 2, worstBranch: { assetId: 'branch:g-a' } })
    expect(emergency.baseCase.overloadedCount).toBe(2)
    expect(emergency.baseCase.worstBranch.loadingPercent).toBeCloseTo(normal.baseCase.worstBranch.loadingPercent / 1.2, 0)
    // Losing either A line moves the whole transfer onto the B path; no outage islands the meshed corridor.
    const lossOfA = normal.results.find((result: any) => result.contingency.assetId === 'branch:g-a')
    expect(lossOfA).toMatchObject({ islanding: false, violationCount: 2, worstBranch: { assetId: 'branch:g-b' } })
    expect(lossOfA.worstBranch.loadingPercent).toBeGreaterThan(250)
    expect(normal.islandingCount).toBe(0)
    const units = await ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: 'largest-generators', largestGeneratorCount: 2 })
    expect(units.results.map((result: any) => result.contingency.assetId).sort()).toEqual(['generator:g1', 'generator:l1'])
    const lossOfG1 = units.results.find((result: any) => result.contingency.assetId === 'generator:g1')
    expect(lossOfG1.islanding).toBe(false)
    expect(lossOfG1.affectedIslands[0]).toMatchObject({ balancing: 'reserves', unservedLoadMw: 0 })
    expect(lossOfG1.affectedIslands[0].imbalanceMw).toBeCloseTo(-lossOfG1.contingency.lostMw, 0)
    await expect(ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: 'largest-generators' })).rejects.toThrow('largestGeneratorCount is required')
    await expect(ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: ['branch:g-l'] })).rejects.toThrow('not in service')
    await expect(ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: ['bus:g'] })).rejects.toThrow('not a branch or generator')

    // With only the A path left, its lines are bridges: losing one separates L with its own unit;
    // with that unit tripped, L loses supply.
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-b' }).ok).toBe(true)
    const radial = await ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: ['branch:a-l'] })
    expect(radial.results[0]).toMatchObject({ islanding: true, unservedLoadMw: 0 })
    // The lost flow is the branch's AC flow; each part rebalances what the branch carried in the DC solution.
    const radialCase = liveContingencyCase(run.grid)
    const aL = radialCase.network.branchIds.indexOf('branch:a-l')
    expect(radialCase.baseFlowModels).toEqual([expect.objectContaining({ flowModel: 'ac' })])
    expect(radial.results[0].contingency.lostMw).toBeCloseTo(radialCase.flowsMw[aL]!, 1)
    for (const part of radial.results[0].affectedIslands) expect(Math.abs(part.imbalanceMw)).toBeCloseTo(Math.abs(radialCase.dcFlowsMw[aL]!), 1)
    expect(run.command('world.electric-grid.trip-generator', { assetId: 'generator:l1' }).ok).toBe(true)
    const dead = await ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: ['branch:a-l'] })
    const lostPart = dead.results[0].affectedIslands.find((part: any) => part.balancing === 'de-energised')
    // L and B (still tied to L by b-l) lose supply.
    expect(lostPart.busCount).toBe(2)
    expect(dead.results[0].unservedLoadMw).toBeCloseTo(run.grid.loads.get('load:l')!.servedMw, 0)
  })

  test('the adapter awaits the asynchronous N-1 answers; every other query still answers synchronously', async () => {
    const scenario = scenarios.find(candidate => candidate.id === 'test-grid')!
    const adapter = createLocalElectricGridPackRuntimeAdapter()
    const connection = await adapter.connect({
      simulationRunId: 'run-contingency-test' as SimulationRunId,
      scenario: { scenarioId: scenario.id, runtimeIds: [electricGridRuntimeId], connections: [], world: scenario.world, initialObjects: scenario.initialObjects, runtimeConfigByRuntimeId: {}, runtimeConfig: {} },
    })
    try {
      // Output parsed by the published schema, as the Capability Broker does.
      const capability = (id: string) => adapter.capabilities.find(candidate => candidate.id === id)!
      const screening: any = capability('world.electric-grid.contingency.screen').output.parse(await connection.invokeQuery({
        capabilityId: 'world.electric-grid.contingency.screen', input: { gridId: 'grid:norway', contingencies: 'all-branches', limit: 5 },
      }))
      expect(screening.screenedCount).toBeGreaterThan(250)
      expect(screening.results).toHaveLength(5)
      const remedial: any = capability('world.electric-grid.remedial-actions.evaluate').output.parse(await connection.invokeQuery({
        capabilityId: 'world.electric-grid.remedial-actions.evaluate',
        input: { gridId: 'grid:norway', contingencies: [screening.results[0].contingency.assetId], actions: [{ kind: 'open-branch', assetId: screening.results[1].contingency.assetId }] },
      }))
      expect(remedial.before.screenedCount).toBe(1)
      await expect(connection.invokeQuery({ capabilityId: 'world.electric-grid.contingency.screen', input: { gridId: 'grid:missing', contingencies: 'all-branches' } }))
        .rejects.toThrow('Electric Grid not found: grid:missing')
    } finally {
      await connection.close()
    }
    const grid = solvedNorway()
    const summary = answerElectricGridQuery({ request: { capabilityId: 'world.electric-grid.grid.summary', input: { gridId: grid.definition.gridId } }, grids: new Map([[grid.definition.gridId, grid]]) })
    expect(summary).not.toBeInstanceOf(Promise)
    expect((summary as { gridId: string }).gridId).toBe(grid.definition.gridId)
  }, 60_000)

  test('remedial actions are evaluated on a private case: before equals the screening, after shows the relief', async () => {
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(10_000)
    run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' })
    run.advanceTo(12_000)
    const screened = await ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: 'all-branches' })
    const evaluated = await ask(run.grid, 'world.electric-grid.remedial-actions.evaluate', {
      contingencies: 'all-branches',
      actions: [{ kind: 'shed-load', assetId: 'load:l', targetDemandMw: 450, emergency: true }],
    })
    const { results: _results, gridId: _gridId, revision: _revision, ratingBasis: _ratingBasis, branchOutage: _branchOutage, baseFlowModels, incrementModel, ...summary } = screened
    expect(evaluated.before).toEqual(summary)
    expect({ baseFlowModels: evaluated.baseFlowModels, incrementModel: evaluated.incrementModel }).toEqual({ baseFlowModels, incrementModel: 'dc' })
    expect(evaluated.before.baseCase.overloadedCount).toBe(2)
    expect(evaluated.after.baseCase.overloadedCount).toBe(0)
    expect(evaluated.after.totalViolations).toBeLessThan(evaluated.before.totalViolations)
    expect(evaluated.actionBalances).toHaveLength(1)
    expect(evaluated.actionBalances[0].imbalanceMw).toBeGreaterThan(0)

    // Closing the direct line again passes its synchro-check (its ends lie 17° apart) and relieves the corridor.
    const reconnect = await ask(run.grid, 'world.electric-grid.remedial-actions.evaluate', { contingencies: 'all-branches', actions: [{ kind: 'close-branch', assetId: 'branch:g-l' }] })
    expect(reconnect.after.baseCase.overloadedCount).toBe(0)
    // Opening the B path first puts all of G's export on the A path: measured after that action, the
    // direct line's ends lie 24.6° apart on the case's DC solution, beyond the 20° loop-closing limit, so the close is reported as rejected.
    await expect(ask(run.grid, 'world.electric-grid.remedial-actions.evaluate', {
      contingencies: 'all-branches', actions: [{ kind: 'open-branch', assetId: 'branch:g-b' }, { kind: 'close-branch', assetId: 'branch:g-l' }],
    })).rejects.toThrow(/close-branch branch:g-l would be rejected by synchro-check: both ends are in one energised island after the earlier actions and their voltage angles differ by Δθ 2\d\.\d° \(DC solution of the case after the earlier actions\), above the 20° loop-closing limit/)
    await expect(ask(run.grid, 'world.electric-grid.remedial-actions.evaluate', { contingencies: 'all-branches', actions: [{ kind: 'open-branch', assetId: 'branch:g-l' }] })).rejects.toThrow('already open')
    await expect(ask(run.grid, 'world.electric-grid.remedial-actions.evaluate', {
      contingencies: 'all-branches', actions: [{ kind: 'redispatch', assetId: 'generator:l1', targetMw: 150 }, { kind: 'redispatch', assetId: 'generator:l1', targetMw: 160 }],
    })).rejects.toThrow('more than once')
    await expect(ask(run.grid, 'world.electric-grid.remedial-actions.evaluate', { contingencies: 'all-branches', actions: [{ kind: 'redispatch', assetId: 'generator:l1', targetMw: 900 }] })).rejects.toThrow('outside its minimum stable')
  })

  test('one circuit of a parallel-circuit line is its N-1 outage: the parallel path holds, losing both circuits overloads it, both as DC and AC re-solves give', async () => {
    const run = steppedGrid(gridDefinitionForModel(parallelCircuitCorridorModel(2)))
    run.advanceTo(10_000)
    const screen = async (input: Readonly<Record<string, unknown>>) => (await ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: ['branch:g-l'], ratingBasis: 'emergency', ...input })).results[0]
    const oneCircuit = await screen({})
    const bothCircuits = await screen({ branchOutage: 'branch' })
    expect(oneCircuit.contingency).toMatchObject({ assetId: 'branch:g-l', kind: 'branch', circuits: 2, circuitsLost: 1, category: 'ordinary' })
    expect(bothCircuits.contingency).toMatchObject({ assetId: 'branch:g-l', kind: 'branch', circuits: 2, circuitsLost: 2, category: 'exceptional' })
    expect(oneCircuit.contingency.lostMw).toBeCloseTo(bothCircuits.contingency.lostMw / 2, 0)
    // Losing both circuits puts G's whole export on the path via M, beyond its emergency rating;
    // losing one leaves the other circuit (now rated 500 / 600 MW) as the most loaded branch, within its rating.
    expect(bothCircuits).toMatchObject({ islanding: false, unservedLoadMw: 0, violationCount: 2 })
    expect(bothCircuits.overloadedBranches.map((branch: any) => branch.assetId).sort()).toEqual(['branch:g-m', 'branch:m-l'])
    expect(oneCircuit).toMatchObject({ islanding: false, unservedLoadMw: 0, violationCount: 0, affectedIslands: [], worstBranch: { assetId: 'branch:g-l' } })
    expect(oneCircuit.worstBranch.loadingPercent).toBeLessThan(100)

    // The kernel against brute-force DC re-solves of the hybrid method.
    const live = liveContingencyCase(run.grid)
    const branch = live.network.branchIds.indexOf('branch:g-l')
    const snapshot = captureContingencySnapshot(live, [{ kind: 'branch', branchIndex: branch, circuitsLost: 1 }, { kind: 'branch', branchIndex: branch, circuitsLost: 2 }], 'normal')
    const engine = createContingencyEngine(snapshot)
    const flows = new Float64Array(live.network.branchCount)
    const outOfService = new Uint8Array(live.network.branchCount)
    const partial = engine.evaluate(0, flows, outOfService)
    const resolved = circuitOutageByResolve(run.grid, live, branch, 1)
    expect(largestDifference(flows, resolved.flows)).toBeLessThan(1e-6)
    expect(largestDifference(kernelLoading(snapshot, flows, outOfService, partial), runtimeWayLoading(run.grid, resolved.flows, resolved.live, resolved.derated))).toBeLessThan(1e-6)
    const partialFlows = flows.slice()
    engine.evaluate(1, flows, outOfService)
    const closed = live.closed.slice()
    closed[branch] = 0
    const transfer = new Float64Array(live.network.busCount)
    transfer[live.network.branchFrom[branch]!] = live.flowsMw[branch]!
    transfer[live.network.branchTo[branch]!] = -live.flowsMw[branch]!
    expect(largestDifference(flows, hybridFlows(live.flowsMw, bruteForceDcFlows(run.grid, closed, transfer, null), null))).toBeLessThan(1e-6)

    // Against AC re-solves: the corridor with one circuit, and with the line open.
    const single = steppedGrid(gridDefinitionForModel(parallelCircuitCorridorModel(1)))
    single.advanceTo(10_000)
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' }).ok).toBe(true)
    const acFlows = (grid: GridRuntimeInstance): Float64Array => Float64Array.from(grid.definition.model.branches, definition => grid.branches.get(definition.id)!.flowModel === null ? 0 : grid.branches.get(definition.id)!.flowMw)
    const transferMw = Math.abs(live.flowsMw[branch]!)
    const partialAcDifference = largestDifference(partialFlows, acFlows(single.grid))
    const fullAcDifference = largestDifference(flows, acFlows(run.grid))
    const acEmergencyLoading = (grid: GridRuntimeInstance, branchId: string): number => {
      const definition = grid.definition.model.branches.find(candidate => candidate.id === branchId)!
      return grid.branches.get(branchId)!.loadingPercent * definition.ratingMw / definition.emergencyRatingMw
    }
    console.info(`parallel-circuit corridor: G – L carries ${transferMw.toFixed(1)} MW on 2 circuits; one circuit lost: G – L ${oneCircuit.worstBranch.loadingPercent} % of its remaining emergency rating (AC re-solve ${acEmergencyLoading(single.grid, 'branch:g-l').toFixed(1)} %), largest flow difference to the AC re-solve ${partialAcDifference.toFixed(1)} MW; both lost: G – M ${bothCircuits.worstBranch.loadingPercent} % (AC ${acEmergencyLoading(run.grid, 'branch:g-m').toFixed(1)} %), ${fullAcDifference.toFixed(1)} MW`)
    // The DC increments stay within 3 % of the transfer of the AC re-solves, on the same side of the ratings.
    expect(partialAcDifference).toBeLessThan(0.03 * transferMw)
    expect(fullAcDifference).toBeLessThan(0.03 * transferMw)
    expect(acEmergencyLoading(single.grid, 'branch:g-l')).toBeLessThan(100)
    expect(acEmergencyLoading(single.grid, 'branch:g-m')).toBeLessThan(100)
    expect(acEmergencyLoading(run.grid, 'branch:g-m')).toBeGreaterThan(100)
  })

  test('a partial outage of a parallel-circuit bridge splits nothing: the remaining circuits carry the transfer; losing every circuit islands', async () => {
    const run = steppedGrid(gridDefinitionForModel(parallelCircuitCorridorModel(2)))
    run.advanceTo(10_000)
    // Without the path G – L is a bridge between G and L (with M radial behind it).
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-m' }).ok).toBe(true)
    run.advanceTo(12_000)
    const live = liveContingencyCase(run.grid)
    const branch = live.network.branchIds.indexOf('branch:g-l')
    const snapshot = captureContingencySnapshot(live, [{ kind: 'branch', branchIndex: branch, circuitsLost: 1 }], 'emergency')
    expect(snapshot.bridges.childOf[branch]).toBeGreaterThanOrEqual(0)
    const flows = new Float64Array(live.network.branchCount)
    const outOfService = new Uint8Array(live.network.branchCount)
    expect(createContingencyEngine(snapshot).evaluate(0, flows, outOfService)).toMatchObject({ islanding: false, parts: [], deratedBranch: branch, remainingShare: 0.5 })
    expect(Array.from(flows)).toEqual(Array.from(live.flowsMw))
    expect(Array.from(outOfService)).toEqual(Array.from(new Uint8Array(live.network.branchCount)))
    const oneCircuit = await ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: ['branch:g-l'], ratingBasis: 'emergency' })
    expect(oneCircuit.islandingCount).toBe(0)
    expect(oneCircuit.results[0]).toMatchObject({ islanding: false, affectedIslands: [], unservedLoadMw: 0, worstBranch: { assetId: 'branch:g-l' } })
    // The remaining circuit carries what both did, on half the rating, holding its half of the base reactive power.
    const remainingLoading = Math.round(remainingCircuitsLoadingPercent(snapshot, branch, live.flowsMw[branch]!, 0.5) * 10) / 10
    expect(oneCircuit.results[0].worstBranch.loadingPercent).toBe(remainingLoading)
    expect(remainingLoading).toBeGreaterThan(1.9 * oneCircuit.results[0].worstBranch.preContingencyLoadingPercent)
    const bothCircuits = await ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: ['branch:g-l'], ratingBasis: 'emergency', branchOutage: 'branch' })
    expect(bothCircuits.islandingCount).toBe(1)
    expect(bothCircuits.results[0].affectedIslands).toHaveLength(2)

    // Remedial evaluation screens the same one-circuit outage by default.
    const evaluated = await ask(run.grid, 'world.electric-grid.remedial-actions.evaluate', { contingencies: ['branch:g-l'], ratingBasis: 'emergency', actions: [{ kind: 'shed-load', assetId: 'load:l', targetDemandMw: 700, emergency: true }] })
    expect(evaluated.branchOutage).toBe('circuit')
    const { results: _results, gridId: _gridId, revision: _revision, ratingBasis: _ratingBasis, branchOutage: _branchOutage, baseFlowModels: _baseFlowModels, incrementModel: _incrementModel, ...summary } = oneCircuit
    expect(evaluated.before).toEqual(summary)
    expect(evaluated.results[0].contingency).toMatchObject({ circuits: 2, circuitsLost: 1, category: 'ordinary' })
    await expect(ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: ['branch:g-l'], branchOutage: 'circuits' })).rejects.toThrow()
    expect(() => captureContingencySnapshot(live, [{ kind: 'branch', branchIndex: branch, circuitsLost: 3 }], 'normal')).toThrow('branch:g-l has 2 circuit(s); an outage of 3 is not one of 1 to 2')
  })

  test('on the v2 winter weekday peak one circuit of each multi-circuit branch is screened by default, the loss of all of them as an exceptional N-k case', async () => {
    const grid = await v2WinterPeak()
    const live = liveContingencyCase(grid)
    const screen = async (branchOutage: 'circuit' | 'branch', ratingBasis: 'normal' | 'emergency') => await screenContingencies({
      screeningCase: live, contingencies: selectContingencies(live, { kind: 'all-branches' }, branchOutage), ratingBasis, screen: async snapshot => screenRecordsInline(snapshot),
    })
    const circuitsOf = new Map(grid.definition.model.branches.map(branch => [branch.id, branch.circuits]))
    const counts = (summary: Awaited<ReturnType<typeof screen>>) => {
      const multi = summary.results.filter(result => circuitsOf.get(result.contingency.assetId)! > 1)
      return {
        violating: summary.violatingCount,
        violations: summary.totalViolations,
        islanding: summary.islandingCount,
        unserved: summary.results.filter(result => result.unservedLoadMw > 0).length,
        unservedMw: Math.round(summary.results.reduce((sum, result) => sum + result.unservedLoadMw, 0)),
        multiCircuitViolating: multi.filter(result => result.violationCount > 0).length,
        multiCircuitIslanding: multi.filter(result => result.islanding).length,
      }
    }
    const report: string[] = []
    for (const ratingBasis of ['emergency', 'normal'] as const) {
      const perCircuit = await screen('circuit', ratingBasis)
      const whole = await screen('branch', ratingBasis)
      const byId = new Map(perCircuit.results.map(result => [result.contingency.assetId, result]))
      expect(perCircuit.screenedCount).toBe(whole.screenedCount)
      for (const result of whole.results) {
        const circuits = circuitsOf.get(result.contingency.assetId)!
        const partial = byId.get(result.contingency.assetId)!
        // A single-circuit branch is lost whole either way: the same result.
        if (circuits === 1) expect(partial).toEqual(result)
        else {
          expect(result.contingency).toMatchObject({ circuits, circuitsLost: circuits, category: 'exceptional' })
          expect(partial.contingency).toMatchObject({ circuits, circuitsLost: 1, category: 'ordinary' })
          // The branch stays closed: no partial outage splits an island or loses load.
          expect(partial).toMatchObject({ islanding: false, affectedIslands: [], unservedLoadMw: 0 })
        }
      }
      const [after, before] = [counts(perCircuit), counts(whole)]
      expect(after.multiCircuitIslanding).toBe(0)
      expect(after.islanding).toBe(before.islanding - before.multiCircuitIslanding)
      expect(after.multiCircuitViolating).toBeLessThanOrEqual(before.multiCircuitViolating)
      report.push(`${ratingBasis}: outages with violations ${before.violating} → ${after.violating} (multi-circuit ${before.multiCircuitViolating} → ${after.multiCircuitViolating}), violations ${before.violations} → ${after.violations}, islanding ${before.islanding} → ${after.islanding}, with unserved load ${before.unserved} → ${after.unserved} (${before.unservedMw} → ${after.unservedMw} MW)`)
    }
    // Losing one circuit moves on every other branch a share of what losing them all moves, the same
    // way: no other branch is loaded more than in the base case or the N-k case.
    const multi = selectContingencies(live, { kind: 'all-branches' }, 'circuit').filter(contingency => contingency.kind === 'branch' && circuitsOf.get(live.network.branchIds[contingency.branchIndex]!)! > 1)
    const contingencies = multi.flatMap(contingency => contingency.kind === 'branch' ? [contingency, { ...contingency, circuitsLost: circuitsOf.get(live.network.branchIds[contingency.branchIndex]!)! }] : [])
    const snapshot = captureContingencySnapshot(live, contingencies, 'emergency')
    const engine = createContingencyEngine(snapshot)
    const flows = new Float64Array(live.network.branchCount)
    const outOfService = new Uint8Array(live.network.branchCount)
    const baseLoading = kernelLoading(snapshot, live.flowsMw, outOfService)
    let compared = 0
    for (let position = 0; position < contingencies.length; position += 2) {
      const partialOutcome = engine.evaluate(position, flows, outOfService)
      const partial = kernelLoading(snapshot, flows, outOfService, partialOutcome)
      if (engine.evaluate(position + 1, flows, outOfService).parts.length > 0) continue
      const whole = kernelLoading(snapshot, flows, outOfService)
      const outaged = (contingencies[position] as { branchIndex: number }).branchIndex
      for (let branch = 0; branch < partial.length; branch += 1) {
        if (branch !== outaged) expect(partial[branch]!).toBeLessThanOrEqual(Math.max(baseLoading[branch]!, whole[branch]!) + 1e-9)
      }
      compared += 1
    }
    expect(compared).toBeGreaterThan(50)
    console.info(`N-1 v2 winter weekday peak 08:00, whole branch → one circuit of ${multi.length} multi-circuit branches: ${report.join('; ')}`)
  }, 120_000)
})
