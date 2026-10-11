import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { gridCloseBranchCommandKind, gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { nordicFrequencyAutomationRef, norwayGridModelRef, norwayWinterPeakOperatingPointRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import type { CompiledGridDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { applyGridCommand } from '../src/packs/electric-grid/runtime/apply-command.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { costsInReferences, referenceComputation, referenceQuietMs, threadCpuMs } from './cpu-cost.ts'
import { syntheticGridDefinition } from './fixtures/synthetic-grid.ts'

// Tick costs of a running Grid with branch relays (two network solutions and twenty frequency
// sub-steps per 2 s tick), in reference computations timed alongside (cpu-cost.ts). Steady ticks are
// measured after the first demand sample: from then on frequency control moves the units every
// tick and the AC load flow re-converges each solve (5 to 7 FDLF iterations on the 10k grid, 1 to 3
// on Norway). Quiet-machine costs at the time of writing: Norway v2 winter peak 1.8 ms, the 10k-bus
// fixture 11 ms per steady tick, 20 ms for an open-branch command with its zero-length tick on the
// 10k grid. The gates keep a 2.5x margin: they catch a regression of the per-tick bookkeeping, not
// machine load.

const startMs = Date.parse('2026-01-15T10:00:00.000Z')
const isoAt = (seconds: number): IsoTimestamp => new Date(startMs + seconds * 1_000).toISOString() as IsoTimestamp
const margin = 2.5

const norwayDefinition = (): CompiledGridDefinition => compileGridDefinition({
  id: 'grid:tick-cost-norway',
  model: { ref: norwayGridModelRef },
  operatingPoint: { ref: norwayWinterPeakOperatingPointRef },
  automation: { ref: nordicFrequencyAutomationRef },
})

/** A Grid driven like the adapter: 2 s ticks, a command followed by a zero-length tick. */
const runningGrid = (definition: CompiledGridDefinition) => {
  const grid = createGridRuntimeInstance({ definition, at: isoAt(0) })
  let seconds = 0
  advanceGrid(grid, 0, isoAt(seconds))
  const tick = (): void => {
    seconds += 2
    advanceGrid(grid, 2, isoAt(seconds))
  }
  const command = (kind: string, assetId: string): void => {
    const result = applyGridCommand(grid, {
      id: `command:${crypto.randomUUID()}` as CommandId,
      simulationRunId: 'run:grid-tick-cost' as SimulationRunId,
      actorId: 'actor:grid-tick-cost-test' as ActorId,
      kind,
      targetObjectIds: [grid.definition.gridId as ObjectId],
      payload: { assetId },
      issuedAt: isoAt(seconds),
    } satisfies CommandEnvelope)
    if (!result.ok) throw new Error(result.reason)
    advanceGrid(grid, 0, isoAt(seconds))
  }
  return { grid, tick, command }
}

/** Map and Set constructions while `run` runs: the global constructors are wrapped and restored. */
const mapAndSetConstructions = (run: () => void): { readonly maps: number; readonly sets: number } => {
  const globals = globalThis as { Map: MapConstructor; Set: SetConstructor }
  const { Map: OriginalMap, Set: OriginalSet } = globals
  let maps = 0
  let sets = 0
  globals.Map = new Proxy(OriginalMap, { construct: (target, args, newTarget) => { maps += 1; return Reflect.construct(target, args, newTarget) } })
  globals.Set = new Proxy(OriginalSet, { construct: (target, args, newTarget) => { sets += 1; return Reflect.construct(target, args, newTarget) } })
  try {
    run()
  } finally {
    globals.Map = OriginalMap
    globals.Set = OriginalSet
  }
  return { maps, sets }
}

const steadyTicks = (grid: GridRuntimeInstance, tick: () => void, count: number): void => {
  for (let index = 0; index < count; index += 1) tick()
  expect(grid.islandPlan!.islands.filter(island => island.energized).length).toBeGreaterThan(0)
}

describe('electric grid tick cost', () => {
  test('a steady tick creates no Map or Set, over two minutes of ticks with demand samples and dispatch (Norway, 10k)', () => {
    for (const definition of [norwayDefinition(), syntheticGridDefinition(10_000)]) {
      const { grid, tick } = runningGrid(definition)
      steadyTicks(grid, tick, 20)
      expect(mapAndSetConstructions(() => steadyTicks(grid, tick, 60))).toEqual({ maps: 0, sets: 0 })
    }
  }, 120_000)

  test(`a steady 2 s tick costs within ${margin}x of 1.8 ms quiet on Norway and 11 ms on the 10k grid`, () => {
    const budgets = [{ definition: norwayDefinition(), quietMs: 1.8 }, { definition: syntheticGridDefinition(10_000), quietMs: 11 }]
    for (const { definition, quietMs } of budgets) {
      const { grid, tick } = runningGrid(definition)
      steadyTicks(grid, tick, 40)
      const [cost] = costsInReferences([tick], 15)
      console.log(`${definition.model.id}: steady 2 s tick ${(cost! * referenceQuietMs).toFixed(2)} ms quiet`)
      expect(cost).toBeLessThan(margin * quietMs / referenceQuietMs)
    }
  }, 120_000)

  test(`an open-branch command with its zero-length tick costs within ${margin}x of 20 ms quiet on the 10k grid`, () => {
    const busCount = 10_000
    const definition = syntheticGridDefinition(busCount)
    const { grid, tick, command } = runningGrid(definition)
    steadyTicks(grid, tick, 5)
    const ratios: number[] = []
    for (let round = 0; round < 9; round += 1) {
      // The first busCount - 1 branches are the fixture's spanning tree; opening a meshing branch keeps one island.
      const branchId = definition.model.branches[busCount + 400 * round]!.id
      const referenceMs = threadCpuMs(referenceComputation)
      ratios.push(threadCpuMs(() => command(gridOpenBranchCommandKind, branchId)) / referenceMs)
      expect(grid.islandPlan!.islands.length).toBe(1)
      tick()
      command(gridCloseBranchCommandKind, branchId)
      tick()
    }
    const cost = [...ratios].sort((a, b) => a - b)[Math.floor(ratios.length / 2)]!
    console.log(`${definition.model.id}: open-branch command + zero-length tick ${(cost * referenceQuietMs).toFixed(1)} ms quiet`)
    expect(cost).toBeLessThan(margin * 20 / referenceQuietMs)
  }, 120_000)
})
