import { describe, expect, test } from 'bun:test'
import { gridCloseBranchCommandKind, gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridDispatchGeneratorCommandKind, gridStartGeneratorCommandKind } from '../src/packs/electric-grid/commands/generator.ts'
import { gridRestoreLoadCommandKind, gridShedLoadCommandKind } from '../src/packs/electric-grid/commands/load.ts'
import type { GridGeneratorDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { steppedGrid, type SteppedGrid } from './fixtures/grid-corridor.ts'
import { restorationDefinition, restorationFeederIds } from './fixtures/grid-restoration.ts'

const islandOf = (run: SteppedGrid, busId: string) => run.grid.islandPlan!.islands.find(island => island.id === run.grid.busStates.get(busId)!.islandId)!

describe('electric grid restoration', () => {
  test('only a black-start capable unit starts in a dead island; any unit starts once a neighbour energises it by dead-bus closing', () => {
    const run = steppedGrid(restorationDefinition())
    run.advanceTo(10_000)
    expect(islandOf(run, 'bus:r1').energized).toBe(false)
    const refused = run.command(gridStartGeneratorCommandKind, { assetId: 'generator:follower' })
    expect(refused.reason).toContain('is not black-start capable, and its island')
    expect(refused.reason).toContain('start a black-start capable unit in it (generator:black-start)')
    expect(run.grid.generators.get('generator:follower')!.state).toBe('offline')

    expect(run.command(gridCloseBranchCommandKind, { assetId: 'branch:tie' }).ok).toBe(true)
    expect(islandOf(run, 'bus:r1').energized).toBe(true)
    expect(run.command(gridStartGeneratorCommandKind, { assetId: 'generator:follower' }).ok).toBe(true)
  })

  test('a unit whose island loses supply during its start-up cannot synchronise onto the dead bus', () => {
    const run = steppedGrid(restorationDefinition())
    run.advanceTo(10_000)
    run.command(gridCloseBranchCommandKind, { assetId: 'branch:tie' })
    expect(run.command(gridStartGeneratorCommandKind, { assetId: 'generator:follower' }).ok).toBe(true)
    run.advanceTo(60_000)
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:tie' }).ok).toBe(true)
    expect(islandOf(run, 'bus:r1').energized).toBe(false)
    run.advanceTo(400_000)
    expect(run.grid.generators.get('generator:follower')!.state).toBe('offline')
    expect(islandOf(run, 'bus:r1').energized).toBe(false)
    expect(run.signals.filter(signal => signal.type === 'electric-grid.generator.start-aborted').map(signal => signal.payload.assetId)).toEqual(['generator:follower'])
  })

  test('restoration: a black-start unit energises the dead island and picks up its feeders in blocks without LFDD', () => {
    const run = steppedGrid(restorationDefinition())
    run.advanceTo(10_000)
    // The dead island's feeders are disconnected before energisation; only the base feeder stays on for the unit's minimum load.
    for (const feederId of restorationFeederIds) {
      expect(run.command(gridShedLoadCommandKind, { assetId: feederId, targetDemandMw: 0 }).reason).toContain('set emergency')
      expect(run.command(gridShedLoadCommandKind, { assetId: feederId, targetDemandMw: 0, emergency: true }).ok).toBe(true)
    }
    const unit: GridGeneratorDefinition = restorationDefinition().model.generators.find(generator => generator.id === 'generator:black-start')!
    expect(run.command(gridStartGeneratorCommandKind, { assetId: unit.id }).ok).toBe(true)
    let lowestHz = Number.POSITIVE_INFINITY
    let highestHz = 0
    const follow = (untilMs: number): void => {
      while (run.nowMs() < untilMs) {
        run.advanceTo(run.nowMs() + 1_000, [1_000])
        const island = islandOf(run, 'bus:r2')
        if (!island.energized) continue
        lowestHz = Math.min(lowestHz, island.minimumHz!)
        highestHz = Math.max(highestHz, island.maximumHz!)
      }
    }
    follow(320_000)
    // Synchronised after the 300 s hydro start-up; the energised island holds the unit's droop and headroom as reserve.
    const state = run.grid.generators.get(unit.id)!
    expect(state.state).toBe('online')
    expect(islandOf(run, 'bus:r2').energized).toBe(true)
    expect(state.reserves.fcrDUpMw).toBeGreaterThan(0)
    expect(state.reserves.afrrUpMw).toBeGreaterThan(0)
    // The operator raises the set-point with each 15 MW feeder it reconnects, three minutes apart.
    expect(run.command(gridDispatchGeneratorCommandKind, { assetId: unit.id, targetMw: run.grid.loads.get('load:r-base')!.demandMw + 0.3 }).ok).toBe(true)
    for (const feederId of restorationFeederIds) {
      expect(run.command(gridDispatchGeneratorCommandKind, { assetId: unit.id, targetMw: state.targetMw + run.grid.loads.get(feederId)!.demandMw }).ok).toBe(true)
      expect(run.command(gridRestoreLoadCommandKind, { assetId: feederId }).ok).toBe(true)
      follow(run.nowMs() + 180_000)
    }
    const island = islandOf(run, 'bus:r2')
    console.info(`restoration: frequency ${lowestHz.toFixed(3)}–${highestHz.toFixed(3)} Hz over six 15 MW blocks; unit at ${state.dispatchMw.toFixed(1)} MW; f ${island.frequency!.frequencyHz!.toFixed(3)} Hz`)
    expect(run.grid.frequencyEvents.filter(event => event.kind === 'lfdd-stage-operated')).toEqual([])
    expect(lowestHz).toBeGreaterThan(49.3)
    expect(highestHz).toBeLessThan(50.5)
    expect(Math.abs(island.frequency!.frequencyHz! - 50)).toBeLessThan(0.1)
    for (const loadId of ['load:r-base', ...restorationFeederIds]) {
      const service = run.grid.loads.get(loadId)!
      expect(service).toMatchObject({ lfddShedMw: 0, curtailedMw: 0, outageMw: 0 })
    }
    // With the island live, the unit that is not black-start capable may now start.
    expect(run.command(gridStartGeneratorCommandKind, { assetId: 'generator:follower' }).ok).toBe(true)
  }, 120_000)
})
