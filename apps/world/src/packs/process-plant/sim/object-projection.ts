import type { IsoTimestamp, ObjectId, OperationalObject, Provenance } from '../../../core/model/index.ts'
import type { PackRuntimeEvent } from '../../../simulation/protocol.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { processPlantIdForObject } from '../model.ts'
import { processPlantProjectionKey, projectedProcessPlantUnit } from '../projection.ts'

export const initialProcessPlantObjects = (config: {
  readonly initialObjects?: ReadonlyArray<OperationalObject>
  readonly scenario: { readonly initialObjects: ReadonlyArray<OperationalObject> }
}): ReadonlyArray<OperationalObject> =>
  config.initialObjects ?? config.scenario.initialObjects

export const projectedInitialProcessPlantObjects = (config: {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly at: IsoTimestamp
  readonly simulationTime: IsoTimestamp
  readonly connectedPlantIds?: ReadonlySet<string>
}): ReadonlyArray<OperationalObject> =>
  config.objects.map(object => {
    const plantId = processPlantIdForObject(object)
    return plantId === null
      ? object
      : projectedProcessPlantUnit({
          object,
          plant: config.plants.get(plantId),
          at: config.at,
          simulationTime: config.simulationTime,
          connected: config.connectedPlantIds?.has(plantId) ?? false,
        })
  })

export const processPlantProjectionEvents = (config: {
  readonly objectsById: Map<ObjectId, OperationalObject>
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly at: IsoTimestamp
  readonly simulationTime: IsoTimestamp
  readonly provenance: Provenance
  readonly connectedPlantIds?: ReadonlySet<string>
}): ReadonlyArray<PackRuntimeEvent> => {
  const events: PackRuntimeEvent[] = []
  for (const object of config.objectsById.values()) {
    const plantId = processPlantIdForObject(object)
    if (plantId === null) continue
    const next = projectedProcessPlantUnit({
      object,
      plant: config.plants.get(plantId),
      at: config.at,
      simulationTime: config.simulationTime,
      connected: config.connectedPlantIds?.has(plantId) ?? false,
    })
    if (processPlantProjectionKey(object) === processPlantProjectionKey(next)) continue
    config.objectsById.set(next.id, next)
    events.push({
      type: 'object.upserted',
      object: next,
      at: config.at,
      provenance: config.provenance,
      history: 'snapshot-only',
    })
  }
  return events
}
