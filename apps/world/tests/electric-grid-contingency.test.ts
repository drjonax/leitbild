import { describe, expect, test } from 'bun:test'
import { norwayRuntimeTestOperatingPointRef } from './fixtures/grid-operating-point.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { norwayGridModelRef, nordicFrequencyAutomationRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import { compileGridModelV2 } from '../src/packs/electric-grid/models/compile-v2.ts'
import { answerElectricGridQuery } from '../src/packs/electric-grid/queries/index.ts'
import { liveContingencyCase, rebalancePart, type RemovedParticipant } from '../src/packs/electric-grid/runtime/contingency-case.ts'
import { createContingencyEngine } from '../src/packs/electric-grid/runtime/contingency.ts'
import { generatorIsVoltageForming, generatorKineticEnergyMws } from '../src/packs/electric-grid/runtime/generator-dynamics.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { gridGeneratorIsSynchronised } from '../src/packs/electric-grid/runtime/island-input.ts'
import { createGridIslandSystem, solveGridIslandInto } from '../src/packs/electric-grid/runtime/network/dc-power-flow.ts'
import { findGridIslands } from '../src/packs/electric-grid/runtime/network/islands.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { validateGridModel } from '../src/packs/electric-grid/schemas/grid-model.ts'
import { gridOperatingPointTargetsForModel, validateGridOperatingPoint } from '../src/packs/electric-grid/schemas/grid-operating-point.ts'
import { runtimeStateForElectricGrids } from '../src/packs/electric-grid/sim/runtime-state.ts'
import { costsInReferences, referenceQuietMs, threadCpuMs } from './cpu-cost.ts'
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
const ask = (grid: GridRuntimeInstance, capabilityId: string, input: Readonly<Record<string, unknown>>): any =>
  answerElectricGridQuery({ request: { capabilityId, input: { gridId: grid.definition.gridId, ...input } } satisfies Query, grids: new Map([[grid.definition.gridId, grid]]) })

/** Brute force: a fresh factorisation of every island of the changed network, injections rebalanced by the same participation rule. */
const bruteForceFlows = (grid: GridRuntimeInstance, closed: Uint8Array, injections: Float64Array, removed: RemovedParticipant | null): Float64Array => {
  const screeningCase = liveContingencyCase(grid)
  const network = screeningCase.network
  const found = findGridIslands(network, closed)
  const balanced = injections.slice()
  const angles = new Float64Array(network.busCount)
  const flows = new Float64Array(network.branchCount)
  const scratch = new Int32Array(network.busCount)
  for (let island = 0; island < found.count; island += 1) {
    const buses = found.busOrder.slice(found.busStart[island]!, found.busStart[island + 1]!)
    const branches = found.branchOrder.slice(found.branchStart[island]!, found.branchStart[island + 1]!)
    if (rebalancePart({ participation: screeningCase.participation, members: buses, injections: balanced, removed }).balancing === 'de-energised') continue
    solveGridIslandInto(network, createGridIslandSystem({ network, islandId: `brute-${island}`, buses, branches, localOfBus: scratch }), balanced, angles)
    for (const branch of branches) flows[branch] = (angles[network.branchFrom[branch]!]! - angles[network.branchTo[branch]!]!) * network.sBaseMva * network.branchSusceptancePu[branch]!
  }
  return flows
}

const largestDifference = (a: Float64Array, b: Float64Array): number => a.reduce((largest, value, index) => Math.max(largest, Math.abs(value - b[index]!)), 0)

describe('electric grid N-1 screening', () => {
  test('post-contingency flows match brute-force re-solves within 1e-6 MW on every branch, for every branch and unit outage', () => {
    const grid = solvedNorway()
    const screeningCase = liveContingencyCase(grid)
    const engine = createContingencyEngine(screeningCase)
    const network = screeningCase.network
    const flows = new Float64Array(network.branchCount)
    let branchCount = 0
    let islanding = 0
    let largest = 0
    for (let branch = 0; branch < network.branchCount; branch += 1) {
      if (screeningCase.closed[branch] !== 1 || !screeningCase.islands[screeningCase.islandOfBus[network.branchFrom[branch]!]!]!.energised) continue
      const outcome = engine.evaluate({ kind: 'branch', branchIndex: branch }, flows)
      const closed = screeningCase.closed.slice()
      closed[branch] = 0
      largest = Math.max(largest, largestDifference(flows, bruteForceFlows(grid, closed, screeningCase.injectionsMw, null)))
      branchCount += 1
      if (outcome.islanding) {
        islanding += 1
        // The part cut off absorbs exactly what the branch carried.
        expect(Math.abs(Math.abs(outcome.parts[0]!.imbalanceMw) - Math.abs(outcome.lostMw))).toBeLessThan(1e-6)
      }
    }
    let unitCount = 0
    for (const definition of norway.model.generators) {
      const state = grid.generators.get(definition.id)!
      const bus = network.busIndexById.get(definition.busId)!
      if (!gridGeneratorIsSynchronised(state) || !screeningCase.islands[screeningCase.islandOfBus[bus]!]!.energised) continue
      engine.evaluate({ kind: 'generator', generatorId: definition.id }, flows)
      const injections = screeningCase.injectionsMw.slice()
      injections[bus] = injections[bus]! - state.dispatchMw
      const removed = {
        bus,
        upMw: state.reserves.fcrNMw + state.reserves.fcrDUpMw,
        downMw: state.reserves.fcrNMw + state.reserves.fcrDDownMw,
        kineticEnergyMws: generatorKineticEnergyMws(definition),
        forming: generatorIsVoltageForming(definition) ? 1 : 0,
      }
      largest = Math.max(largest, largestDifference(flows, bruteForceFlows(grid, screeningCase.closed, injections, removed)))
      unitCount += 1
    }
    console.info(`N-1 vs brute force: ${branchCount} branch outages (${islanding} islanding), ${unitCount} unit outages, largest difference ${largest.toExponential(2)} MW`)
    expect(branchCount).toBeGreaterThan(250)
    expect(islanding).toBeGreaterThan(0)
    expect(largest).toBeLessThan(1e-6)
  }, 60_000)

  test('screens 300 contingencies within 100 ms of quiet CPU time (reported at the v2 model size too)', async () => {
    const grid = solvedNorway()
    const branchIds = norway.model.branches.filter(branch => grid.branches.get(branch.id)!.state === 'closed' && grid.busStates.get(branch.fromBusId)!.energized).map(branch => branch.id)
    const unitIds = norway.model.generators.filter(generator => grid.generators.get(generator.id)!.state === 'online').map(generator => generator.id)
    const contingencies = [...branchIds, ...unitIds].slice(0, 300)
    expect(contingencies).toHaveLength(300)
    const screen = (): unknown => ask(grid, 'world.electric-grid.contingency.screen', { contingencies })
    const [cost] = costsInReferences([screen], 7)
    const budget = 100 / referenceQuietMs
    console.info(`N-1 v1 (${norway.model.buses.length} buses): 300 contingencies cost ${cost!.toFixed(2)} references (budget ${budget.toFixed(2)}), ${threadCpuMs(screen).toFixed(1)} ms CPU`)
    expect(cost!).toBeLessThan(budget)

    const directory = join(import.meta.dir, '../src/packs/electric-grid/models')
    const generated = validateGridModel(JSON.parse(await readFile(join(directory, 'norway-transmission.grid-model.json'), 'utf8')), 'v2')
    const winter = validateGridOperatingPoint(JSON.parse(await readFile(join(directory, 'norway-winter-weekday-peak.operating-point.json'), 'utf8')), 'winter', gridOperatingPointTargetsForModel(generated))
    const v2 = gridDefinitionForModel(compileGridModelV2(generated, winter).model)
    const v2At = '2026-01-15T07:00:00.000Z' as IsoTimestamp
    const v2Grid = createGridRuntimeInstance({ definition: v2, at: v2At })
    advanceGrid(v2Grid, 0, v2At)
    const v2Branches = v2.model.branches.filter(branch => v2Grid.branches.get(branch.id)!.state === 'closed' && v2Grid.busStates.get(branch.fromBusId)!.energized).map(branch => branch.id)
    const v2Three = (): unknown => ask(v2Grid, 'world.electric-grid.contingency.screen', { contingencies: v2Branches.slice(0, 300) })
    const v2All = (): unknown => ask(v2Grid, 'world.electric-grid.contingency.screen', { contingencies: 'all-branches' })
    const [v2ThreeCost, v2AllCost] = costsInReferences([v2Three, v2All], 5)
    console.info(`N-1 v2 (${v2.model.buses.length} buses, ${v2.model.branches.length} branches): 300 contingencies ${v2ThreeCost!.toFixed(2)} references (${threadCpuMs(v2Three).toFixed(1)} ms CPU); all ${v2Branches.length} in-service branches ${v2AllCost!.toFixed(2)} references (${threadCpuMs(v2All).toFixed(1)} ms CPU)`)
    expect(v2ThreeCost!).toBeLessThan(budget)
  }, 120_000)

  test('screening and remedial evaluation are read-only: state, topology, factors and projection are unchanged', () => {
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
    const screened = ask(grid, 'world.electric-grid.contingency.screen', { contingencies: 'all-branches', ratingBasis: 'emergency', limit: 500 })
    expect(screened.screenedCount).toBeGreaterThan(250)
    ask(grid, 'world.electric-grid.contingency.screen', { contingencies: 'largest-generators', largestGeneratorCount: 10 })
    const meshed = screened.results.find((result: any) => !result.islanding && result.contingency.kind === 'branch').contingency.assetId
    const unit = norway.model.generators.find(generator => grid.generators.get(generator.id)!.state === 'online' && grid.generators.get(generator.id)!.dispatchMw > 50)!
    // The largest Oslo load (Grid Model v2 municipality 0301).
    const oslo = [...norway.model.loads].filter(load => load.id.startsWith('load:0301-')).sort((a, b) => b.demandMw - a.demandMw)[0]!
    ask(grid, 'world.electric-grid.remedial-actions.evaluate', {
      contingencies: 'all-branches',
      actions: [
        { kind: 'open-branch', assetId: meshed },
        { kind: 'redispatch', assetId: unit.id, targetMw: grid.generators.get(unit.id)!.dispatchMw - 20 },
        { kind: 'shed-load', assetId: oslo.id, targetDemandMw: (grid.loads.get(oslo.id)!.servedMw + oslo.criticalMw) / 2 },
      ],
    })
    expect(grid.topologyPlan).toBe(plan)
    expect(snapshot()).toBe(before)
  }, 60_000)

  test('reports islanding with each part\'s imbalance, unit outages rebalanced by reserves, and the rating basis', () => {
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(10_000)
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' }).ok).toBe(true)
    run.advanceTo(12_000)
    const normal = ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: 'all-branches', ratingBasis: 'normal' })
    const emergency = ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: 'all-branches', ratingBasis: 'emergency' })
    // The A path runs at 131 % / 125 % of its rating, 109 % / 105 % of its emergency rating, and G–B
    // just above its rating (101 %): the AC losses of the stressed corridor (L at 0.81 pu) add to the transfer.
    expect(normal.baseCase).toMatchObject({ overloadedCount: 3, worstBranch: { assetId: 'branch:g-a' } })
    expect(emergency.baseCase.overloadedCount).toBe(2)
    expect(emergency.baseCase.worstBranch.loadingPercent).toBeCloseTo(normal.baseCase.worstBranch.loadingPercent / 1.2, 0)
    // Losing either A line moves the whole transfer onto the B path; no outage islands the meshed corridor.
    const lossOfA = normal.results.find((result: any) => result.contingency.assetId === 'branch:g-a')
    expect(lossOfA).toMatchObject({ islanding: false, violationCount: 2, worstBranch: { assetId: 'branch:g-b' } })
    expect(lossOfA.worstBranch.loadingPercent).toBeGreaterThan(250)
    expect(normal.islandingCount).toBe(0)
    const units = ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: 'largest-generators', largestGeneratorCount: 2 })
    expect(units.results.map((result: any) => result.contingency.assetId).sort()).toEqual(['generator:g1', 'generator:l1'])
    const lossOfG1 = units.results.find((result: any) => result.contingency.assetId === 'generator:g1')
    expect(lossOfG1.islanding).toBe(false)
    expect(lossOfG1.affectedIslands[0]).toMatchObject({ balancing: 'reserves', unservedLoadMw: 0 })
    expect(lossOfG1.affectedIslands[0].imbalanceMw).toBeCloseTo(-lossOfG1.contingency.lostMw, 0)
    expect(() => ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: 'largest-generators' })).toThrow('largestGeneratorCount is required')
    expect(() => ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: ['branch:g-l'] })).toThrow('not in service')
    expect(() => ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: ['bus:g'] })).toThrow('not a branch or generator')

    // With only the A path left, its lines are bridges: losing one separates L with its own unit;
    // with that unit tripped, L loses supply.
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-b' }).ok).toBe(true)
    const radial = ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: ['branch:a-l'] })
    expect(radial.results[0]).toMatchObject({ islanding: true, unservedLoadMw: 0 })
    for (const part of radial.results[0].affectedIslands) expect(Math.abs(part.imbalanceMw)).toBeCloseTo(Math.abs(radial.results[0].contingency.lostMw), 0)
    expect(run.command('world.electric-grid.trip-generator', { assetId: 'generator:l1' }).ok).toBe(true)
    const dead = ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: ['branch:a-l'] })
    const lostPart = dead.results[0].affectedIslands.find((part: any) => part.balancing === 'de-energised')
    // L and B (still tied to L by b-l) lose supply.
    expect(lostPart.busCount).toBe(2)
    expect(dead.results[0].unservedLoadMw).toBeCloseTo(run.grid.loads.get('load:l')!.servedMw, 0)
  })

  test('remedial actions are evaluated on a private case: before equals the screening, after shows the relief', () => {
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(10_000)
    run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' })
    run.advanceTo(12_000)
    const screened = ask(run.grid, 'world.electric-grid.contingency.screen', { contingencies: 'all-branches' })
    const evaluated = ask(run.grid, 'world.electric-grid.remedial-actions.evaluate', {
      contingencies: 'all-branches',
      actions: [{ kind: 'shed-load', assetId: 'load:l', targetDemandMw: 450 }],
    })
    const { results: _results, gridId: _gridId, revision: _revision, ratingBasis: _ratingBasis, ...summary } = screened
    expect(evaluated.before).toEqual(summary)
    expect(evaluated.before.baseCase.overloadedCount).toBe(3)
    expect(evaluated.after.baseCase.overloadedCount).toBe(0)
    expect(evaluated.after.totalViolations).toBeLessThan(evaluated.before.totalViolations)
    expect(evaluated.actionBalances).toHaveLength(1)
    expect(evaluated.actionBalances[0].imbalanceMw).toBeGreaterThan(0)

    const reconnect = ask(run.grid, 'world.electric-grid.remedial-actions.evaluate', { contingencies: 'all-branches', actions: [{ kind: 'close-branch', assetId: 'branch:g-l' }] })
    expect(reconnect.after.baseCase.overloadedCount).toBe(0)
    expect(() => ask(run.grid, 'world.electric-grid.remedial-actions.evaluate', { contingencies: 'all-branches', actions: [{ kind: 'open-branch', assetId: 'branch:g-l' }] })).toThrow('already open')
    expect(() => ask(run.grid, 'world.electric-grid.remedial-actions.evaluate', {
      contingencies: 'all-branches', actions: [{ kind: 'redispatch', assetId: 'generator:l1', targetMw: 150 }, { kind: 'redispatch', assetId: 'generator:l1', targetMw: 160 }],
    })).toThrow('more than once')
    expect(() => ask(run.grid, 'world.electric-grid.remedial-actions.evaluate', { contingencies: 'all-branches', actions: [{ kind: 'redispatch', assetId: 'generator:l1', targetMw: 900 }] })).toThrow('outside its minimum stable')
  })
})
