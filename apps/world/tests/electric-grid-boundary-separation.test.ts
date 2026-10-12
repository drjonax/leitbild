import { describe, expect, test } from 'bun:test'
import { gridCloseBranchCommandKind, gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridSetExternalExchangeCommandKind } from '../src/packs/electric-grid/commands/external.ts'
import { gridDispatchGeneratorCommandKind } from '../src/packs/electric-grid/commands/generator.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { nordicFrequencyAutomationRef, norwayGridModelRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import type { CompiledGridDefinition, GridBusDefinition, GridModelDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { answerElectricGridQuery, electricGridQueryCapabilities } from '../src/packs/electric-grid/queries/index.ts'
import { gridMapIslandState } from '../src/packs/electric-grid/queries/map-state.ts'
import { createGridRecordingPlan } from '../src/packs/electric-grid/recording.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { electricGridRuntimeStateSchema, restoredGridRuntimeStateFor, runtimeStateForElectricGrids } from '../src/packs/electric-grid/sim/runtime-state.ts'
import { liveContingencyCase } from '../src/packs/electric-grid/runtime/contingency-case.ts'
import { islandKineticEnergyMws } from '../src/packs/electric-grid/runtime/island-input.ts'
import { remedialCaseChanges } from '../src/packs/electric-grid/runtime/remedial-actions.ts'
import { isoAt, steppedGrid, type SteppedGrid } from './fixtures/grid-corridor.ts'
import { largestIslandInjectionSumMw } from './fixtures/grid-invariants.ts'
import { norwayRuntimeTestOperatingPointRef } from './fixtures/grid-operating-point.ts'
import { gridDefinitionForModel, handBuiltModel, syntheticHydroUnit, testLine, testLoad } from './fixtures/synthetic-grid.ts'

// Two Norwegian 420 kV buses, each tied to the Nordic equivalent: the south one at SE3, the north
// one at SE1. Norway imports 300 MW on schedule.
const provenance = { sources: ['test:hand-built'], method: 'curated' as const, confidence: 'high' as const, note: 'Boundary separation test model.' }
const bus = (id: string, longitude: number, kind: GridBusDefinition['kind'] = 'substation'): GridBusDefinition => ({ id, label: id, kind, nominalKv: 420, location: [longitude, 60] })
const line = (id: string, fromBusId: string, toBusId: string, ratingMw: number) =>
  testLine({ id, fromBusId, toBusId, nominalKv: 420, ratingMw, reactancePu: 0.01, resistancePu: 0.001 })
const se1 = 'bus:boundary-SE1@420'
const se3 = 'bus:boundary-SE3@420'
const scheduledImportMw = 300

const model: GridModelDefinition = handBuiltModel({
  id: 'boundary-separation',
  title: 'Boundary separation',
  description: 'Two Norwegian buses tied to the Nordic equivalent at SE3 and SE1.',
  buses: [bus('bus:south', 7), bus('bus:north', 8), bus(se3, 11, 'boundary'), bus(se1, 12, 'boundary')],
  branches: [line('south-north', 'bus:south', 'bus:north', 2_000), line('tie-se3', 'bus:south', se3, 1_500), line('tie-se1', 'bus:north', se1, 1_000)],
  generators: Array.from({ length: 4 }, (_, index) => syntheticHydroUnit({ id: `south-${index}`, label: `South ${index}`, busId: 'bus:south', location: [7, 60], capacityMw: 400 })),
  loads: [testLoad({ id: 'south-load', busId: 'bus:south', demandMw: 1_100 }), testLoad({ id: 'north-load', busId: 'bus:north', demandMw: 400 })],
  externalSystems: [{
    id: 'external:nordic-remainder', label: 'Nordic remainder', area: 'nordic-remainder', synchronous: true, boundaryBusIds: [se3, se1],
    inertiaGws: 171, loadMw: 43_100, fcrNMwPerHz: 3_720, fcrDUpMw: 899, fcrDDownMw: 868, afrrUpMw: 138, afrrDownMw: 138,
    areaParticipation: [{ area: 'SE3', share: 0.6, boundaryBusIds: [se3] }, { area: 'SE1', share: 0.4, boundaryBusIds: [se1] }], provenance,
  }],
})

const definition = (): CompiledGridDefinition => {
  const base = gridDefinitionForModel(model)
  // The schedule enters 60 % at SE3 and 40 % at SE1, as the area participation shares a change of it.
  const borders = [{ label: 'NO1–SE3', boundaryBusIds: [se3], scheduledExportMw: -0.6 * scheduledImportMw }, { label: 'NO4–SE1', boundaryBusIds: [se1], scheduledExportMw: -0.4 * scheduledImportMw }]
  return { ...base, operatingPoint: { ...base.operatingPoint, externalExchanges: [{ systemId: 'external:nordic-remainder', scheduledExportMw: -scheduledImportMw, borders }] } }
}

const queryCapability = (id: string) => electricGridQueryCapabilities.find(capability => capability.id === id)!
const query = (grid: GridRuntimeInstance, capabilityId: string, input: Readonly<Record<string, unknown>> = {}) =>
  queryCapability(capabilityId).output.parse(answerElectricGridQuery({
    request: { capabilityId, input: { gridId: grid.definition.gridId, ...input } },
    grids: new Map([[grid.definition.gridId, grid]]),
  })) as Record<string, any>

const reasonOf = (result: { readonly ok: boolean; readonly reason?: string }): string => {
  if (result.ok) throw new Error('expected the command to be rejected')
  return result.reason!
}
/** A bus state's published fields (the state is a view of getters). */
const busState = (grid: GridRuntimeInstance, busId: string) => {
  const state = grid.busStates.get(busId)!
  return { islandId: state.islandId, energized: state.energized, voltagePu: state.voltagePu, voltageModel: state.voltageModel, frequencyHz: state.frequencyHz }
}
const mainIsland = (run: SteppedGrid) => run.grid.islandPlan!.islands.find(island => island.id === run.grid.busStates.get('bus:south')!.islandId)!
const remainder = (run: SteppedGrid) => run.grid.externalSystems.get('external:nordic-remainder')!

describe('a separated boundary bus of a synchronous external system', () => {
  test('stays energised by its system in no island: the island count, alarms and recordings are unchanged', async () => {
    const run = steppedGrid(definition())
    run.advanceTo(10_000, [1_000])
    const before = query(run.grid, 'world.electric-grid.islands.list')
    expect(before.total).toBe(1)
    expect(before.islands[0].busCount).toBe(4)
    // N-1 and remedial switching agree: losing SE1's only tie separates the boundary bus, no split.
    const ask = async (capabilityId: string, input: Readonly<Record<string, unknown>>) => await answerElectricGridQuery({
      request: { capabilityId, input: { gridId: run.grid.definition.gridId, ...input } },
      grids: new Map([[run.grid.definition.gridId, run.grid]]),
    }) as Record<string, any>
    const tieOutage = await ask('world.electric-grid.contingency.screen', { contingencies: ['tie-se1'] })
    expect(tieOutage).toMatchObject({ islandingCount: 0, results: [{ islanding: false, unservedLoadMw: 0 }] })
    expect(tieOutage.results[0].affectedIslands.map((part: { busCount: number; balancing: string }) => [part.busCount, part.balancing])).toEqual([[3, 'reserves']])
    expect((await ask('world.electric-grid.remedial-actions.evaluate', { contingencies: 'all-branches', actions: [{ kind: 'open-branch', assetId: 'tie-se1' }] })).actionBalances
      .map((part: { busCount: number }) => part.busCount)).toEqual([3])
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'tie-se1' }).ok).toBe(true)
    run.advanceTo(30_000, [1_000])

    // No de-energised island: islands.list, the projection and the map agree on one island.
    const listed = query(run.grid, 'world.electric-grid.islands.list')
    expect(listed.total).toBe(1)
    expect(listed.islands[0]).toMatchObject({ id: before.islands[0].id, busCount: 3, energized: true })
    expect(run.grid.projection.islandCount).toBe(1)
    expect(run.grid.projection.islands.map(island => island.id)).toEqual([before.islands[0].id])
    expect([...run.grid.alarms.records.values()].filter(record => record.condition === 'de-energised' || record.condition === 'formed')).toEqual([])
    expect(gridMapIslandState(run.grid).busIsland).toEqual([0, 0, 0, null])

    // The remainder stays coupled through SE3, so SE1 runs at the island's frequency, held at the equivalent's voltage.
    const islandHz = mainIsland(run).frequency!.frequencyHz!
    expect(Math.abs(islandHz - 50)).toBeLessThan(0.01)
    expect(busState(run.grid, se1)).toMatchObject({ islandId: null, energized: true, voltagePu: 1, voltageModel: 'external', frequencyHz: islandHz })
    expect(query(run.grid, 'world.electric-grid.asset.get', { assetId: se1 }).asset).toMatchObject({
      status: { tone: 'working', label: 'Separated · held by Nordic remainder' },
      state: { islandId: null, energized: true, voltageModel: 'external' },
    })
    expect(query(run.grid, 'world.electric-grid.assets.search', { kinds: ['bus'], status: ['de-energized'] }).total).toBe(0)
    expect(remainder(run)).toMatchObject({ islandId: before.islands[0].id, energized: true, scheduledImportMw })
    // The import now enters through SE3 alone (less the tie's losses), and the island balance closes.
    const tieFlowMw = run.grid.branches.get('tie-se3')!.flowMw
    expect(tieFlowMw).toBeLessThan(0)
    expect(-tieFlowMw).toBeGreaterThan(remainder(run).importMw - 2)
    expect(-tieFlowMw).toBeLessThanOrEqual(remainder(run).importMw)
    expect(largestIslandInjectionSumMw(run.grid)).toBeLessThan(1e-6)
    const recording = createGridRecordingPlan({ selection: { packId: 'electric-grid', profileId: 'engineering' }, grids: new Map([[run.grid.definition.gridId, run.grid]]) })
    expect(recording.descriptors.filter(descriptor => descriptor.signalId.startsWith('island.')).map(descriptor => descriptor.signalId))
      .toEqual(['frequency', 'energized', 'ac-flow'].map(quantity => `island.${before.islands[0].id}.${quantity}`))

    // N-1 screening runs on the separated topology; a remedial evaluation leaves reconnecting the external system to close-branch.
    const screening = await answerElectricGridQuery({
      request: { capabilityId: 'world.electric-grid.contingency.screen', input: { gridId: run.grid.definition.gridId, contingencies: 'all-branches', ratingBasis: 'emergency' } },
      grids: new Map([[run.grid.definition.gridId, run.grid]]),
    }) as { readonly screenedCount: number }
    expect(screening.screenedCount).toBe(2)
    expect(() => remedialCaseChanges(liveContingencyCase(run.grid), [{ kind: 'close-branch', assetId: 'tie-se1' }]))
      .toThrow(`closing tie-se1 reconnects ${se1}, a boundary bus whose ties are all open, to its external system`)

    // Reclosing onto it rejoins the island through the equivalent at one frequency: accepted.
    expect(run.command(gridCloseBranchCommandKind, { assetId: 'tie-se1' }).ok).toBe(true)
    run.advanceTo(40_000, [1_000])
    expect(query(run.grid, 'world.electric-grid.islands.list').islands.map((island: { id: string; busCount: number }) => [island.id, island.busCount])).toEqual([[before.islands[0].id, 4]])
    expect(busState(run.grid, se1)).toMatchObject({ islandId: before.islands[0].id, voltageModel: 'ac-fdlf' })
  })

  test('with every tie open Norway runs alone on its own swing equation, and reclosing passes the synchro-check only within its limit', () => {
    const run = steppedGrid(definition())
    run.advanceTo(10_000, [1_000])
    const islandId = mainIsland(run).id
    const kineticEnergyMws = islandKineticEnergyMws(run.grid, run.grid.islandPlan!.plan.islands[mainIsland(run).planIndex]!) - 171_000
    const importMw = remainder(run).importMw
    expect(importMw).toBeCloseTo(scheduledImportMw, 0)
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'tie-se1' }).ok).toBe(true)
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'tie-se3' }).ok).toBe(true)
    // The lost import decelerates the island at ΔP·f0 / (2·E_k) over its own units' kinetic energy.
    run.advanceTo(10_100, [100])
    const rocof = mainIsland(run).rocofHzPerSecond!
    expect(rocof).toBeCloseTo(-importMw * 50 / (2 * kineticEnergyMws), 1)
    run.advanceTo(20_000, [1_000])
    const islandHz = mainIsland(run).frequency!.frequencyHz!
    expect(islandHz).toBeLessThan(49.9)

    // One Norwegian island; both boundary buses are held by the remainder at its nominal frequency, which exchanges nothing now.
    const listed = query(run.grid, 'world.electric-grid.islands.list')
    expect(listed.islands.map((island: { id: string; busCount: number; energized: boolean }) => [island.id, island.busCount, island.energized])).toEqual([[islandId, 2, true]])
    expect(run.grid.projection.islandCount).toBe(1)
    for (const busId of [se1, se3]) expect(busState(run.grid, busId)).toMatchObject({ islandId: null, energized: true, frequencyHz: 50, voltageModel: 'external' })
    expect(remainder(run)).toMatchObject({ islandId: null, energized: false, importMw: 0, scheduledImportMw: 0, targetImportMw: 0, exchangeVoided: true })
    // The voided exchange is visible: the summary beside the Operating Point's, and an external alarm.
    expect(query(run.grid, 'world.electric-grid.grid.summary').externalExchanges).toEqual([{
      systemId: 'external:nordic-remainder', label: 'Nordic remainder', operatingPointExportMw: -scheduledImportMw, scheduledExportMw: 0, targetExportMw: 0, exchangeMw: 0, islandId: null, voidedBySeparation: true,
    }])
    const voidedAlarm = () => run.grid.alarms.records.get('external:nordic-remainder:exchange-voided')
    expect(voidedAlarm()).toMatchObject({ active: true, scope: 'external', priority: 2, islandId: null, value: scheduledImportMw, unit: 'MW' })
    expect(query(run.grid, 'world.electric-grid.alarms.list', { states: ['active'] }).alarms.find((alarm: { id: string }) => alarm.id === 'external:nordic-remainder:exchange-voided'))
      .toMatchObject({ assetLabel: 'Nordic remainder', mapAssetId: se3 })
    // Nothing to exchange with while separated.
    expect(reasonOf(run.command(gridSetExternalExchangeCommandKind, { assetId: 'external:nordic-remainder', scheduledExportMw: -scheduledImportMw })))
      .toBe('external:nordic-remainder is coupled to no Norwegian island: all its ties are open, so there is nothing to exchange with; close a tie to it first (close-branch, under the synchro-check)')
    expect(largestIslandInjectionSumMw(run.grid)).toBeLessThan(1e-6)

    // A persisted Run restores the separation: the island alone, the void exchange, the buses held by the remainder.
    const { gridId, definitionDigest } = run.grid.definition
    const stored = electricGridRuntimeStateSchema.parse(JSON.parse(JSON.stringify(runtimeStateForElectricGrids(new Map([[gridId, run.grid]])))))
    const restored = createGridRuntimeInstance({ definition: run.grid.definition, at: isoAt(20_000), restored: restoredGridRuntimeStateFor(stored, gridId, definitionDigest)! })
    advanceGrid(restored, 0, isoAt(20_000))
    advanceGrid(restored, 2, isoAt(22_000))
    expect(restored.islandPlan!.islands.map(island => island.id)).toEqual([islandId])
    expect(restored.externalSystems.get('external:nordic-remainder')).toMatchObject({ islandId: null, scheduledImportMw: 0, targetImportMw: 0, exchangeVoided: true })
    expect(busState(restored, se3)).toMatchObject({ islandId: null, energized: true, frequencyHz: 50, voltageModel: 'external' })

    // Reclosing onto the separated system compares the island with its nominal frequency.
    expect(reasonOf(run.command(gridCloseBranchCommandKind, { assetId: 'tie-se3' }))).toBe(
      `synchro-check blocks closing tie-se3: ${islandId} at ${mainIsland(run).frequency!.frequencyHz!.toFixed(3)} Hz and external:nordic-remainder, separated from every Norwegian island and so at its nominal 50.000 Hz, `
      + `differ by ${(50 - mainIsland(run).frequency!.frequencyHz!).toFixed(3)} Hz, above the 0.1 Hz limit; bring ${islandId} within 0.1 Hz of 50.000 Hz first`,
    )
    expect(run.grid.branches.get('tie-se3')!.state).toBe('open')
    // Its units take up the lost import; within 0.1 Hz the tie closes and the island rejoins the remainder.
    for (let unit = 0; unit < 4; unit += 1) {
      const assetId = `south-${unit}`
      expect(run.command(gridDispatchGeneratorCommandKind, { assetId, targetMw: run.grid.generators.get(assetId)!.targetMw + scheduledImportMw / 4 }).ok).toBe(true)
    }
    let atMs = 20_000
    while (Math.abs(mainIsland(run).frequency!.frequencyHz! - 50) > 0.1) {
      atMs += 10_000
      if (atMs > 900_000) throw new Error('the island did not return within 0.1 Hz of nominal in 15 minutes')
      run.advanceTo(atMs, [1_000])
    }
    const beforeHz = mainIsland(run).frequency!.frequencyHz!
    expect(run.command(gridCloseBranchCommandKind, { assetId: 'tie-se3' }).ok).toBe(true)
    const rejoined = mainIsland(run)
    expect(rejoined.id).toBe(islandId)
    // The joined frequency is the kinetic-energy-weighted mean with the remainder at nominal.
    expect(rejoined.frequency!.frequencyHz!).toBeCloseTo((beforeHz * kineticEnergyMws + 50 * 171_000) / (kineticEnergyMws + 171_000), 9)
    expect(remainder(run)).toMatchObject({ islandId, energized: true, scheduledImportMw: 0 })
    run.advanceTo(atMs + 10_000, [1_000])
    expect(busState(run.grid, se3)).toMatchObject({ islandId, voltageModel: 'ac-fdlf' })
    expect(busState(run.grid, se1)).toMatchObject({ islandId: null, voltageModel: 'external', frequencyHz: mainIsland(run).frequency!.frequencyHz! })
    expect(largestIslandInjectionSumMw(run.grid)).toBeLessThan(1e-6)

    // Coupled again, the exchange is restored by command, within the closed tie's rating, at the Automation's 100 MW/min.
    const setExchange = (scheduledExportMw: number) => run.command(gridSetExternalExchangeCommandKind, { assetId: 'external:nordic-remainder', scheduledExportMw })
    expect(reasonOf(setExchange(-1_600))).toBe('scheduled exchange -1600 MW with external:nordic-remainder exceeds the 1500 MW rating of its closed ties (positive exports from Norway)')
    expect(reasonOf(setExchange(0))).toBe('external:nordic-remainder already has the target scheduled exchange 0 MW (scheduled now 0 MW, positive exports from Norway)')
    expect(setExchange(-scheduledImportMw).ok).toBe(true)
    const restoredAtMs = atMs + 10_000
    run.advanceTo(restoredAtMs + 60_000, [1_000])
    expect(remainder(run).scheduledImportMw).toBeCloseTo(100, 9)
    expect(remainder(run)).toMatchObject({ targetImportMw: scheduledImportMw, exchangeVoided: true })
    expect(voidedAlarm()!.value).toBeCloseTo(200, 9)
    run.advanceTo(restoredAtMs + 200_000, [1_000])
    expect(remainder(run)).toMatchObject({ scheduledImportMw, targetImportMw: scheduledImportMw, exchangeVoided: false })
    expect(voidedAlarm()).toMatchObject({ active: false })
    expect(query(run.grid, 'world.electric-grid.grid.summary').externalExchanges[0]).toMatchObject({ scheduledExportMw: -scheduledImportMw, targetExportMw: -scheduledImportMw, islandId, voidedBySeparation: false })
    expect(largestIslandInjectionSumMw(run.grid)).toBeLessThan(1e-6)
  }, 120_000)
})

describe('Norway separated from Sweden and Finland', () => {
  test('opening every AC tie leaves one Norwegian island on its own swing equation, the boundary buses held at nominal', () => {
    const definition = compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:norway', model: { ref: norwayGridModelRef }, automation: { ref: nordicFrequencyAutomationRef }, operatingPoint: { ref: norwayRuntimeTestOperatingPointRef },
    }))
    const nordic = definition.index.externalSystems.find(system => system.synchronous)!
    const ties = definition.model.branches.filter(branch => nordic.boundaryBusIds.includes(branch.fromBusId) || nordic.boundaryBusIds.includes(branch.toBusId))
    expect(ties).toHaveLength(8)
    const run = steppedGrid(definition)
    run.advanceTo(4_000, [1_000])
    const before = query(run.grid, 'world.electric-grid.islands.list', { limit: 500 })
    expect(before.total).toBe(1)
    const islandId = before.islands[0].id
    const island = () => run.grid.islandPlan!.islands.find(candidate => candidate.id === islandId)!
    // Norway's exchange with the remainder at the Operating Point, positive into Norway.
    const importMw = run.grid.externalSystems.get(nordic.id)!.importMw
    for (const tie of ties) expect(run.command(gridOpenBranchCommandKind, { assetId: tie.id }).ok).toBe(true)
    const kineticEnergyMws = islandKineticEnergyMws(run.grid, run.grid.islandPlan!.plan.islands[island().planIndex]!)
    run.advanceTo(4_100, [100])
    const rocof = island().rocofHzPerSecond!
    console.info(`Norway separated from the Nordic remainder: ${importMw.toFixed(1)} MW exchange lost, E_k ${(kineticEnergyMws / 1_000).toFixed(1)} GWs, RoCoF ${rocof.toFixed(4)} Hz/s (swing ${(-importMw * 50 / (2 * kineticEnergyMws)).toFixed(4)} Hz/s)`)
    expect(rocof).toBeCloseTo(-importMw * 50 / (2 * kineticEnergyMws), 2)
    run.advanceTo(10_000, [1_000])
    const listed = query(run.grid, 'world.electric-grid.islands.list', { limit: 500 })
    expect(listed.islands.map((item: { id: string }) => item.id)).toEqual([islandId])
    expect(listed.islands[0].busCount).toBe(definition.model.buses.length - 4 - nordic.boundaryBusIds.length)
    expect(run.grid.projection.islandCount).toBe(1)
    expect(island().frequency!.frequencyHz).not.toBe(50)
    for (const busId of nordic.boundaryBusIds) expect(busState(run.grid, busId)).toMatchObject({ islandId: null, energized: true, frequencyHz: 50, voltageModel: 'external' })
    expect([...run.grid.alarms.records.values()].filter(record => record.condition === 'de-energised')).toEqual([])
    expect(largestIslandInjectionSumMw(run.grid)).toBeLessThan(1e-6)
  }, 120_000)
})
