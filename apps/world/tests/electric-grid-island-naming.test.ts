import { describe, expect, test } from 'bun:test'
import { gridCloseBranchCommandKind, gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridDispatchGeneratorCommandKind, gridResetGeneratorTripCommandKind, gridStartGeneratorCommandKind, gridTripGeneratorCommandKind } from '../src/packs/electric-grid/commands/generator.ts'
import { gridShedLoadCommandKind } from '../src/packs/electric-grid/commands/load.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { nordicFrequencyAutomationRef, norwayGridModelRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import type { GridBusDefinition, GridModelDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { gridMapIslandState } from '../src/packs/electric-grid/queries/map-state.ts'
import { answerElectricGridQuery } from '../src/packs/electric-grid/queries/index.ts'
import { createGridRecordingPlan } from '../src/packs/electric-grid/recording.ts'
import { gridAlarmId } from '../src/packs/electric-grid/runtime/alarms.ts'
import type { GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { steppedGrid, type SteppedGrid } from './fixtures/grid-corridor.ts'
import { norwayRuntimeTestOperatingPointRef } from './fixtures/grid-operating-point.ts'
import { gridDefinitionForModel, handBuiltModel, syntheticHydroUnit, testLine, testLoad } from './fixtures/synthetic-grid.ts'
import { balanceSeparablePart, separableBranch } from './fixtures/grid-split.ts'

// Island names: a new island is island:<anchor>, its highest-voltage station bus with the most
// connected branch capacity (never a junction or boundary bus while it holds a station), and an
// island keeps its id through splits, merges and re-energisation as its lineage decides.

const provenance = { sources: ['test:hand-built'], method: 'curated' as const, confidence: 'high' as const, note: 'Island naming test model.' }
const bus = (id: string, longitude: number, nominalKv: number, kind: GridBusDefinition['kind']): GridBusDefinition => ({ id, label: id, kind, nominalKv, location: [longitude, 60] })
const line = (id: string, fromBusId: string, toBusId: string, ratingMw: number) =>
  testLine({ id, fromBusId, toBusId, nominalKv: 420, ratingMw, reactancePu: 0.01, resistancePu: 0.001 })

const hubId = 'island:bus:station-hub@420'
const westId = 'island:bus:station-west@420'

// The boundary and junction buses sort first by id, and the junction carries the most connected
// capacity of the west part (4,500 MW): neither may name an island. The hub (4,500 MW at 420 kV)
// names the whole system; the west 420 kV station (2,100 MW) names the west part, north (1,500 MW) does not.
const namingModel: GridModelDefinition = handBuiltModel({
  id: 'island-naming',
  title: 'Island naming',
  description: 'A hub tied to the Nordic equivalent and a west part behind a 420 kV junction.',
  buses: [
    bus('bus:boundary-SE3@420', 12, 420, 'boundary'),
    bus('bus:junction-t@420', 10, 420, 'junction'),
    bus('bus:station-north@420', 10, 420, 'substation'),
    bus('bus:station-hub@420', 11, 420, 'substation'),
    bus('bus:station-west@420', 9, 420, 'substation'),
    bus('bus:station-west@132', 8, 132, 'plant-terminal'),
  ],
  branches: [
    line('tie', 'bus:station-hub@420', 'bus:boundary-SE3@420', 3_000),
    line('hub-t', 'bus:station-hub@420', 'bus:junction-t@420', 1_500),
    line('t-west', 'bus:junction-t@420', 'bus:station-west@420', 1_500),
    line('t-north', 'bus:junction-t@420', 'bus:station-north@420', 1_500),
    testLine({ id: 'west-tx', kind: 'transformer', tapRatio: 1, fromBusId: 'bus:station-west@420', toBusId: 'bus:station-west@132', nominalKv: 420, ratingMw: 600, reactancePu: 0.02, resistancePu: 0.001 }),
  ],
  generators: [
    ...Array.from({ length: 4 }, (_, index) => syntheticHydroUnit({ id: `hub-${index}`, label: `Hub ${index}`, busId: 'bus:station-hub@420', location: [11, 60], capacityMw: 400 })),
    syntheticHydroUnit({ id: 'west-a', label: 'West A', busId: 'bus:station-west@132', location: [8, 60], capacityMw: 300, blackStartCapable: true }),
    syntheticHydroUnit({ id: 'west-b', label: 'West B', busId: 'bus:station-west@132', location: [8, 60], capacityMw: 300 }),
  ],
  loads: [
    testLoad({ id: 'hub-load', busId: 'bus:station-hub@420', demandMw: 1_000 }),
    testLoad({ id: 'west-load', busId: 'bus:station-west@132', demandMw: 270 }),
    testLoad({ id: 'north-load', busId: 'bus:station-north@420', demandMw: 30 }),
  ],
  externalSystems: [{
    id: 'external:nordic-remainder', label: 'Nordic remainder', area: 'nordic-remainder', synchronous: true, boundaryBusIds: ['bus:boundary-SE3@420'],
    inertiaGws: 171, loadMw: 43_100, fcrNMwPerHz: 3_720, fcrDUpMw: 899, fcrDDownMw: 868, afrrUpMw: 138, afrrDownMw: 138,
    areaParticipation: [{ area: 'SE3', share: 1, boundaryBusIds: ['bus:boundary-SE3@420'] }], provenance,
  }],
})

const ok = (result: { readonly ok: boolean; readonly reason?: string }): void => {
  if (!result.ok) throw new Error(`command rejected: ${result.reason}`)
}
const islandIds = (run: SteppedGrid): string[] => run.grid.islandPlan!.islands.map(island => island.id)
const islandAt = (run: SteppedGrid, busId: string) => run.grid.islandPlan!.islands.find(island => island.id === run.grid.busStates.get(busId)!.islandId)!
const listed = (grid: GridRuntimeInstance) => answerElectricGridQuery({
  request: { capabilityId: 'world.electric-grid.islands.list', input: { gridId: grid.definition.gridId } },
  grids: new Map([[grid.definition.gridId, grid]]),
}) as { islands: ReadonlyArray<{ id: string; energized: boolean; anchorBus: { id: string } }> }

describe('island naming', () => {
  test('stays stable and meaningful over split, merge and re-energisation, in alarms, map state and recordings', () => {
    const run = steppedGrid(gridDefinitionForModel(namingModel))
    // The west units carry the west part's 300 MW, so it separates without a frequency step.
    ok(run.command(gridDispatchGeneratorCommandKind, { assetId: 'west-a', targetMw: 150 }))
    ok(run.command(gridDispatchGeneratorCommandKind, { assetId: 'west-b', targetMw: 150 }))
    run.advanceTo(120_000)
    expect(islandIds(run)).toEqual([hubId])
    expect(listed(run.grid).islands.map(island => island.anchorBus.id)).toEqual(['bus:station-hub@420'])

    // Split: the part with the Nordic equivalent keeps the id; the west part is named after its west station.
    ok(run.command(gridOpenBranchCommandKind, { assetId: 'hub-t' }))
    run.advanceTo(140_000)
    expect(islandAt(run, 'bus:station-hub@420').id).toBe(hubId)
    expect(islandAt(run, 'bus:junction-t@420').id).toBe(westId)
    expect(islandAt(run, 'bus:station-north@420')).toMatchObject({ id: westId, energized: true })
    expect(listed(run.grid).islands.map(island => [island.id, island.anchorBus.id])).toEqual([[hubId, 'bus:station-hub@420'], [westId, 'bus:station-west@420']])
    // Alarms, the map's island state and recordings carry the same ids.
    expect(run.grid.alarms.records.get(gridAlarmId('island', westId, 'formed'))).toMatchObject({ active: true, islandId: westId })
    expect(gridMapIslandState(run.grid).islands.map(island => island.id)).toEqual(islandIds(run))
    const recording = createGridRecordingPlan({ selection: { packId: 'electric-grid', profileId: 'operations' }, grids: new Map([[run.grid.definition.gridId, run.grid]]) })
    expect(recording.descriptors.map(descriptor => descriptor.signalId).filter(id => id.startsWith('island.'))).toEqual([
      `island.${hubId}.frequency`, `island.${hubId}.energized`, `island.${hubId}.ac-flow`,
      `island.${westId}.frequency`, `island.${westId}.energized`, `island.${westId}.ac-flow`,
    ])

    // Merge: the island with the larger kinetic energy (the hub, with the Nordic equivalent) keeps its id.
    ok(run.command(gridCloseBranchCommandKind, { assetId: 'hub-t' }))
    run.advanceTo(150_000)
    expect(islandIds(run)).toEqual([hubId])

    // A second split names the west part as before, and losing its units de-energises it under the same id.
    ok(run.command(gridOpenBranchCommandKind, { assetId: 'hub-t' }))
    run.advanceTo(160_000)
    expect(islandIds(run)).toEqual([hubId, westId])
    ok(run.command(gridTripGeneratorCommandKind, { assetId: 'west-a' }))
    ok(run.command(gridTripGeneratorCommandKind, { assetId: 'west-b' }))
    run.advanceTo(170_000)
    expect(islandAt(run, 'bus:station-west@420')).toMatchObject({ id: westId, energized: false })
    expect(run.grid.alarms.records.get(gridAlarmId('island', westId, 'de-energised'))).toMatchObject({ active: true, islandId: westId })

    // Re-energised by its own black-start unit: the island keeps its id.
    ok(run.command(gridShedLoadCommandKind, { assetId: 'west-load', targetDemandMw: 0, emergency: true }))
    ok(run.command(gridResetGeneratorTripCommandKind, { assetId: 'west-a' }))
    ok(run.command(gridStartGeneratorCommandKind, { assetId: 'west-a' }))
    run.advanceTo(510_000)
    expect(run.grid.generators.get('west-a')!.state).toBe('online')
    expect(islandAt(run, 'bus:station-west@420')).toMatchObject({ id: westId, energized: true })
    expect(islandIds(run)).toEqual([hubId, westId])
    expect(run.grid.alarms.records.get(gridAlarmId('island', westId, 'de-energised'))!.active).toBe(false)

    // De-energised again and re-energised by closing onto the hub: the merged island is the hub's.
    ok(run.command(gridTripGeneratorCommandKind, { assetId: 'west-a' }))
    run.advanceTo(520_000)
    expect(islandAt(run, 'bus:station-west@420')).toMatchObject({ id: westId, energized: false })
    ok(run.command(gridCloseBranchCommandKind, { assetId: 'hub-t' }))
    run.advanceTo(530_000)
    expect(islandIds(run)).toEqual([hubId])
    expect(islandAt(run, 'bus:station-west@420').energized).toBe(true)
  })

  test('the Norway Model names its main island and a separated part after station buses', () => {
    const definition = compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:norway', model: { ref: norwayGridModelRef }, automation: { ref: nordicFrequencyAutomationRef }, operatingPoint: { ref: norwayRuntimeTestOperatingPointRef },
    }))
    const { model } = definition
    const stationKinds: ReadonlyArray<GridBusDefinition['kind']> = ['substation', 'plant-terminal', 'connection-point']
    // The rule, computed independently: the highest-voltage station bus with the most connected capacity, then the lowest id.
    const capacityMw = new Map<string, number>()
    for (const branch of model.branches) for (const busId of [branch.fromBusId, branch.toBusId]) capacityMw.set(busId, (capacityMw.get(busId) ?? 0) + branch.ratingMw)
    const anchorOf = (busIds: ReadonlySet<string>): string => model.buses
      .filter(candidate => busIds.has(candidate.id) && stationKinds.includes(candidate.kind))
      .sort((a, b) => b.nominalKv - a.nominalKv || (capacityMw.get(b.id) ?? 0) - (capacityMw.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1))[0]!.id
    const run = steppedGrid(definition)
    run.advanceTo(10_000, [1_000])
    const main = run.grid.islandPlan!.islands[0]!
    const mainBuses = new Set([...run.grid.busStates.keys()])
    expect(run.grid.islandPlan!.islands).toHaveLength(1)
    expect(main.id).toBe(`island:${anchorOf(mainBuses)}`)
    expect(model.buses.find(candidate => `island:${candidate.id}` === main.id)).toMatchObject({ kind: 'substation', nominalKv: 420 })

    // A part separated from the main island is named after its own anchor, not a junction or boundary bus.
    const mainBus = model.loads[0]!.busId
    const separable = separableBranch(run.grid, mainBus)
    balanceSeparablePart(run.grid, separable, () => run.advanceTo(run.nowMs() + 20_000, [2_000]))
    ok(run.command(gridOpenBranchCommandKind, { assetId: separable.branch.id }))
    run.advanceTo(run.nowMs() + 4_000, [1_000])
    const islands = run.grid.islandPlan!.islands
    expect(islands).toHaveLength(2)
    expect(islands.map(island => island.id)).toContain(main.id)
    const part = islands.find(island => island.id !== main.id)!
    const partBuses = new Set([...run.grid.busStates].filter(([, state]) => state.islandId === part.id).map(([busId]) => busId))
    expect(part.id).toBe(`island:${anchorOf(partBuses)}`)
    expect(stationKinds).toContain(model.buses.find(candidate => `island:${candidate.id}` === part.id)!.kind)
    console.info(`Norway island names: main ${main.id}, separated part ${part.id} (${partBuses.size} buses)`)
  }, 120_000)
})
