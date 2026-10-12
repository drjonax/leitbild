import { describe, expect, test } from 'bun:test'
import { gridRestoreLoadCommandKind, gridSetEvChargingDemandCommandKind, gridShedLoadCommandKind } from '../src/packs/electric-grid/commands/load.ts'
import type { GridModelDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { createGridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { gridTablesFor } from '../src/packs/electric-grid/runtime/state/tables.ts'
import { parseElectricGridRuntimeState, restoredGridRuntimeStateFor, runtimeStateForElectricGrids } from '../src/packs/electric-grid/sim/runtime-state.ts'
import { isoAt, steppedGrid, type SteppedGrid } from './fixtures/grid-corridor.ts'
import { declaredDailyProfile, flatDemandProfile, gridDefinitionForModel, handBuiltModel, syntheticHydroUnit, testLine, testLoad } from './fixtures/synthetic-grid.ts'

/** One island: a hydro station and loads of every priority, some with interruptible demand; the chargers draw their EV schedule flat, the rest follow a declared daily profile. */
const curtailmentModel: GridModelDefinition = handBuiltModel({
  id: 'test-curtailment',
  title: 'Test curtailment',
  description: 'Loads with and without interruptible demand',
  buses: [{ id: 'bus:a', label: 'A', kind: 'substation', nominalKv: 132, location: [10, 60] }, { id: 'bus:b', label: 'B', kind: 'substation', nominalKv: 132, location: [10.1, 60] }],
  branches: [testLine({ id: 'branch:a-b', fromBusId: 'bus:a', toBusId: 'bus:b', nominalKv: 132, ratingMw: 600, reactancePu: 0.05, resistancePu: 0.005 })],
  generators: [
    syntheticHydroUnit({ id: 'generator:big', label: 'Big', busId: 'bus:a', location: [10, 60], capacityMw: 250, rampRateMwPerMinute: 250 }),
    ...Array.from({ length: 8 }, (_, index) => syntheticHydroUnit({ id: `generator:small-${index}`, label: `Small ${index}`, busId: 'bus:a', location: [10, 60], capacityMw: 50, rampRateMwPerMinute: 50 })),
  ],
  loads: [
    testLoad({ id: 'load:smelter', busId: 'bus:b', location: [10.1, 60], demandMw: 200, priority: 'normal', interruptibleMw: 120, criticalMw: 20 }),
    testLoad({ id: 'load:town', busId: 'bus:b', location: [10.1, 60], demandMw: 100, priority: 'low' }),
    testLoad({ id: 'load:hospital', busId: 'bus:b', location: [10.1, 60], demandMw: 40, priority: 'critical', criticalMw: 40 }),
    testLoad({ id: 'load:chargers', kind: 'ev_charging', busId: 'bus:b', location: [10.1, 60], demandMw: 60, priority: 'normal', interruptibleMw: 40, criticalMw: 10 }),
  ].map(load => load.kind === 'ev_charging' ? load : { ...load, demandProfileId: declaredDailyProfile.id }),
  demandProfiles: [flatDemandProfile, declaredDailyProfile],
})

const curtailment = (): SteppedGrid => {
  const run = steppedGrid({ ...gridDefinitionForModel(curtailmentModel), gridId: 'grid:test-curtailment' })
  run.advanceTo(10_000)
  return run
}

describe('electric grid curtailment and emergency shedding', () => {
  test('curtailment stays within interruptible demand; beyond it needs the emergency flag and is recorded as emergency shedding', () => {
    const run = curtailment()
    const smelter = run.grid.loads.get('load:smelter')!
    const demandMw = smelter.demandMw
    // 100 MW of the 120 MW interruptible: curtailment.
    expect(run.command(gridShedLoadCommandKind, { assetId: 'load:smelter', targetDemandMw: demandMw - 100 }).ok).toBe(true)
    expect(smelter).toMatchObject({ manualShedEmergency: false, shedCauses: ['manual'] })
    expect(smelter.curtailedMw).toBeCloseTo(100, 6)
    // 150 MW is beyond it: the reason gives the interruptible demand, the curtailment floor and the critical floor.
    const beyond = run.command(gridShedLoadCommandKind, { assetId: 'load:smelter', targetDemandMw: demandMw - 150 })
    expect(beyond.ok).toBe(false)
    expect(beyond.reason).toContain('beyond its 120 MW of interruptible demand')
    expect(beyond.reason).toContain(`no lower than ${Math.round((demandMw - 120) * 10) / 10} MW`)
    expect(beyond.reason).toContain('critical demand 20 MW')
    expect(run.command(gridShedLoadCommandKind, { assetId: 'load:smelter', targetDemandMw: demandMw - 150, emergency: true }).ok).toBe(true)
    expect(smelter).toMatchObject({ manualShedEmergency: true, shedCauses: ['emergency'] })
    expect(smelter.curtailedMw).toBeCloseTo(150, 6)
    expect(run.signals.filter(signal => signal.type === 'electric-grid.load.emergency-shed').map(signal => signal.payload))
      .toEqual([expect.objectContaining({ loadId: 'load:smelter', interruptibleMw: 120, criticalMw: 20, targetDemandMw: demandMw - 150 })])
    // Even emergency shedding keeps the critical demand.
    expect(run.command(gridShedLoadCommandKind, { assetId: 'load:smelter', targetDemandMw: 10, emergency: true }).reason).toContain('below the critical demand 20 MW')
    // The record persists with the run.
    const stored = parseElectricGridRuntimeState(JSON.parse(JSON.stringify(runtimeStateForElectricGrids(new Map([[run.grid.definition.gridId, run.grid]])))))
    const restored = createGridRuntimeInstance({ definition: run.grid.definition, at: isoAt(10_000), restored: restoredGridRuntimeStateFor(stored, run.grid.definition.gridId, run.grid.definition.definitionDigest)! })
    expect(restored.loads.get('load:smelter')).toMatchObject({ manualDemandLimitMw: demandMw - 150, manualShedEmergency: true })
    expect(run.command(gridRestoreLoadCommandKind, { assetId: 'load:smelter' }).ok).toBe(true)
    expect(smelter).toMatchObject({ manualDemandLimitMw: null, manualShedEmergency: false, curtailedMw: 0 })
  })

  test('a load without interruptible demand can only be shed as an emergency; a critical load never', () => {
    const run = curtailment()
    expect(run.command(gridShedLoadCommandKind, { assetId: 'load:town', targetDemandMw: 50 }).reason).toContain('beyond its 0 MW of interruptible demand')
    expect(run.command(gridShedLoadCommandKind, { assetId: 'load:town', targetDemandMw: 50, emergency: true }).ok).toBe(true)
    expect(run.command(gridShedLoadCommandKind, { assetId: 'load:hospital', targetDemandMw: 39, emergency: true }).reason).toContain('critical in full')
    expect(run.grid.loads.get('load:hospital')!.curtailedMw).toBe(0)
  })

  test('a curtailment never exceeds interruptible demand as the daily profile moves, and an EV schedule draws on the same budget', () => {
    const run = curtailment()
    const smelter = run.grid.loads.get('load:smelter')!
    expect(run.command(gridShedLoadCommandKind, { assetId: 'load:smelter', targetDemandMw: smelter.demandMw - 120 }).ok).toBe(true)
    let largest = 0
    for (let hour = 1; hour <= 12; hour += 1) {
      run.advanceTo(10_000 + hour * 600_000, [60_000])
      largest = Math.max(largest, smelter.curtailedMw)
    }
    expect(largest).toBeLessThanOrEqual(120 + 1e-9)

    const chargers = run.grid.loads.get('load:chargers')!
    const modelledMw = chargers.modelledDemandMw
    expect(run.command(gridSetEvChargingDemandCommandKind, { assetId: 'load:chargers', demandMw: modelledMw - 50 }).reason).toContain('beyond its 40 MW of interruptible demand')
    expect(run.command(gridSetEvChargingDemandCommandKind, { assetId: 'load:chargers', demandMw: modelledMw - 30 }).ok).toBe(true)
    // 10 MW of interruptible demand is left for curtailment.
    const shed = run.command(gridShedLoadCommandKind, { assetId: 'load:chargers', targetDemandMw: chargers.demandMw - 20 })
    expect(shed.reason).toContain('beyond its 10 MW of interruptible demand (40 MW less what its EV schedule uses)')
    expect(run.command(gridShedLoadCommandKind, { assetId: 'load:chargers', targetDemandMw: chargers.demandMw - 10 }).ok).toBe(true)
  }, 60_000)

  test('LFDD keeps its priority order whatever demand is interruptible', () => {
    const run = curtailment()
    // Losing the 250 MW unit takes the island below the LFDD stages.
    const big = run.grid.generators.get('generator:big')!
    big.state = 'tripped'
    big.targetMw = 0
    run.advanceTo(600_000, [1_000])
    const shed = (id: string): number => run.grid.loads.get(id)!.lfddShedMw
    expect(run.grid.frequencyEvents.some(event => event.kind === 'lfdd-stage-operated')).toBe(true)
    // The low-priority town goes first though it has no interruptible demand and the smelter has 120 MW.
    expect(shed('load:town')).toBeGreaterThan(0)
    if (shed('load:smelter') > 0) expect(shed('load:town')).toBeCloseTo(run.grid.loads.get('load:town')!.demandMw, 9)
    expect(shed('load:hospital')).toBe(0)
  }, 60_000)

  test('the losses below 132 kV behind a load follow its connected share and never count as demand', () => {
    // 10 MW of network losses behind the 100 MW town at the Operating Point.
    const model = { ...curtailmentModel, loads: curtailmentModel.loads.map(load => load.id === 'load:town' ? { ...load, networkLossMw: 10 } : load) }
    const run = steppedGrid({ ...gridDefinitionForModel(model), gridId: 'grid:test-network-losses' })
    run.advanceTo(10_000)
    const town = run.grid.loads.get('load:town')!
    const fullMw = 10 * town.profileFactor
    expect(town.networkLossMw).toBeCloseTo(fullMw, 9)
    expect(run.grid.projection.networkLossesMw).toBeCloseTo(fullMw, 1)
    // The bus draws its loads' served demand, the town's losses and its half of the line's losses; demand, served and unserved figures leave the network losses out.
    const busServedMw = ['load:smelter', 'load:town', 'load:hospital', 'load:chargers'].reduce((sum, id) => sum + run.grid.loads.get(id)!.servedMw, 0)
    const lineLossMw = run.grid.lossLoadByBusMw[gridTablesFor(run.grid.definition).network.busIndexById.get('bus:b')!]!
    expect(-run.grid.busStates.get('bus:b')!.netInjectionMw).toBeCloseTo(busServedMw + fullMw + lineLossMw, 6)
    expect(run.grid.projection.servedLoadMw).toBeCloseTo(busServedMw, 0)
    // Shedding half the town opens half its feeders: half the losses go with them (linear in the connected share).
    expect(run.command(gridShedLoadCommandKind, { assetId: 'load:town', targetDemandMw: town.demandMw / 2, emergency: true }).ok).toBe(true)
    expect(town.networkLossMw).toBeCloseTo(fullMw / 2, 9)
    expect(town.unservedMw).toBeCloseTo(town.demandMw / 2, 9)
    expect(run.command(gridRestoreLoadCommandKind, { assetId: 'load:town' }).ok).toBe(true)
    expect(town.networkLossMw).toBeCloseTo(fullMw, 9)
  })
})
