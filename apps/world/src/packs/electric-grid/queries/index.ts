import type { ScenarioRecordingSelection } from '../../../core/model/index.ts'
import type { PackRuntimeQuery, SimulationCapability } from '../../../simulation/protocol.ts'
import { gridAlarmsQuery } from './alarms.ts'
import { gridAssetGetQuery, gridAssetSearchQuery } from './assets.ts'
import { gridCatalogQuery } from './catalog.ts'
import type { ElectricGridQuery, GridRuntimes } from './common.ts'
import { gridConnectionPointsQuery } from './connection-points.ts'
import { gridContingencyScreenQuery, gridRemedialActionsEvaluateQuery } from './contingency.ts'
import { gridIslandsQuery } from './islands.ts'
import { gridMapGeometryQuery } from './map-geometry.ts'
import { gridMapStateQuery } from './map-state.ts'
import { gridPowerFlowQuery } from './power-flow.ts'
import { gridSummaryQuery } from './summary.ts'
import { gridObservationDeclarationsQuery } from '../observation/declarations.ts'
import { gridObservationReadQuery } from '../observation/read.ts'

/** Published order of the Electric Grid query Capabilities. */
const electricGridQueries: ReadonlyArray<ElectricGridQuery> = [
  gridCatalogQuery,
  gridSummaryQuery,
  gridIslandsQuery,
  gridAlarmsQuery,
  gridAssetSearchQuery,
  gridAssetGetQuery,
  gridPowerFlowQuery,
  gridContingencyScreenQuery,
  gridRemedialActionsEvaluateQuery,
  gridConnectionPointsQuery,
  gridMapGeometryQuery,
  gridMapStateQuery,
  gridObservationDeclarationsQuery,
  gridObservationReadQuery,
]

const queryById = new Map(electricGridQueries.map(query => [query.capability.id, query]))

export const electricGridQueryKinds: ReadonlyArray<string> = electricGridQueries.map(query => query.capability.id)

export const electricGridQueryCapabilities: ReadonlyArray<SimulationCapability> = electricGridQueries.map(query => query.capability)

const clonedWhenSettled = async (answer: Promise<unknown>): Promise<unknown> => structuredClone(await answer)

/**
 * Answers one query with a deep copy, so callers never alias live runtime state. A query that
 * finishes on worker threads (N-1 screening) answers with a Promise of its copy; every other
 * query answers synchronously.
 */
export const answerElectricGridQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly grids: GridRuntimes
  readonly recording?: ScenarioRecordingSelection | undefined
}): unknown => {
  const query = queryById.get(config.request.capabilityId)
  if (!query) throw new Error(`unsupported Electric Grid query Capability: ${config.request.capabilityId}`)
  const answer = query.answer(config.request.input, config.grids, config.recording)
  return answer instanceof Promise ? clonedWhenSettled(answer) : structuredClone(answer)
}
