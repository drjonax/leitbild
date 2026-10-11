import { describe, expect, test } from 'bun:test'
import { norwayRuntimeTestOperatingPointRef } from './fixtures/grid-operating-point.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { norwayGridModelRef, nordicFrequencyAutomationRef, norwayWinterPeakOperatingPointRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition, gridOperatingPointDemand } from '../src/packs/electric-grid/definitions.ts'
import { compileGridModelV2 } from '../src/packs/electric-grid/models/compile-v2.ts'
import { answerElectricGridQuery } from '../src/packs/electric-grid/queries/index.ts'
import { rebalancePart, type RemovedParticipant } from '../src/packs/electric-grid/runtime/contingency-balance.ts'
import { captureContingencySnapshot } from '../src/packs/electric-grid/runtime/contingency-capture.ts'
import { liveContingencyCase, switchedContingencyCase } from '../src/packs/electric-grid/runtime/contingency-case.ts'
import { remedialCaseChanges } from '../src/packs/electric-grid/runtime/remedial-actions.ts'
import { screenRecordsInline } from '../src/packs/electric-grid/runtime/contingency-execution.ts'
import { screenContingencies, selectContingencies } from '../src/packs/electric-grid/runtime/contingency-screen.ts'
import type { ContingencySnapshot, GridContingency } from '../src/packs/electric-grid/runtime/contingency-snapshot.ts'
import { branchLoadingPercent, createContingencyEngine } from '../src/packs/electric-grid/runtime/contingency.ts'
import { generatorIsVoltageForming, generatorKineticEnergyMws } from '../src/packs/electric-grid/runtime/generator-dynamics.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { gridGeneratorIsSynchronised } from '../src/packs/electric-grid/runtime/island-input.ts'
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
import { corridorDefinition, steppedGrid } from './fixtures/grid-corridor.ts'
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
 * Brute force: a fresh factorisation of every island of the changed network, injections rebalanced
 * by the same participation rule. Returns the DC flows and which branches stay on the energised network.
 */
const bruteForceDcFlows = (grid: GridRuntimeInstance, closed: Uint8Array, injections: Float64Array, removed: RemovedParticipant | null) => {
  const screeningCase = liveContingencyCase(grid)
  const network = screeningCase.network
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

/**
 * Loading (%) the runtime's way, from the Grid's branch states: on a branch carrying AC flow the
 * larger end apparent power, each end's reactive power held at its base and its active power moved
 * by the change from the base flow (the to end's base being the AC series loss less the from end's);
 * |flow| on a DC branch; 0 on a branch out of service.
 */
const runtimeWayLoading = (grid: GridRuntimeInstance, flowsMw: Float64Array, inService: Uint8Array): Float64Array =>
  Float64Array.from(grid.definition.model.branches, (branch, index) => {
    if (inService[index] !== 1) return 0
    const state = grid.branches.get(branch.id)!
    const capacityMw = branch.ratingMw * state.availability
    if (state.flowModel !== 'ac') return Math.abs(flowsMw[index]!) / capacityMw * 100
    const changeMw = flowsMw[index]! - state.flowMw
    const toMw = state.lossesMw - state.flowMw - changeMw
    return Math.max(Math.hypot(flowsMw[index]!, state.reactiveFromMvar!), Math.hypot(toMw, state.reactiveToMvar!)) / capacityMw * 100
  })

/** The kernel's loading of every branch after an evaluation. */
const kernelLoading = (snapshot: ContingencySnapshot, flowsMw: Float64Array, outOfService: Uint8Array): Float64Array =>
  Float64Array.from(flowsMw, (flow, branch) => outOfService[branch] === 1 ? 0 : branchLoadingPercent(snapshot, branch, flow))

const liveMask = (flows: ArrayLike<number>, outOfService: Uint8Array, closed: Uint8Array): Uint8Array =>
  Uint8Array.from(flows, (_, branch) => closed[branch] === 1 && outOfService[branch] !== 1 ? 1 : 0)

describe('electric grid N-1 screening', () => {
  test('post-contingency flows and loading match brute-force re-solves of the hybrid method on every branch, for every branch and unit outage', () => {
    const grid = solvedNorway()
    const screeningCase = liveContingencyCase(grid)
    const network = screeningCase.network
    // The base is the AC solution where the islands converged; the increments are DC.
    expect(screeningCase.baseFlowModels.some(island => island.flowModel === 'ac')).toBe(true)
    expect(largestDifference(screeningCase.flowsMw, screeningCase.dcFlowsMw)).toBeGreaterThan(1)
    const inService = (bus: number): boolean => screeningCase.islands[screeningCase.islandOfBus[bus]!]!.energised
    const units = norway.model.generators.filter(definition =>
      gridGeneratorIsSynchronised(grid.generators.get(definition.id)!) && inService(network.busIndexById.get(definition.busId)!))
    const contingencies: GridContingency[] = [
      ...selectContingencies(screeningCase, { kind: 'all-branches' }),
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
    let largest = 0
    let largestLoading = 0
    const check = (expected: { readonly flows: Float64Array; readonly live: Uint8Array }): void => {
      largest = Math.max(largest, largestDifference(flows, expected.flows))
      largestLoading = Math.max(largestLoading, largestDifference(kernelLoading(snapshot, flows, outOfService), runtimeWayLoading(grid, expected.flows, expected.live)))
      // The kernel takes out exactly the branches the re-solve leaves off the energised network.
      expect(Array.from(liveMask(flows, outOfService, screeningCase.closed))).toEqual(Array.from(expected.live))
    }
    contingencies.forEach((contingency, position) => {
      if (contingency.kind !== 'branch') return
      const branch = contingency.branchIndex
      const outcome = engine.evaluate(position, flows, outOfService)
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
    console.info(`N-1 vs brute force (AC base, DC increments): ${branchCount} branch outages (${islanding} islanding, ${separating} separating a boundary bus), ${unitCount} unit outages, largest difference ${largest.toExponential(2)} MW, ${largestLoading.toExponential(2)} % loading`)
    expect(branchCount).toBeGreaterThan(250)
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
      const selected = selectContingencies(live, assetIds === 'all' ? { kind: 'all-branches' } : { kind: 'assets', assetIds })
      return await screenContingencies({ screeningCase: live, contingencies: selected, ratingBasis: 'normal', screen: async snapshot => screenRecordsInline(snapshot) })
    }
    const query = (screened: GridRuntimeInstance, ids: ReadonlyArray<string> | 'all-branches') => async (): Promise<unknown> =>
      await ask(screened, 'world.electric-grid.contingency.screen', { contingencies: ids })
    const budget = 100 / referenceQuietMs
    const cost = await asyncCostInReferences(inline(grid, contingencies), 7)
    const queryCost = await asyncCostInReferences(query(grid, contingencies), 7)
    console.info(`N-1 (${norway.model.buses.length} buses): 300 contingencies inline ${cost.toFixed(2)} references (budget ${budget.toFixed(2)}); the query's main-thread share ${queryCost.toFixed(2)} references`)
    expect(cost).toBeLessThan(budget)

    const directory = join(import.meta.dir, '../src/packs/electric-grid/models')
    const generated = validateGridModel(JSON.parse(await readFile(join(directory, 'norway-transmission.grid-model.json'), 'utf8')), 'v2')
    const winter = validateGridOperatingPoint(JSON.parse(await readFile(join(directory, 'norway-winter-weekday-peak.operating-point.json'), 'utf8')), 'winter', gridOperatingPointTargetsForModel(generated))
    const v2 = gridDefinitionForModel(compileGridModelV2(generated, winter, gridOperatingPointDemand(norwayWinterPeakOperatingPointRef, norwayGridModelRef)).model)
    const v2At = '2026-01-15T07:00:00.000Z' as IsoTimestamp
    const v2Grid = createGridRuntimeInstance({ definition: v2, at: v2At })
    advanceGrid(v2Grid, 0, v2At)
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
    const { results: _results, gridId: _gridId, revision: _revision, ratingBasis: _ratingBasis, baseFlowModels, incrementModel, ...summary } = screened
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
})
