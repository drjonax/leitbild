import type { PackRuntimeQuery, SimulationCapability } from '../../../simulation/protocol.ts'
import { gridAlarmsQuery } from './alarms.ts'
import { gridAssetGetQuery, gridAssetSearchQuery } from './assets.ts'
import { gridCatalogQuery } from './catalog.ts'
import type { ElectricGridQuery, GridRuntimes } from './common.ts'
import { gridConnectionPointsQuery } from './connection-points.ts'
import { gridIslandsQuery } from './islands.ts'
import { gridMapGeometryQuery } from './map-geometry.ts'
import { gridMapStateQuery } from './map-state.ts'
import { gridPowerFlowQuery } from './power-flow.ts'
import { gridSummaryQuery } from './summary.ts'

/** Published order of the Electric Grid query Capabilities. */
const electricGridQueries: ReadonlyArray<ElectricGridQuery> = [
  gridCatalogQuery,
  gridSummaryQuery,
  gridIslandsQuery,
  gridAlarmsQuery,
  gridAssetSearchQuery,
  gridAssetGetQuery,
  gridPowerFlowQuery,
  gridConnectionPointsQuery,
  gridMapGeometryQuery,
  gridMapStateQuery,
]

const queryById = new Map(electricGridQueries.map(query => [query.capability.id, query]))

export const electricGridQueryKinds: ReadonlyArray<string> = electricGridQueries.map(query => query.capability.id)

export const electricGridQueryCapabilities: ReadonlyArray<SimulationCapability> = electricGridQueries.map(query => query.capability)

/** Answers one query with a deep copy, so callers never alias live runtime state. */
export const answerElectricGridQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly grids: GridRuntimes
}): unknown => {
  const query = queryById.get(config.request.capabilityId)
  if (!query) throw new Error(`unsupported Electric Grid query Capability: ${config.request.capabilityId}`)
  return structuredClone(query.answer(config.request.input, config.grids))
}
