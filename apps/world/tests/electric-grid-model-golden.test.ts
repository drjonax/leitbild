import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuditCheck, GridAuditReport } from '../src/packs/electric-grid/audit/audit-report.ts'
import { auditGridTopology } from '../src/packs/electric-grid/audit/grid-audit.ts'
import { auditGraphFromGridModelV2 } from '../src/packs/electric-grid/audit/v2-adapter.ts'
import { compileGridModelV2 } from '../src/packs/electric-grid/models/compile-v2.ts'
import { gridLoadProfiles } from '../src/packs/electric-grid/definitions.ts'
import { norwayGridModelRef } from '../src/packs/electric-grid/definition-refs.ts'
import { loadGridGeometryArtifact } from '../src/packs/electric-grid/queries/map-geometry.ts'
import { gridCurationCollectionSchema } from '../src/packs/electric-grid/schemas/grid-curation.ts'
import { gridGoldenSchema } from '../src/packs/electric-grid/schemas/grid-golden.ts'
import { validateGridLoadProfiles } from '../src/packs/electric-grid/schemas/grid-load-profile.ts'
import { composeGridModel, validateGridModelAddition } from '../src/packs/electric-grid/schemas/grid-model-addition.ts'
import { validateGridModel } from '../src/packs/electric-grid/schemas/grid-model.ts'
import { gridOperatingPointTargetsForModel, validateGridOperatingPoint } from '../src/packs/electric-grid/schemas/grid-operating-point.ts'

// The committed generated Norway model against the golden list: the gate metrics must pass, and no
// other audit check may report more failures than the committed audit report of the same build.

const models = join(import.meta.dir, '../src/packs/electric-grid/models')
const load = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(models, name), 'utf8')) as unknown
const model = validateGridModel(await load('norway-transmission.grid-model.json'), 'norway-transmission.grid-model.json')
const committed = await load('norway-transmission.audit.json') as GridAuditReport
const golden = gridGoldenSchema.parse(await load('norway-grid-golden.json'))
const curations = gridCurationCollectionSchema.parse(await load('norway-grid-curations.geojson'))
// The build audits as of its snapshot date; review-by expiries are judged against it.
const report = auditGridTopology(auditGraphFromGridModelV2(model), golden, { asOf: committed.asOf, curations })
const check = (id: string): AuditCheck => report.checks.find(entry => entry.id === id) ?? (() => { throw new Error(`no audit check ${id}`) })()

describe('generated Norway Grid Model v2 against the golden list', () => {
  test('is one AC component with every golden substation, corridor and interconnector', () => {
    expect(check('components').status).toBe('pass')
    expect(check('components').metrics.components).toBe(1)
    for (const id of ['golden-substations', 'golden-corridors', 'golden-excluded-corridors', 'golden-interconnectors', 'voltage-mismatch']) {
      expect({ id, status: check(id).status, failures: check(id).failures.map(failure => failure.message) }).toEqual({ id, status: 'pass', failures: [] })
    }
  })

  test('matches NVE generation and Elhub demand per price area', () => {
    expect(check('generation-by-area').failures.map(failure => failure.message)).toEqual([])
    expect(check('load-by-area').failures.map(failure => failure.message)).toEqual([])
  })

  test('attaches no generator beyond its radius without a curated regional route', () => {
    expect(check('attachment-distance').metrics.generatorViolations).toBe(0)
  })

  test('applies every curation and keeps the curated ≥300 kV length within budget', () => {
    expect(check('curations').status).toBe('pass')
    expect(check('curations').metrics.curatedShare300kv as number).toBeLessThanOrEqual(golden.thresholds.maxCuratedShare300kv)
  })

  test('regresses no other check against the committed audit report', () => {
    for (const previous of committed.checks) {
      const current = check(previous.id)
      // Checks that need the sidecar's reference geometry are not measurable here.
      if (current.status === 'not-measurable') continue
      expect({ id: previous.id, failures: current.failures.length <= previous.failures.length }).toEqual({ id: previous.id, failures: true })
    }
    expect(report.counts).toEqual(committed.counts)
  })
})

describe('generated Norway companions', () => {
  test('validate the operating points against the model and the Halden addition', async () => {
    const addition = validateGridModelAddition(await load('halden-four-unit.grid-model-addition.json'), 'halden-four-unit.grid-model-addition.json')
    const halden = composeGridModel({ addition, base: { kind: 'model', model }, source: addition.id })
    expect(halden.connectionPoints.map(point => point.id)).toEqual(['unit-1-420kv', 'unit-2-420kv', 'unit-3-420kv', 'unit-4-420kv'])
    for (const name of ['norway-winter-weekday-peak.operating-point.json', 'norway-summer-night-low.operating-point.json']) {
      const json = await load(name)
      for (const target of [model, halden]) {
        const point = validateGridOperatingPoint(json, name, gridOperatingPointTargetsForModel(target))
        // Initial dispatch balances the scaled demand plus the scheduled HVDC and Nordic export.
        const scale = point.priceAreaDemandScale ?? {}
        const demandMw = model.loads.reduce((sum, entry) => sum + entry.referenceDemandMw * point.loadScale * (scale[entry.priceArea] ?? 1), 0)
        const exportMw = (point.hvdcSchedules ?? []).reduce((sum, entry) => sum + entry.points[0]!.transferMw, 0)
          + (point.externalExchangeSchedules ?? []).reduce((sum, entry) => sum + entry.points[0]!.exportMw, 0)
        const generationMw = (point.generatorStates ?? []).reduce((sum, entry) => sum + (entry.targetMw ?? 0), 0)
        expect(Math.abs(generationMw - demandMw - exportMw)).toBeLessThan(1)
      }
    }
  })

  test('give every branch and HVDC link a path the live map accepts, mapped for all but the ledgered lines', async () => {
    const text = await readFile(join(models, 'norway-transmission.geometry.json'), 'utf8')
    const winter = validateGridOperatingPoint(await load('norway-winter-weekday-peak.operating-point.json'), 'winter', gridOperatingPointTargetsForModel(model))
    const runtime = compileGridModelV2(model, winter, gridLoadProfiles(norwayGridModelRef)).model
    const busLocation = new Map(model.buses.map(bus => [bus.id, bus.location]))
    // The live map's loader checks model and build ids, coverage and from→to orientation.
    const paths = loadGridGeometryArtifact({
      file: 'norway-transmission.geometry.json',
      text,
      model: runtime,
      hvdcLinks: model.hvdcLinks.map(link => ({ id: link.id, from: busLocation.get(link.fromBusId)!, to: busLocation.get(link.toBusId)! })),
    })
    expect(paths.simplificationMeters).toBe(50)
    const ledger = await load('norway-transmission.ledger.json') as { readonly summary: { readonly geometryUnresolved: ReadonlyArray<string> } }
    const unresolved = new Set(ledger.summary.geometryUnresolved)
    expect(unresolved.size).toBeLessThanOrEqual(1)
    const mapped = model.branches.filter(branch => branch.kind !== 'transformer' && !unresolved.has(branch.id))
    expect(mapped.filter(branch => paths.branchPaths.get(branch.id)!.length < 2)).toEqual([])
    expect(model.branches.filter(branch => branch.kind === 'transformer').every(branch => paths.branchPaths.get(branch.id)!.length === 2)).toBe(true)
  })

  test('normalise the load profiles to the reference hour', async () => {
    const profiles = validateGridLoadProfiles(await load('norway-load-profiles.json'), 'norway-load-profiles.json')
    expect(profiles.referenceHour).toBe(model.referenceHour)
    // The reference hour (Monday 08:00, the week's weekday peak) is one of the five weekday 08:00
    // hours averaged, so their mean lies near, and summer nights well below, 1.
    for (const area of ['NO1', 'NO2', 'NO3', 'NO4', 'NO5'] as const) {
      expect(profiles.seasons.winter.weekday[area].private[8]!).toBeGreaterThan(0.7)
      expect(profiles.seasons.winter.weekday[area].private[8]!).toBeLessThan(1.05)
      expect(profiles.seasons.summer.weekend[area].private[4]!).toBeLessThan(profiles.seasons.winter.weekday[area].private[8]!)
    }
  })
})
