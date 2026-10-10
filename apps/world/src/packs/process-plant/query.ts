import type { PackRuntimeQuery, PackRuntimeRecordedHistory } from '../../simulation/protocol.ts'
import type { IsoTimestamp, ObjectId, OperationalObject } from '../../core/model/index.ts'
import { answerProcessPlantIcQuery, processPlantIcQueryKinds } from './ic-query.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import { failure } from './queries/common.ts'
import { answerProcessPlantCatalogQuery, processPlantCatalogQueryKinds } from './queries/catalog-query.ts'
import { answerProcessPlantControlQuery, processPlantControlQueryKinds } from './queries/control-query.ts'
import { answerProcessPlantCredibilityQuery, processPlantCredibilityQueryKinds } from './queries/credibility-query.ts'
import { answerProcessPlantGraphQuery, processPlantGraphQueryKinds } from './queries/graph-query.ts'
import { answerProcessPlantRuntimeQuery, processPlantRuntimeQueryKinds } from './queries/runtime-query.ts'
import { answerProcessPlantSignalQuery, processPlantSignalQueryKinds } from './queries/signal-query.ts'
import { answerProcessPlantComposedDisplayQuery, processPlantComposedDisplayQueryKinds } from './queries/composed-display-query.ts'
import { answerProcessPlantVariableQuery, processPlantVariableQueryKinds } from './queries/variable-query.ts'

export { processPlantCredibilityEvidenceForGraph } from './queries/credibility-query.ts'

export const processPlantQueryKinds = [
  ...processPlantCatalogQueryKinds,
  ...processPlantCredibilityQueryKinds,
  ...processPlantGraphQueryKinds,
  ...processPlantVariableQueryKinds,
  ...processPlantSignalQueryKinds,
  ...processPlantControlQueryKinds,
  ...processPlantRuntimeQueryKinds,
  ...processPlantIcQueryKinds,
  ...processPlantComposedDisplayQueryKinds,
] as const

export const answerProcessPlantQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly objects: ReadonlyMap<ObjectId, Pick<OperationalObject, 'id' | 'label'>>
  /** Simulation Run time the Plants have been advanced to; required by time-stamped views. */
  readonly simulationTime?: IsoTimestamp
  /** Series the Run's historian records (empty when it records none); required by composed displays. */
  readonly recordedSeriesIds?: ReadonlySet<string>
  /** What the Run's historian holds of them; a composed display reads the recent history of what it trends. */
  readonly recordedHistory?: PackRuntimeRecordedHistory
}): unknown => answerProcessPlantCatalogQuery(config)
  ?? answerProcessPlantCredibilityQuery(config)
  ?? answerProcessPlantIcQuery(config)
  ?? answerProcessPlantGraphQuery(config)
  ?? answerProcessPlantVariableQuery(config)
  ?? answerProcessPlantSignalQuery(config)
  ?? answerProcessPlantControlQuery(config)
  ?? answerProcessPlantRuntimeQuery(config)
  ?? answerProcessPlantComposedDisplayQuery(config)
  ?? failure(`Process Plant does not support query Capability: ${config.request.capabilityId}`)
