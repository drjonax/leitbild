import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compileGridModelIndex } from '../src/packs/electric-grid/definitions.ts'
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
    const hydro = model.generators.find(generator => generator.id === 'generator:nve-hydro-123')!
    expect(hydro).toMatchObject({ kind: 'hydro', availableMw: 280, reserveMw: 80, rampRateMwPerMinute: 60, inertiaSeconds: 3.5 })
    expect(model.generators.find(generator => generator.id === 'generator:nve-wind-45')).toMatchObject({ kind: 'wind', availableMw: 30, reserveMw: 0 })
    // Not in the Operating Point: available at capacity.
    expect(model.generators.find(generator => generator.kind === 'hydro' && generator.id.startsWith('generator:aggregate'))?.availableMw).toBe(40)
    const oslo = model.loads.find(load => load.id === 'load:0301-private-osm-way-60495669')!
    expect(oslo.kind).toBe('residential')
    expect(oslo.demandMw).toBeCloseTo(800 * 1.1 * 0.5, 9)
    expect(oslo.reactiveDemandMvar).toBeCloseTo(800 * 1.1 * 0.5 * Math.tan(Math.acos(0.98)), 9)
    expect(model.loads.find(load => load.id === 'load:site-test-smelter')).toMatchObject({ kind: 'industry', demandMw: 250 * 1.1, controllable: true, criticalMw: 0 })
    expect(operatingPoint).toMatchObject({ loadScale: 1, generationAvailabilityScale: 1, storageStateOfCharge: 0 })
    expect(model.hvdcLinks).toEqual(fixture.hvdcLinks)
    expect(model.sourceBuild).toEqual({ id: fixture.sourceBuild.id, generatedAt: '2026-10-10T00:00:00Z' })
  })

  test('gives each synchronous runtime system one boundary bus and keeps the totals', async () => {
    const generated = validateGridModel(JSON.parse(await readFile(join(import.meta.dir, '../src/packs/electric-grid/models/norway-transmission.grid-model.json'), 'utf8')), 'generated')
    const winter = validateGridOperatingPoint(JSON.parse(await readFile(join(import.meta.dir, '../src/packs/electric-grid/models/norway-winter-weekday-peak.operating-point.json'), 'utf8')), 'winter', gridOperatingPointTargetsForModel(generated))
    const { model } = compileGridModelV2(generated, winter)
    const nordic = generated.externalSystems.find(system => system.synchronous)!
    const parts = model.externalSystems.filter(system => system.synchronous)
    expect(parts.map(part => part.boundaryBusIds.length)).toEqual(nordic.boundaryBusIds.map(() => 1))
    for (const field of ['inertiaGws', 'loadMw', 'fcrNMwPerHz', 'fcrDUpMw', 'fcrDDownMw', 'afrrUpMw', 'afrrDownMw'] as const) {
      expect(parts.reduce((sum, part) => sum + part[field]!, 0)).toBeCloseTo(nordic[field]!, 6)
    }
    expect(model.externalSystems.filter(system => !system.synchronous).map(system => system.id).sort()).toEqual(['external:DE', 'external:DK1', 'external:GB', 'external:NL'])
    const demandMw = model.loads.reduce((sum, load) => sum + load.demandMw, 0)
    expect(demandMw).toBeCloseTo(generated.loads.reduce((sum, load) => sum + load.referenceDemandMw, 0), 6)
    // The runtime loader accepts the mapped model.
    const index = compileGridModelIndex(model)
    expect(index.busById.size).toBe(generated.buses.length)
    expect(index.diagnostics.assetCount).toBeGreaterThan(generated.buses.length + generated.branches.length)
  })

  test('refuses an Operating Point for another model', () => {
    expect(() => compileGridModelV2(fixture, { ...fixturePoint, compatibleModelRefs: ['electric-grid.other'] })).toThrow('is not compatible')
  })
})
