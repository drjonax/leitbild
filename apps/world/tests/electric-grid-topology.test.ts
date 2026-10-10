import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileGridTopology } from '../src/packs/electric-grid/topology/compile.ts'
import { adaptCoordinateSidecar } from '../src/packs/electric-grid/topology/coordinate-sidecar.ts'
import type { TopologyCurationSet, TopologyInterconnectorTable } from '../src/packs/electric-grid/topology/input.ts'
import { adaptNodeSidecar } from '../src/packs/electric-grid/topology/node-sidecar.ts'
import type { TopologyBranch, TopologyResult } from '../src/packs/electric-grid/topology/result.ts'

// Fixture areas (tests/fixtures/electric-grid/topology): A fjord triple span, tee and through-pass;
// B voltage-less gap; C co-located levels, transformers, busbars, route relations; D HVDC landfall and
// AC tie; E railway traction; F portal gantry at a point station; G voltage-less last span, wide
// buffer, 39 m station link and a busbar spanning two stations.
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'electric-grid', 'topology', name), 'utf8'))
const table = fixture('interconnectors.json') as TopologyInterconnectorTable
const nodeSidecar = fixture('node-sidecar.geojson') as { type: string; features: unknown[] }
const noCurations: TopologyCurationSet = { sourceId: 'fixture:curations', records: [] }
const compileNode = (interconnectors = table, curations = noCurations, sidecar: unknown = nodeSidecar): TopologyResult =>
  compileGridTopology(adaptNodeSidecar(sidecar, 'osm:fixture').input, interconnectors, curations)
const withFeature = (externalId: string, change: Record<string, unknown>) => ({
  ...nodeSidecar,
  features: nodeSidecar.features.map(feature => {
    const typed = feature as { properties: { externalId: string } }
    return typed.properties.externalId === externalId ? { ...typed, properties: { ...typed.properties, ...change } } : feature
  }),
})

const result = compileNode()
const branchBetween = (topology: TopologyResult, a: string, b: string): TopologyBranch | undefined =>
  topology.branches.find(branch => (branch.fromBusId === a && branch.toBusId === b) || (branch.fromBusId === b && branch.toBusId === a))
const ledgerOf = (topology: TopologyResult, reason: string) => topology.ledger.filter(entry => entry.reason === reason)

describe('electric-grid topology compiler', () => {
  test('merges a phase-split fjord triple span into one circuit', () => {
    const corridor = branchBetween(result, 'bus:osm-way-1@420', 'bus:junction-osm-node-1005@420')!
    expect(corridor.osmWayIds).toEqual(['way/101', 'way/102', 'way/103', 'way/104', 'way/105'])
    expect(corridor.circuits).toBe(1)
    expect(corridor.circuitsSource).toBe('cables-tag')
    expect(corridor.parallelSpanGroups).toBe(1)
    // The three parallel spans count once in the corridor length.
    expect(corridor.lengthKm).toBeGreaterThan(8.3)
    expect(corridor.lengthKm).toBeLessThan(8.4)
    expect(ledgerOf(result, 'parallel-spans-merged').map(entry => entry.elementIds)).toEqual([['way/102', 'way/103', 'way/104']])
  })

  test('turns a tee into an explicit junction bus', () => {
    const junction = result.buses.find(bus => bus.id === 'bus:junction-osm-node-1005@420')!
    expect(junction.kind).toBe('junction')
    expect(junction.vertexKey).toBe('1005')
    const incident = result.branches.filter(branch => branch.fromBusId === junction.id || branch.toBusId === junction.id)
    expect(incident.map(branch => branch.fromBusId === junction.id ? branch.toBusId : branch.fromBusId).sort())
      .toEqual(['bus:osm-way-1@420', 'bus:osm-way-2@420', 'bus:osm-way-3@420'])
  })

  test('never makes a through-passing vertex a terminal and reports it', () => {
    expect(result.buses.some(bus => bus.stationId === 'osm-way-4')).toBe(false)
    const pass = ledgerOf(result, 'passes-through-station')
    expect(pass.map(entry => [entry.elementIds, entry.stationId])).toEqual([[['way/105'], 'osm-way-4']])
    expect(ledgerOf(result, 'station-without-corridor').map(entry => entry.stationId)).toEqual(['osm-way-4'])
  })

  test('inherits a voltage only when every chain end meets that voltage', () => {
    const corridor = branchBetween(result, 'bus:osm-way-11@300', 'bus:osm-way-12@300')!
    expect(corridor.osmWayIds).toEqual(['way/201', 'way/202', 'way/203'])
    expect(corridor.voltageSource).toBe('inherited')
    expect(corridor.provenance).toMatchObject({ method: 'inferred', confidence: 'low' })
    expect(ledgerOf(result, 'voltage-inherited').map(entry => [entry.elementIds, entry.voltageKv, entry.stationId])).toEqual([[['way/202'], 300, null], [['way/702'], 300, 'osm-way-71']])
    expect(ledgerOf(result, 'voltage-unknown').map(entry => entry.elementIds)).toEqual([['way/204']])
  })

  test('builds one bus per station voltage level with transformers between levels', () => {
    const golf = result.buses.filter(bus => bus.stationId === 'osm-way-21')
    expect(golf.map(bus => bus.id).sort()).toEqual(['bus:osm-way-21@132', 'bus:osm-way-21@420'])
    expect(golf[0]!.stationFeatureIds).toEqual(['way/21', 'way/22'])
    const mapped = result.branches.find(branch => branch.id === 'branch:transformer-osm-way-21-420-132')!
    expect(mapped).toMatchObject({ kind: 'transformer', fromBusId: 'bus:osm-way-21@420', toBusId: 'bus:osm-way-21@132', ratingMva: 400, circuitsSource: 'transformer-count', osmTransformerIds: ['node/3100'] })
    expect(mapped.provenance.method).toBe('mapped')
    const inferred = result.branches.find(branch => branch.id === 'branch:transformer-osm-way-25-300-132')!
    expect(inferred).toMatchObject({ ratingMva: null, circuitsSource: 'inferred' })
    expect(inferred.provenance.method).toBe('inferred')
    expect(ledgerOf(result, 'transformer-inferred').map(entry => entry.stationId)).toEqual(['osm-way-25', 'osm-way-75'])
  })

  test('connects busbars only inside their own station', () => {
    // way/302 ends on a busbar vertex 105 m outside the station polygon, beyond the 30 m buffer.
    expect(branchBetween(result, 'bus:osm-way-21@132', 'bus:osm-way-24@132')?.osmWayIds).toEqual(['way/302'])
    expect(ledgerOf(result, 'busbar-outside-station').map(entry => entry.elementIds)).toEqual([['way/305']])
    expect(result.branches.some(branch => branch.osmWayIds.includes('way/303') || branch.osmWayIds.includes('way/305'))).toBe(false)
  })

  test('joins a line ending on a portal gantry to its point-only station', () => {
    // way/602 ends 198 m from the Quebec node, beyond the 150 m point radius, on portal way/601.
    expect(branchBetween(result, 'bus:osm-node-7000@132', 'bus:osm-way-41@132')?.osmWayIds).toEqual(['way/602'])
  })

  test('counts circuits from route=power relations', () => {
    expect(branchBetween(result, 'bus:osm-way-25@300', 'bus:osm-way-26@300')).toMatchObject({ circuits: 2, circuitsSource: 'route-relation' })
  })

  test('ends an HVDC landfall and an AC tie at boundary buses', () => {
    expect(result.hvdcLinks).toHaveLength(1)
    expect(result.hvdcLinks[0]).toMatchObject({
      id: 'hvdc:test-link',
      fromBusId: 'bus:osm-way-32@420',
      toBusId: 'bus:boundary-NL',
      converterStationId: 'osm-way-32',
      dcVoltagesKv: [450],
      osmWayIds: ['way/402'],
    })
    // The unlisted overhead section stays visible until a curation adds it to the link.
    expect(ledgerOf(result, 'hvdc-unmatched').map(entry => entry.elementIds)).toEqual([['way/404']])
    expect(branchBetween(result, 'bus:osm-way-31@420', 'bus:boundary-SE3@420')).toMatchObject({ interconnectorId: 'ac:test-tie', toBusId: 'bus:boundary-SE3@420' })
    expect(result.boundaries.map(boundary => [boundary.busId, boundary.kind, boundary.externalArea])).toEqual([
      ['bus:boundary-NL', 'hvdc', 'NL'],
      ['bus:boundary-SE3@420', 'ac', 'SE3'],
    ])
    expect(result.buses.filter(bus => bus.kind === 'boundary').every(bus => bus.provenance.method === 'curated')).toBe(true)
  })

  test('rejects an interconnector whose corridor starts at another station', () => {
    const wrong = { ...table, interconnectors: table.interconnectors.map(entry => entry.id === 'ac:test-tie' ? { ...entry, norwegianStationId: 'way/23' } : entry) }
    const topology = compileNode(wrong)
    expect(topology.branches.some(branch => branch.interconnectorId === 'ac:test-tie')).toBe(false)
    expect(ledgerOf(topology, 'interconnector-terminal-mismatch').map(entry => entry.elementIds[0])).toEqual(['ac:test-tie'])
  })

  test('rejects an HVDC link whose listed ways are not all in the source', () => {
    // A missing cable would let a gap inside Norway pass for the foreign landfall.
    const incomplete = { ...table, interconnectors: table.interconnectors.map(entry => entry.id === 'hvdc:test-link' ? { ...entry, osmWayIds: ['way/402', 'way/999'] } : entry) }
    const topology = compileNode(incomplete)
    expect(topology.hvdcLinks).toEqual([])
    expect(ledgerOf(topology, 'interconnector-way-missing').map(entry => entry.elementIds)).toEqual([['hvdc:test-link', 'way/999']])
    expect(ledgerOf(topology, 'hvdc-unmatched').map(entry => entry.elementIds)).toEqual([['way/402', 'way/404']])
  })

  test('excludes 16.7 Hz railway traction circuits', () => {
    const oscarPapa = result.branches.filter(branch => [branch.fromBusId, branch.toBusId].sort().join(' ') === 'bus:osm-way-41@132 bus:osm-way-42@132')
    expect(oscarPapa.map(branch => branch.osmWayIds)).toEqual([['way/501']])
    expect(oscarPapa[0]!.circuitsSource).toBe('voltage-list')
    expect(ledgerOf(result, 'traction-system').map(entry => entry.elementIds)).toEqual([['way/501'], ['way/502']])
  })

  test('accounts for every line and cable in a model element or the ledger', () => {
    const modelled = new Set([...result.branches.flatMap(branch => branch.osmWayIds), ...result.hvdcLinks.flatMap(link => link.osmWayIds)])
    const ledgered = new Set(result.ledger.flatMap(entry => entry.elementIds))
    const ways = nodeSidecar.features
      .map(feature => (feature as { properties: { category: string; externalId: string } }).properties)
      .filter(properties => properties.category === 'line' || properties.category === 'cable')
      .map(properties => properties.externalId)
    const unaccounted = ways.filter(id => !modelled.has(id) && !ledgered.has(id))
    expect(unaccounted).toEqual([])
  })

  test('uses the Grid Model v2 id grammar', () => {
    for (const bus of result.buses) expect(bus.id).toMatch(/^bus:(osm-(way|node|relation)-\d+@\d+|junction-osm-node-\d+@\d+|boundary-[A-Z0-9]+(@\d+)?)$/)
    for (const branch of result.branches) expect(branch.id).toMatch(/^branch:(osm-[0-9a-f]{16}|transformer-osm-(way|node|relation)-\d+-\d+-\d+)$/)
  })

  test('is deterministic regardless of input order', () => {
    const shuffled = { ...nodeSidecar, features: [...nodeSidecar.features].reverse() }
    const again = compileNode(table, noCurations, shuffled)
    expect(JSON.stringify(again)).toBe(JSON.stringify(result))
    expect(JSON.stringify(compileNode())).toBe(JSON.stringify(result))
  })

  test('reads the coordinate-keyed legacy sidecar into the same network', () => {
    const legacy = compileGridTopology(adaptCoordinateSidecar(fixture('coordinate-sidecar.geojson'), 'osm:fixture-legacy').input, table, noCurations)
    const shape = (topology: TopologyResult, skip: ReadonlySet<string>) => topology.branches
      .filter(branch => !branch.osmWayIds.some(wayId => skip.has(wayId)))
      .map(branch => `${[branch.fromBusId, branch.toBusId].map(id => id.replace(/junction-[^@]+/, 'junction')).sort().join(' ')} ${branch.osmWayIds.join(',')}`)
      .sort()
    // The legacy build dropped voltage-less ways, route relations and portals.
    const differ = new Set(['way/201', 'way/306', 'way/602', 'way/701'])
    expect(shape(legacy, differ)).toEqual(shape(result, differ))
    expect(legacy.buses.some(bus => bus.id === 'bus:junction-coordinate-10.1500000_60.0000000@420')).toBe(true)
    expect(ledgerOf(legacy, 'corridor-dangling').flatMap(entry => entry.elementIds.filter(id => id.startsWith('way/'))).sort()).toEqual(['way/201', 'way/203', 'way/602', 'way/701'])
  })

  test('refuses a node sidecar whose tags disagree with its parsed fields', () => {
    expect(() => adaptNodeSidecar(withFeature('way/101', { voltageKv: [300] }), 'osm:fixture')).toThrow(/way\/101 levels from tags/)
  })

  test('lets a voltage-less last span inherit from the line and the station it enters', () => {
    const corridor = branchBetween(result, 'bus:osm-way-71@300', 'bus:osm-way-72@300')
    expect(result.branches.filter(branch => branch.osmWayIds.includes('way/702')).map(branch => branch.osmWayIds)).toEqual([['way/701', 'way/702']])
    expect(corridor).toBeDefined()
    const inherited = ledgerOf(result, 'voltage-inherited').find(entry => entry.elementIds.includes('way/702'))!
    expect(inherited).toMatchObject({ voltageKv: 300, stationId: 'osm-way-71' })
  })

  test('joins way ends up to 50 m from a polygon and lists those beyond 30 m for review', () => {
    expect(result.branches.find(branch => branch.osmWayIds.includes('way/703'))).toMatchObject({ fromBusId: 'bus:osm-way-71@300', toBusId: 'bus:osm-way-72@300' })
    const review = ledgerOf(result, 'terminal-buffer-review')
    expect(review.map(entry => [entry.elementIds, entry.stationId])).toEqual([[['way/703', 'way/71'], 'osm-way-71']])
    expect(review[0]!.distanceM).toBeGreaterThan(30)
    expect(review[0]!.distanceM).toBeLessThan(50)
  })

  test('merges the buses of a corridor shorter than 50 m into one', () => {
    expect(result.branches.some(branch => branch.osmWayIds.includes('way/704'))).toBe(false)
    expect(result.buses.some(bus => bus.id === 'bus:osm-way-74@132')).toBe(false)
    const tango = result.buses.find(bus => bus.id === 'bus:osm-way-73@132')!
    expect(tango.mergedBusIds).toEqual(['bus:osm-way-74@132'])
    expect(tango.stationFeatureIds).toEqual(['way/73', 'way/74'])
    expect(ledgerOf(result, 'short-branch-merged').map(entry => entry.elementIds.filter(id => id.startsWith('way/')))).toEqual([['way/704']])
  })

  test('connects two stations through a busbar that spans both at its voltage', () => {
    const whiskey = result.buses.find(bus => bus.id === 'bus:osm-way-75@132')!
    expect(whiskey.mergedBusIds).toEqual(['bus:osm-way-76@132'])
    expect(branchBetween(result, 'bus:osm-way-75@132', 'bus:osm-way-77@132')?.osmWayIds).toEqual(['way/708'])
    // Whiskey gains the busbar's level, so its transformer reaches the shared busbar.
    expect(result.branches.some(branch => branch.id === 'branch:transformer-osm-way-75-420-132')).toBe(true)
    expect(ledgerOf(result, 'busbar-tie-merged').map(entry => entry.elementIds)).toEqual([['way/706', 'way/75', 'way/76']])
  })

  test('applies curations only where open data needs them and ledgers every record', () => {
    const stale = withFeature('way/402', { lifecycle: 'construction' })
    const rejected = compileNode(table, noCurations, stale)
    expect(rejected.hvdcLinks).toEqual([])
    expect(ledgerOf(rejected, 'interconnector-unmatched').map(entry => entry.elementIds[0])).toEqual(['hvdc:test-link'])

    const curations: TopologyCurationSet = {
      sourceId: 'fixture:curations',
      records: [
        { kind: 'assert-in-service', id: 'curation:test-link-in-service', targetOsmIds: ['way/402', 'way/101', 'way/9999'], reason: 'commissioned', evidence: ['https://example.org/test-link'] },
        { kind: 'add-interconnector-ways', id: 'curation:test-link-overhead', interconnectorId: 'hvdc:test-link', osmWayIds: ['way/404', 'way/402'], reason: 'overhead section', evidence: ['https://example.org/test-link'] },
        { kind: 'add-interconnector-ways', id: 'curation:unknown-link', interconnectorId: 'hvdc:missing', osmWayIds: ['way/1'], reason: 'test', evidence: ['https://example.org'] },
      ],
    }
    const topology = compileNode(table, curations, stale)
    expect(topology.hvdcLinks.map(link => [link.id, link.osmWayIds])).toEqual([['hvdc:test-link', ['way/402', 'way/404']]])
    expect(topology.hvdcLinks[0]!.provenance.note).toContain('curation:test-link-in-service')
    expect(topology.hvdcLinks[0]!.provenance.note).toContain('curation:test-link-overhead')
    expect(ledgerOf(topology, 'hvdc-unmatched')).toEqual([])
    expect(ledgerOf(topology, 'curation-applied').map(entry => entry.elementIds[0]).sort()).toEqual(['curation:test-link-in-service', 'curation:test-link-overhead'])
    expect(ledgerOf(topology, 'curation-unneeded').map(entry => entry.elementIds.slice(0, 2))).toEqual([['curation:test-link-in-service', 'way/101']])
    expect(ledgerOf(topology, 'curation-target-missing').map(entry => entry.elementIds.slice(0, 2)).sort()).toEqual([['curation:test-link-in-service', 'way/9999'], ['curation:unknown-link', 'hvdc:missing']])
    expect(topology.curationSourceId).toBe('fixture:curations')
  })
})
