import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gridCurationCollectionSchema } from '../src/packs/electric-grid/schemas/grid-curation.ts'
import { validateGridModel } from '../src/packs/electric-grid/schemas/grid-model.ts'
import { gridOperatingPointTargetsForModel, validateGridOperatingPoint } from '../src/packs/electric-grid/schemas/grid-operating-point.ts'

// The committed Norway model carries the topology corrections that published documents give and
// OSM does not map (lane VAL1, norway-grid-curations.geojson): station transformer units, a
// normally-open sectioning point and a tap operated below the model's 132 kV floor.

const models = join(import.meta.dir, '../src/packs/electric-grid/models')
const load = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(models, name), 'utf8')) as unknown
const model = validateGridModel(await load('norway-transmission.grid-model.json'), 'norway-transmission.grid-model.json')
const curations = gridCurationCollectionSchema.parse(await load('norway-grid-curations.geojson'))
const targets = gridOperatingPointTargetsForModel(model)
const operatingPoints = await Promise.all(['norway-winter-weekday-peak.operating-point.json', 'norway-summer-night-low.operating-point.json']
  .map(async file => validateGridOperatingPoint(await load(file), file, targets)))

const transformersOf = (stationId: string) => model.branches
  .filter(branch => branch.kind === 'transformer' && branch.fromBusId.startsWith(`bus:${stationId}@`))
  .map(branch => ({ highKv: branch.nominalKv, lowKv: Number(branch.toBusId.split('@')[1]), units: branch.circuits, ratingMw: branch.ratingMw, curated: branch.provenance.method === 'curated' }))
  .sort((left, right) => right.lowKv - left.lowKv)

describe('curated topology of the Norway model', () => {
  test('Fagrafjell joins 132 kV and 300 kV from 420 kV with its concession units', () => {
    // Statnett's draft concession: 3 × 420/132 kV 300 MVA and 2 × 420/300 kV 1,000 MVA.
    expect(transformersOf('osm-way-830770515')).toEqual([
      { highKv: 420, lowKv: 300, units: 2, ratingMw: 2000, curated: true },
      { highKv: 420, lowKv: 132, units: 3, ratingMw: 900, curated: true },
    ])
  })

  test('Hamang has its two 300 MVA 300(420)/132 kV units', () => {
    expect(transformersOf('osm-way-187555858')).toEqual([{ highKv: 300, lowKv: 132, units: 2, ratingMw: 600, curated: true }])
  })

  test('the 132 kV under Rana runs split: both Operating Points start the Svabo – Rana kraftverk lines open', () => {
    const record = curations.features.find(feature => feature.id === 'rana-svabo-132kv-delt-drift')
    if (record?.properties.kind !== 'normally-open') throw new Error('the Rana normally-open curation is missing')
    const lines = model.branches.filter(branch => branch.provenance.sources.includes('curation:rana-svabo-132kv-delt-drift')).map(branch => branch.id).sort()
    expect(lines).toEqual(['branch:osm-122cf84b421ee3ca', 'branch:osm-64c4608e3fb764b2'])
    expect(lines.map(id => model.branches.find(branch => branch.id === id)!.label)).toEqual(['Svabo - Rana kraftverk', 'Svabo - Rana kraftverk'])
    for (const operatingPoint of operatingPoints) {
      expect((operatingPoint.branchStates ?? []).filter(state => state.state === 'open').map(state => state.assetId).sort()).toEqual(lines)
    }
  })

  test('the Ålefjær tap operated at 110 kV is not part of the ≥132 kV model', () => {
    expect(model.buses.filter(bus => bus.substationId === 'osm-relation-14027918')).toEqual([])
    expect(model.branches.filter(branch => branch.osmWayIds.includes('988971051'))).toEqual([])
  })
})
