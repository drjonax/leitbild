import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compileGridModelIndex } from '../src/packs/electric-grid/definitions.ts'
import { nordicAreaParticipation } from '../src/packs/electric-grid/build/interconnectors.ts'
import { interconnectorTableSchema } from '../src/packs/electric-grid/schemas/grid-interconnector.ts'
import { compileGridModelV2 } from '../src/packs/electric-grid/models/compile-v2.ts'
import { validateGridModel } from '../src/packs/electric-grid/schemas/grid-model.ts'
import { gridOperatingPointTargetsForModel, validateGridOperatingPoint } from '../src/packs/electric-grid/schemas/grid-operating-point.ts'

const fixture = validateGridModel(await Bun.file(new URL('./fixtures/grid-model-v2.fixture.json', import.meta.url)).json(), 'fixture')
const fixturePoint = validateGridOperatingPoint({
  schemaVersion: 2, id: 'electric-grid.test.v2-fixture.peak', title: 'Peak', description: 'Fixture peak.',
  compatibleModelRefs: [fixture.id], loadScale: 1.1, priceAreaDemandScale: { NO1: 0.5 },
  generatorStates: [
    { assetId: 'generator:nve-hydro-123', state: 'online', availableMw: 280, targetMw: 200 },
    { assetId: 'generator:nve-wind-45', state: 'offline', availableMw: 30, targetMw: 0 },
  ],
}, 'fixture point', gridOperatingPointTargetsForModel(fixture))

describe('Grid Model v2 → runtime model', () => {
  test('maps every asset with its Operating Point state and demand scaling', () => {
    const { model, operatingPoint } = compileGridModelV2(fixture, fixturePoint)
    expect(model.buses.map(bus => bus.id)).toEqual(fixture.buses.map(bus => bus.id))
    expect(model.branches.map(branch => branch.kind)).toEqual(fixture.branches.map(branch => branch.kind))
    const source = (id: string) => fixture.generators.find(generator => generator.id === id)!
    const hydro = model.generators.find(generator => generator.id === 'generator:nve-hydro-123')!
    expect(hydro).toMatchObject({ kind: 'hydro', availableMw: 280, initialState: 'online', rampRateMwPerMinute: 60, inertiaSeconds: 3.5 })
    // Machine data is carried as the Model states it.
    for (const field of ['ratedMva', 'powerFactor', 'voltageSetpointPu', 'minimumStableMw', 'blackStartCapable', 'synchronous'] as const) {
      expect(hydro[field]).toBe(source(hydro.id)[field])
    }
    expect(model.generators.find(generator => generator.id === 'generator:nve-wind-45')).toMatchObject({ kind: 'wind', availableMw: 30, initialState: 'offline', synchronous: false, inertiaSeconds: 0 })
    // Not in the Operating Point: online and available at capacity.
    expect(model.generators.find(generator => generator.kind === 'hydro' && generator.id.startsWith('generator:aggregate'))).toMatchObject({ availableMw: 40, initialState: 'online' })
    const oslo = model.loads.find(load => load.id === 'load:0301-private-osm-way-60495669')!
    expect(oslo.kind).toBe('residential')
    // The price-area scale is in the load's demand; the Operating Point's load scale is applied by the runtime.
    expect(oslo.demandMw).toBeCloseTo(800 * 0.5, 9)
    expect(oslo.powerFactor).toBe(0.98)
    expect(model.loads.find(load => load.id === 'load:site-test-smelter')).toMatchObject({ kind: 'industry', demandMw: 250, criticalMw: 0 })
    expect(operatingPoint).toMatchObject({ loadScale: 1.1, generationAvailabilityScale: 1, storageStateOfCharge: null })
    expect(operatingPoint.hvdcSetpoints).toEqual(fixture.hvdcLinks.map(link => ({ linkId: link.id, setpointMw: 0 })))
    // Branch electrical data and shunts are carried for the AC load flow.
    model.branches.forEach((branch, position) => {
      const original = fixture.branches[position]!
      expect(branch).toMatchObject({ circuits: original.circuits, emergencyDurationSeconds: original.emergencyDurationSeconds, chargingSusceptancePu: original.chargingSusceptancePu })
      expect(branch.tapRatio).toBe(original.tapRatio)
    })
    expect(model.shunts).toEqual(fixture.shunts)
    expect(model.sBaseMva).toBe(fixture.sBaseMva)
    expect(model.hvdcLinks).toEqual(fixture.hvdcLinks)
    expect(model.sourceBuild).toEqual({ id: fixture.sourceBuild.id, generatedAt: '2026-10-10T00:00:00Z' })
  })

  test('carries the synchronous Nordic equivalent with all its boundary buses and keeps the totals', async () => {
    const generated = validateGridModel(JSON.parse(await readFile(join(import.meta.dir, '../src/packs/electric-grid/models/norway-transmission.grid-model.json'), 'utf8')), 'generated')
    const winter = validateGridOperatingPoint(JSON.parse(await readFile(join(import.meta.dir, '../src/packs/electric-grid/models/norway-winter-weekday-peak.operating-point.json'), 'utf8')), 'winter', gridOperatingPointTargetsForModel(generated))
    const { model } = compileGridModelV2(generated, winter)
    const nordic = generated.externalSystems.find(system => system.synchronous)!
    const synchronous = model.externalSystems.filter(system => system.synchronous)
    expect(synchronous.map(system => [system.id, system.boundaryBusIds])).toEqual([[nordic.id, nordic.boundaryBusIds]])
    expect(nordic.boundaryBusIds.length).toBeGreaterThan(1)
    // The exchange enters by area as the build derives it from the interconnector table: the
    // remainder's kinetic energy routed towards Norway mostly reaches the SE3 border.
    const table = interconnectorTableSchema.parse(JSON.parse(await readFile(join(import.meta.dir, '../src/packs/electric-grid/models/norway-interconnectors.json'), 'utf8')))
    expect(nordic.areaParticipation).toEqual(nordicAreaParticipation(table).map(entry => ({ ...entry })))
    const share = new Map(nordic.areaParticipation!.map(entry => [entry.area, entry.share]))
    expect(share.get('SE3')!).toBeGreaterThan(0.85)
    expect(share.get('FI')!).toBeLessThan(0.02)
    const mapped = synchronous[0]!.areaParticipation!
    expect(mapped.find(entry => entry.area === 'SE3')!.boundaryBusIds).toEqual(['bus:boundary-SE3@132', 'bus:boundary-SE3@420'])
    expect(mapped.flatMap(entry => entry.boundaryBusIds).sort()).toEqual([...nordic.boundaryBusIds].sort())
    expect(model.externalSystems.filter(system => !system.synchronous).map(system => system.id).sort()).toEqual(['external:DE', 'external:DK1', 'external:GB', 'external:NL'])
    const demandMw = model.loads.reduce((sum, load) => sum + load.demandMw, 0) * winter.loadScale
    expect(demandMw).toBeCloseTo(generated.loads.reduce((sum, load) => sum + load.referenceDemandMw, 0) * winter.loadScale, 6)
    // The runtime loader accepts the mapped model.
    const index = compileGridModelIndex(model)
    expect(index.busById.size).toBe(generated.buses.length)
    expect(index.diagnostics.assetCount).toBeGreaterThan(generated.buses.length + generated.branches.length)
  })

  test('takes the synchronous equivalent\'s inertia and load from each season\'s Operating Point', async () => {
    const read = async (file: string) => JSON.parse(await readFile(join(import.meta.dir, '../src/packs/electric-grid/models', file), 'utf8')) as unknown
    const generated = validateGridModel(await read('norway-transmission.grid-model.json'), 'generated')
    const targets = gridOperatingPointTargetsForModel(generated)
    const winter = validateGridOperatingPoint(await read('norway-winter-weekday-peak.operating-point.json'), 'winter', targets)
    const summer = validateGridOperatingPoint(await read('norway-summer-night-low.operating-point.json'), 'summer', targets)
    const equivalent = (point: typeof winter) => compileGridModelV2(generated, point).model.externalSystems.find(system => system.synchronous)!
    for (const point of [winter, summer]) {
      const state = point.externalSystemStates!.find(entry => entry.assetId === 'external:nordic-remainder')!
      expect(equivalent(point)).toMatchObject({ inertiaGws: state.inertiaGws, loadMw: state.loadMw })
      // Reserve volumes are the Model's in every season.
      expect(equivalent(point).fcrNMwPerHz).toBe(generated.externalSystems.find(system => system.synchronous)!.fcrNMwPerHz)
    }
    expect(equivalent(summer).inertiaGws).toBeLessThan(equivalent(winter).inertiaGws!)
    expect(equivalent(summer).loadMw).toBeLessThan(equivalent(winter).loadMw!)
    expect(() => validateGridOperatingPoint({ ...summer, externalSystemStates: [{ ...summer.externalSystemStates![0]!, assetId: 'external:DE' }] }, 'summer', targets))
      .toThrow('$.externalSystemStates[0].assetId: external:DE is not synchronous')
  })

  test('refuses an Operating Point for another model and schedules the runtime does not follow', () => {
    expect(() => compileGridModelV2(fixture, { ...fixturePoint, compatibleModelRefs: ['electric-grid.other'] })).toThrow('is not compatible')
    const link = fixture.hvdcLinks[0]!
    const twoPoints = { assetId: link.id, timeZone: 'Europe/Oslo' as const, points: [{ localTime: '00:00', transferMw: 0 }, { localTime: '12:00', transferMw: 100 }] }
    expect(() => compileGridModelV2(fixture, { ...fixturePoint, hvdcSchedules: [twoPoints] })).toThrow(`the schedule of ${link.id} has 2 points`)
    const constant = compileGridModelV2(fixture, { ...fixturePoint, hvdcSchedules: [{ ...twoPoints, points: [{ localTime: '00:00', transferMw: 100 }] }] })
    expect(constant.operatingPoint.hvdcSetpoints.find(entry => entry.linkId === link.id)?.setpointMw).toBe(100)
  })

  test('takes the Operating Point\'s ambient ratings as the base ratings of the branches it lists', () => {
    const [summer, other] = fixture.branches
    const compiled = compileGridModelV2(fixture, { ...fixturePoint, branchRatings: [{ assetId: summer!.id, ratingMw: summer!.ratingMw * 0.856, emergencyRatingMw: summer!.emergencyRatingMw * 0.856 }] })
    expect(compiled.model.branches[0]).toMatchObject({ ratingMw: summer!.ratingMw * 0.856, emergencyRatingMw: summer!.emergencyRatingMw * 0.856 })
    expect(compiled.model.branches[1]).toMatchObject({ ratingMw: other!.ratingMw, emergencyRatingMw: other!.emergencyRatingMw })
    expect(compiled.operatingPoint.branchStates[0]).toEqual({ branchId: summer!.id, state: 'closed', availability: 1 })
    expect(() => validateGridOperatingPoint({ ...fixturePoint, branchRatings: [{ assetId: summer!.id, ratingMw: 100, emergencyRatingMw: 90 }] }, 'ratings', gridOperatingPointTargetsForModel(fixture)))
      .toThrow('$.branchRatings[0].emergencyRatingMw: must be at least ratingMw (100)')
    expect(() => validateGridOperatingPoint({ ...fixturePoint, branchRatings: [{ assetId: 'branch:curated-missing', ratingMw: 100, emergencyRatingMw: 120 }] }, 'ratings', gridOperatingPointTargetsForModel(fixture)))
      .toThrow('$.branchRatings[0].assetId: unknown branch branch:curated-missing')
  })

  test('starts each branch as the Operating Point lists it, and every other branch closed at its full rating', () => {
    const [opened, derated, ...others] = fixture.branches
    const compiled = compileGridModelV2(fixture, { ...fixturePoint, branchStates: [{ assetId: opened!.id, state: 'open' }, { assetId: derated!.id, state: 'closed', availability: 0.856 }] })
    expect(compiled.operatingPoint.branchStates).toEqual([
      { branchId: opened!.id, state: 'open', availability: 1 },
      { branchId: derated!.id, state: 'closed', availability: 0.856 },
      ...others.map(branch => ({ branchId: branch.id, state: 'closed' as const, availability: 1 })),
    ])
  })
})
