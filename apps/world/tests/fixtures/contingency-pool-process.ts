// Run as a child process by electric-grid-contingency-pool.test.ts: the process's N-1 worker pool
// across a server-like lifetime, printed as one JSON line. A fresh process, so no other test's
// screening has started the pool before.
import type { IsoTimestamp } from '../../src/core/model/index.ts'
import { answerElectricGridQuery } from '../../src/packs/electric-grid/queries/index.ts'
import { processContingencyPool, processContingencyPoolStatus } from '../../src/packs/electric-grid/runtime/contingency-pool.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../../src/packs/electric-grid/runtime/solver.ts'
import { gridAutomationSchema } from '../../src/packs/electric-grid/schemas/grid-automation.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../../src/packs/electric-grid/sim/adapter.ts'
import { corridorDefinition, steppedGrid } from './grid-corridor.ts'
import { syntheticGridDefinition } from './synthetic-grid.ts'

const screen = async (grid: GridRuntimeInstance): Promise<unknown> => await answerElectricGridQuery({
  request: { capabilityId: 'world.electric-grid.contingency.screen', input: { gridId: grid.definition.gridId, contingencies: 'all-branches' } },
  grids: new Map([[grid.definition.gridId, grid]]),
})

/** The pool as grid.summary reports it in its diagnostics. */
const summaryPool = (grid: GridRuntimeInstance): unknown => (answerElectricGridQuery({
  request: { capabilityId: 'world.electric-grid.grid.summary', input: { gridId: grid.definition.gridId } },
  grids: new Map([[grid.definition.gridId, grid]]),
}) as { diagnostics: { contingencyWorkerPool: unknown } }).diagnostics.contingencyWorkerPool

createLocalElectricGridPackRuntimeAdapter()
const atStart = processContingencyPoolStatus()

const corridor = steppedGrid(corridorDefinition())
corridor.advanceTo(10_000)
const summaryAtStart = summaryPool(corridor.grid)
await screen(corridor.grid)
const afterSmall = processContingencyPool().liveWorkerCount()

// The synthetic grid intact: with branch relays its random dispatch would trip part of it at once.
const base = syntheticGridDefinition(2_000)
const definition = { ...base, automation: gridAutomationSchema.parse({ ...base.automation, branchProtection: { enabled: false } }) }
const at = '2026-01-15T07:00:00.000Z' as IsoTimestamp
const large = createGridRuntimeInstance({ definition, at })
advanceGrid(large, 0, at)
await screen(large)
const afterLarge = processContingencyPool().liveWorkerCount()
const summaryAfterLarge = summaryPool(large)

// Polled with a generous deadline: a loaded machine may run the idle timer late, never early.
const idleFrom = performance.now()
while (processContingencyPool().liveWorkerCount() > 0 && performance.now() - idleFrom < 10_000) await Bun.sleep(10)
const afterIdle = processContingencyPool().liveWorkerCount()

console.log(JSON.stringify({
  poolAtStart: atStart,
  summaryPoolAtStart: summaryAtStart,
  workersAfterSmall: afterSmall,
  workersAfterLarge: afterLarge,
  summaryPoolAfterLarge: summaryAfterLarge,
  workersAfterIdle: afterIdle,
}))
