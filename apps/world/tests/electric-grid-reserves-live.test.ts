import { describe, expect, test } from 'bun:test'
import { gridDispatchGeneratorCommandKind, gridStartGeneratorCommandKind } from '../src/packs/electric-grid/commands/generator.ts'
import { gridRestoreLoadCommandKind, gridShedLoadCommandKind } from '../src/packs/electric-grid/commands/load.ts'
import { steppedGrid, type SteppedGrid } from './fixtures/grid-corridor.ts'
import { restorationDefinition, restorationFeederIds } from './fixtures/grid-restoration.ts'

// Reserves follow each unit's present room: a black-started island picking up load gains FCR from
// the footroom its unit's rising set-point opens, so a set-point trim is contained by droop.

const islandOf = (run: SteppedGrid, busId: string) => run.grid.islandPlan!.islands.find(island => island.id === run.grid.busStates.get(busId)!.islandId)!

describe('reserves allocated continuously', () => {
  test('a black-started island with load picked up in blocks rides through a ±3 MW trim within ±0.2 Hz', () => {
    const run = steppedGrid(restorationDefinition())
    run.advanceTo(10_000)
    for (const feederId of restorationFeederIds) expect(run.command(gridShedLoadCommandKind, { assetId: feederId, targetDemandMw: 0, emergency: true }).ok).toBe(true)
    const unitId = 'generator:black-start'
    expect(run.command(gridStartGeneratorCommandKind, { assetId: unitId }).ok).toBe(true)
    run.advanceTo(320_000)
    const state = run.grid.generators.get(unitId)!
    expect(state.state).toBe('online')
    // At minimum stable generation the unit has no footroom: no FCR-N and no downward reserve yet.
    expect(state.targetMw).toBe(restorationDefinition().model.generators.find(generator => generator.id === unitId)!.minimumStableMw)
    expect(state.reserves.fcrNMw).toBe(0)
    expect(state.reserves.fcrDDownMw).toBe(0)
    // The operator raises the set-point with each 15 MW feeder it reconnects; the reserve follows.
    expect(run.command(gridDispatchGeneratorCommandKind, { assetId: unitId, targetMw: run.grid.loads.get('load:r-base')!.demandMw }).ok).toBe(true)
    for (const feederId of restorationFeederIds) {
      expect(run.command(gridDispatchGeneratorCommandKind, { assetId: unitId, targetMw: state.targetMw + run.grid.loads.get(feederId)!.demandMw }).ok).toBe(true)
      expect(run.command(gridRestoreLoadCommandKind, { assetId: feederId }).ok).toBe(true)
      run.advanceTo(run.nowMs() + 180_000, [1_000])
    }
    expect(state.reserves.fcrNMw).toBeGreaterThan(0)
    expect(state.reserves.fcrDDownMw).toBeGreaterThan(0)
    for (const trimMw of [3, -3, -3, 3]) {
      expect(run.command(gridDispatchGeneratorCommandKind, { assetId: unitId, targetMw: state.targetMw + trimMw }).ok).toBe(true)
      let lowestHz = Number.POSITIVE_INFINITY
      let highestHz = 0
      for (let second = 0; second < 120; second += 1) {
        run.advanceTo(run.nowMs() + 1_000, [1_000])
        const island = islandOf(run, 'bus:r2')
        lowestHz = Math.min(lowestHz, island.minimumHz!)
        highestHz = Math.max(highestHz, island.maximumHz!)
      }
      console.info(`trim ${trimMw > 0 ? '+' : ''}${trimMw} MW at ${(state.targetMw - trimMw).toFixed(1)} MW: ${lowestHz.toFixed(3)}–${highestHz.toFixed(3)} Hz, FCR-N ${state.reserves.fcrNMw.toFixed(1)} MW`)
      expect(lowestHz).toBeGreaterThan(49.8)
      expect(highestHz).toBeLessThan(50.2)
    }
  }, 120_000)
})
