import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import type { CompiledGridDefinition, GridBranchDefinition, GridModelDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { compileGridNetwork } from '../src/packs/electric-grid/runtime/network/compiled-network.ts'
import { createGridIslandSystem, gridBranchFlowMw, gridBranchFlowsMwInto } from '../src/packs/electric-grid/runtime/network/dc-power-flow.ts'
import { findGridIslands } from '../src/packs/electric-grid/runtime/network/islands.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { solveGridAngles, topologyPlanForGrid } from '../src/packs/electric-grid/runtime/topology.ts'
import { costsInReferences, referenceQuietMs } from './cpu-cost.ts'
import { gridDefinitionForModel, syntheticGridDefinition } from './fixtures/synthetic-grid.ts'

const at = '2026-01-01T10:00:00.000Z' as IsoTimestamp

const line = (id: string, fromBusId: string, toBusId: string, reactancePu: number): GridBranchDefinition => ({
  id, label: id, kind: 'ac_line', fromBusId, toBusId, nominalKv: 420, lengthKm: 50, circuits: 1, ratingMw: 2_000, emergencyRatingMw: 2_400,
  emergencyDurationSeconds: 900, reactancePu, resistancePu: 0.001, chargingSusceptancePu: 0,
})

/** System base of the hand-built and synthetic models: the conventional 100 MVA transmission study base. */
const sBaseMva = 100

const handModel = (id: string, busIds: ReadonlyArray<string>, branches: ReadonlyArray<GridBranchDefinition>): GridModelDefinition => ({
  id, title: id, description: 'Hand-built network test model', nominalFrequencyHz: 50, sBaseMva,
  fidelity: { powerFlow: 'dc', voltage: 'not-modelled', frequency: 'island-swing', recommendedMaximumBusCount: 1000 },
  sourceBuild: { id: 'network-test', generatedAt: '2026-10-10T00:00:00.000Z' },
  sourceIds: [],
  buses: busIds.map((busId, index) => ({ id: busId, label: busId, nominalKv: 420, location: [10 + index * 0.1, 60] as const })),
  branches,
  shunts: [], generators: [], loads: [], storage: [], connectionPoints: [], externalSystems: [], hvdcLinks: [],
})

const gridFor = (definition: CompiledGridDefinition): GridRuntimeInstance => createGridRuntimeInstance({ definition, at })

const norwayDefinition = (): CompiledGridDefinition => compileGridDefinition(gridDefinitionSchema.parse({
  id: 'grid:norway',
  model: { ref: 'electric-grid.norway.transmission' },
  operatingPoint: { ref: 'electric-grid.norway.winter-weekday-peak' },
  automation: { ref: 'electric-grid.frequency.nordic-2025' },
}))

const injectionsOf = (grid: GridRuntimeInstance): ReadonlyMap<string, number> =>
  new Map([...grid.busStates].map(([busId, state]) => [busId, state.netInjectionMw]))

const isClosed = (grid: GridRuntimeInstance) => (branch: GridBranchDefinition): boolean => grid.branches.get(branch.id)!.state === 'closed'

/**
 * The previous dense solver, kept here only as a reference: breadth-first islands rooted at
 * each island's first bus in model order, that bus dropped as reference, a dense Cholesky of
 * the reduced susceptance matrix. Angles come out in the legacy θ·S_base unit (B⁻¹·P, P in MW).
 */
const denseReferenceAngles = (
  model: GridModelDefinition,
  closed: (branch: GridBranchDefinition) => boolean,
  injections: ReadonlyMap<string, number>,
): Map<string, number> => {
  const adjacency = new Map(model.buses.map(bus => [bus.id, new Set<string>()]))
  for (const branch of model.branches.filter(closed)) {
    adjacency.get(branch.fromBusId)!.add(branch.toBusId)
    adjacency.get(branch.toBusId)!.add(branch.fromBusId)
  }
  const seen = new Set<string>()
  const angles = new Map<string, number>()
  for (const root of model.buses) {
    if (seen.has(root.id)) continue
    const order = [root.id]
    seen.add(root.id)
    for (let head = 0; head < order.length; head += 1) {
      for (const next of adjacency.get(order[head]!)!) {
        if (seen.has(next)) continue
        seen.add(next)
        order.push(next)
      }
    }
    const reduced = order.slice(1)
    const position = new Map(reduced.map((busId, index) => [busId, index]))
    const matrix = reduced.map(() => reduced.map(() => 0))
    const members = new Set(order)
    for (const branch of model.branches) {
      if (!closed(branch) || !members.has(branch.fromBusId)) continue
      const susceptance = 1 / branch.reactancePu
      const i = position.get(branch.fromBusId)
      const j = position.get(branch.toBusId)
      if (i !== undefined) matrix[i]![i]! += susceptance
      if (j !== undefined) matrix[j]![j]! += susceptance
      if (i !== undefined && j !== undefined) {
        matrix[i]![j]! -= susceptance
        matrix[j]![i]! -= susceptance
      }
    }
    const lower = reduced.map(() => reduced.map(() => 0))
    for (let row = 0; row < reduced.length; row += 1) {
      for (let column = 0; column <= row; column += 1) {
        let value = matrix[row]![column]!
        for (let k = 0; k < column; k += 1) value -= lower[row]![k]! * lower[column]![k]!
        lower[row]![column] = row === column ? Math.sqrt(value) : value / lower[column]![column]!
      }
    }
    const forward = reduced.map(busId => injections.get(busId)!)
    for (let row = 0; row < reduced.length; row += 1) {
      for (let column = 0; column < row; column += 1) forward[row]! -= lower[row]![column]! * forward[column]!
      forward[row]! /= lower[row]![row]!
    }
    for (let row = reduced.length - 1; row >= 0; row -= 1) {
      for (let column = row + 1; column < reduced.length; column += 1) forward[row]! -= lower[column]![row]! * forward[column]!
      forward[row]! /= lower[row]![row]!
    }
    angles.set(order[0]!, 0)
    reduced.forEach((busId, index) => angles.set(busId, forward[index]!))
  }
  return angles
}

const denseReferenceFlowsMw = (model: GridModelDefinition, closed: (branch: GridBranchDefinition) => boolean, injections: ReadonlyMap<string, number>): ReadonlyArray<number> => {
  const angles = denseReferenceAngles(model, closed, injections)
  return model.branches.map(branch => closed(branch) ? (angles.get(branch.fromBusId)! - angles.get(branch.toBusId)!) / branch.reactancePu : 0)
}

const maximumDifference = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number =>
  a.reduce((worst, value, index) => Math.max(worst, Math.abs(value - b[index]!)), 0)

/** Injection minus net branch outflow per bus, from the runtime's solved flows. */
const kclResidualsMw = (grid: GridRuntimeInstance): Map<string, number> => {
  const residuals = new Map([...grid.busStates].map(([busId, state]) => [busId, state.netInjectionMw]))
  for (const branch of grid.definition.model.branches) {
    const flowMw = grid.branches.get(branch.id)!.flowMw
    residuals.set(branch.fromBusId, residuals.get(branch.fromBusId)! - flowMw)
    residuals.set(branch.toBusId, residuals.get(branch.toBusId)! + flowMw)
  }
  return residuals
}

describe('electric-grid sparse network core', () => {
  test('solves an analytic three-bus DC case exactly, in radians, with the first bus as reference', () => {
    // Reference bus:c comes first in model order; island ids name the lowest bus id.
    const model = handModel('three-bus', ['bus:c', 'bus:a', 'bus:b'], [
      line('c-a', 'bus:c', 'bus:a', 0.1),
      line('a-b', 'bus:a', 'bus:b', 0.2),
      line('c-b', 'bus:c', 'bus:b', 0.2),
    ])
    const grid = gridFor(gridDefinitionForModel(model))
    const plan = topologyPlanForGrid(grid)
    expect(plan.islands.map(island => [island.id, island.referenceBusId])).toEqual([['island:bus:a', 'bus:c']])
    // B_reduced = [[15, -5], [-5, 10]] pu, P = [-1, 0.5] pu on 100 MVA: θ_a = -0.06 rad, θ_b = 0.02 rad.
    const balanced = new Map([['bus:c', 50], ['bus:a', -100], ['bus:b', 50]])
    const angles = solveGridAngles(plan, balanced)
    expect(angles.get('bus:c')).toBe(0)
    expect(Math.abs(angles.get('bus:a')! + 0.06)).toBeLessThan(1e-15)
    expect(Math.abs(angles.get('bus:b')! - 0.02)).toBeLessThan(1e-15)
    const flows = model.branches.map(branch => gridBranchFlowMw(angles, branch, sBaseMva))
    expect(maximumDifference(flows, [60, -40, -10])).toBeLessThan(1e-9)
    expect(plan.referenceMismatchMw[0]).toBeCloseTo(0, 12)
    // An unbalanced island: the reference bus absorbs the whole mismatch and the flows do not change.
    const unbalanced = new Map([['bus:c', 0], ['bus:a', -100], ['bus:b', 50]])
    const unbalancedFlows = model.branches.map(branch => gridBranchFlowMw(solveGridAngles(plan, unbalanced), branch, sBaseMva))
    expect(maximumDifference(unbalancedFlows, [60, -40, -10])).toBeLessThan(1e-9)
    expect(plan.referenceMismatchMw[0]).toBeCloseTo(-50, 12)
  })

  test('splits a transfer across parallel circuits in inverse proportion to reactance', () => {
    const model = handModel('parallel', ['bus:a', 'bus:b', 'bus:c'], [
      line('a-b-1', 'bus:a', 'bus:b', 0.1),
      line('a-b-2', 'bus:a', 'bus:b', 0.3),
      line('b-c', 'bus:b', 'bus:c', 0.05),
      line('c-b', 'bus:c', 'bus:b', 0.05),
    ])
    const grid = gridFor(gridDefinitionForModel(model))
    const plan = topologyPlanForGrid(grid)
    const angles = solveGridAngles(plan, new Map([['bus:a', 100], ['bus:b', 0], ['bus:c', -100]]))
    // 1/(10 + 10/3) pu: θ_b = -0.075 rad; the c side is two equal 0.05 pu circuits (40 pu).
    expect(Math.abs(angles.get('bus:b')! + 0.075)).toBeLessThan(1e-15)
    expect(Math.abs(angles.get('bus:c')! + 0.1)).toBeLessThan(1e-15)
    const flows = model.branches.map(branch => gridBranchFlowMw(angles, branch, sBaseMva))
    expect(maximumDifference(flows, [75, 25, 50, -50])).toBeLessThan(1e-9)
    const indexed = new Float64Array(model.branches.length)
    gridBranchFlowsMwInto(plan.network, plan.closedBranches, plan.anglesRad, indexed)
    expect(maximumDifference([...indexed], flows)).toBeLessThan(1e-12)
  })

  test('matches the previous dense solver on the Norway model to 1e-11 of the largest flow with bus angles in radians, before and after switching', () => {
    const definition = norwayDefinition()
    const grid = gridFor(definition)
    const check = (): void => {
      advanceGrid(grid, 2, at)
      const injections = injectionsOf(grid)
      const dense = denseReferenceFlowsMw(definition.model, isClosed(grid), injections)
      const runtimeFlows = definition.model.branches.map(branch => grid.branches.get(branch.id)!.flowMw)
      // Round-off of two factorisations of a 1,000-bus matrix: relative to the largest flow.
      const tolerance = 1e-11 * Math.max(...dense.map(Math.abs))
      expect(maximumDifference(runtimeFlows, dense)).toBeLessThan(tolerance)
      const plan = topologyPlanForGrid(grid)
      const angles = solveGridAngles(plan, injections)
      const radianFlows = definition.model.branches.map(branch => isClosed(grid)(branch) ? gridBranchFlowMw(angles, branch, sBaseMva) : 0)
      expect(maximumDifference(radianFlows, dense)).toBeLessThan(tolerance)
      const denseAngles = denseReferenceAngles(definition.model, isClosed(grid), injections)
      const angleTolerance = 1e-10 * Math.max(...[...denseAngles.values()].map(value => Math.abs(value / sBaseMva)))
      for (const [busId, angle] of angles) {
        expect(Math.abs(angle - denseAngles.get(busId)! / sBaseMva)).toBeLessThan(angleTolerance)
        expect(Math.abs(grid.busStates.get(busId)!.angleRad - angle)).toBeLessThan(1e-15)
      }
    }
    check()
    definition.model.branches.forEach((branch, index) => { if (index % 9 === 4) grid.branches.get(branch.id)!.state = 'open' })
    check()
    expect(grid.diagnostics.topologyRebuildCount).toBe(2)
  })

  test('closes KCL at every bus to 1e-9 MW; the reference bus absorbs no component mismatch', () => {
    const definition = norwayDefinition()
    const grid = gridFor(definition)
    advanceGrid(grid, 0, at)
    const plan = topologyPlanForGrid(grid)
    const residuals = kclResidualsMw(grid)
    plan.components.forEach((component, index) => {
      for (const busId of component.buses) {
        if (busId === component.referenceBusId) expect(Math.abs(residuals.get(busId)! - plan.referenceMismatchMw[index]!)).toBeLessThan(1e-9)
        else expect(Math.abs(residuals.get(busId)!)).toBeLessThan(1e-9)
      }
    })
    // Island balance closes by construction (inertial and governor sharing): the references absorb nothing.
    expect(Math.max(...[...plan.referenceMismatchMw].map(Math.abs))).toBeLessThan(1e-6)
  })

  test('detects the islands left by opening a bridge, and reuses island factors when it closes again', () => {
    const model = handModel('two-triangles', ['bus:d', 'bus:e', 'bus:f', 'bus:a', 'bus:b', 'bus:c'], [
      line('d-e', 'bus:d', 'bus:e', 0.1), line('e-f', 'bus:e', 'bus:f', 0.1), line('f-d', 'bus:f', 'bus:d', 0.1),
      line('a-b', 'bus:a', 'bus:b', 0.1), line('b-c', 'bus:b', 'bus:c', 0.1), line('c-a', 'bus:c', 'bus:a', 0.1),
      line('bridge', 'bus:f', 'bus:a', 0.2),
    ])
    const grid = gridFor(gridDefinitionForModel(model))
    const injections = new Map([['bus:d', 120], ['bus:e', 0], ['bus:f', -20], ['bus:a', -30], ['bus:b', -50], ['bus:c', 0]])
    const whole = topologyPlanForGrid(grid)
    expect(whole.islands.map(island => island.id)).toEqual(['island:bus:a'])
    const bridgeFlow = gridBranchFlowMw(solveGridAngles(whole, injections), model.branches[6]!, sBaseMva)
    expect(bridgeFlow).toBeCloseTo(80, 9)

    grid.branches.get('bridge')!.state = 'open'
    const split = topologyPlanForGrid(grid)
    expect(split.islands.map(island => [island.id, island.referenceBusId, island.buses])).toEqual([
      ['island:bus:d', 'bus:d', ['bus:d', 'bus:e', 'bus:f']],
      ['island:bus:a', 'bus:a', ['bus:a', 'bus:b', 'bus:c']],
    ])
    expect(split.islandIdByBus.get('bus:f')).toBe('island:bus:d')
    expect(split.islands[1]!.branches.map(branch => branch.id)).toEqual(['a-b', 'b-c', 'c-a'])
    solveGridAngles(split, injections)
    expect([...split.referenceMismatchMw]).toEqual([100, -80])

    grid.branches.get('bridge')!.state = 'closed'
    grid.topologyPlan = null
    const rejoined = topologyPlanForGrid(grid)
    expect(rejoined).not.toBe(whole)
    expect(rejoined.islands).toEqual(whole.islands)
    expect(rejoined.systems[0]).toBe(whole.systems[0]!)
    expect(topologyPlanForGrid(grid)).toBe(rejoined)
    expect(grid.diagnostics.topologyRebuildCount).toBe(3)
  })

  test('isolates a radial Norway bus as its own island when its only branch opens', () => {
    const definition = norwayDefinition()
    // A Norwegian leaf: a boundary bus stays with the Nordic equivalent when its tie opens.
    const leaf = definition.model.buses.find(bus => !bus.id.startsWith('bus:boundary-') && definition.index.branchesByBus.get(bus.id)?.length === 1
      && definition.index.branchesByBus.get(bus.id)!.every(branch => definition.index.branchesByBus.get(branch.fromBusId === bus.id ? branch.toBusId : branch.fromBusId)!.length > 1))!
    const grid = gridFor(definition)
    advanceGrid(grid, 0, at)
    const before = topologyPlanForGrid(grid).islands.length
    const branch = definition.index.branchesByBus.get(leaf.id)![0]!
    const neighbour = branch.fromBusId === leaf.id ? branch.toBusId : branch.fromBusId
    const parentId = grid.busStates.get(leaf.id)!.islandId
    grid.branches.get(branch.id)!.state = 'open'
    advanceGrid(grid, 2, at)
    const plan = topologyPlanForGrid(grid)
    expect(plan.islands.length).toBe(before + 1)
    const index = plan.islands.findIndex(island => island.buses.length === 1 && island.buses[0] === leaf.id)
    expect(plan.islands[index]!.id).toBe(`island:${leaf.id}`)
    // Stable identity: the larger part keeps the parent's id; the separated bus is a new island.
    expect(grid.busStates.get(neighbour)!.islandId).toBe(parentId)
    expect(grid.busStates.get(leaf.id)!.islandId).not.toBe(parentId)
    expect(plan.referenceMismatchMw[plan.componentIndexOfBus[plan.network.busIndexById.get(leaf.id)!]!]).toBe(grid.busStates.get(leaf.id)!.netInjectionMw)
  })

  test('throws naming the island and bus when the susceptance matrix is not positive definite', () => {
    // A negative reactance (no Model allows one) makes the reduced matrix indefinite.
    const network = compileGridNetwork(handModel('indefinite', ['bus:x', 'bus:y', 'bus:z'], [
      line('x-y', 'bus:x', 'bus:y', 0.1),
      line('y-z', 'bus:y', 'bus:z', -0.1),
    ]))
    const islands = findGridIslands(network, new Uint8Array([1, 1]))
    expect(() => createGridIslandSystem({
      network, islandId: 'island:bus:x', buses: islands.busOrder, branches: islands.branchOrder, localOfBus: new Int32Array(network.busCount),
    })).toThrow(/^Grid island island:bus:x susceptance matrix is not positive definite: pivot -?\d[^ ]* at bus bus:[yz]$/)
  })

  test('rejects a solve with a missing or non-finite bus injection', () => {
    const model = handModel('two-bus', ['bus:a', 'bus:b'], [line('a-b', 'bus:a', 'bus:b', 0.1)])
    const plan = topologyPlanForGrid(gridFor(gridDefinitionForModel(model)))
    expect(() => solveGridAngles(plan, new Map([['bus:a', 10]]))).toThrow('Grid bus bus:b has no finite injection: undefined')
    expect(() => solveGridAngles(plan, new Map([['bus:a', 10], ['bus:b', Number.NaN]]))).toThrow('Grid bus bus:b has no finite injection: NaN')
  })

  test('closes KCL on a synthetic 1k-bus grid to 1e-12 of the largest flow', () => {
    const grid = gridFor(syntheticGridDefinition(1_000))
    advanceGrid(grid, 0, at)
    const plan = topologyPlanForGrid(grid)
    const references = new Set(plan.islands.map(island => island.referenceBusId))
    const largestFlowMw = Math.max(...[...grid.branches.values()].map(state => Math.abs(state.flowMw)))
    const worst = Math.max(...[...kclResidualsMw(grid)].filter(([busId]) => !references.has(busId)).map(([, residual]) => Math.abs(residual)))
    expect(worst / largestFlowMw).toBeLessThan(1e-12)
  })

  // Costs are main-thread CPU time in reference computations timed
  // immediately before each run, the median of five (cpu-cost.ts): wall time
  // measures a loaded shared machine, not the solver. The gates keep a 3x
  // margin over 50 ms and 5 ms on a quiet machine.
  test('rebuilds a 10k-bus synthetic topology within 50 ms and solves it within 5 ms quiet (3x margin)', () => {
    const busCount = 10_000
    const definition = syntheticGridDefinition(busCount)
    const grid = gridFor(definition)
    const plan = topologyPlanForGrid(grid)
    expect(plan.islands.length).toBe(1)
    for (let run = 0; run < 20; run += 1) expect(topologyPlanForGrid(grid)).toBe(plan)
    const injections = new Map(definition.model.buses.map((bus, index) => [bus.id, ((index * 7919) % 401) - 200]))
    const [solveCost] = costsInReferences([() => solveGridAngles(plan, injections)], 5)
    // The first busCount - 1 branches are the fixture's spanning tree; opening a meshing branch keeps one island.
    const rebuiltIslands: number[] = []
    const rebuild = (): void => {
      grid.branches.get(definition.model.branches[busCount + 500 * rebuiltIslands.length]!.id)!.state = 'open'
      rebuiltIslands.push(topologyPlanForGrid(grid).islands.length)
    }
    const [rebuildCost] = costsInReferences([rebuild], 5)
    expect(rebuiltIslands).toEqual([1, 1, 1, 1, 1])
    const nnz = plan.systems[0]!.factor.structure.rowIndex.length
    console.log(`10k synthetic: rebuild ${(rebuildCost! * referenceQuietMs).toFixed(1)} ms quiet, solve ${(solveCost! * referenceQuietMs).toFixed(2)} ms quiet, nnz(L) ${nnz}`)
    expect(rebuildCost).toBeLessThan(3 * 50 / referenceQuietMs)
    expect(solveCost).toBeLessThan(3 * 5 / referenceQuietMs)
    expect(nnz).toBeLessThan(8 * busCount)
  })
})
