import { describe, expect, test } from 'bun:test'
import { observationShapes, type ObservationDeclaration } from '../src/core/observation/capabilities.ts'
import { recordingSeriesIdFor, type ScenarioRecordingSelection } from '../src/core/model/index.ts'
import { gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import type { CompiledGridDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { declareGrid, gridObservationDeclarationsQuery, gridPriority } from '../src/packs/electric-grid/observation/declarations.ts'
import { gridAlarmSignal, gridObservationReadQuery } from '../src/packs/electric-grid/observation/read.ts'
import { createGridRecordingPlan } from '../src/packs/electric-grid/recording.ts'
import { createGridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { corridorDefinition, steppedGrid } from './fixtures/grid-corridor.ts'

// N2 (plan v3.1 §2.2, architecture A1): the Grid declares an element catalogue and element-scoped
// observables through the core shapes; values read with the priority of their active alarm record.
const halden = (() => {
  const definition = compileGridDefinition(gridDefinitionSchema.parse({
    id: 'grid:halden-four-unit', model: { ref: 'electric-grid.halden.four-unit' }, operatingPoint: { ref: 'electric-grid.norway.winter-weekday-peak' }, automation: { ref: 'electric-grid.frequency.nordic-2025' },
  }))
  const grid = createGridRuntimeInstance({ definition, at: '2026-01-15T17:00:00.000Z' as never })
  advanceGrid(grid, 0, '2026-01-15T17:00:00.000Z' as never)
  return grid
})()
const operations: ScenarioRecordingSelection = { packId: 'electric-grid', profileId: 'operations' }
const engineering: ScenarioRecordingSelection = { packId: 'electric-grid', profileId: 'engineering' }
const valid = (declaration: ObservationDeclaration) => observationShapes.declarations.output.parse({ declarations: [declaration] }).declarations[0] as ObservationDeclaration
const byRef = (declaration: ObservationDeclaration, signalId: string) => declaration.observables.find(observable => observable.ref === `${declaration.objectId}#${signalId}`)
/** The corridor with its direct line open: the A path runs above its emergency rating (electric-grid-alarms.test.ts). */
const overloadedCorridor = (definition: CompiledGridDefinition = corridorDefinition()) => {
  const run = steppedGrid(definition)
  run.advanceTo(10_000)
  expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' }).ok).toBe(true)
  run.advanceTo(30_000)
  return run
}

describe('grid observation declarations (N2)', () => {
  test('the element catalogue: stations, buses, branches, generators, connection points, HVDC links, external systems and islands', () => {
    const declaration = valid(declareGrid(halden, operations))
    const count = (elementClass: string) => declaration.elements.filter(element => element.class === elementClass).length
    const model = halden.definition.model
    expect([count('bus'), count('branch'), count('generator'), count('connection-point'), count('hvdc-link'), count('external-system')])
      .toEqual([model.buses.length, model.branches.length, model.generators.length, model.connectionPoints.length, model.hvdcLinks.length, model.externalSystems.length])
    expect(count('station')).toBe(new Set(model.buses.flatMap(bus => bus.sourceFeatureId ?? [])).size)
    expect(declaration.elements.find(element => element.id === 'bus:osm-way-60495669@420')).toMatchObject({ class: 'bus', group: 'station:osm-way-60495669' })
    expect(declaration.elements.find(element => element.id === 'station:osm-way-60495669')).toMatchObject({ class: 'station', label: 'Hasle trafostasjon', shortLabel: 'Hasle trafostasjon' })
    expect(declaration.elements.find(element => element.class === 'island')).toMatchObject({ id: halden.projection.islands[0]!.id, label: expect.stringMatching(/^Island at /) })
    expect(declaration.elements.every(element => element.shortLabel === undefined || element.shortLabel.length <= 24)).toBe(true)
  })

  test('grid-wide observables map the Historian\'s quantities and carry the Automation\'s bands', () => {
    const declaration = valid(declareGrid(halden, operations))
    expect(byRef(declaration, 'grid.generation')).toMatchObject({ quantity: 'electric-power', unit: 'MW' })
    expect('element' in byRef(declaration, 'grid.generation')!).toBe(false)
    expect(byRef(declaration, 'grid.maximum-branch-loading')).toMatchObject({ quantity: 'loading', unit: '%' })
    expect(byRef(declaration, 'grid.maximum-branch-loading')!.thresholds.map(threshold => [threshold.id, threshold.value])).toEqual([['loading-high', 90], ['loading-overload', 100]])
    expect(byRef(declaration, 'grid.frequency')!.thresholds.map(threshold => threshold.value)).toEqual([49.9, 50.1, 49.5, 50.5, 49, 51])
    expect(byRef(declaration, 'grid.voltage.min')).toMatchObject({ quantity: 'voltage', unit: 'pu' })
    expect(byRef(declaration, `island.${halden.projection.islands[0]!.id}.frequency`)).toMatchObject({ element: halden.projection.islands[0]!.id, series: { intervalMs: 2_000 } })
  })

  test('the four missing addresses, element-scoped, with series null where nothing records them', () => {
    const elements = ['branch:osm-a0269051d0144396', 'generator:aggregate-osm-node-5981385036@132-hydro-run-of-river', 'bus:curated-halden-pwr-switchyard@420', 'unit-1-420kv']
    const declaration = valid(declareGrid(halden, engineering, elements))
    expect(declaration.elements.map(element => element.id)).toEqual(elements)
    // Q8: the state a conducting binding reads as on is marked; every other one reads off.
    expect(byRef(declaration, 'branch:osm-a0269051d0144396.state')).toMatchObject({ valueType: 'enum', states: [{ value: 'closed', label: 'closed', active: true }, { value: 'open', label: 'open' }, { value: 'tripped', label: 'tripped' }], series: null })
    expect(byRef(declaration, 'branch:osm-a0269051d0144396.state')!.states!.filter(state => state.active === true).map(state => state.value)).toEqual(['closed'])
    expect(byRef(declaration, 'generator:aggregate-osm-node-5981385036@132-hydro-run-of-river.state')).toMatchObject({ valueType: 'enum', series: null })
    expect(byRef(declaration, 'bus:curated-halden-pwr-switchyard@420.voltage')).toMatchObject({ quantity: 'voltage', unit: 'pu', series: null })
    expect(byRef(declaration, 'unit-1-420kv.exchange')).toMatchObject({ quantity: 'electric-power', unit: 'MW', element: 'unit-1-420kv', series: null })
    expect(byRef(declaration, 'branch:osm-a0269051d0144396.loading')!.series).toEqual({ seriesId: recordingSeriesIdFor('grid:halden-four-unit', 'branch:osm-a0269051d0144396.loading'), intervalMs: 10_000 })
  })

  test('Q8: an HVDC link conducts while deblocked, the one state its conducting binding reads as on', () => {
    const link = halden.definition.model.hvdcLinks[0]!
    const state = byRef(valid(declareGrid(halden, engineering, [link.id])), `${link.id}.state`)!
    expect(state.states).toEqual([{ value: 'deblocked', label: 'deblocked', active: true }, { value: 'blocked', label: 'blocked' }, { value: 'tripped', label: 'tripped' }])
  })

  test('labels are unique within the Grid across its whole catalogue, at most 80 characters (R25)', () => {
    // Islands' observables come with the grid-wide ones; every other element's by request.
    const ids = valid(declareGrid(halden, operations)).elements.filter(element => element.class !== 'island').map(element => element.id)
    const labels = [...valid(declareGrid(halden, operations)).observables.map(observable => observable.label)]
    for (let at = 0; at < ids.length; at += 256) labels.push(...valid(declareGrid(halden, operations, ids.slice(at, at + 256))).observables.map(observable => observable.label))
    expect(labels.length).toBeGreaterThan(8_000)
    expect(new Set(labels).size).toBe(labels.length)
    expect(Math.max(...labels.map(label => label.length))).toBeLessThanOrEqual(80)
  })

  test('every declared series is one the Grid\'s recording plan describes; per-asset ones only with the engineering profile', () => {
    for (const selection of [operations, engineering]) {
      const { grid } = steppedGrid(corridorDefinition())
      const described = new Set(createGridRecordingPlan({ selection, grids: new Map([[grid.definition.gridId, grid]]) }).descriptors.map(descriptor => descriptor.id))
      const declared = [valid(declareGrid(grid, selection)), valid(declareGrid(grid, selection, ['branch:g-a', 'bus:g', 'generator:g1']))].flatMap(declaration => declaration.observables.flatMap(observable => observable.series?.seriesId ?? []))
      expect(declared.filter(seriesId => !described.has(seriesId))).toEqual([])
      expect(byRef(valid(declareGrid(grid, selection, ['branch:g-a'])), 'branch:g-a.loading')!.series === null).toBe(selection === operations)
    }
    expect(valid(declareGrid(steppedGrid(corridorDefinition()).grid, undefined)).observables.every(observable => observable.series === null)).toBe(true)
  })

  test('loading thresholds follow the Automation\'s branch loading bands (mutation)', () => {
    const base = corridorDefinition()
    const loading = (definition: CompiledGridDefinition) => byRef(valid(declareGrid(steppedGrid(definition).grid, undefined, ['branch:g-a'])), 'branch:g-a.loading')!.thresholds.map(threshold => [threshold.id, threshold.value, threshold.priority])
    expect(loading(base)).toEqual([['loading-high', 90, 'caution'], ['loading-overload', 100, 'warning'], ['loading-above-emergency', 120, 'alarm']])
    const bands = base.automation.alarms.branchLoading
    const moved = { ...base, automation: { ...base.automation, alarms: { ...base.automation.alarms, branchLoading: bands.map(band => band.id === 'high' ? { ...band, raisePercent: 80, clearPercent: 78 } : band) } } }
    expect(loading(moved)[0]).toEqual(['loading-high', 80, 'caution'])
    const removed = { ...base, automation: { ...base.automation, alarms: { ...base.automation.alarms, branchLoading: bands.filter(band => band.id !== 'overload') } } }
    expect(loading(removed).map(([id]) => id)).toEqual(['loading-high', 'loading-above-emergency'])
  })

  test('frequency thresholds follow the protection Automation\'s frequency bands (mutation)', () => {
    const base = corridorDefinition()
    const frequency = (definition: CompiledGridDefinition) => byRef(valid(declareGrid(steppedGrid(definition).grid, undefined)), 'grid.frequency')!.thresholds.map(threshold => [threshold.id, threshold.value])
    const bands = base.automation.alarms.islandFrequency
    const moved = { ...base, automation: { ...base.automation, alarms: { ...base.automation.alarms, islandFrequency: bands.map(band => band.id === 'steady-state-limit' ? { ...band, deviationHz: 0.4 } : band) } } }
    expect(frequency(moved).filter(([id]) => String(id).endsWith('steady-state-limit'))).toEqual([['under-frequency-steady-state-limit', 49.6], ['over-frequency-steady-state-limit', 50.4]])
    const removed = { ...base, automation: { ...base.automation, alarms: { ...base.automation.alarms, islandFrequency: bands.filter(band => band.id !== 'instantaneous-limit') } } }
    expect(frequency(removed).some(([id]) => String(id).includes('instantaneous'))).toBe(false)
  })

  test('read: values at the Grid\'s simulation time; a coloured value has a matching active alarm; unknown refs listed', () => {
    const run = overloadedCorridor()
    const grids = new Map([[run.grid.definition.gridId, run.grid]])
    const refs = valid(declareGrid(run.grid, undefined, ['branch:g-a', 'branch:g-l', 'bus:l', 'generator:g1'])).observables.map(observable => observable.ref)
    const answer = observationShapes.read.output.parse(gridObservationReadQuery.answer({ refs: [...refs, 'grid:test-corridor#grid.frequency', 'grid:test-corridor#branch:nowhere.flow'] }, grids))
    expect(answer.unknown).toEqual(['grid:test-corridor#branch:nowhere.flow'])
    expect(answer.observations.every(observation => observation.at === run.grid.projection.updatedAt && observation.clock === 'simulation')).toBe(true)
    expect(answer.observations.find(observation => observation.ref.endsWith('#branch:g-l.state'))).toMatchObject({ value: 'open', quality: 'good', priority: 'none' })
    expect(answer.observations.find(observation => observation.ref.endsWith('#branch:g-a.loading'))).toMatchObject({ priority: 'alarm' })
    const active = [...run.grid.alarms.records.values()].filter(record => record.active)
    for (const observation of answer.observations.filter(candidate => candidate.priority !== 'none')) {
      expect(active.some(record => `grid:test-corridor#${gridAlarmSignal(record)}` === observation.ref && gridPriority[record.priority] === observation.priority)).toBe(true)
    }
  })

  test('lead: alarmed values first, then the grid-wide values; declarations answer unchanged for a held revision; unknown elements refused', () => {
    const run = overloadedCorridor()
    const grids = new Map([[run.grid.definition.gridId, run.grid]])
    const lead = observationShapes.read.output.parse(gridObservationReadQuery.answer({ refs: [], lead: { objectId: 'grid:test-corridor', count: 8 } }, grids))
    const alarmed = new Set([...run.grid.alarms.records.values()].filter(record => record.active).map(record => `grid:test-corridor#${gridAlarmSignal(record)}`))
    const refs = lead.lead!
    expect(refs[0]).toBe('grid:test-corridor#branch:g-a.loading')
    expect(refs.slice(0, alarmed.size).every(ref => alarmed.has(ref))).toBe(true)
    expect(refs[alarmed.size]).toBe('grid:test-corridor#grid.frequency')
    expect(lead.observations.map(observation => observation.ref)).toEqual(refs)
    // Read with refs, the lead comes in the same answer: the refs' values first, the lead's others after, each once.
    const both = observationShapes.read.output.parse(gridObservationReadQuery.answer({ refs: ['grid:test-corridor#grid.frequency', 'grid:test-corridor#branch:nowhere.flow'], lead: { objectId: 'grid:test-corridor', count: 8 } }, grids))
    expect(both.lead).toEqual(refs)
    expect(both.observations.map(observation => observation.ref)).toEqual(['grid:test-corridor#grid.frequency', ...refs.filter(ref => ref !== 'grid:test-corridor#grid.frequency')])
    expect(both.unknown).toEqual(['grid:test-corridor#branch:nowhere.flow'])
    const first = observationShapes.declarations.output.parse(gridObservationDeclarationsQuery.answer({ objectIds: ['grid:test-corridor'] }, grids)).declarations[0]!
    // The grid-wide values the lead goes on with are those declaring a lead rank, in its order.
    const ranked = 'observables' in first ? first.observables.filter(observable => observable.lead !== undefined).sort((left, right) => left.lead! - right.lead!).map(observable => observable.ref) : []
    expect(ranked.map(ref => ref.split('#')[1])).toEqual(['grid.frequency', 'grid.maximum-branch-loading', 'grid.unserved-load', 'grid.reserve', 'grid.island-count', 'grid.active-alarms'])
    expect(refs.slice(alarmed.size)).toEqual(ranked.filter(ref => !alarmed.has(ref)).slice(0, refs.length - alarmed.size))
    const again = gridObservationDeclarationsQuery.answer({ objectIds: ['grid:test-corridor'], known: { 'grid:test-corridor': first.revision } }, grids)
    expect(again).toEqual({ declarations: [{ objectId: 'grid:test-corridor' as never, revision: first.revision, unchanged: true }] })
    expect(() => gridObservationDeclarationsQuery.answer({ objectIds: ['grid:test-corridor'], elementIds: ['branch:nowhere'] }, grids)).toThrow(/no element branch:nowhere/)
  })
})
