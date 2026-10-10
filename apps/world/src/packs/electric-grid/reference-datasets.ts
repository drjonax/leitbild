import type { PackReferenceDatasetBuilder } from '../../core/packs/protocol.ts'
import { createGridNorwayDataset, gridNorwayDatasetId } from './datasets/grid-norway.ts'

export const electricGridReferenceDatasetBuilders: ReadonlyArray<PackReferenceDatasetBuilder> = [{
  id: gridNorwayDatasetId,
  build: (env) => createGridNorwayDataset({
    ...(env.GRID_NORWAY_OSM_PBF_PATH !== undefined ? { osmPbfPath: env.GRID_NORWAY_OSM_PBF_PATH } : {}),
    ...(env.GRID_NORWAY_OSM_PBF_URL !== undefined ? { osmPbfDownloadUrl: env.GRID_NORWAY_OSM_PBF_URL } : {}),
    ...(env.GRID_NORWAY_OSM_PBF_USER_AGENT !== undefined ? { osmPbfUserAgent: env.GRID_NORWAY_OSM_PBF_USER_AGENT } : {}),
  }),
}]
