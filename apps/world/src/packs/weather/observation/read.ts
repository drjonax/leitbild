// Reads weather observables at the object's sample time (N5). A value takes the priority of its most urgent
// active advisory (R42, T05); without one it is not coloured.
import { priorityLevels, refObjectId } from '../../../core/model/alerts.ts'
import { defineObservationCapability, observationShapes } from '../../../core/observation/capabilities.ts'
import type { Observation } from '../../../core/observation/model.ts'
import { weatherQuantities } from '../quantities.ts'
import { weatherObjectData, type WeatherObjects } from './declarations.ts'

/** Lead order after the advised values: what an operator weighs first. */
const leadOrder = ['visibilityM', 'windSpeedMps', 'precipitationType', 'airTemperatureC', 'ice', 'snow']

const observe = (objects: WeatherObjects, objectId: string, quantityId: string, rank?: number): Observation | undefined => {
  const quantity = weatherQuantities.find(candidate => candidate.id === quantityId)
  if (quantity === undefined || !objects.has(objectId)) return undefined
  const { sample } = weatherObjectData(objects, objectId)
  const ref = `${objectId}#${quantity.id}`
  const priority = objects.get(objectId)!.alerts.flatMap(alert => (alert.observable === ref && alert.priority !== undefined ? [alert.priority] : []))
    .reduce<Observation['priority']>((worst, next) => (priorityLevels.indexOf(next) > priorityLevels.indexOf(worst) ? next : worst), 'none')
  return { ref, value: quantity.value(sample.state), quality: 'good', priority, at: sample.quality.validAt, clock: 'simulation', ...(rank === undefined ? {} : { rank }) }
}

export const weatherObservationRead = {
  capability: defineObservationCapability('read', {
    id: 'world.weather.observation.read', title: 'Read weather observations', description: 'World-internal: weather values by ref, or a probe\'s or area\'s lead values.',
  }),
  answer: (rawInput: unknown, objects: WeatherObjects) => {
    const input = observationShapes.read.input.parse(rawInput)
    if ('lead' in input) {
      const { objectId, count } = input.lead
      weatherObjectData(objects, objectId)
      const advised = weatherQuantities.filter(quantity => observe(objects, objectId, quantity.id)?.priority !== 'none').map(quantity => quantity.id)
      return { observations: [...new Set([...advised, ...leadOrder])].slice(0, count).map((id, rank) => observe(objects, objectId, id, rank + 1)!), unknown: [] }
    }
    const answers = input.refs.map(ref => ({ ref, observation: observe(objects, refObjectId(ref), ref.slice(ref.indexOf('#') + 1)) }))
    return { observations: answers.flatMap(answer => answer.observation ?? []), unknown: answers.filter(answer => answer.observation === undefined).map(answer => answer.ref) }
  },
}
