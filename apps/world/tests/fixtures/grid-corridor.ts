// A meshed 300 kV corridor for protection and alarm tests: a generator bus G feeds a load bus L
// over a direct line and two two-line paths (via A and via B). Opening the direct line overloads
// the A path above its emergency rating and loads the B path near its rating. Reactances of lines
// of 20–40 km keep the AC flows within 2 % of the DC ones (L's unit holds its voltage); twice
// these, the A path's reactive losses take L to 0.8 pu and its relays trip at once.
import type { ActorId, CommandId, IsoTimestamp, ObjectId, SimulationRunId } from '../../src/core/model/index.ts'
import type { CompiledGridDefinition, GridBranchDefinition, GridBusDefinition, GridModelDefinition } from '../../src/packs/electric-grid/grid-model.ts'
import { applyGridCommand } from '../../src/packs/electric-grid/runtime/apply-command.ts'
import { drainGridSignals, type GridRuntimeSignal } from '../../src/packs/electric-grid/runtime/grid-signals.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../../src/packs/electric-grid/runtime/solver.ts'
import { gridDefinitionForModel, handBuiltModel, syntheticHydroUnit, testLine, testLoad } from './synthetic-grid.ts'

const bus = (id: string, longitude: number): GridBusDefinition => ({ id, label: id, nominalKv: 300, location: [longitude, 60] })

// Emergency rating 120 % for 15 minutes, as the v2 electrical rule emergency-120pct-15min.
const line = (id: string, fromBusId: string, toBusId: string, reactancePu: number, ratingMw: number): GridBranchDefinition =>
  testLine({ id, fromBusId, toBusId, nominalKv: 300, ratingMw, emergencyRatingMw: ratingMw * 1.2, emergencyDurationSeconds: 900, reactancePu, resistancePu: reactancePu / 20 })

export const corridorModel: GridModelDefinition = handBuiltModel({
  id: 'test-corridor',
  title: 'Test corridor',
  description: 'Meshed corridor for protection tests',
  buses: [bus('bus:g', 8), bus('bus:a', 9), bus('bus:b', 9.5), bus('bus:l', 10)],
  branches: [
    line('branch:g-l', 'bus:g', 'bus:l', 0.05, 600),
    line('branch:g-a', 'bus:g', 'bus:a', 0.025, 460),
    line('branch:a-l', 'bus:a', 'bus:l', 0.025, 470),
    line('branch:g-b', 'bus:g', 'bus:b', 0.05, 300),
    line('branch:b-l', 'bus:b', 'bus:l', 0.05, 300),
  ],
  generators: [
    syntheticHydroUnit({ id: 'generator:g1', label: 'G1', busId: 'bus:g', location: [8, 60], capacityMw: 1400, rampRateMwPerMinute: 300 }),
    syntheticHydroUnit({ id: 'generator:l1', label: 'L1', busId: 'bus:l', location: [10, 60], capacityMw: 400, availableMw: 200, rampRateMwPerMinute: 100 }),
  ],
  loads: [testLoad({ id: 'load:l', label: 'Load L', busId: 'bus:l', location: [10, 60], demandMw: 1000 })],
})

export const corridorDefinition = (): CompiledGridDefinition => gridDefinitionForModel(corridorModel)

const startsAtMs = Date.parse('2026-01-15T10:00:00.000Z')
export const isoAt = (milliseconds: number): IsoTimestamp => new Date(startsAtMs + milliseconds).toISOString() as IsoTimestamp

/** A Grid on its own clock (whole milliseconds), driven like the adapter; queued signals are collected. */
export const steppedGrid = (definition: CompiledGridDefinition) => {
  const grid = createGridRuntimeInstance({ definition, at: isoAt(0) })
  let nowMs = 0
  const signals: GridRuntimeSignal[] = []
  advanceGrid(grid, 0, isoAt(0))
  signals.push(...drainGridSignals(grid))
  return {
    grid,
    signals,
    nowMs: (): number => nowMs,
    /** Advances to `untilMs` in steps from `stepMs` (cycled), never past the end. */
    advanceTo: (untilMs: number, stepMs: ReadonlyArray<number> = [2_000]): void => {
      let index = 0
      while (nowMs < untilMs) {
        const dtMs = Math.min(stepMs[index % stepMs.length]!, untilMs - nowMs)
        index += 1
        nowMs += dtMs
        advanceGrid(grid, dtMs / 1_000, isoAt(nowMs))
        signals.push(...drainGridSignals(grid))
      }
    },
    command: (kind: string, payload: Readonly<Record<string, unknown>>): { readonly ok: boolean; readonly reason?: string } => {
      const result = applyGridCommand(grid, {
        id: `command:${crypto.randomUUID()}` as CommandId,
        simulationRunId: 'run-grid-protection' as SimulationRunId,
        actorId: 'actor:protection-test' as ActorId,
        kind,
        targetObjectIds: [grid.definition.gridId as ObjectId],
        payload,
        issuedAt: isoAt(nowMs),
      })
      if (result.ok) {
        advanceGrid(grid, 0, isoAt(nowMs))
        signals.push(...drainGridSignals(grid))
      }
      return result
    },
  }
}

export type SteppedGrid = ReturnType<typeof steppedGrid>

export const tripSignals = (signals: ReadonlyArray<GridRuntimeSignal>) => signals
  .filter(signal => signal.type === 'electric-grid.protection.tripped')
  .map(signal => ({ assetId: signal.payload.assetId as string, element: signal.payload.element as string, elapsedSeconds: signal.payload.elapsedSeconds as number }))

export const branchState = (grid: GridRuntimeInstance, branchId: string) => grid.branches.get(branchId)!
