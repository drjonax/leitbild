import { refObjectId, type IsoTimestamp, type ObjectId } from '../../../core/model/index.ts'
import { observationShapes } from '../../../core/observation/capabilities.ts'
import type { Observation } from '../../../core/observation/model.ts'
import { rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import type { PackRuntimeQuery, PackRuntimeRecordedHistory } from '../../../simulation/protocol.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { declarationRevision, plantDeclaration, type PlantRecording } from './declarations.ts'
import { leadPaths, readPlant } from './read.ts'
import { plantNowOf } from '../ic/key-values.ts'
import { servedPlantTopology } from './topology.ts'

/** The Plant's observation Capabilities (WorldPack.observation): World core defines their shapes. */
export const processPlantObservationCapabilityIds = {
  declarations: 'world.process-plant.observation.declarations',
  read: 'world.process-plant.observation.read',
  topology: 'world.process-plant.observation.topology',
} as const

export const answerProcessPlantObservationQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly simulationTime?: IsoTimestamp
  readonly recording: PlantRecording
  readonly recordedHistory?: PackRuntimeRecordedHistory
}): unknown | undefined => {
  const plantOf = (objectId: string): ProcessPlantRuntimeInstance => config.plants.get(objectId) ?? rejectCapabilityTarget(`No Process Plant ${objectId} in this Run`)
  if (config.request.capabilityId === processPlantObservationCapabilityIds.declarations) {
    const input = observationShapes.declarations.input.parse(config.request.input)
    return {
      declarations: input.objectIds.map(objectId => {
        const system = plantOf(objectId)
        // The elements' lead lists follow the operating mode the unit is in, never its live state (Q22).
        const mode = plantNowOf(system).mode
        const revision = declarationRevision(system.plant, config.recording, mode)
        return input.known?.[objectId] === revision ? { objectId, revision, unchanged: true as const } : plantDeclaration(objectId, system.plant, config.recording, input.elementIds, mode)
      }),
    }
  }
  if (config.request.capabilityId === processPlantObservationCapabilityIds.topology) {
    const input = observationShapes.topology.input.parse(config.request.input)
    const plant = plantOf(input.objectId).plant
    return input.known === plant.modelDigest ? { objectId: input.objectId, revision: plant.modelDigest, unchanged: true as const } : servedPlantTopology(input.objectId, plant)
  }
  if (config.request.capabilityId !== processPlantObservationCapabilityIds.read) return undefined
  const simulationTime = config.simulationTime ?? rejectCapabilityTarget('Process Plant values are read at the Run time the Plants stand at, which this runtime has not been given')
  const input = observationShapes.read.input.parse(config.request.input)
  const context = (objectId: ObjectId) => ({ objectId, system: plantOf(objectId), recording: config.recording, simulationTime, history: config.recordedHistory })
  // One read per Plant: the refs in the order they came, then the lead's values not among them, so a sample's values
  // and its lead cost one protection snapshot.
  const byPlant = new Map<ObjectId, Array<{ readonly ref: string; readonly index: number }>>()
  input.refs.forEach((ref, index) => byPlant.set(refObjectId(ref), [...(byPlant.get(refObjectId(ref)) ?? []), { ref, index }]))
  const lead = input.lead === undefined ? undefined : { objectId: input.lead.objectId, paths: leadPaths(plantOf(input.lead.objectId), input.lead.count) }
  if (lead !== undefined && !byPlant.has(lead.objectId)) byPlant.set(lead.objectId, [])
  const read: Array<Observation | null> = input.refs.map(() => null)
  const added: Observation[] = []
  let led: ReadonlyArray<string> | undefined
  for (const [objectId, entries] of byPlant) {
    if (!config.plants.has(objectId)) continue
    const paths = entries.map(entry => entry.ref.slice(entry.ref.indexOf('#') + 1))
    const leading = lead?.objectId === objectId ? lead.paths : []
    const more = leading.filter(path => !paths.includes(path))
    const observations = readPlant(context(objectId), [...paths, ...more])
    entries.forEach((entry, at) => { read[entry.index] = observations[at] ?? null })
    added.push(...observations.slice(paths.length).filter((observation): observation is Observation => observation !== null))
    if (lead?.objectId === objectId) {
      const byPath = new Map([...paths, ...more].map((path, at) => [path, observations[at]] as const))
      led = leading.flatMap(path => byPath.get(path)?.ref ?? [])
    }
  }
  return {
    observations: [...read.filter((observation): observation is Observation => observation !== null), ...added],
    unknown: input.refs.filter((_, index) => read[index] === null),
    ...(led === undefined ? {} : { lead: led }),
  }
}
