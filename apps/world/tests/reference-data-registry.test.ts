import { describe, expect, test } from 'bun:test'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { gridNorwayDatasetId } from '../src/packs/electric-grid/datasets/grid-norway.ts'
import { electricGridReferenceDatasetBuilders } from '../src/packs/electric-grid/reference-datasets.ts'
import {
  collectRegisteredDatasets,
  findRegisteredDataset,
  type RegistryEnvironment,
} from '../src/reference-data/registry.ts'
import type { WorldPack } from '../src/core/packs/protocol.ts'
import { createWorldPackDescriptor } from '../src/core/packs/protocol.ts'

const emptyEnv: RegistryEnvironment = {}

const electricGridPackWithReferenceDatasets: WorldPack = {
  ...electricGridPack,
  referenceData: {
    builders: electricGridReferenceDatasetBuilders,
    datasetIds: electricGridPack.referenceData?.datasetIds ?? [],
  },
}
const packs: ReadonlyArray<WorldPack> = [
  electricGridPackWithReferenceDatasets,
]

describe('reference-data registry (collector)', () => {
  test('lists pack-owned reference dataset contributions', () => {
    const datasets = collectRegisteredDatasets(packs)
    expect(datasets.map(d => String(d.id))).toContain(String(gridNorwayDatasetId))
  })

  test('grid-norway build() returns an OSM PBF dataset config for a pinned extract', () => {
    const descriptor = findRegisteredDataset(String(gridNorwayDatasetId), packs)!
    const config = descriptor.build({
      GRID_NORWAY_OSM_PBF_PATH: '/opt/leitbild/maps/sources/norway-latest.osm.pbf',
      GRID_NORWAY_OSM_PBF_MAX_AGE_DAYS: '14',
    })
    expect(String(config.id)).toBe(String(gridNorwayDatasetId))
    expect(config.sources.map(source => String(source.id))).toEqual(['osm:pbf-power:NO'])
    expect(config.licences.map(licence => String(licence.id))).toEqual(['osm-odbl-1.0'])
  })

  test('grid-norway build() refuses an unpinned or ambiguously pinned extract', () => {
    const descriptor = findRegisteredDataset(String(gridNorwayDatasetId), packs)!
    expect(() => descriptor.build(emptyEnv)).toThrow('GRID_NORWAY_OSM_PBF_PATH is required')
    expect(() => descriptor.build({ GRID_NORWAY_OSM_PBF_PATH: '/x.osm.pbf' })).toThrow('exactly one of')
    expect(() => descriptor.build({
      GRID_NORWAY_OSM_PBF_PATH: '/x.osm.pbf',
      GRID_NORWAY_OSM_PBF_SHA256: 'a'.repeat(64),
      GRID_NORWAY_OSM_PBF_MAX_AGE_DAYS: '14',
    })).toThrow('exactly one of')
    expect(() => descriptor.build({ GRID_NORWAY_OSM_PBF_PATH: '/x.osm.pbf', GRID_NORWAY_OSM_PBF_SHA256: 'abc' })).toThrow('64 lowercase hex')
    expect(() => descriptor.build({ GRID_NORWAY_OSM_PBF_PATH: '/x.osm.pbf', GRID_NORWAY_OSM_PBF_MAX_AGE_DAYS: 'soon' })).toThrow('positive number of days')
  })

  test('findRegisteredDataset returns null for unknown id', () => {
    expect(findRegisteredDataset('does-not-exist', packs)).toBeNull()
  })

  test('empty pack list yields zero datasets without throwing', () => {
    expect(collectRegisteredDatasets([])).toEqual([])
  })

  test('duplicate dataset id across packs throws', () => {
    const dup: WorldPack = {
      ...electricGridPackWithReferenceDatasets,
      descriptor: createWorldPackDescriptor({
        id: 'grid-clone',
        version: electricGridPack.descriptor.version,
        name: 'Grid Clone',
        description: 'Test Pack.',
        contributions: electricGridPack.descriptor.contributions.map(contribution => contribution.kind),
      }),
    }
    expect(() => collectRegisteredDatasets([electricGridPackWithReferenceDatasets, dup])).toThrow(/duplicate dataset id/)
  })
})
