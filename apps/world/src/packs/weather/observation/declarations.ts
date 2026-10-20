// Weather observation declarations (plan v3.1 §2.2; architecture A1, N5): every probe and area declares
// the weather quantities in their core unit codes, a probe's recorded by the `probes` profile. The
// severity ladder's rules are each quantity's thresholds; no alert is raised from them.
import { createHash } from 'node:crypto'
import { recordingSeriesIdFor, type OperationalObject, type ScenarioRecordingSelection } from '../../../core/model/index.ts'
import { defineObservationCapability, observationShapes, type ObservationDeclaration } from '../../../core/observation/capabilities.ts'
import type { Observable } from '../../../core/observation/model.ts'
import { rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import { weatherSeverityLadder } from '../conditions.ts'
import { precipitationTypeSchema, weatherPackDataSchema, type WeatherPackData } from '../model.ts'
import { weatherQuantities, weatherRecordingProfiles } from '../quantities.ts'

const tickPriority = { notice: 'notice', adverse: 'caution', hazard: 'warning' } as const
export type WeatherObjects = ReadonlyMap<string, OperationalObject>

/** A weather object's data, or a refusal naming where object ids come from. */
export const weatherObjectData = (objects: WeatherObjects, objectId: string): WeatherPackData => {
  const object = objects.get(objectId)
  return object === undefined ? rejectCapabilityTarget(`No weather probe or area ${objectId}; weather object ids are this Run's objects of the weather category.`) : weatherPackDataSchema.parse(object.packData)
}

export const declareWeather = (objectId: string, data: WeatherPackData, recording: ScenarioRecordingSelection | undefined): ObservationDeclaration => {
  const intervalMs = recording?.intervalMs ?? weatherRecordingProfiles.find(profile => profile.id === recording?.profileId)?.defaultIntervalMs
  const observables = weatherQuantities.map((quantity): Observable => ({
    ref: `${objectId}#${quantity.id}`, label: quantity.title, quantity: quantity.quantity, unit: quantity.unit, basis: 'model',
    valueType: quantity.quantity === 'state' ? 'enum' : 'number',
    ...(quantity.quantity === 'state' ? { states: precipitationTypeSchema.options.map(value => ({ value, label: value.replaceAll('_', ' ') })) } : {}),
    thresholds: weatherSeverityLadder.filter(rule => rule.quantity === quantity.id).map((rule, order) => ({
      id: `${rule.severity}-${rule.quantity}`, direction: rule.direction, value: rule.limit, order: order + 1, effect: 'rating', priority: tickPriority[rule.severity],
    })),
    series: data.definition.type === 'weather_probe' && intervalMs !== undefined ? { seriesId: recordingSeriesIdFor(objectId, quantity.id), intervalMs } : null,
  }))
  return { objectId: objectId as ObservationDeclaration['objectId'], revision: createHash('sha256').update(JSON.stringify(observables)).digest('hex').slice(0, 32), observables, elements: [] }
}

export const weatherObservationDeclarations = {
  capability: defineObservationCapability('declarations', {
    id: 'world.weather.observation.declarations', title: 'Declare weather observations', description: 'World-internal: the weather quantities a probe or area declares.',
  }),
  answer: (rawInput: unknown, objects: WeatherObjects, recording: ScenarioRecordingSelection | undefined) => {
    const input = observationShapes.declarations.input.parse(rawInput)
    return { declarations: input.objectIds.map(objectId => {
      const declaration = declareWeather(objectId, weatherObjectData(objects, objectId), recording)
      return input.known?.[objectId] === declaration.revision ? { objectId, revision: declaration.revision, unchanged: true as const } : declaration
    }) }
  },
}
