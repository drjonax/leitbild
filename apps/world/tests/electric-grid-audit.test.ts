import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuditBranch, AuditBus, AuditGraph, LonLat } from '../src/packs/electric-grid/audit/audit-graph.ts'
import { nveLinesFromGeoJson, referenceGeometryFromSidecar } from '../src/packs/electric-grid/audit/audit-inputs.ts'
import type { GridAuditReport } from '../src/packs/electric-grid/audit/audit-report.ts'
import { auditGridTopology } from '../src/packs/electric-grid/audit/grid-audit.ts'
import { bridgesAndArticulationPoints, createMultigraph, maximumCircuitFlow } from '../src/packs/electric-grid/audit/graph-metrics.ts'
import { measureNveCoverage } from '../src/packs/electric-grid/audit/nve-coverage.ts'
import { createReferenceGeometry } from '../src/packs/electric-grid/audit/reference-geometry.ts'
import { auditGraphFromGridModelV1 } from '../src/packs/electric-grid/audit/v1-adapter.ts'
import { auditGraphFromGridModelV2, type GridModelV2AuditInput } from '../src/packs/electric-grid/audit/v2-adapter.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import { norwayGridModelRef, norwayNormalOperatingPointRef, norwayStandardAutomationRef } from '../src/packs/electric-grid/definition-refs.ts'
import type { GridModelDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { norwayGridSourceData } from '../src/packs/electric-grid/models/norway-source-data.generated.ts'
import { gridCurationCollectionSchema, type GridCurationCollection } from '../src/packs/electric-grid/schemas/grid-curation.ts'
import { gridGoldenSchema, type GridGolden } from '../src/packs/electric-grid/schemas/grid-golden.ts'
import {
  fixtureCurations,
  fixtureCurationsInput,
  fixtureGolden,
  fixtureGoldenInput,
  fixtureGraph,
  fixtureLine,
  fixtureLocations,
  fixtureNveLines,
} from './fixtures/electric-grid/audit-fixture.ts'

const audit = (config: {
  readonly graph?: AuditGraph
  readonly golden?: GridGolden
  readonly curations?: GridCurationCollection
  readonly asOf?: string
  readonly withNve?: boolean
} = {}): GridAuditReport => auditGridTopology(config.graph ?? fixtureGraph(), config.golden ?? fixtureGolden(), {
  asOf: config.asOf ?? '2026-10-10',
  curations: config.curations ?? fixtureCurations(),
  ...(config.withNve === true ? { nveLines: fixtureNveLines() } : {}),
})

const check = (report: GridAuditReport, id: string) => {
  const found = report.checks.find(candidate => candidate.id === id)
  if (!found) throw new Error(`report has no check ${id}`)
  return found
}

const failedAssets = (report: GridAuditReport, id: string): ReadonlyArray<string> => check(report, id).failures.flatMap(failure => failure.assetIds)
const messages = (report: GridAuditReport, id: string): string => check(report, id).failures.map(failure => failure.message).join('\n')

const editGraph = (edit: (graph: AuditGraph) => Partial<AuditGraph>): AuditGraph => {
  const graph = fixtureGraph()
  return { ...graph, ...edit(graph) }
}
const withoutBranches = (...ids: ReadonlyArray<string>): AuditGraph =>
  editGraph(graph => ({ branches: graph.branches.filter(branch => !ids.includes(branch.id)) }))
const patchBranch = (graph: AuditGraph, id: string, patch: Partial<AuditBranch>): AuditGraph =>
  ({ ...graph, branches: graph.branches.map(branch => branch.id === id ? { ...branch, ...patch } : branch) })
const addBranches = (graph: AuditGraph, ...branches: ReadonlyArray<AuditBranch>): AuditGraph =>
  ({ ...graph, branches: [...graph.branches, ...branches] })
const editGolden = (edit: (input: ReturnType<typeof fixtureGoldenInput>) => unknown): GridGolden =>
  gridGoldenSchema.parse(edit(fixtureGoldenInput()))
const withoutCuration = (id: string): GridCurationCollection =>
  gridCurationCollectionSchema.parse({ ...fixtureCurationsInput(), features: fixtureCurationsInput().features.filter(feature => feature.id !== id) })
const north = (point: LonLat, km: number): LonLat => [point[0], point[1] + km / 111.2]

describe('grid audit on the fixture grid', () => {
  test('passes every check on the unmodified fixture, NVE oracle included', () => {
    const report = audit({ withNve: true })
    expect(report.checks.filter(item => item.status !== 'pass').map(item => `${item.id}: ${item.summary}`)).toEqual([])
    expect(report.verdict).toBe('pass')
    expect(report.oracles.nveCoverage).toBe('supplied')
    expect(report.curations.map(status => status.status)).toEqual(['applied', 'applied', 'applied', 'applied'])
  })

  test('reports checks without reference geometry as not measurable and the verdict as incomplete', () => {
    const graph = editGraph(base => ({
      branches: base.branches.map(({ ends: _ends, geometry: _geometry, ...branch }) => ({ ...branch, osmWayIds: [] })),
    }))
    const report = audit({ graph })
    expect(check(report, 'off-terminal-ends').status).toBe('not-measurable')
    expect(check(report, 'off-terminal-ends').unmeasured).toContain('17 line ends')
    expect(check(report, 'parallel-duplicates').status).toBe('not-measurable')
    expect(report.oracles.nveCoverage).toBe('not-supplied')
    expect(report.checks.some(item => item.id === 'nve-coverage')).toBe(false)
    expect(report.verdict).toBe('incomplete')
  })

  test('rejects an inconsistent graph instead of auditing it', () => {
    expect(() => audit({ graph: addBranches(fixtureGraph(), fixtureLine('branch:a-b-1', 'bus:a@420', 'bus:b@420', 420)) })).toThrow('duplicate asset id')
    expect(() => audit({ graph: editGraph(graph => ({ loads: [{ ...graph.loads[0]!, busId: 'bus:missing' }] })) })).toThrow('unknown bus')
    expect(() => audit({ asOf: '10.10.2026' })).toThrow('ISO date')
  })
})

describe('components', () => {
  test('counts components, lists the separated buses and the lost shares', () => {
    const report = audit({ graph: withoutBranches('branch:b-c', 'branch:d-a') })
    const components = check(report, 'components')
    expect(components.status).toBe('fail')
    expect(components.metrics.components).toBe(2)
    expect(components.metrics.componentSizes).toEqual([6, 4])
    expect(components.failures[0]!.assetIds).toEqual(['bus:a@132', 'bus:a@420', 'bus:b@420', 'bus:e@132'])
    expect(components.metrics.busShare300kv).toBeCloseTo(6 / 8)
    expect(messages(report, 'components')).toContain('load share in the main component')
  })

  test('does not join Norwegian parts through a boundary bus', () => {
    const graph = addBranches(withoutBranches('branch:b-c', 'branch:d-a'), fixtureLine('branch:d-se3', 'bus:d@420', 'bus:boundary-SE3', 420))
    expect(check(audit({ graph }), 'components').metrics.components).toBe(2)
  })
})

describe('≥300 kV radial checks', () => {
  test('explain a radial plant by the allow-list and flag it without one', () => {
    expect(check(audit(), 'bridges-300kv').metrics).toEqual({ bridges: 3, unexplainedBridges: 0 })
    const report = audit({ golden: editGolden(input => ({ ...input, radialAllowList: [] })) })
    expect(failedAssets(report, 'bridges-300kv')).toContain('branch:c-p')
    expect(failedAssets(report, 'degree-one-300kv')).toEqual(['bus:p@300'])
    expect(failedAssets(report, 'articulation-points-300kv')).toEqual(['bus:c@300', 'bus:p@300', 'bus:c@420', 'bus:c@300', 'bus:p@300'])
  })

  test('treat a station level behind its own transformer as part of that station', () => {
    const graph = editGraph(base => ({ branches: base.branches.filter(branch => branch.id !== 'branch:c-p'), generators: base.generators.filter(item => item.busId !== 'bus:p@300') }))
    const report = audit({ graph, curations: withoutCuration('fixture-plant-terminal') })
    expect(check(report, 'bridges-300kv').failures).toEqual([])
    // C@300 keeps only its transformer; the now isolated plant P stays allow-listed.
    expect(failedAssets(report, 'degree-one-300kv')).toEqual(['bus:c@300'])
  })

  test('allow a station by an assert-radial curation and flag it once the curation is gone', () => {
    const report = audit({ curations: withoutCuration('fixture-q-radial') })
    expect(failedAssets(report, 'degree-one-300kv')).toEqual(['bus:q@420'])
    expect(failedAssets(report, 'bridges-300kv')).toEqual(['branch:j-q', 'bus:q@420'])
    expect(failedAssets(report, 'articulation-points-300kv')).toEqual(['bus:junction-j@420', 'bus:q@420'])
  })

  test('flag a dangling junction even next to an allowed station', () => {
    const report = audit({ graph: withoutBranches('branch:c-j', 'branch:j-q') })
    expect(failedAssets(report, 'degree-one-300kv')).toContain('bus:junction-j@420')
  })
})

describe('line checks', () => {
  test('flag a line ending at another voltage class, tolerating 400/420 kV and transformers', () => {
    const mismatched = audit({ graph: patchBranch(fixtureGraph(), 'branch:b-c', { nominalKv: 300 }) })
    expect(failedAssets(mismatched, 'voltage-mismatch')).toEqual(['branch:b-c', 'bus:b@420', 'bus:c@420'])
    expect(check(audit({ graph: patchBranch(fixtureGraph(), 'branch:b-c', { nominalKv: 400 }) }), 'voltage-mismatch').status).toBe('pass')
  })

  test('flag branches built twice from the same OSM way set in any order', () => {
    const graph = addBranches(
      patchBranch(fixtureGraph(), 'branch:b-c', { osmWayIds: ['way/500', 'way/501'] }),
      fixtureLine('branch:b-c-copy', 'bus:b@420', 'bus:c@420', 420, { osmWayIds: ['way/501', 'way/500', 'way/501'] }),
    )
    const report = audit({ graph })
    expect(check(report, 'parallel-duplicates').metrics.duplicateBranches).toBe(1)
    expect(failedAssets(report, 'parallel-duplicates')).toEqual(['branch:b-c', 'branch:b-c-copy'])
  })

  test('flag a mapped line end outside its terminal and respect the junction point radius', () => {
    const c = fixtureLocations.c
    const moved = audit({ graph: patchBranch(fixtureGraph(), 'branch:b-c', { ends: { from: fixtureLocations.b, to: north(c, 1) } }) })
    expect(failedAssets(moved, 'off-terminal-ends')).toEqual(['branch:b-c', 'bus:c@420'])
    expect(messages(moved, 'off-terminal-ends')).toContain('to end lies 0.78 km outside bus:c@420')
    const nearJunction = (km: number) => patchBranch(fixtureGraph(), 'branch:c-j', { ends: { from: c, to: north(fixtureLocations.j, km) } })
    expect(check(audit({ graph: nearJunction(0.2) }), 'off-terminal-ends').status).toBe('pass')
    expect(failedAssets(audit({ graph: nearJunction(0.4) }), 'off-terminal-ends')).toEqual(['branch:c-j', 'bus:junction-j@420'])
  })
})

describe('inventory checks', () => {
  test('flag generators and loads attached beyond their kind limit', () => {
    const graph = editGraph(base => ({
      generators: base.generators.map(item => item.id === 'generator:c' ? { ...item, attachmentKm: 31 } : item),
      loads: base.loads.map(item => ({ ...item, attachmentKm: item.family === 'site' ? 16 : 59 })),
    }))
    expect(failedAssets(audit({ graph }), 'attachment-distance')).toEqual(['generator:c', 'bus:c@420', 'load:d', 'bus:d@420'])
  })

  test('accept a generator beyond its limit only on a curated regional route naming it', () => {
    const input = fixtureCurationsInput()
    const route = {
      type: 'Feature', id: 'fixture-regional-route', geometry: { type: 'Point', coordinates: fixtureLocations.c },
      properties: {
        kind: 'attach-via-regional-grid', licence: 'osm-odbl-1.0', author: 'test', reviewedAt: '2026-10-10',
        targetOsmIds: ['way/2'], generatorId: 'generator:nve-hydro-7', substationOsmId: 'way/2', voltageKv: 420, viaOsmIds: ['way/2'], networkKm: 40,
        reason: 'regional route', evidence: [{ url: 'https://www.openstreetmap.org/way/2', ref: 'way/2' }], expiresWhen: [{ kind: 'review-by', date: '2027-10-10' }],
      },
    }
    const curations = gridCurationCollectionSchema.parse({ ...input, features: [...input.features, route] })
    const far = (id: string, curationIds: ReadonlyArray<string>) => editGraph(base => ({
      generators: base.generators.map(item => item.id === 'generator:c' ? { ...item, id, attachmentKm: 31, curationIds } : item),
    }))
    const explained = audit({ graph: far('generator:nve-hydro-7', ['fixture-regional-route']), curations })
    expect(check(explained, 'attachment-distance')).toMatchObject({ status: 'pass', metrics: { curatedRegionalRoutes: 1 } })
    expect(explained.curations.find(status => status.id === 'fixture-regional-route')?.status).toBe('applied')
    expect(failedAssets(audit({ graph: far('generator:nve-hydro-8', ['fixture-regional-route']), curations }), 'attachment-distance')).toEqual(['generator:nve-hydro-8', 'bus:c@420'])
  })

  test('compare capacity per kind and price area and flag generation without a price area', () => {
    const graph = editGraph(base => ({
      generators: base.generators.map(item => item.id === 'generator:c' ? { ...item, capacityMw: 400 } : item.id === 'generator:e' ? { id: item.id, label: item.label, kind: item.kind, family: item.family, busId: item.busId, capacityMw: item.capacityMw, attachmentKm: item.attachmentKm, curationIds: [] } : item),
    }))
    const report = audit({ graph })
    expect(messages(report, 'generation-by-area')).toContain('hydro in NO1: model 700 MW vs reference 800 MW (-12.5 %')
    expect(messages(report, 'generation-by-area')).toContain('wind in NO1: model 0 MW vs reference 100 MW')
    expect(failedAssets(report, 'generation-by-area')).toContain('generator:e')
  })

  test('require the golden reference hour and per-area load', () => {
    const graph = editGraph(base => ({
      referenceHour: '2026-01-15T17:00:00+01:00',
      loads: base.loads.map(item => item.id === 'load:d' ? { ...item, priceArea: 'NO2' } : item),
    }))
    const text = messages(audit({ graph }), 'load-by-area')
    expect(text).toContain('differs from the golden reference')
    expect(text).toContain('load in NO1: model 400 MW vs reference 600 MW')
    expect(text).toContain('load in NO2: model 200 MW vs reference 0 MW (no reference quantity')
  })
})

describe('golden checks', () => {
  test('fail a deliberately removed corridor', () => {
    const report = audit({ graph: withoutBranches('branch:j-d') })
    expect(check(report, 'golden-corridors').status).toBe('fail')
    expect(messages(report, 'golden-corridors')).toBe('C – D 420 kV: no 420 kV path between the stations through junctions only')
  })

  test('count circuits and never route a corridor through another station', () => {
    expect(messages(audit({ graph: withoutBranches('branch:a-b-2') }), 'golden-corridors')).toBe('A – B 420 kV: 1 of 2 circuits')
    expect(messages(audit({ graph: patchBranch(withoutBranches('branch:a-b-2'), 'branch:a-b-1', { circuits: 2 }) }), 'golden-corridors')).toBe('')
    expect(messages(audit({ graph: withoutBranches('branch:a-b-1', 'branch:a-b-2') }), 'golden-corridors')).toContain('A – B 420 kV: no 420 kV path')
  })

  test('report absent stations, missing voltage levels, main-component membership and degree', () => {
    const golden = editGolden(input => ({
      ...input,
      stations: [...input.stations, { id: 'ghost', name: 'Ghost', osmIds: ['way/9999'], evidence: input.stations[0]!.evidence }],
      substations: [
        { ...input.substations[0]!, minDegree: 4 },
        { stationId: 'e', voltageKv: 420, minDegree: 1, evidence: input.substations[0]!.evidence },
        { stationId: 'ghost', voltageKv: 420, minDegree: 1, evidence: input.substations[0]!.evidence },
      ],
    }))
    const text = messages(audit({ golden }), 'golden-substations')
    expect(text).toContain('A 420 kV: degree 3 < expected 4')
    expect(text).toContain('E 420 kV: the station has no 420 kV level')
    expect(text).toContain('Ghost 420 kV: station absent from the model')
    expect(messages(audit({ graph: withoutBranches('branch:b-c', 'branch:d-a') }), 'golden-substations')).toContain('A 420 kV: not in the main component')
  })

  test('fail an excluded corridor the model energises', () => {
    const report = audit({ graph: addBranches(fixtureGraph(), fixtureLine('branch:a-c', 'bus:a@420', 'bus:c@420', 420)) })
    expect(messages(report, 'golden-excluded-corridors')).toBe('A – C: the model energises 1 circuit although it is under construction')
  })

  test('need a boundary line or HVDC link for every golden interconnector', () => {
    expect(messages(audit({ graph: editGraph(() => ({ hvdcLinks: [] })) }), 'golden-interconnectors')).toBe('B – DK1 (HVDC, DK1): 0 of 1 HVDC links from B to the DK1 boundary')
    expect(messages(audit({ graph: withoutBranches('branch:a-se3') }), 'golden-interconnectors')).toBe('A – SE3 (AC, SE3): 0 of 1 420 kV circuits from A to the SE3 boundary')
    const twoLinks = editGolden(input => ({ ...input, interconnectors: [...input.interconnectors, { ...input.interconnectors[1]!, id: 'b-dk1-second', name: 'B – DK1 second' }] }))
    expect(check(audit({ golden: twoLinks }), 'golden-interconnectors').failures).toHaveLength(2)
    const noBoundary = editGraph(base => ({ buses: base.buses.filter(bus => bus.id !== 'bus:boundary-DK1'), hvdcLinks: [] }))
    expect(messages(audit({ graph: noBoundary }), 'golden-interconnectors')).toContain('the model has no boundary bus for DK1')
  })
})

describe('curations', () => {
  test('fail a curation whose review date has passed', () => {
    const report = audit({ asOf: '2027-05-01' })
    expect(report.curations.find(status => status.id === 'fixture-exclude')).toEqual({
      id: 'fixture-exclude', kind: 'exclude-feature', status: 'expired', reasons: ['review date 2027-04-10 has passed (audit as of 2027-05-01)'],
    })
    expect(check(report, 'curations').status).toBe('fail')
    expect(report.verdict).toBe('fail')
  })

  test('expire a terminal curation once open data maps the corridor, but not on an off-terminal line', () => {
    const mapped = fixtureLine('branch:c-p-mapped', 'bus:c@300', 'bus:p@300', 300)
    const expired = audit({ graph: addBranches(fixtureGraph(), mapped) })
    expect(expired.curations.find(status => status.id === 'fixture-plant-terminal')!.status).toBe('expired')
    const offTerminal = { ...mapped, ends: { from: fixtureLocations.c, to: north(fixtureLocations.p, 2) } }
    expect(audit({ graph: addBranches(fixtureGraph(), offTerminal) }).curations.find(status => status.id === 'fixture-plant-terminal')!.status).toBe('applied')
  })

  test('expire an assert-radial curation once the station gains a second neighbour', () => {
    const report = audit({ graph: addBranches(fixtureGraph(), fixtureLine('branch:q-d', 'bus:q@420', 'bus:d@420', 420)) })
    expect(report.curations.find(status => status.id === 'fixture-q-radial')!.reasons).toEqual(['way/107 now has 2 neighbours at 420 kV'])
  })

  test('report unused, violated and unknown curations', () => {
    const graph = addBranches(
      editGraph(base => ({ buses: base.buses.map(bus => ({ ...bus, curationIds: [] })) })),
      fixtureLine('branch:excluded', 'bus:b@420', 'bus:c@420', 420, { osmWayIds: ['way/999'] }),
      fixtureLine('branch:unknown', 'bus:b@420', 'bus:c@420', 420, { curationIds: ['no-such-curation'] }),
    )
    const report = audit({ graph })
    expect(report.curations.find(status => status.id === 'fixture-se3-boundary')).toEqual({ id: 'fixture-se3-boundary', kind: 'boundary', status: 'unused', reasons: ['no model asset references this curation'] })
    expect(report.curations.find(status => status.id === 'fixture-exclude')!.reasons).toEqual(['excluded feature is present as branch branch:excluded'])
    expect(messages(report, 'curations')).toContain('model assets reference unknown curation no-such-curation')
  })

  test('keep the curated share of ≥300 kV line length within budget', () => {
    const report = audit({ graph: patchBranch(fixtureGraph(), 'branch:c-p', { lengthKm: 50 }) })
    expect(messages(report, 'curations')).toMatch(/curated share of ≥300 kV line length \d+\.\d+ % > 2\.00 %/)
  })
})

describe('NVE coverage oracle', () => {
  const model: ReadonlyArray<ReadonlyArray<LonLat>> = [[[10, 60], [10, 60.1]]]
  const nve = (offset: number, kv = 420) => [{ globalId: '{X}', name: 'X', voltageKv: kv, parts: [[[10 + offset, 60], [10 + offset, 60.05], [10 + offset, 60.2]] as LonLat[]] }]

  test('measures uncovered NVE kilometres against model polylines', () => {
    const covered = measureNveCoverage(nve(0.002), model, { minKv: 300, bufferKm: 0.3 })
    // A span counts as covered only when both of its vertices are near the model: 60.00–60.05 is, 60.05–60.20 is not.
    expect(covered.totalKm).toBeCloseTo(22.24, 1)
    expect(covered.uncoveredKm).toBeCloseTo(16.68, 1)
    expect(measureNveCoverage(nve(0.02), model, { minKv: 300, bufferKm: 0.3 }).uncoveredKm).toBeCloseTo(22.24, 1)
    expect(measureNveCoverage(nve(0.002, 132), model, { minKv: 300, bufferKm: 0.3 }).lineCount).toBe(0)
  })

  test('fails the audit when NVE lines have no model line', () => {
    const report = auditGridTopology(fixtureGraph(), fixtureGolden(), {
      asOf: '2026-10-10', curations: fixtureCurations(),
      nveLines: [...fixtureNveLines(), { globalId: '{FAR}', name: 'Far line', voltageKv: 420, parts: [[[12, 62], [12.5, 62]]] }],
    })
    expect(failedAssets(report, 'nve-coverage')).toEqual(['nve:{FAR}'])
    expect(check(report, 'nve-coverage').status).toBe('fail')
  })
})

describe('graph metrics', () => {
  test('keep parallel circuits out of the bridge list and find articulation points', () => {
    const graph = createMultigraph(['a', 'b', 'c', 'd'], [
      { a: 'a', b: 'b', capacity: 1 }, { a: 'a', b: 'b', capacity: 1 }, { a: 'b', b: 'c', capacity: 1 }, { a: 'c', b: 'd', capacity: 1 },
    ])
    expect(bridgesAndArticulationPoints(graph)).toEqual({ bridges: [2, 3], articulationPoints: ['b', 'c'] })
  })

  test('count circuits through passable nodes only', () => {
    const graph = createMultigraph(['a', 'j', 'b', 's'], [
      { a: 'a', b: 'j', capacity: 2 }, { a: 'j', b: 'b', capacity: 1 }, { a: 'a', b: 's', capacity: 3 }, { a: 's', b: 'b', capacity: 3 },
    ])
    expect(maximumCircuitFlow(graph, new Set(['a']), new Set(['b']), node => node === 'j')).toBe(1)
    expect(maximumCircuitFlow(graph, new Set(['a']), new Set(['b']), () => true)).toBe(4)
  })
})

describe('golden and curation schemas', () => {
  const goldenIssues = (edit: (input: ReturnType<typeof fixtureGoldenInput>) => unknown): string => {
    const result = gridGoldenSchema.safeParse(edit(fixtureGoldenInput()))
    return result.success ? '' : result.error.issues.map(issue => issue.message).join('; ')
  }

  test('reject golden lists with dangling references, shared OSM ids or undocumented thresholds', () => {
    expect(goldenIssues(input => ({ ...input, corridors: [{ ...input.corridors[0]!, toStationId: 'nowhere' }] }))).toContain('unknown station nowhere')
    expect(goldenIssues(input => ({ ...input, stations: [...input.stations, { ...input.stations[0]!, id: 'a-copy' }] }))).toContain('way/101 already belongs to station a')
    expect(goldenIssues(input => {
      const { maxComponents: _omitted, ...thresholdNotes } = input.thresholdNotes
      return { ...input, thresholdNotes }
    })).toContain('threshold maxComponents has no note')
    expect(goldenIssues(input => ({ ...input, thresholdNotes: { ...input.thresholdNotes, maxSpeed: 'fast' } }))).toContain('unknown threshold maxSpeed')
    expect(goldenIssues(input => ({ ...input, corridors: [{ ...input.corridors[0]!, evidence: [{ sourceId: 'rumour', url: 'https://example.org', ref: 'x' }] }] }))).toContain('unknown source rumour')
    expect(goldenIssues(input => ({ ...input, corridors: [{ ...input.corridors[0]!, toStationId: 'a' }] }))).toContain('corridor connects a station to itself')
    expect(goldenIssues(input => ({ ...input, stations: [{ ...input.stations[0]!, osmIds: ['osm-way-101'] }] }))).not.toBe('')
    expect(goldenIssues(input => ({ ...input, references: { ...input.references, load: { ...input.references.load, demandMwByArea: { NO1: 600 } } } }))).not.toBe('')
  })

  const curationIssues = (edit: (feature: ReturnType<typeof fixtureCurationsInput>['features'][number]) => unknown, index = 0): string => {
    const input = fixtureCurationsInput()
    const features = input.features.map((feature, position) => position === index ? edit(feature) : feature)
    const result = gridCurationCollectionSchema.safeParse({ ...input, features })
    return result.success ? '' : result.error.issues.map(issue => issue.message).join('; ')
  }

  test('reject curation records that are untyped, unevidenced or unexpiring', () => {
    const lineFeature = (feature: ReturnType<typeof fixtureCurationsInput>['features'][number]) => ({
      ...feature,
      properties: { ...feature.properties, kind: 'add-line', fromSubstationOsmId: 'way/105', toSubstationOsmId: 'way/103', voltageKv: 300, circuits: 1, wayOsmId: undefined, substationOsmId: undefined, remoteSubstationOsmId: undefined, targetOsmIds: ['way/105', 'way/103'] },
    })
    expect(curationIssues(lineFeature)).toContain('add-line needs the curated line geometry')
    expect(curationIssues(feature => ({ ...feature, properties: { ...feature.properties, expiresWhen: [{ kind: 'review-by', date: '2027-01-01' }] } }))).toContain('add-terminal requires a mapped-corridor-present condition')
    expect(curationIssues(feature => ({ ...feature, properties: { ...feature.properties, expiresWhen: [{ kind: 'radial-no-longer', substationOsmId: 'way/107', voltageKv: 420 }] } }), 2)).toContain('radial-no-longer does not apply to exclude-feature')
    expect(curationIssues(feature => ({ ...feature, properties: { ...feature.properties, licence: 'cc-by-sa-4.0' } }))).toContain('licence must be registered')
    expect(curationIssues(feature => ({ ...feature, properties: { ...feature.properties, targetOsmIds: ['way/209'] } }))).toContain('targetOsmIds must include way/105')
    expect(curationIssues(feature => ({ ...feature, id: 'fixture-q-radial' }))).toContain('duplicate curation id fixture-q-radial')
    expect(curationIssues(feature => ({ ...feature, properties: { ...feature.properties, evidence: [] } }))).not.toBe('')
    expect(curationIssues(feature => ({ ...feature, properties: { ...feature.properties, remoteSubstationOsmId: 'way/105' } }))).toContain('remote station equals the attached station')
    expect(curationIssues(feature => ({ ...feature, properties: { ...feature.properties, kind: 'merge-patch' } }))).not.toBe('')
  })
})

describe('model adapters', () => {
  const v1Model = (): GridModelDefinition => ({
    id: 'v1-fixture', title: 'v1', description: 'v1', nominalFrequencyHz: 50,
    fidelity: { powerFlow: 'dc', voltage: 'approximate', frequency: 'aggregate-dynamic', recommendedMaximumBusCount: 10 },
    sourceBuild: { id: 'b', generatedAt: '2026-01-01T00:00:00Z' }, sourceIds: [],
    buses: [
      { id: 'NO-A', label: 'A', nominalKv: 420, location: [10, 60], sourceId: 'osm:pbf-power:NO', sourceFeatureId: 'way/1' },
      { id: 'NO-B', label: 'B', nominalKv: 420, location: [10.5, 60], sourceId: 'osm:pbf-power:NO', sourceFeatureId: 'relation/2' },
      { id: 'bus:plant', label: 'Plant', nominalKv: 420, location: [10.2, 60.2], sourceId: 'leitbild:engineering', sourceFeatureId: 'plant' },
    ],
    branches: [
      { id: 'br:ab', label: 'A – B', kind: 'ac_line', fromBusId: 'NO-A', toBusId: 'NO-B', nominalKv: 420, ratingMw: 1, emergencyRatingMw: 1, reactancePu: 0.1, resistancePu: 0, weatherExposure: 'low', sourceId: 'osm:pbf-power:NO', sourceFeatureId: 'merged/line/ab' },
      { id: 'br:hvdc', label: 'Link', kind: 'hvdc_link', fromBusId: 'NO-A', toBusId: 'bus:plant', nominalKv: 525, ratingMw: 700, emergencyRatingMw: 700, reactancePu: 0.1, resistancePu: 0, weatherExposure: 'low' },
    ],
    generators: [{ id: 'gen', label: 'Gen', kind: 'hydro', busId: 'NO-B', location: [10.5, 60.1], capacityMw: 10, availableMw: 10, reserveMw: 0, rampRateMwPerMinute: 1, inertiaSeconds: 3, priceArea: 'NO1' }],
    loads: [{ id: 'load', label: 'Load', kind: 'industry', busId: 'NO-A', location: [10, 60], demandMw: 5, criticalMw: 0, reactiveDemandMvar: 0, priority: 'normal', controllable: false }],
    storage: [], connectionPoints: [],
  })
  const reference = createReferenceGeometry([
    { geometry: { type: 'Polygon', coordinates: [[[9.99, 59.99], [10.01, 59.99], [10.01, 60.01], [9.99, 59.99]]] }, properties: { externalId: 'way/1' } },
    { geometry: { type: 'Point', coordinates: [10.5, 60] }, properties: { externalId: 'relation/2' } },
    { geometry: { type: 'LineString', coordinates: [[10.5, 60], [10.25, 60.01], [10, 60]] }, properties: { externalId: 'merged/line/ab', tags: { 'leitbild:merged_source_ids': 'way/10;way/11' } } },
  ])

  test('map a v1 model with reference geometry and source lengths', () => {
    const graph = auditGraphFromGridModelV1({
      model: v1Model(), reference,
      sourceData: { ...norwayGridSourceData, branches: [{ externalId: 'merged/line/ab', name: 'A – B', category: 'line', fromExternalId: 'way/1', toExternalId: 'relation/2', nominalKv: 420, lengthKm: 28.5, sourceId: 'osm:pbf-power:NO' }] },
    })
    expect(graph.busPerVoltageLevel).toBe(false)
    expect(graph.buses.map(bus => bus.substationId)).toEqual(['way/1', 'relation/2', undefined])
    expect(graph.buses[0]!.footprint?.kind).toBe('polygon')
    expect(graph.branches).toHaveLength(1)
    expect(graph.branches[0]).toMatchObject({ osmWayIds: ['way/10', 'way/11'], lengthKm: 28.5, circuits: 1, ends: { from: [10, 60], to: [10.5, 60] } })
    expect(graph.hvdcLinks.map(link => link.id)).toEqual(['br:hvdc'])
    expect(graph.generators[0]!.attachmentKm).toBeCloseTo(11.1, 1)
    expect(graph.loads[0]!.family).toBe('site')
  })

  test('refuse v1 assets the audit cannot classify', () => {
    const model = v1Model()
    expect(() => auditGraphFromGridModelV1({ model: { ...model, generators: [{ ...model.generators[0]!, kind: 'battery' }] } })).toThrow('is not a generation family')
    expect(() => auditGraphFromGridModelV1({ model: { ...model, branches: [{ ...model.branches[0]!, kind: 'switch' }] } })).toThrow('unsupported kind switch')
    expect(() => auditGraphFromGridModelV1({ model: { ...model, buses: [{ ...model.buses[0]!, sourceFeatureId: 'merged/x' }, ...model.buses.slice(1)] } })).toThrow('has no OSM feature id')
  })

  const v2Model = (): GridModelV2AuditInput => ({
    id: 'v2-fixture', referenceHour: '2026-01-15T00:00:00+01:00',
    buses: [
      { id: 'bus:osm-way-1@420', label: 'A', kind: 'substation', substationId: 'osm-way-1', nominalKv: 420, location: [10, 60], priceArea: 'NO1', provenance: { sources: ['osm'] } },
      { id: 'bus:osm-relation-2@420', label: 'B', kind: 'substation', substationId: 'osm-relation-2', nominalKv: 420, location: [10.5, 60], priceArea: 'NO1', provenance: { sources: ['osm', 'curation:b-terminal'] } },
      { id: 'bus:boundary-SE3', label: 'SE3', kind: 'boundary', nominalKv: 420, location: [11, 59], externalArea: 'SE3', provenance: { sources: ['curation:se3'] } },
    ],
    branches: [
      { id: 'branch:osm-x', label: 'A – B', kind: 'ac_line', fromBusId: 'bus:osm-way-1@420', toBusId: 'bus:osm-relation-2@420', nominalKv: 420, lengthKm: 28, circuits: 2, osmWayIds: ['10', '11'], provenance: { sources: ['osm'] } },
      { id: 'branch:osm-y', label: 'A – SE3', kind: 'ac_line', fromBusId: 'bus:osm-way-1@420', toBusId: 'bus:boundary-SE3', nominalKv: 420, lengthKm: 50, circuits: 1, osmWayIds: ['12'], provenance: { sources: ['osm'] } },
    ],
    hvdcLinks: [],
    generators: [{ id: 'generator:nve-hydro-1', label: 'G', kind: 'hydro-pumped', busId: 'bus:osm-relation-2@420', capacityMw: 10, priceArea: 'NO1', attachmentKm: 2, provenance: { sources: ['nve', 'curation:g-route'] } }],
    loads: [{ id: 'load:0301-private-osm-way-1', label: 'L', kind: 'private', busId: 'bus:osm-way-1@420', referenceDemandMw: 5, priceArea: 'NO1', attachmentKm: 3, provenance: { sources: ['elhub'] } }],
  })

  test('map a v2 model, reading curation ids from provenance', () => {
    const lines = createReferenceGeometry([
      { geometry: { type: 'LineString', coordinates: [[10, 60], [10.25, 60]] }, properties: { externalId: 'way/10' } },
      { geometry: { type: 'LineString', coordinates: [[10.25, 60], [10.5, 60]] }, properties: { externalId: 'way/11' } },
    ])
    const graph = auditGraphFromGridModelV2(v2Model(), lines)
    expect(graph.busPerVoltageLevel).toBe(true)
    expect(graph.buses.map(bus => bus.curationIds)).toEqual([[], ['b-terminal'], ['se3']])
    expect(graph.buses.map(bus => bus.substationId)).toEqual(['way/1', 'relation/2', undefined])
    expect(graph.branches[0]!.osmWayIds).toEqual(['way/10', 'way/11'])
    expect(graph.branches[0]).toMatchObject({ circuits: 2, ends: { from: [10, 60], to: [10.5, 60] } })
    expect(graph.branches[0]!.geometry).toHaveLength(2)
    expect(graph.branches[1]!.geometry).toBeUndefined()
    expect(graph.generators[0]).toMatchObject({ family: 'hydro', curationIds: ['g-route'] })
    expect(graph.loads[0]).toMatchObject({ family: 'distributed', demandMw: 5 })
  })

  test('refuse v2 station and way ids outside the v2 grammar', () => {
    const model = v2Model()
    expect(() => auditGraphFromGridModelV2({ ...model, buses: [{ ...model.buses[0]!, substationId: 'way/1' }, ...model.buses.slice(1)] })).toThrow('is not of the form osm-')
    expect(() => auditGraphFromGridModelV2({ ...model, branches: [{ ...model.branches[0]!, osmWayIds: ['way/10'] }] })).toThrow('is not a positive OSM way number')
  })

  test('parse sidecar and NVE inputs with validation', () => {
    const sidecar = referenceGeometryFromSidecar({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [10, 60] }, properties: { externalId: 'node/1', tags: {} } }] })
    expect(sidecar.footprint('node/1')).toEqual({ kind: 'point', location: [10, 60] })
    expect(() => referenceGeometryFromSidecar({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [10, 60] }, properties: {} }] })).toThrow()
    const nve = nveLinesFromGeoJson({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[10, 60], [10, 61]]] }, properties: { globalid: '{A}', navn: 'A - B', spenning_kv: 420 } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[10, 60], [10, 61]] }, properties: { globalid: '{B}', navn: null, spenning_kv: null } },
    ] })
    expect(nve.withoutVoltage).toBe(1)
    expect(nve.lines).toEqual([{ globalId: '{A}', name: 'A - B', voltageKv: 420, parts: [[[10, 60], [10, 61]]] }])
  })
})

describe('repository golden list and curations', () => {
  const modelsDirectory = join(import.meta.dir, '../src/packs/electric-grid/models')
  const load = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(modelsDirectory, name), 'utf8')) as unknown

  test('validate and cite a public source for every entry', async () => {
    const golden = gridGoldenSchema.parse(await load('norway-grid-golden.json'))
    const curations = gridCurationCollectionSchema.parse(await load('norway-grid-curations.geojson'))
    expect({
      stations: golden.stations.length, substations: golden.substations.length, corridors: golden.corridors.length,
      interconnectors: golden.interconnectors.length, radial: golden.radialAllowList.length, curations: curations.features.length,
    }).toEqual({ stations: 85, substations: 37, corridors: 24, interconnectors: 14, radial: 29, curations: 6 })
    const entries = [...golden.stations, ...golden.substations, ...golden.corridors, ...golden.excludedCorridors, ...golden.interconnectors, ...golden.radialAllowList]
    expect(entries.every(entry => entry.evidence.length > 0 && entry.evidence.every(item => item.url.startsWith('https://')))).toBe(true)
  })

  // Baseline of today's v1 model (audit B, 2026-10-10). The model build lane replaces this with a
  // passing audit of the v2 model; until then it pins the measured gaps so regressions stay visible.
  test("today's v1 Norway model reproduces the measured gap baseline", async () => {
    const golden = gridGoldenSchema.parse(await load('norway-grid-golden.json'))
    const curations = gridCurationCollectionSchema.parse(await load('norway-grid-curations.geojson'))
    const model = compileGridDefinition({
      id: 'grid:audit', model: { ref: norwayGridModelRef }, operatingPoint: { ref: norwayNormalOperatingPointRef }, automation: { ref: norwayStandardAutomationRef },
    }).model
    const report = auditGridTopology(auditGraphFromGridModelV1({ model, sourceData: norwayGridSourceData }), golden, { asOf: '2026-10-10', curations })
    expect(report.verdict).toBe('fail')
    expect(check(report, 'components').metrics.componentSizes).toEqual([99, 78, 46, 14, 3, 2, 2, 2, 2, 2, 2, 2, 1])
    expect(check(report, 'voltage-mismatch').metrics.mismatchedLines).toBe(62)
    expect(check(report, 'off-terminal-ends').status).toBe('not-measurable')
    expect(check(report, 'golden-interconnectors').metrics).toEqual({ total: 14, present: 0 })
    expect(check(report, 'golden-substations').metrics).toEqual({ total: 37, present: 34, inMainComponent: 19, degreeMet: 20 })
    const corridorFailures = messages(report, 'golden-corridors')
    for (const corridor of ['Kvinesdal – Lista 1 and 2', 'Sylling – Hamang 1 and 2', 'Nordreisa – Guolasjokka 1 and 2', 'Skillemoen – Kvænangen 1 and 2']) {
      expect(corridorFailures).toContain(`${corridor} `)
    }
    expect(check(report, 'golden-corridors').metrics).toEqual({ total: 24, connected: 13, circuitsMet: 9 })
  })
})
