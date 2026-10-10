import type { PackReferenceDatasetBuilder } from '../../core/packs/protocol.ts'
import { createGridNorwayDataset, gridNorwayDatasetId } from './datasets/grid-norway.ts'
import type { OsmPbfPin } from './sources/osm-pbf-power.ts'

type Env = Readonly<Record<string, string | undefined>>

const requiredEnv = (env: Env, key: string): string => {
  const value = env[key]
  if (value === undefined || value.trim() === '') throw new Error(`electric-grid pack: ${key} is required`)
  return value.trim()
}

// The OSM extract is a pinned input: either its exact sha256 or a maximum age of its replication timestamp.
const osmPbfPinFromEnv = (env: Env): OsmPbfPin => {
  const sha256 = env.GRID_NORWAY_OSM_PBF_SHA256
  const maxAgeDays = env.GRID_NORWAY_OSM_PBF_MAX_AGE_DAYS
  if ((sha256 === undefined) === (maxAgeDays === undefined)) {
    throw new Error('electric-grid pack: set exactly one of GRID_NORWAY_OSM_PBF_SHA256 or GRID_NORWAY_OSM_PBF_MAX_AGE_DAYS')
  }
  if (sha256 !== undefined) return { kind: 'sha256', sha256: sha256.trim().toLowerCase() }
  return { kind: 'max-age', maxAgeDays: Number(maxAgeDays), now: () => new Date() }
}

export const electricGridReferenceDatasetBuilders: ReadonlyArray<PackReferenceDatasetBuilder> = [{
  id: gridNorwayDatasetId,
  build: (env) => createGridNorwayDataset({
    osmPbf: {
      path: requiredEnv(env, 'GRID_NORWAY_OSM_PBF_PATH'),
      pin: osmPbfPinFromEnv(env),
    },
  }),
}]
